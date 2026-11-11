"""Run a flow: dependency order, parallel branches, cache, cancel, live events.

Every run executes in its own daemon thread with a private event loop, so the same code serves the
async REST handlers and the synchronous agent tools, and a run survives a hot reload of the engine
(the thread keeps the code it started with). Live handles sit in ``env.state["active_runs"]``.
"""
from __future__ import annotations

import asyncio
import contextvars
import copy
import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

from . import executors as X
from . import graph as G
from . import media as M
from . import nodes as N
from . import picks as P
from . import store as S
from . import timings as T
from . import types as ptypes

logger = logging.getLogger("flowcanvas.runner")

DEFAULT_MAX_PARALLEL = 3
DEFAULT_NODE_TIMEOUT_S = 120.0
LARGE_VALUE_CHARS = 64 * 1024
PREVIEW_CHARS = 300
SAVE_INTERVAL_S = 0.4
HEARTBEAT_S = 30.0     # a running flow re-saves at least this often (store.HEARTBEAT_STALE_S = 120 s)
CACHE_KEEP = 500           # newest entries kept per flow (cache/<flow_id>/)
CACHE_KEEP_TOTAL = 5000    # all flows together; over it, the flow with the most entries gives up its oldest
CACHE_PRUNE_MIN_PUTS = 25  # _prune_cache lists every cache folder, so it runs at most every N puts (review E-12)
CACHE_PRUNE_MIN_S = 60.0   # ... or every minute, whichever comes first
CACHE_MAX_ENTRY_BYTES = 256 * 1024 * 1024   # one entry: its JSON plus its own media copies (review EN-11)
CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024    # the whole cache root; over it the oldest entries go, across flows
CACHE_ORPHAN_AGE_S = 3600                   # an unreferenced .media-* dir untouched this long is a crash leftover
HASH_MEMO_MAX = 2000       # media fingerprints remembered per process (path+mtime+size -> sha256)
TERMINAL_NODE = ("done", "cached", "error", "skipped", "cancelled")
_INPUT_PARAM = {"input.text": "value", "input.number": "value", "input.file": "path", "input.json": "value"}
MERGE = "logic.merge"  # G10: joins branches, see _Execution.gate
DEFAULT_MAX_ITEMS = 100  # G11: list items one For each runs at most (config max_items)
MAX_ITERATION_RECORDS = 500


class RunError(ValueError):
    """A run cannot be started (bad target node, unknown input name, ...)."""


@dataclass
class RunHandle:
    run: dict
    lock: threading.RLock = field(default_factory=threading.RLock)
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    loop: Optional[asyncio.AbstractEventLoop] = None
    tasks: dict = field(default_factory=dict)
    thread: Optional[threading.Thread] = None

    def snapshot(self) -> dict:
        with self.lock:
            return copy.deepcopy(self.run)


# ----------------------------------------------------------------- env helpers

def _active(env) -> dict:
    return env.state.setdefault("active_runs", {})


def _config_number(env, key: str, default: float) -> float:
    getter = getattr(getattr(env, "ctx", None), "get_config", None)
    if callable(getter):
        try:
            value = getter(key, None)
            if value not in (None, ""):
                number = float(value)
                if number > 0:
                    return number
        except (TypeError, ValueError):
            pass
        except Exception as exc:  # noqa: BLE001 - config errors fall back to defaults
            logger.warning("flowcanvas: config %s unreadable: %s", key, exc)
    return default


def boot_token(env) -> str:
    """One random token per process (per engine state): tells this process's runs from another's on disk."""
    token = env.state.get("boot_token")
    if not token:
        import secrets
        token = env.state["boot_token"] = secrets.token_hex(8)
    return token


def ensure_startup(env) -> None:
    """Once per process: runs whose owner process is gone (dead pid, stale heartbeat) become 'interrupted',
    and trash/uploads nobody can use any more are swept (review E-12)."""
    if env.state.get("startup_done"):
        return
    env.state["startup_done"] = True
    try:
        fixed = S.mark_interrupted(env, active_ids=lambda: _active(env), boot=boot_token(env))
        if fixed:
            logger.info("flowcanvas: marked %d interrupted run(s)", len(fixed))
    except Exception as exc:  # noqa: BLE001 - never block the plugin on housekeeping
        logger.warning("flowcanvas: interrupted-run cleanup failed: %s", exc)
    try:
        swept = S.prune_stale_files(env)
        if swept["trash"] or swept["uploads"]:
            logger.info("flowcanvas: swept %d trashed flow(s) and %d unused upload(s)",
                        swept["trash"], swept["uploads"])
    except Exception as exc:  # noqa: BLE001 - housekeeping must never block a run
        logger.warning("flowcanvas: trash/upload sweep failed: %s", exc)


def _emit(env, event: str, payload: dict) -> None:
    try:
        env.emit(event, payload)
    except Exception as exc:  # noqa: BLE001 - UI delivery is best effort
        logger.debug("flowcanvas: emit %s failed: %s", event, exc)


# ----------------------------------------------------------------- values

def preview_of(value):
    """Small, JSON-safe preview for events and logs."""
    if ptypes.is_media(value):
        meta = value["$media"]
        return {"$media": {k: meta.get(k) for k in ("kind", "file", "mime", "path", "source") if meta.get(k)}}
    if isinstance(value, dict) and "$large" in value:
        return value["$large"].get("preview", "")[:PREVIEW_CHARS]
    text = ptypes.to_text(value)
    return text if len(text) <= PREVIEW_CHARS else text[:PREVIEW_CHARS - 1] + "…"


def node_preview(outputs: dict):
    if not outputs:
        return None
    for key in ("media", "value", "file", "text", "number", "result"):
        if key in outputs and outputs[key] is not None:
            return preview_of(outputs[key])
    first = next((v for v in outputs.values() if v is not None), None)
    return preview_of(first) if first is not None else None


def _branch(outputs) -> dict:
    return {"branch": outputs[X.BRANCH]} if isinstance(outputs, dict) and outputs.get(X.BRANCH) else {}


def _json_safe(value):
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return ptypes.to_text(value) if not isinstance(value, (dict, list)) else json.loads(
            json.dumps(value, default=str))


def record_value(env, value, run_id: str, node_id: str, port: str):
    """The value as stored in the run record: large values move to a file, a preview stays."""
    value = _json_safe(value)
    if ptypes.is_media(value) or value is None or isinstance(value, (bool, int, float)):
        return value
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    if len(text) <= LARGE_VALUE_CHARS:
        return value
    folder = S.outputs_dir(env, run_id)
    name = f"{node_id}-{port}.{'txt' if isinstance(value, str) else 'json'}"
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return {"$large": {"file": name, "path": path, "chars": len(text), "preview": text[:2000]}}


class ValueCorruptionError(X.NodeError):
    """A spilled value on disk no longer matches its metadata and must never feed a node."""


def load_value(value):
    """Undo record_value (used when a cached/large value feeds a later run)."""
    if isinstance(value, dict) and isinstance(value.get("$large"), dict):
        meta = value["$large"]
        path = meta.get("path")
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8", newline="") as fh:
                text = fh.read()
            chars = meta.get("chars")
            if isinstance(chars, int) and not isinstance(chars, bool) and chars >= 0:
                if len(text) != chars:
                    raise ValueCorruptionError(
                        f"stored value length mismatch; historical data may be corrupted "
                        f"({len(text)} chars on disk, {chars} recorded)"
                    )
            if path.endswith(".json"):
                try:
                    return json.loads(text)
                except ValueError:
                    raise ValueCorruptionError("stored JSON value is corrupt") from None
            return text
    return value


# ----------------------------------------------------------------- cache

def _hash_memo(env) -> "OrderedDict":
    """Process-wide media fingerprint memo, capped at HASH_MEMO_MAX entries (review E-12)."""
    memo = env.state.get("hash_memo")
    if memo is None:
        memo = env.state["hash_memo"] = OrderedDict()
    return memo


def _media_fingerprint(env, value) -> str:
    path = M.media_path(value)
    if M.blocked_local_path(path):
        return "missing:" + path
    try:
        st = os.stat(path)
    except OSError:
        return "missing:" + path
    memo = _hash_memo(env)
    key = (path, st.st_mtime_ns, st.st_size)
    with env.state.setdefault("hash_memo_guard", threading.Lock()):
        found = memo.get(key)
    if found is None:
        found = M.file_sha256(path)        # up to 200 MB: callers on a loop run this in a worker thread
        with env.state.setdefault("hash_memo_guard", threading.Lock()):
            memo[key] = found
            while len(memo) > HASH_MEMO_MAX:
                memo.popitem(last=False)   # oldest fingerprint out; the file is re-hashed if it comes back
    return found


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _effective_params(node: dict, spec: dict) -> dict:
    """The params the executor really runs with: a blank model/setting takes the spec's default
    (executors.build_tool_args), so a moved default model must change the key (review E-11)."""
    params = dict(node.get("params") or {})
    for param in (spec or {}).get("params") or []:
        name, default = param.get("name"), param.get("default")
        if not name or _blank(default) or not (param.get("options_source") or param.get("fallback")):
            continue
        if _blank(params.get(name)):
            params[name] = default
    return params


def _param_paths(value) -> list:
    """Local files a param value points at: a path string, a media value, or a list/dict of those."""
    if isinstance(value, str):
        if M.blocked_local_path(value):
            return []
        # only path-shaped text reaches the disk check: prompts are long or multi-line, data/web URLs are not files
        if (value and len(value) < 1024 and "\n" not in value and not value.startswith(("data:", "http://", "https://"))
                and os.path.isfile(value)):
            return [value]
        return []
    if ptypes.is_media(value):
        path = M.media_path(value)
        return [path] if path and not M.blocked_local_path(path) and os.path.isfile(path) else []
    if isinstance(value, list):
        return [p for item in value for p in _param_paths(item)]
    if isinstance(value, dict):
        return [p for item in value.values() for p in _param_paths(item)]
    return []


def _param_fingerprints(env, params: dict) -> dict:
    """Content behind path-like params (review E-11): a media setting, a picker path or any string
    naming an existing local file — the same treatment input.file's own file gets."""
    out = {}
    for name in sorted(params):
        paths = sorted({os.path.abspath(p) for p in _param_paths(params[name])})
        if paths:
            out[name] = [_media_fingerprint(env, {"$media": {"path": p}}) for p in paths]
    return out


def _schema_signature(spec: dict) -> str:
    """Hash of a tool node's schema shape, so a changed MCP/tool schema drops stale hits (review E-11).

    Defaults stay out: only the ones a run actually falls back to matter, and those live in the
    effective params. Labels and descriptions are cosmetic and must not invalidate a cache.
    """
    if not spec or not spec.get("tool"):
        return ""
    shape = {
        "tool": spec.get("tool"),
        "params": [{k: p.get(k) for k in ("name", "kind", "required", "options", "media_kind",
                                          "min_items", "max_items")} for p in spec.get("params") or []],
        "inputs": [{k: p.get(k) for k in ("name", "type", "required", "multiple", "min", "max")}
                   for p in spec.get("inputs") or []],
    }
    return hashlib.sha256(json.dumps(shape, sort_keys=True, ensure_ascii=False, default=str)
                          .encode("utf-8")).hexdigest()


def _fingerprint(env, value):
    if ptypes.is_media(value):
        return {"$media": _media_fingerprint(env, value), "kind": ptypes.media_kind(value)}
    if isinstance(value, dict):
        return {k: _fingerprint(env, v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_fingerprint(env, v) for v in value]
    return value


def cache_key(env, node: dict, inputs: dict, spec: dict = None) -> str:
    params = _effective_params(node, spec)
    params.pop("cache", None)
    params.pop("timeout_s", None)
    payload = {"type": node.get("type"), "params": params, "inputs": _fingerprint(env, inputs),
               "files": _param_fingerprints(env, params), "schema": _schema_signature(spec)}
    if node.get("type") == "input.file":
        path = str(params.get("path") or "")
        payload["file"] = _media_fingerprint(env, {"$media": {"path": os.path.abspath(path)}}) if path else ""
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _media_alive(value) -> bool:
    if ptypes.is_media(value):
        return os.path.isfile(M.media_path(value))
    if isinstance(value, dict):
        if "$large" in value:
            return os.path.isfile(value["$large"].get("path", ""))
        return all(_media_alive(v) for v in value.values())
    if isinstance(value, list):
        return all(_media_alive(v) for v in value)
    return True


def _cache_folders(env, flow_id):
    """Where a key may live: this flow's folder first, then the old flat cache, then other flows
    (keys hash the node + inputs, so a duplicated flow still reuses results)."""
    root = S.cache_dir(env)
    own = os.path.join(root, flow_id) if flow_id else root
    yield own
    if own != root:
        yield root
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return
    for name in names:
        folder = os.path.join(root, name)
        if folder != own and not name.startswith(".media-") and os.path.isdir(folder):
            yield folder


def _has_file_values(value) -> bool:
    if ptypes.is_media(value) or (isinstance(value, dict) and isinstance(value.get("$large"), dict)):
        return True
    if isinstance(value, dict):
        return any(_has_file_values(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_file_values(v) for v in value)
    return False


def _copy_file_values(value, folder: str):
    """Give a cache entry or a hit run its own files, including nested media. Never mutate the source."""
    copied, created = {}, []

    def walk(item):
        if isinstance(item, dict):
            marker = "$media" if ptypes.is_media(item) else "$large"
            meta = item.get(marker)
            if isinstance(meta, dict) and meta.get("path"):
                source = meta["path"]
                if source not in copied:
                    os.makedirs(folder, exist_ok=True)
                    fd, target = tempfile.mkstemp(prefix="media-", suffix=os.path.splitext(source)[1], dir=folder)
                    os.close(fd)
                    created.append(target)
                    shutil.copy2(source, target)
                    copied[source] = target
                target = copied[source]
                return {**item, marker: {**meta, "path": target, "file": os.path.basename(target)}}
            return {k: walk(v) for k, v in item.items()}
        if isinstance(item, list):
            return [walk(v) for v in item]
        return item

    try:
        return walk(value)
    except (OSError, TypeError, ValueError):
        for path in created:
            try:
                os.remove(path)
            except OSError:
                pass
        raise


def _media_dir_path(path: str, entry):
    """The entry's own media directory (a plain .media-* name next to it), or None."""
    name = entry.get("media_dir") if isinstance(entry, dict) else None
    if isinstance(name, str) and name.startswith(".media-") and os.path.basename(name) == name:
        return os.path.join(os.path.dirname(path), name)
    return None


def _drop_cache_media(path: str, entry) -> None:
    """Only delete the cache entry's dedicated directory, never a source path from its outputs."""
    media = _media_dir_path(path, entry)
    if media:
        shutil.rmtree(media, ignore_errors=True)


def _tree_bytes(folder: str) -> int:
    total = 0
    for base, _, files in os.walk(folder):
        for name in files:
            if name.endswith(".lock") or name.startswith((".lock", ".tmp-")):
                continue
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


def _entry_bytes(path: str, entry) -> int:
    """Disk bytes of one cache entry: its JSON file plus its own media directory (review EN-11)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    media = _media_dir_path(path, entry)
    return size + (_tree_bytes(media) if media else 0)


def _json_bytes(data) -> int:
    """Bytes S.write_json puts on disk for data (text mode turns each newline into os.linesep)."""
    text = json.dumps(data, ensure_ascii=False, indent=1)
    return len(text.encode("utf-8")) + text.count("\n") * (len(os.linesep) - 1)


def _remove_cache_entry(path: str) -> int:
    """Delete an entry and its media directory; returns the bytes freed."""
    try:
        entry = S.read_json(path)
    except (OSError, ValueError):
        entry = None
    freed = _entry_bytes(path, entry)
    os.remove(path)
    _drop_cache_media(path, entry)
    return freed


def cache_get(env, key: str, flow_id: str = None, out_dir: str = None):
    # Share the lock with puts/pruning so a hit finishes copying before its entry can be evicted.
    with S.lock(env, "cache"):
        for folder in _cache_folders(env, flow_id):
            path = os.path.join(folder, key + ".json")
            try:
                entry = S.read_json(path)
                outputs = entry.get("outputs") if isinstance(entry, dict) else None
                if not isinstance(outputs, dict) or not _media_alive(outputs):
                    continue
                # Old entries pointed at producer-run files. Adopt them lazily while those files exist.
                if _has_file_values(outputs) and not entry.get("media_dir"):
                    cache_put(env, key, {"type": entry.get("node_type")}, outputs,
                              None if folder == S.cache_dir(env) else os.path.basename(folder))
                    outputs = S.read_json(path)["outputs"]
                return _copy_file_values(outputs, out_dir) if out_dir else outputs
            except (OSError, TypeError, ValueError):
                continue
    return None


def _cache_entries(folder) -> list:
    """(mtime, path) of a cache folder's entries, oldest first."""
    out = []
    for name in os.listdir(folder):
        if name.endswith(".json") and not name.startswith("."):
            path = os.path.join(folder, name)
            try:
                out.append((os.path.getmtime(path), path))
            except OSError:
                pass
    return sorted(out)


def _scan_cache(env) -> dict:
    """Entries per cache folder, from disk: one listing of the whole cache (startup and each sweep)."""
    root = S.cache_dir(env)
    folders = {root: len(_cache_entries(root))}
    for name in os.listdir(root):
        folder = os.path.join(root, name)
        if not name.startswith(".media-") and os.path.isdir(folder):
            folders[folder] = len(_cache_entries(folder))
    return folders


def _cache_counts(env) -> dict:
    """Approximate entries per cache folder, so a put does not have to list the cache to know the bounds.

    Filled by one listing the first time, then kept by cache_put and refreshed by _prune_cache. Another
    process writing cache entries makes the numbers stale; the throttled sweep (see _prune_due) is what
    keeps the total honest across processes.
    """
    counts = env.state.get("cache_counts")
    if counts is None:
        counts = env.state["cache_counts"] = _scan_cache(env)
    return counts


def _cache_bytes(env) -> int:
    """Approximate bytes under the cache root, kept like _cache_counts; each sweep re-measures the disk."""
    total = env.state.get("cache_bytes")
    if total is None:
        total = env.state["cache_bytes"] = _tree_bytes(S.cache_dir(env))
    return total


def _media_owner(path: str):
    """media_dir of the entry at path; "" if there is no usable entry, None if it cannot be read now."""
    try:
        entry = S.read_json(path)
    except (FileNotFoundError, ValueError):
        return ""
    except OSError:
        return None
    return (entry.get("media_dir") if isinstance(entry, dict) else None) or ""


def _sweep_orphans(folder: str, entries: list) -> None:
    """Remove .media-* dirs no entry references and nothing touched for CACHE_ORPHAN_AGE_S (crashed puts).

    New dirs are named .media-<key>-<random>, so only that key's entry is read; older random names
    are checked against every entry of the folder. Fresh dirs may belong to a put in progress.
    """
    now = time.time()
    referenced = None
    for name in os.listdir(folder):
        media = os.path.join(folder, name)
        if not name.startswith(".media-") or not os.path.isdir(media):
            continue
        try:
            touched = max([os.path.getmtime(media)] +
                          [os.path.getmtime(os.path.join(media, f)) for f in os.listdir(media)])
        except OSError:
            continue
        if now - touched < CACHE_ORPHAN_AGE_S:
            continue
        key = name[len(".media-"):].rpartition("-")[0]
        if key:
            owner = _media_owner(os.path.join(folder, key + ".json"))
            owned = owner is None or owner == name
        else:
            if referenced is None:
                referenced = {_media_owner(path) for _, path in entries}
            owned = None in referenced or name in referenced
        if not owned:
            shutil.rmtree(media, ignore_errors=True)


def _prune_cache(env, own: str) -> None:
    """Enforce CACHE_KEEP per flow, CACHE_KEEP_TOTAL and CACHE_MAX_BYTES overall, and sweep crash orphans.
    The only place that lists every folder."""
    root = S.cache_dir(env)
    folders = {own: _cache_entries(own)}
    folders.setdefault(root, _cache_entries(root))
    for name in os.listdir(root):
        folder = os.path.join(root, name)
        if folder not in folders and not name.startswith(".media-") and os.path.isdir(folder):
            folders[folder] = _cache_entries(folder)
    for folder, entries in list(folders.items()):
        drop = max(0, len(entries) - CACHE_KEEP)
        for _, old in entries[:drop]:
            _remove_cache_entry(old)
        folders[folder] = entries[drop:]
    extra = sum(len(v) for v in folders.values()) - CACHE_KEEP_TOTAL
    while extra > 0:
        biggest = max(folders.values(), key=len)       # the flow that caches most pays first
        _remove_cache_entry(biggest.pop(0)[1])
        extra -= 1
    for folder, entries in folders.items():
        _sweep_orphans(folder, entries)
    total = _tree_bytes(root)
    if total > CACHE_MAX_BYTES:
        # oldest first across every flow; only cache-owned files go, never producer or hit-run files
        for (mtime, path), folder in sorted((e, f) for f, entries in folders.items() for e in entries):
            if total <= CACHE_MAX_BYTES:
                break
            try:
                total -= _remove_cache_entry(path)
            except OSError:
                continue
            folders[folder].remove((mtime, path))
    env.state["cache_bytes"] = total
    env.state["cache_counts"] = {folder: len(entries) for folder, entries in folders.items()}


def _prune_due(env) -> bool:
    """Sweep at most every CACHE_PRUNE_MIN_PUTS puts or CACHE_PRUNE_MIN_S seconds, not on every put."""
    clock = env.state.get("cache_prune")
    now = time.monotonic()
    if clock is None:
        env.state["cache_prune"] = {"puts": 0, "at": now}
        return False
    clock["puts"] += 1
    if clock["puts"] >= CACHE_PRUNE_MIN_PUTS or now - clock["at"] >= CACHE_PRUNE_MIN_S:
        clock["puts"], clock["at"] = 0, now
        return True
    return False


def cache_put(env, key: str, node: dict, outputs: dict, flow_id: str = None) -> None:
    root = S.cache_dir(env)
    folder = os.path.join(root, flow_id) if flow_id else root
    media_folder = None
    published = False
    with S.lock(env, "cache"):
        try:
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, key + ".json")
            counts = _cache_counts(env)
            total = _cache_bytes(env)
            existed = os.path.isfile(path)
            try:
                previous = S.read_json(path) if existed else None
            except (OSError, ValueError):
                previous = None
            owned = _json_safe(outputs)
            if _has_file_values(owned):
                media_folder = tempfile.mkdtemp(prefix=f".media-{key}-", dir=folder)
                owned = _copy_file_values(owned, media_folder)
            entry = {"node_type": node.get("type"), "created_at": G.now_iso(), "outputs": owned}
            if media_folder:
                entry["media_dir"] = os.path.basename(media_folder)
            # measured while staged: an entry over budget is never published and a previous one stays
            size = _json_bytes(entry) + (_tree_bytes(media_folder) if media_folder else 0)
            if size > CACHE_MAX_ENTRY_BYTES:
                raise ValueError(f"entry of {size} bytes over the {CACHE_MAX_ENTRY_BYTES}-byte budget")
            replaced = _entry_bytes(path, previous) if existed else 0
            S.write_json(path, entry)
            published = True
            _drop_cache_media(path, previous)
            counts[folder] = counts.get(folder, 0) + (0 if existed else 1)
            env.state["cache_bytes"] = total = total + size - replaced
            # over a known limit (cheap, from the counts) or the sweep is due (review E-12)
            if (counts[folder] > CACHE_KEEP or sum(counts.values()) > CACHE_KEEP_TOTAL
                    or total > CACHE_MAX_BYTES or _prune_due(env)):
                _prune_cache(env, folder)
        except (OSError, TypeError, ValueError) as exc:
            if media_folder and not published:
                shutil.rmtree(media_folder, ignore_errors=True)
            logger.info("flowcanvas: cache write skipped: %s", exc)


def node_cacheable(node: dict, spec: dict, fresh: bool) -> bool:
    if fresh or not spec:
        return False
    if spec.get("cacheable", True) is False:   # For each / Collect: never, whatever the switch says
        return False
    choice = (node.get("params") or {}).get("cache")
    if choice is not None and str(choice).lower() in ("true", "false"):
        return str(choice).lower() == "true"   # the inspector switch (review E-8: both ways)
    return spec.get("cache_default", True) is not False


# ----------------------------------------------------------------- preparation

def apply_inputs(flow: dict, inputs: dict) -> dict:
    """Override input nodes by id or (case-insensitive) title. Raises RunError for unknown names."""
    if not inputs:
        return flow
    flow = copy.deepcopy(flow)
    for key, value in inputs.items():
        matches = [n for n in flow["nodes"] if n["id"] == key] or \
                  [n for n in flow["nodes"] if str(n.get("title") or "").strip().lower() == str(key).strip().lower()
                   and n.get("type") in _INPUT_PARAM]
        targets = [n for n in matches if n.get("type") in _INPUT_PARAM]
        if not targets:
            names = [n.get("title") or n["id"] for n in flow["nodes"] if n.get("type") in _INPUT_PARAM]
            raise RunError(f"no input node {key!r}; inputs are: {', '.join(names) or 'none'}")
        for n in targets:
            n.setdefault("params", {})[_INPUT_PARAM[n["type"]]] = value
            P.drop(n)   # an input set by the caller (agent, cron) is never a canvas pick (catalog review)
    return flow


def run_node_set(flow: dict, target_node: str = None) -> list:
    runnable = {n["id"] for n in flow["nodes"] if n.get("type") != G.NOTE_TYPE}
    if target_node:
        if target_node not in {n["id"] for n in flow["nodes"]}:
            raise RunError(f"no node {target_node!r} in this flow")
        wanted = (G.ancestors(flow, target_node) | {target_node}) & runnable
        target = G.node_by_id(flow, target_node)
        if target.get("type") == G.FOREACH:
            loop = G.loops(flow)[0].get(target_node, {})
            complete = set(loop.get("body", ())) | set(loop.get("collects", ()))
            wanted.update(complete)
            # Body/Collect inputs may come from independent upstream nodes, not just the list source.
            for nid in complete:
                wanted.update(G.ancestors(flow, nid))
            wanted.intersection_update(runnable)
    else:
        wanted = runnable
    return [n["id"] for n in flow["nodes"] if n["id"] in wanted]


def parse_fresh(value=False) -> bool:
    """A run's cost-affecting cache override: no Python truthiness for user-supplied values."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value in ("true", "false"):
        return value == "true"
    raise RunError("fresh must be a boolean (true/false)")


def prepare(env, flow: dict, target_node=None, fresh=False, inputs=None, types=None) -> tuple:
    """(run record, effective flow, types). Invalid flows yield status 'invalid' with issues."""
    fresh = parse_fresh(fresh)
    types = types if types is not None else N.types_by_name(env)
    flow = apply_inputs(flow, inputs or {})
    run = {
        "id": S.new_run_id(), "flow_id": flow["id"], "flow_name": flow.get("name", ""),
        "flow_revision": flow.get("revision"), "status": "queued", "started_at": G.now_iso(),
        "finished_at": None, "ms": None, "target_node": target_node, "fresh": fresh,
        "nodes": {}, "order": [], "issues": [], "error": None,
        "owner": {"pid": os.getpid(), "boot": boot_token(env)}, "heartbeat": time.time(),
    }
    node_ids = run_node_set(flow, target_node)
    wanted = set(node_ids)
    issues = [i for i in G.validate(flow, types)
              if i.get("level") == "error" and (i.get("node") is None or i.get("node") in wanted)]
    run["issues"] = issues
    if issues:
        run["status"] = "invalid"
        run["error"] = issues[0]["message"]
        run["finished_at"] = run["started_at"]
        run["ms"] = 0
        return run, flow, types
    try:
        order = G.topo_order(flow, node_ids)
    except G.CycleError as exc:
        run.update(status="invalid", error=f"cycle: {exc}", finished_at=run["started_at"], ms=0)
        return run, flow, types
    run["order"] = order
    run["nodes"] = {nid: {"status": "queued"} for nid in order}
    return run, flow, types


# ----------------------------------------------------------------- execution

class _Execution:
    def __init__(self, env, flow, types, handle: RunHandle):
        self.env, self.flow, self.types, self.handle = env, flow, types, handle
        self.run = handle.run
        self.values: dict = {}
        self.nodes = {n["id"]: n for n in flow["nodes"]}
        self.feeds = {}
        for e in flow.get("edges", []):
            key = (e["to"]["node"], e["to"]["port"])
            self.feeds.setdefault(key, []).append((e["from"]["node"], e["from"]["port"]))
        wanted = set(self.run["order"])
        self.parents = {nid: set() for nid in wanted}
        for (dst, _port), sources in self.feeds.items():
            for src, _sport in sources:
                if dst in wanted and src in wanted:
                    self.parents[dst].add(src)
        self.max_parallel = max(1, int(_config_number(env, "max_parallel", DEFAULT_MAX_PARALLEL)))
        self.timeout = _config_number(env, "node_timeout_s", DEFAULT_NODE_TIMEOUT_S)
        self.out_dir = S.outputs_dir(env, self.run["id"])
        # Files the user picked in the canvas for this flow; any other local file outside the uploads/outputs
        # folders is never inlined into a tool argument (catalog review).
        self.approved = P.flow_picks(env, self.run["flow_id"], flow)
        self._last_save = 0.0
        self.slots = None                      # asyncio.Semaphore(max_parallel), made inside the event loop
        # G11: For each loops. body/collects keep run order (topological); body nodes are run by run_loop.
        self.max_items = max(1, int(_config_number(env, "max_items", DEFAULT_MAX_ITEMS)))
        self.loops, self.body_of, self.collect_of, self.loop_inputs = {}, {}, {}, {}
        self.collected, self.loop_failed = {}, {}
        found, _issues = G.loops(flow, types)
        for fid, loop in found.items():
            if fid not in wanted:
                continue
            body = [n for n in self.run["order"] if n in loop["body"]]
            collects = [c for c in self.run["order"] if c in loop["collects"]]
            self.loops[fid] = {"body": body, "collects": collects}
            self.body_of.update({n: fid for n in body})
            self.collect_of.update({c: fid for c in collects})
        for fid, loop in self.loops.items():
            inside = set(loop["body"]) | {fid}
            self.loop_inputs[fid] = [(src, port) for nid in loop["body"] for src, port in self.in_edges(nid)
                                     if src not in inside]

    # -- bookkeeping
    def save(self, force=False):
        now = time.monotonic()
        if not force and now - self._last_save < SAVE_INTERVAL_S:
            return
        self._last_save = now
        with self.handle.lock:
            self.run["heartbeat"] = time.time()
        try:
            S.save_run(self.env, self.handle.snapshot())
        except Exception as exc:  # noqa: BLE001 - a failed save must not kill the run
            logger.warning("flowcanvas: saving run %s failed: %s", self.run["id"], exc)

    def set_node(self, nid: str, **fields):
        with self.handle.lock:
            state = self.run["nodes"].setdefault(nid, {})
            state.update(fields)
            payload = {"run_id": self.run["id"], "flow_id": self.run["flow_id"], "node_id": nid,
                       "status": state.get("status")}
            for key in ("ms", "error", "preview", "started_at", "branch", "skip", "reason", "items", "count", "note",
                        "progress"):
                if fields.get(key) is not None:
                    payload[key] = fields[key]
        _emit(self.env, "node.status", payload)
        self.save(force=fields.get("status") in TERMINAL_NODE and fields.get("status") != "skipped")

    def record_inputs(self, nid, inputs, spec, index=None):
        if self.nodes[nid].get("record_inputs") is not True:
            return
        from . import input_history as H
        try:
            if index is not None and index >= MAX_ITERATION_RECORDS:
                raise ValueError("iteration history limit exceeded")
            safe, size = H.snapshot(inputs, spec)
            if not hasattr(self, "_input_history_sizes"):
                self._input_history_sizes = {}
            used = self._input_history_sizes.get(nid, 0)
            if used + size > H.MAX_BYTES:
                raise ValueError("input history byte limit exceeded")
            self._input_history_sizes[nid] = used + size
            if index is None:
                stored = {name: record_value(self.env, value, self.run["id"], f"{nid}-input-{i}", "value")
                          for i, (name, value) in enumerate(safe.items())}
            else:
                item_name = f"item {index + 1}"
                item_value = record_value(self.env, safe, self.run["id"], f"{nid}-input-{index}", "value")
                with self.handle.lock:
                    # Merge only this item: another iteration may have committed while this one spilled.
                    stored = dict(self.run["nodes"].get(nid, {}).get("inputs") or {})
                    stored[item_name] = item_value
                    item_names = sorted(
                        (name for name in stored if name.startswith("item ") and name[5:].isdigit()
                         and int(name[5:]) > 0),
                        key=lambda name: int(name[5:]))
                    ordered = {name: stored[name] for name in stored if name not in item_names}
                    ordered.update({name: stored[name] for name in item_names})
                    stored = ordered
            incomplete = nid in getattr(self, "_input_history_incomplete", set())
            self.set_node(nid, inputs=stored, input_history={"status": "partial" if incomplete else "recorded", "scope": "wired inputs after conversion",
                                                           "redaction": "best effort; not a secret detector"})
        except (ValueError, UnicodeError, RecursionError, OSError):
            if not hasattr(self, "_input_history_incomplete"):
                self._input_history_incomplete = set()
            self._input_history_incomplete.add(nid)
            with self.handle.lock:
                existing = bool(self.run["nodes"].get(nid, {}).get("inputs"))
            self.set_node(nid, input_history={"status": "partial" if existing else "omitted",
                                              "reason": "Input history limit or encoding/storage error; execution continues."})

    def status_of(self, nid: str) -> str:
        return self.run["nodes"].get(nid, {}).get("status", "queued")

    # -- inputs
    # -- scopes: one For each item sees its own states/values for body nodes, the run's for everything else
    def state_of(self, nid: str, scope=None) -> dict:
        if scope is not None and nid in scope["states"]:
            return scope["states"][nid]
        return self.run["nodes"].get(nid, {})

    def value_of(self, nid: str, scope=None):
        if scope is not None and nid in scope["values"]:
            return scope["values"][nid]
        return self.values.get(nid)

    def resolve_inputs(self, nid: str, scope=None) -> dict:
        node = self.nodes[nid]
        in_ports, _ = G.node_ports(node, self.types)
        inputs = {}
        for port in in_ports or []:
            sources = self.feeds.get((nid, port["name"]))
            if not sources:
                continue
            # Single inputs keep the old last-wire behaviour in invalid hand-written flows. Multiple
            # inputs follow flow-edge order, never parallel completion order (G8).
            selected = sources if port.get("multiple") else sources[-1:]
            values = []
            for src in selected:
                value = load_value((self.value_of(src[0], scope) or {}).get(src[1]))
                if port.get("multiple") and isinstance(value, list):
                    values.extend(value)
                elif isinstance(value, list) and port.get("type") in ptypes.MEDIA_KINDS + ("file",):
                    # A list output feeding a single-media input contributes its first item (G8). Other single
                    # inputs (any, json, text) take the whole list, e.g. a Collect result (G11).
                    values.append(value[0] if value else None)
                else:
                    values.append(value)
            converted = []
            try:
                for value in values:
                    converted.append(None if value is None else ptypes.convert(value, port.get("type", "any")))
            except ptypes.ConversionError as exc:
                raise X.NodeError(f"input {port['name']!r}: {exc}") from None
            inputs[port["name"]] = converted if port.get("multiple") else converted[0]
        return inputs

    # -- one node
    async def run_node(self, nid: str):
        node = self.nodes[nid]
        if nid in self.loops:
            return await self.run_foreach(nid)
        spec = self.types.get(node.get("type"))
        started = time.monotonic()
        # type + model let GET /x/timings average real durations per node type and model (G9)
        self.set_node(nid, status="running", started_at=G.now_iso(), error=None, type=node.get("type"),
                      model=T.model_key(spec, node))
        try:
            if nid in self.collect_of:
                inputs = {"value": self.collected.get(nid, [])}
            elif node.get("type") == MERGE:
                inputs = {"value": self.merge_value(nid)}
            else:
                inputs = self.resolve_inputs(nid)
            self.record_inputs(nid, inputs, spec)
            key = None
            if node_cacheable(node, spec, self.run.get("fresh")):
                # hashing an upload can take seconds: keep it off this run's loop (review E-12)
                key = await asyncio.to_thread(cache_key, self.env, node, inputs, spec)
                hit = await asyncio.to_thread(cache_get, self.env, key, self.run["flow_id"], self.out_dir)
                if hit is not None:
                    self.values[nid] = hit
                    self.finish_node(nid, hit, started, "cached")
                    return
            nctx = X.NodeContext(run_id=self.run["id"], node_id=nid, out_dir=self.out_dir,
                                 flow_id=self.run["flow_id"], approved=self.approved,
                                 timeout_s=float((spec or {}).get("timeout_s") or self.timeout),
                                 log=lambda msg: self.set_node(nid, progress=msg))
            async with self.slots:
                outputs = await X.execute(self.env, node, spec, inputs, nctx)
            outputs = outputs if isinstance(outputs, dict) else {"value": outputs}
            self.values[nid] = outputs
            if key is not None:
                await asyncio.to_thread(cache_put, self.env, key, node, outputs, self.run["flow_id"])
            self.finish_node(nid, outputs, started, "done")
        except asyncio.CancelledError:
            self.set_node(nid, status="cancelled", ms=int((time.monotonic() - started) * 1000))
            raise
        except X.NodeError as exc:
            self.set_node(nid, status="error", error=str(exc), ms=int((time.monotonic() - started) * 1000))
        except Exception as exc:  # noqa: BLE001 - any bug in one node must not kill the run
            logger.exception("flowcanvas: node %s crashed", nid)
            self.set_node(nid, status="error", error=f"{type(exc).__name__}: {exc}",
                          ms=int((time.monotonic() - started) * 1000))

    def finish_node(self, nid, outputs, started, status):
        recorded = {port: record_value(self.env, v, self.run["id"], nid, port)
                    for port, v in outputs.items() if not port.startswith("_")}
        extra = outputs.get("_media")
        if extra:
            recorded["_media"] = [preview_of(m) for m in extra]
        branch = {"branch": outputs[X.BRANCH]} if outputs.get(X.BRANCH) else {}
        self.set_node(nid, status=status, ms=int((time.monotonic() - started) * 1000),
                      outputs=recorded, preview=node_preview(outputs), **branch)

    # -- control flow (G10)
    def edge_state(self, src: str, port: str, scope=None) -> str:
        """live (value ready), dead (untaken branch), failed (error/cancel upstream) or pending."""
        st = self.state_of(src, scope)
        status = st.get("status", "queued")
        if status in ("error", "cancelled"):
            return "failed"
        if status == "skipped":
            return "dead" if st.get("skip") == "branch" else "failed"
        if status in ("done", "cached"):
            taken = st.get("branch")
            return "dead" if taken and port != taken else "live"
        return "pending"

    def in_edges(self, nid: str) -> list:
        """(src, src_port) of every wire into `nid` from this run: ports in input order, wires in flow order."""
        in_ports, _ = G.node_ports(self.nodes[nid], self.types)
        out = []
        for port in in_ports or []:
            out += [s for s in self.feeds.get((nid, port["name"]), []) if s[0] in self.parents]
        return out

    def dead_reason(self, src: str, port: str, scope=None) -> str:
        st = self.state_of(src, scope)
        if st.get("status") == "skipped":
            return st.get("reason") or "an earlier branch was not taken"
        _, outs = G.node_ports(self.nodes[src], self.types)
        label = {p["name"]: p.get("label") or p["name"] for p in outs or []}
        title = self.nodes[src].get("title") or (self.types.get(self.nodes[src].get("type")) or {}).get("title") or src
        return f"{title} took “{label.get(st.get('branch'), st.get('branch'))}”, not “{label.get(port, port)}”"

    def merge_value(self, nid: str, scope=None):
        for src, port in self.in_edges(nid):
            if self.edge_state(src, port, scope) == "live":
                return load_value((self.value_of(src, scope) or {}).get(port))
        return None

    def loop_gate(self, fid: str, owned: bool):
        """Body nodes and Collects follow their For each: wait while it runs, share its failure or skip."""
        st = self.run["nodes"].get(fid, {})
        status = st.get("status", "queued")
        if status in ("done", "cached"):
            return ("owned", None) if owned else ("run", None)
        if status in ("error", "cancelled"):
            return "fail", [fid]
        if status == "skipped":
            if st.get("skip") == "branch":
                return "dead", st.get("reason") or "the For each was skipped"
            return "fail", [fid]
        return "wait", None

    def gate(self, nid: str, scope=None):
        """('run'|'wait'|'fail'|'dead'|'owned', detail) for a waiting node. Merge waits for every wire and runs on
        any live one; every other node needs all wires live and is skipped as soon as one is failed or dead.
        Without a scope, For each body nodes are 'owned' by their loop and Collects wait for it (G11)."""
        if scope is None and nid in self.body_of:
            return self.loop_gate(self.body_of[nid], owned=True)
        if scope is None and nid in self.collect_of:
            verdict, detail = self.loop_gate(self.collect_of[nid], owned=False)
            if verdict != "run":
                return verdict, detail
            failed = self.loop_failed.get(nid)
            return ("fail", failed) if failed else ("run", None)
        verdict, detail = self._gate_edges(nid, scope)
        if verdict == "run" and scope is None and nid in self.loops \
                and any(self.edge_state(s, p) == "pending" for s, p in self.loop_inputs[nid]):
            return "wait", None                # values the loop body takes from outside must be ready first
        return verdict, detail

    def _gate_edges(self, nid: str, scope=None):
        edges = self.in_edges(nid)
        states = [self.edge_state(s, p, scope) for s, p in edges]
        failed = sorted({s for (s, _p), st in zip(edges, states) if st == "failed"})
        dead = [e for e, st in zip(edges, states) if st == "dead"]
        if self.nodes[nid].get("type") == MERGE:
            if "pending" in states:
                return "wait", None
            if "live" in states or not edges:
                return "run", None
            if failed:
                return "fail", failed
            return "dead", self.dead_reason(*dead[0], scope)
        if failed:
            return "fail", failed
        if dead:
            return "dead", self.dead_reason(*dead[0], scope)
        return ("wait", None) if "pending" in states else ("run", None)

    # -- For each (G11)
    def item_limit(self, node: dict) -> tuple:
        raw = (node.get("params") or {}).get("limit")
        try:
            own = int(float(raw)) if raw not in (None, "") else 0
        except (TypeError, ValueError):
            own = 0
        return (min(own, self.max_items), True) if 0 < own < self.max_items else (self.max_items, False)

    async def run_foreach(self, fid: str):
        node = self.nodes[fid]
        started = time.monotonic()
        self.set_node(fid, status="running", started_at=G.now_iso(), error=None, type=node.get("type"), model="")
        try:
            inputs = self.resolve_inputs(fid)
            self.record_inputs(fid, inputs, self.types.get(node.get("type")))
            items = X.list_items(inputs.get("list"))
            limit, own = self.item_limit(node)
            note = None
            if len(items) > limit:
                why = "Limit" if own else f"plugin setting Max items per For each = {self.max_items}"
                note = f"Ran the first {limit} of {len(items)} items ({why})."
                items = items[:limit]
            self.set_node(fid, count=len(items), note=note)
            await self.run_loop(fid, items)
            self.finish_node(fid, {"item": items}, started, "done")
        except asyncio.CancelledError:
            self.set_node(fid, status="cancelled", ms=int((time.monotonic() - started) * 1000))
            raise
        except X.NodeError as exc:
            self.set_node(fid, status="error", error=str(exc), ms=int((time.monotonic() - started) * 1000))
        except Exception as exc:  # noqa: BLE001 - a loop bug must not kill the run
            logger.exception("flowcanvas: For each %s crashed", fid)
            self.set_node(fid, status="error", error=f"{type(exc).__name__}: {exc}",
                          ms=int((time.monotonic() - started) * 1000))

    async def run_item(self, nid: str, index: int, scope: dict) -> tuple:
        """One body node for one item -> (state, outputs or None). Cached per item through the inputs."""
        node = self.nodes[nid]
        spec = self.types.get(node.get("type"))
        started = time.monotonic()
        ms = lambda: int((time.monotonic() - started) * 1000)  # noqa: E731
        try:
            inputs = {"value": self.merge_value(nid, scope)} if node.get("type") == MERGE \
                else self.resolve_inputs(nid, scope)
            self.record_inputs(nid, inputs, spec, index)
            key = None
            if node_cacheable(node, spec, self.run.get("fresh")):
                key = await asyncio.to_thread(cache_key, self.env, node, inputs, spec)
                hit = await asyncio.to_thread(cache_get, self.env, key, self.run["flow_id"], self.out_dir)
                if hit is not None:
                    return {"status": "cached", "ms": ms(), **_branch(hit)}, hit
            nctx = X.NodeContext(run_id=self.run["id"], node_id=f"{nid}-{index + 1}", out_dir=self.out_dir,
                                 flow_id=self.run["flow_id"], approved=self.approved,
                                 timeout_s=float((spec or {}).get("timeout_s") or self.timeout),
                                 log=lambda msg: self.set_node(nid, progress=f"Item {index + 1}: {msg}"))
            async with self.slots:
                outputs = await X.execute(self.env, node, spec, inputs, nctx)
            outputs = outputs if isinstance(outputs, dict) else {"value": outputs}
            if key is not None:
                await asyncio.to_thread(cache_put, self.env, key, node, outputs, self.run["flow_id"])
            return {"status": "done", "ms": ms(), **_branch(outputs)}, outputs
        except asyncio.CancelledError:
            raise
        except X.NodeError as exc:
            return {"status": "error", "error": str(exc), "ms": ms()}, None
        except Exception as exc:  # noqa: BLE001
            logger.exception("flowcanvas: node %s item %s crashed", nid, index + 1)
            return {"status": "error", "error": f"{type(exc).__name__}: {exc}", "ms": ms()}, None

    async def run_loop(self, fid: str, items: list):
        """Run the For each body once per item. Items run in parallel; every tool/LLM call takes one of the
        run's max_parallel slots. Body nodes get aggregate states, Collects get the live item results."""
        loop = self.loops[fid]
        body, collects, n = loop["body"], loop["collects"], len(items)
        agg = {nid: {"total": n, "done": 0, "cached": 0, "skipped": 0, "error": 0} for nid in body}
        iters = {nid: [None] * n for nid in body}
        outs = {nid: {} for nid in body}
        work_ms = {nid: 0 for nid in body}
        firsts = {nid: {} for nid in body}
        results = {c: [None] * n for c in collects}
        live = {c: [False] * n for c in collects}
        sources = {c: (self.feeds.get((c, "value")) or [None])[-1] for c in collects}
        now = G.now_iso()
        for nid in body:
            spec = self.types.get(self.nodes[nid].get("type"))
            self.set_node(nid, status="running", started_at=now, error=None, type=self.nodes[nid].get("type"),
                          model=T.model_key(spec, self.nodes[nid]), items=dict(agg[nid]))

        def record(nid, i, state, outputs):
            key = state["status"] if state["status"] in ("done", "cached", "error") else "skipped"
            agg[nid][key] += 1
            # first error / failed skip / branch reason per node, kept for every item (iters stops at 500)
            seen = firsts[nid]
            if key == "error":
                seen.setdefault("error", (i, state.get("error", "")))
            elif key == "skipped" and state.get("skip") != "branch":
                seen.setdefault("failed", state.get("error"))
            elif key == "skipped":
                seen.setdefault("reason", state.get("reason"))
            work_ms[nid] += int(state.get("ms") or 0)
            if i < MAX_ITERATION_RECORDS:
                iters[nid][i] = {k: v for k, v in state.items() if k in ("status", "ms", "error", "branch", "skip", "reason")}
            for port, value in (outputs or {}).items():
                if not port.startswith("_"):
                    outs[nid].setdefault(port, [None] * n)[i] = record_value(self.env, value, self.run["id"],
                                                                              f"{nid}-{i + 1}", port)
            self.set_node(nid, items=dict(agg[nid]))

        async def one(i):
            scope = {"states": {fid: {"status": "done"}}, "values": {fid: {"item": items[i], "index": i + 1}}}
            for nid in body:
                if self.handle.cancel.is_set():
                    return
                verdict, detail = self.gate(nid, scope)
                outputs = None
                if verdict == "fail":
                    state = {"status": "skipped", "error": f"upstream failed: {', '.join(detail)}"}
                elif verdict == "dead":
                    state = {"status": "skipped", "skip": "branch", "reason": detail}
                elif verdict == "wait":         # cannot happen in topological order; never hang
                    state = {"status": "skipped", "error": "dependencies never finished"}
                else:
                    state, outputs = await self.run_item(nid, i, scope)
                scope["states"][nid] = state
                if outputs is not None:
                    scope["values"][nid] = outputs
                record(nid, i, state, outputs)
            for c in collects:
                src = sources[c]
                if src and self.edge_state(src[0], src[1], scope) == "live":
                    results[c][i] = load_value((self.value_of(src[0], scope) or {}).get(src[1]))
                    live[c][i] = True

        cancelled = False
        failed = False
        try:
            await asyncio.gather(*(one(i) for i in range(n)))
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception:
            failed = True
            raise
        finally:
            cancelled = cancelled or self.handle.cancel.is_set()
            self.finish_loop(fid, body, collects, n, agg, iters, outs, work_ms, results, live, cancelled, firsts, failed)

    def finish_loop(self, fid, body, collects, n, agg, iters, outs, work_ms, results, live, cancelled, firsts, failed=False):
        for nid in body:
            a = agg[nid]
            fields = {"items": dict(a), "iterations": [x for x in iters[nid][:MAX_ITERATION_RECORDS]],
                      "outputs": outs[nid], "ms": work_ms[nid]}
            finished = a["done"] + a["cached"] + a["skipped"] + a["error"]
            seen = firsts[nid]
            if a["error"]:
                bad, msg = seen["error"]
                more = f" ({a['error']} of {n} items failed)" if a["error"] > 1 else ""
                fields.update(status="error", error=f"item {bad + 1} of {n}: {msg}{more}")
            elif failed and finished < n:
                fields.update(status="skipped", error="loop failed before all items completed")
            elif cancelled and finished < n:
                fields.update(status="cancelled")
            elif not n:                       # nothing to repeat: not a success, not a failure
                fields.update(status="skipped", skip="branch", reason="The list was empty.")
            elif a["done"] + a["cached"] == 0:
                if "failed" in seen:
                    fields.update(status="skipped", error=seen["failed"])
                else:
                    fields.update(status="skipped", skip="branch", reason=seen.get("reason"))
            else:
                fields.update(status="done" if a["done"] else "cached")
            self.set_node(nid, **fields)
        anc = {c: G.ancestors(self.flow, c) for c in collects}
        for c in collects:
            self.collected[c] = [v for v, ok in zip(results[c], live[c]) if ok]
            failed = sorted(nid for nid in body if agg[nid]["error"] and nid in anc[c])
            if failed:
                self.loop_failed[c] = failed

    # -- scheduler
    async def execute(self):
        h = self.handle
        h.loop = asyncio.get_running_loop()
        with h.lock:
            self.run["status"] = "running"
        _emit(self.env, "run.started", {"run_id": self.run["id"], "flow_id": self.run["flow_id"],
                                         "nodes": list(self.run["order"])})
        self.save(force=True)
        t0 = time.monotonic()
        self.slots = asyncio.Semaphore(self.max_parallel)
        remaining = list(self.run["order"])
        running: dict = {}
        cancelled = False
        while remaining or running:
            if h.cancel.is_set():
                cancelled = True
                break
            for nid in list(remaining):
                verdict, detail = self.gate(nid)
                if verdict == "owned":            # body node: its For each already recorded every item
                    remaining.remove(nid)
                    continue
                if verdict == "fail":
                    remaining.remove(nid)
                    self.set_node(nid, status="skipped", error=f"upstream failed: {', '.join(detail)}")
                    continue
                if verdict == "dead":           # untaken If/Switch branch: not an error, the run stays done
                    remaining.remove(nid)
                    self.set_node(nid, status="skipped", skip="branch", reason=detail)
                    continue
                if len(running) >= self.max_parallel:
                    continue
                if verdict == "run":
                    remaining.remove(nid)
                    task = asyncio.create_task(self.run_node(nid), name=f"flowcanvas:{nid}")
                    running[nid] = task
                    h.tasks[nid] = task
            if not running:
                for nid in remaining:                 # unreachable in a valid DAG; never hang
                    self.set_node(nid, status="skipped", error="dependencies never finished")
                remaining.clear()
                break
            done, _ = await asyncio.wait(list(running.values()), timeout=0.25,
                                         return_when=asyncio.FIRST_COMPLETED)
            if time.monotonic() - self._last_save >= HEARTBEAT_S:
                self.save(force=True)           # heartbeat during long nodes (review E-7)
            for task in done:
                nid = next(k for k, v in running.items() if v is task)
                running.pop(nid)
                h.tasks.pop(nid, None)
        if cancelled:
            for task in running.values():
                task.cancel()
            await asyncio.gather(*running.values(), return_exceptions=True)
            for nid in remaining:
                if self.status_of(nid) not in TERMINAL_NODE:   # loop bodies keep their own cancel state
                    self.set_node(nid, status="skipped", error="run cancelled")
        statuses = [self.status_of(n) for n in self.run["order"]]
        if cancelled:
            final = "cancelled"
        elif "error" in statuses:
            final = "error"
            first = next(n for n in self.run["order"] if self.status_of(n) == "error")
            with h.lock:
                self.run["error"] = f"{self.nodes[first].get('title') or first}: " \
                                    f"{self.run['nodes'][first].get('error', '')}"[:500]
        else:
            final = "done"
        with h.lock:
            self.run.update(status=final, finished_at=G.now_iso(), ms=int((time.monotonic() - t0) * 1000))
        self.save(force=True)
        _emit(self.env, "run.finished", {"run_id": self.run["id"], "flow_id": self.run["flow_id"],
                                          "status": final, "ms": self.run["ms"]})


def _run_loop(coro, name: str):
    """``asyncio.run`` without its final wait for the default executor (review E-6): a tool thread that outlived
    its node timeout cannot be killed, and must not hold the run open until it finally returns. The run gets
    its own pool; on exit queued calls are cancelled and running ones are left to finish on their own."""
    loop = asyncio.new_event_loop()
    pool = ThreadPoolExecutor(thread_name_prefix=f"{name}-tool")
    loop.set_default_executor(pool)
    try:
        return loop.run_until_complete(coro)
    finally:
        try:
            leftovers = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for task in leftovers:
                task.cancel()
            if leftovers:
                loop.run_until_complete(asyncio.gather(*leftovers, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
            loop.close()


def _thread_main(env, flow, types, handle: RunHandle):
    try:
        _run_loop(_Execution(env, flow, types, handle).execute(), f"flowcanvas-run-{handle.run.get('id')}")
    except Exception as exc:  # noqa: BLE001 - last line of defence: record, never leave 'running'
        logger.exception("flowcanvas: run %s crashed", handle.run.get("id"))
        with handle.lock:
            handle.run.update(status="error", error=f"internal error: {exc}", finished_at=G.now_iso())
        try:
            S.save_run(env, handle.snapshot())
        except Exception:  # noqa: BLE001
            logger.exception("flowcanvas: could not save crashed run")
        _emit(env, "run.finished", {"run_id": handle.run.get("id"), "flow_id": handle.run.get("flow_id"),
                                    "status": "error", "ms": handle.run.get("ms")})
    finally:
        handle.done.set()
        _active(env).pop(handle.run.get("id"), None)


# ----------------------------------------------------------------- public API

def start_run(env, flow_id: str, target_node: str = None, fresh: bool = False, inputs: dict = None,
              flow: dict = None) -> RunHandle:
    """Validate and launch a run in the background. Invalid runs are saved and returned finished."""
    ensure_startup(env)
    flow = flow if flow is not None else S.get_flow(env, flow_id)
    run, effective, types = prepare(env, flow, target_node=target_node, fresh=fresh, inputs=inputs)
    handle = RunHandle(run=run)
    if run["status"] == "invalid":
        S.save_run(env, run)
        _emit(env, "run.finished", {"run_id": run["id"], "flow_id": run["flow_id"], "status": "invalid", "ms": 0})
        handle.done.set()
        return handle
    with S.lock(env, "runs:" + run["flow_id"]):
        _active(env)[run["id"]] = handle
    # Threads do not inherit ContextVars (review E-5): copy the caller's (Hermes session, platform, cron deny
    # mode) so every tool call of the run sees them; asyncio tasks and to_thread copy it on from there.
    snapshot = contextvars.copy_context()
    handle.thread = threading.Thread(target=snapshot.run, args=(_thread_main, env, effective, types, handle),
                                     name=f"flowcanvas-run-{run['id']}", daemon=True)
    handle.thread.start()
    return handle


def run_sync(env, flow_id: str, timeout_s: float = 600, **kwargs) -> dict:
    """Start a run and wait for it (agent tools). Returns the run record (maybe still running)."""
    handle = start_run(env, flow_id, **kwargs)
    handle.done.wait(timeout=max(0.0, float(timeout_s)))
    return handle.snapshot()


def cancel_run(env, run_id: str) -> bool:
    handle = _active(env).get(run_id)
    if handle is None:
        return False
    handle.cancel.set()
    loop = handle.loop
    if loop is not None and not loop.is_closed():
        def _cancel_tasks():
            for task in list(handle.tasks.values()):
                task.cancel()
        try:
            loop.call_soon_threadsafe(_cancel_tasks)
        except RuntimeError:
            pass
    return True


def get_run(env, run_id: str) -> dict:
    handle = _active(env).get(run_id)
    if handle is not None:
        return handle.snapshot()
    return S.load_run(env, run_id)


def active_runs(env, flow_id: str = None) -> list:
    return [h.snapshot() for h in list(_active(env).values())
            if flow_id is None or h.run.get("flow_id") == flow_id]


def wait(env, run_id: str, timeout_s: float) -> dict:
    handle = _active(env).get(run_id)
    if handle is not None:
        handle.done.wait(timeout=max(0.0, float(timeout_s)))
    return get_run(env, run_id)
