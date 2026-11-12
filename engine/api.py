"""REST routes under /api/plugins/arachne-flow/x/<path>.

Every handler returns JSON-safe dicts. Errors become HTTPException with a readable ``detail``:
404 not found, 409 revision conflict (``{"code": "conflict", "current_revision"}``), 400 bad input.
Files are only served from a run's own output folder, from media recorded in a run record, or as a
small image thumbnail of the path saved in a flow's File node (G3) — never from a path the client supplies.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import sys
import threading
import time
import io
import json
import logging
import os
import re

from fastapi import HTTPException

from . import executors as E
from . import generate as GEN
from . import graph as G
from . import layout as L
from . import media as M
from . import messaging as MSG
from . import nodes as N
from . import options as O
from . import picks as PK
from . import presets as P
from . import runner as R
from . import store as S
from . import timings as T
from . import types as ptypes
from .version import VERSION

logger = logging.getLogger("arachne-flow.api")

MAX_INLINE_BYTES = 8 * 1024 * 1024
# The lightbox's 3D viewer needs the whole .glb; generated models are often 10-30 MB (07.11.).
MAX_MODEL_INLINE_BYTES = 40 * 1024 * 1024
MAX_THUMB_PX = 2048   # the lightbox (G1) asks for 2048 px; PIL never upscales
FILE_NODE_THUMB_PX = 512   # File node previews (G3): thumbnails only, never the raw file
_FILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")


# ----------------------------------------------------------------- helpers

def _bad(message: str, **extra):
    raise HTTPException(400, {"message": message, **extra} if extra else message)


def _emit(env, event: str, payload: dict) -> None:
    try:
        env.emit(event, payload)
    except Exception as exc:  # noqa: BLE001 - UI delivery is best effort
        logger.debug("arachne-flow: %s not delivered: %s", event, exc)


def _emit_changed(env, flow: dict, origin: str, **extra) -> None:
    _emit(env, "flow.changed", {"flow_id": flow["id"], "revision": flow.get("revision"),
                                "origin": origin if origin in ("agent", "ui", "api") else "api", **extra})


def _origin(body: dict, query: dict) -> str:
    return str((body or {}).get("origin") or (query or {}).get("origin") or "ui")


def _int(value, default, lo=None, hi=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    if lo is not None:
        number = max(lo, number)
    if hi is not None:
        number = min(hi, number)
    return number


def _truthy(value) -> bool:
    return str(value).lower() in ("1", "true", "yes", "on")


def _check_flow_shape(flow) -> dict:
    if not isinstance(flow, dict):
        _bad("body.flow must be an object")
    if not isinstance(flow.get("nodes"), list) or not isinstance(flow.get("edges"), list):
        _bad("flow needs 'nodes' and 'edges' lists")
    return flow


def file_payload(path: str, thumb: int = 0) -> dict:
    """{name, mime, size, kind, path, data_url} for a local file; images can be thumbnailed."""
    if M.blocked_local_path(path):
        raise HTTPException(403, "UNC and device paths are not supported; choose a local file")
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "file not found")
    if M.secret_reason(path):
        raise HTTPException(403, M.secret_reason(path))
    size = os.path.getsize(path)
    mime = M.mime_for(path)
    kind = M.kind_for(path)
    out = {"name": os.path.basename(path), "mime": mime, "size": size, "kind": kind, "path": path,
           "data_url": None}
    if thumb and kind == "image" and not path.lower().endswith(".svg"):
        try:
            from PIL import Image
            with Image.open(path) as img:
                img.thumbnail((thumb, thumb))
                fmt = "PNG" if img.mode in ("RGBA", "LA", "P") else "JPEG"
                if fmt == "JPEG" and img.mode != "RGB":
                    img = img.convert("RGB")
                buf = io.BytesIO()
                img.save(buf, fmt, quality=85)
            out["data_url"] = f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode()
            out["thumb"] = True
            return out
        except Exception as exc:  # noqa: BLE001 - fall back to the raw file below
            logger.info("arachne-flow: thumbnail failed for %s: %s", path, exc)
    if size <= (MAX_MODEL_INLINE_BYTES if kind == "model3d" else MAX_INLINE_BYTES):
        with open(path, "rb") as fh:
            out["data_url"] = f"data:{mime};base64," + base64.b64encode(fh.read()).decode()
    return out


def _norm(path: str) -> str:
    M.require_local_path(path)
    return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(path))))


def _flow_paths(flow: dict) -> set:
    """Every file a node of the flow names in its settings (File node, media fields), normalized."""
    found = set()

    def walk(value, depth=0):
        if depth > 6:
            return
        if isinstance(value, str) and value.strip() and len(value) < 4096 and "\n" not in value:
            path = value.strip().strip('"')
            if not M.blocked_local_path(path):
                found.add(_norm(path))
        elif isinstance(value, list):
            for v in value:
                walk(v, depth + 1)
        elif isinstance(value, dict):
            for v in value.values():
                walk(v, depth + 1)

    for node in (flow or {}).get("nodes") or []:
        walk(node.get("params") or {})
    return found


def _servable(env, run: dict, path: str) -> bool:
    """Review E-2 (second layer): media are served only from the plugin data dir (outputs, uploads, cache) or
    when a node of the run's flow names that exact file — never an arbitrary path a value points at."""
    if not path or M.blocked_local_path(path):
        return False
    target = _norm(path)
    root = _norm(S.data_dir(env))
    if target == root or target.startswith(root.rstrip(os.sep) + os.sep):
        return True
    try:
        flow = S.get_flow(env, run.get("flow_id"))
    except Exception:  # noqa: BLE001 - deleted or unreadable flow: nothing extra is allowed
        return False
    return target in _flow_paths(flow)


def _run_media(run: dict, node_id: str, port: str, index: int):
    state = (run.get("nodes") or {}).get(node_id)
    if not isinstance(state, dict):
        raise HTTPException(404, f"node {node_id} not in run")
    outputs = state.get("outputs") or {}
    if port == "_media":
        candidates = [m for m in outputs.get("_media") or [] if ptypes.is_media(m)]
    else:
        value = outputs.get(port)
        if ptypes.is_media(value):
            candidates = [value]
        elif isinstance(value, list):
            candidates = [v for v in value if ptypes.is_media(v)]
        else:
            candidates = []
    if index >= len(candidates):
        raise HTTPException(404, "no media at that output")
    return candidates[index]


MAX_VALUE_BYTES = 16 * 1024 * 1024


def _read_large_value(env, run_id: str, meta: dict, read_cache=None) -> tuple[str, str]:
    if not isinstance(meta, dict):
        raise HTTPException(404, "file not found")
    path = meta.get("path")
    if not isinstance(path, str) or not path or M.blocked_local_path(path):
        raise HTTPException(404, "file not found")

    try:
        root = S.outputs_dir(env, run_id, create=False)
    except HTTPException:
        raise
    except (OSError, ValueError):
        raise HTTPException(404, "file not found")

    if isinstance(root, os.PathLike):
        root = os.fspath(root)
    if not isinstance(root, str) or not root:
        raise HTTPException(404, "file not found")

    outputs_parent = os.path.dirname(root)
    try:
        data = S.data_dir(env)
        if isinstance(data, os.PathLike):
            data = os.fspath(data)
        if not isinstance(data, str) or not data:
            raise HTTPException(404, "file not found")
        canonical_data = os.path.normcase(os.path.realpath(data))
        canonical_outputs = os.path.normcase(os.path.join(canonical_data, "outputs"))
        canonical_root = os.path.normcase(os.path.realpath(root))
        if (
            canonical_root != os.path.normcase(os.path.join(canonical_outputs, run_id))
            or os.path.dirname(canonical_root) != canonical_outputs
        ):
            raise HTTPException(403, "value exists but is not safe to serve")
    except HTTPException:
        raise
    except (OSError, ValueError):
            raise HTTPException(404, "file not found")

    def _is_reparse_or_link(p: str) -> bool:
        try:
            if os.path.islink(p):
                return True
            st = os.lstat(p)
            if getattr(st, "st_file_attributes", 0) & 0x400:
                return True
        except (OSError, ValueError):
            raise HTTPException(404, "file not found")
        return False

    for p in (root, outputs_parent, data):
        if _is_reparse_or_link(p):
            raise HTTPException(403, "value exists but is not safe to serve")

    try:
        real_path = os.path.realpath(path)
        canonical_path = os.path.normcase(real_path)
        inside = (
            os.path.commonpath([canonical_root, canonical_path]) == canonical_root
            and canonical_path != canonical_root
        )
    except (ValueError, OSError):
        inside = False

    if not inside:
        raise HTTPException(404, "file not found")

    try:
        if not os.path.isfile(real_path):
            raise HTTPException(404, "file not found")
        st = os.stat(real_path)
    except HTTPException:
        raise
    except (OSError, ValueError):
        raise HTTPException(404, "file not found")

    if st.st_size > MAX_VALUE_BYTES:
        raise HTTPException(413, "value file too large")

    cache_key = (run_id, canonical_path)
    st_ident = (
        st.st_dev,
        st.st_ino,
        st.st_size,
        getattr(st, "st_mtime_ns", getattr(st, "st_mtime", None)),
    )
    if read_cache is not None and cache_key in read_cache:
        cached_text, cached_ident = read_cache[cache_key]
        if st_ident != cached_ident:
            raise HTTPException(409, "conflict")
        text = cached_text
    else:
        try:
            with open(real_path, "rb") as fh:
                fst = os.fstat(fh.fileno())
                fst_ident = (
                    fst.st_dev,
                    fst.st_ino,
                    fst.st_size,
                    getattr(fst, "st_mtime_ns", getattr(fst, "st_mtime", None)),
                )
                if fst_ident != st_ident:
                    raise HTTPException(409, "conflict")
                if fst.st_size > MAX_VALUE_BYTES:
                    raise HTTPException(413, "value file too large")
                if fst.st_mode & 0o170000 != 0o100000:
                    raise HTTPException(404, "file not found")
                raw = fh.read(MAX_VALUE_BYTES + 1)
                if len(raw) > MAX_VALUE_BYTES:
                    raise HTTPException(413, "value file too large")
                after = os.fstat(fh.fileno())
                after_ident = (
                    after.st_dev,
                    after.st_ino,
                    after.st_size,
                    getattr(after, "st_mtime_ns", getattr(after, "st_mtime", None)),
                )
                if after_ident != fst_ident:
                    raise HTTPException(409, "value changed during read")
        except HTTPException:
            raise
        except (OSError, ValueError):
            raise HTTPException(404, "file not found")

        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(422, "value file is not valid UTF-8")

        if read_cache is not None:
            read_cache[cache_key] = (text, fst_ident)

    chars = meta.get("chars")
    if isinstance(chars, int) and not isinstance(chars, bool) and chars >= 0:
        if len(text) != chars:
            raise HTTPException(409, "stored value length mismatch; historical data may be corrupted")

    name = str(meta.get("file") or path)
    kind = "text" if os.path.splitext(name)[1].lower() == ".txt" else "json"

    if kind == "json":
        def _parse_constant(c):
            raise ValueError(f"invalid JSON constant: {c}")

        try:
            parsed = json.loads(text, parse_constant=_parse_constant)
        except (json.JSONDecodeError, ValueError, RecursionError):
            raise HTTPException(422, "value file is not valid JSON")

    return kind, text


_JSON_SHORT_ESC = tuple(chr(i) for i in (34, 92, 8, 9, 10, 12, 13))
_JSON_LONG_ESC = tuple(chr(i) for i in range(32) if i not in (8, 9, 10, 12, 13))


def _json_str_len(s) -> int:
    # Exact len(json.dumps(s, ensure_ascii=False)) for a str, without serializing.
    n = len(s) + 2
    for c in _JSON_SHORT_ESC:
        n += s.count(c)
    for c in _JSON_LONG_ESC:
        n += 5 * s.count(c)
    return n


def _canonical_marker_path(meta: dict) -> str:
    p = meta.get("path")
    if p is None:
        p = meta.get("file")
    if isinstance(p, str):
        try:
            return os.path.normcase(os.path.realpath(os.path.normpath(p)))
        except Exception:
            return os.path.normcase(os.path.normpath(p))
    try:
        return json.dumps(meta, sort_keys=True)
    except Exception:
        return str(id(meta))


def _resolve_run_value(node, depth, budget, dereferenced, active_markers, cache, env, run_id, read_cache=None):
    if read_cache is None:
        read_cache = {}
    if depth > 64:
        raise HTTPException(400, "recursion depth limit exceeded")

    if isinstance(node, dict) and isinstance(node.get("$large"), dict):
        meta = node["$large"]
        cpath = _canonical_marker_path(meta)
        if cpath in active_markers:
            raise HTTPException(409, "cyclic marker reference detected")

        if cpath not in dereferenced:
            if len(dereferenced) >= 256:
                raise HTTPException(400, "too many marker dereferences")
            dereferenced.add(cpath)

        m_kind, m_text = _read_large_value(env, run_id, meta, read_cache)
        cache_key = (cpath, m_kind)
        if cache_key in cache:
            cached_val, cached_size = cache[cache_key]
            budget[0] += cached_size
            if budget[0] > 16 * 1024 * 1024:
                raise HTTPException(413, "value exceeds size limit")
            return cached_val, True

        active_markers.add(cpath)
        try:
            if len(m_text) > 16 * 1024 * 1024:
                raise HTTPException(413, "value exceeds size limit")

            is_json = (m_kind == "json")

            if is_json:
                def _parse_constant(c):
                    raise ValueError(f"invalid JSON constant: {c}")

                try:
                    m_parsed = json.loads(m_text, parse_constant=_parse_constant)
                except (json.JSONDecodeError, ValueError, RecursionError):
                    raise HTTPException(422, "value file is not valid JSON")

                start_budget = budget[0]
                m_expanded, _ = _resolve_run_value(
                    m_parsed,
                    depth + 1,
                    budget,
                    dereferenced,
                    active_markers,
                    cache,
                    env,
                    run_id,
                    read_cache,
                )
                try:
                    m_serialized = json.dumps(m_expanded, ensure_ascii=False, allow_nan=False)
                except (ValueError, TypeError, RecursionError):
                    raise HTTPException(422, "value is not valid JSON")
                charged = budget[0] - start_budget
                val_size = max(charged, len(m_serialized))
                if val_size > charged:
                    budget[0] += val_size - charged
                if val_size > 16 * 1024 * 1024 or budget[0] > 16 * 1024 * 1024:
                    raise HTTPException(413, "value exceeds size limit")
                cache[cache_key] = (m_expanded, val_size)
                return m_expanded, True
            else:
                val_size = _json_str_len(m_text)
                budget[0] += val_size
                if budget[0] > 16 * 1024 * 1024:
                    raise HTTPException(413, "value exceeds size limit")
                cache[cache_key] = (m_text, val_size)
                return m_text, True
        finally:
            active_markers.remove(cpath)

    if isinstance(node, dict):
        budget[0] += 2
        if budget[0] > MAX_VALUE_BYTES:
            raise HTTPException(413, "value exceeds size limit")
        has_nested = False
        res = {}
        first = True
        for k, v in node.items():
            if not isinstance(k, str):
                raise HTTPException(422, "value is not valid JSON")
            budget[0] += _json_str_len(k) + 2
            if not first:
                budget[0] += 2
            first = False
            if budget[0] > 16 * 1024 * 1024:
                raise HTTPException(413, "value exceeds size limit")
            v_exp, v_nested = _resolve_run_value(
                v,
                depth + 1,
                budget,
                dereferenced,
                active_markers,
                cache,
                env,
                run_id,
                read_cache,
            )
            if v_nested:
                has_nested = True
            res[k] = v_exp
        return res, has_nested

    if isinstance(node, (list, tuple)):
        budget[0] += 2
        if budget[0] > MAX_VALUE_BYTES:
            raise HTTPException(413, "value exceeds size limit")
        has_nested = False
        res = []
        first = True
        for item in node:
            if not first:
                budget[0] += 2
            first = False
            if budget[0] > 16 * 1024 * 1024:
                raise HTTPException(413, "value exceeds size limit")
            item_exp, item_nested = _resolve_run_value(
                item,
                depth + 1,
                budget,
                dereferenced,
                active_markers,
                cache,
                env,
                run_id,
                read_cache,
            )
            if item_nested:
                has_nested = True
            res.append(item_exp)
        return res, has_nested

    if isinstance(node, str):
        budget[0] += _json_str_len(node)
        if budget[0] > 16 * 1024 * 1024:
            raise HTTPException(413, "value exceeds size limit")
        return node, False

    if isinstance(node, float):
        if node != node or node == float("inf") or node == float("-inf"):
            raise HTTPException(422, "value is not valid JSON")
        budget[0] += len(float.__repr__(node))
        if budget[0] > 16 * 1024 * 1024:
            raise HTTPException(413, "value exceeds size limit")
        return node, False

    if node is None or isinstance(node, (bool, int)):
        if node is None:
            budget[0] += 4
        elif isinstance(node, bool):
            budget[0] += 4 if node else 5
        else:
            budget[0] += len(int.__repr__(node))
        if budget[0] > 16 * 1024 * 1024:
            raise HTTPException(413, "value exceeds size limit")
        return node, False

    try:
        json.dumps(node, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(422, "value is not valid JSON")
    budget[0] += len(str(node)) + 1
    if budget[0] > 16 * 1024 * 1024:
        raise HTTPException(413, "value exceeds size limit")
    return node, False


def _expand_run_value(env, run_id: str, value, read_cache=None, info=None) -> tuple:
    budget = [0]
    dereferenced = set()
    active_markers = set()
    cache = {}
    if read_cache is None:
        read_cache = {}
    if info is None:
        info = {}
    info["expanded"] = False

    if isinstance(value, dict) and isinstance(value.get("$large"), dict):
        meta = value["$large"]
        cpath = _canonical_marker_path(meta)
        active_markers.add(cpath)
        dereferenced.add(cpath)
        try:
            kind, text = _read_large_value(env, run_id, meta, read_cache)
            if len(text) > 16 * 1024 * 1024:
                raise HTTPException(413, "value exceeds size limit")

            if kind == "text":
                return "text", text

            if kind == "json":
                def _parse_constant(c):
                    raise ValueError(f"invalid JSON constant: {c}")

                try:
                    parsed = json.loads(text, parse_constant=_parse_constant)
                except (json.JSONDecodeError, ValueError, RecursionError):
                    raise HTTPException(422, "value file is not valid JSON")

                expanded, has_nested = _resolve_run_value(
                    parsed,
                    1,
                    budget,
                    dereferenced,
                    active_markers,
                    cache,
                    env,
                    run_id,
                    read_cache,
                )
                info["expanded"] = has_nested
                if not has_nested:
                    return "json", text

                try:
                    source = json.dumps(expanded, ensure_ascii=False, allow_nan=False)
                except (ValueError, TypeError, RecursionError):
                    raise HTTPException(422, "value is not valid JSON")
                if len(source) > 16 * 1024 * 1024:
                    raise HTTPException(413, "value exceeds size limit")
                return "json", source

            return kind, text
        finally:
            active_markers.remove(cpath)

    if isinstance(value, str):
        if len(value) > 16 * 1024 * 1024:
            raise HTTPException(413, "value exceeds size limit")
        return "text", value

    expanded, has_nested = _resolve_run_value(
        value,
        0,
        budget,
        dereferenced,
        active_markers,
        cache,
        env,
        run_id,
        read_cache,
    )
    info["expanded"] = has_nested
    try:
        source = json.dumps(expanded, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise HTTPException(422, "value is not valid JSON")
    if len(source) > 16 * 1024 * 1024:
        raise HTTPException(413, "value exceeds size limit")
    return "json", source


# In-memory only, scoped to Env/data-root. Cached content is never trusted as path
# authorization: every page revalidates every dependency through the same reader.
_VALUE_PAGE_CACHE_BYTES = 64 * 1024 * 1024
_VALUE_PAGE_CACHE_ENTRIES = 4
_VALUE_PAGE_CACHE_TTL = 30.0


def _value_memory_size(value, seen=None):
    if seen is None:
        seen = set()
    ident = id(value)
    if ident in seen:
        return 0
    seen.add(ident)
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(_value_memory_size(k, seen) + _value_memory_size(v, seen) for k, v in value.items())
    elif isinstance(value, (list, tuple)):
        size += sum(_value_memory_size(v, seen) for v in value)
    return size


def _value_snapshot(env, run_id, node_id, port, value, restart=False, field="outputs"):
    lock = env.state.setdefault("value_page_cache_lock", threading.RLock())
    with lock:
        cache = env.state.setdefault("value_page_cache", {})
        now = time.monotonic()
        for key in list(cache):
            if now - cache[key]["touched"] >= _VALUE_PAGE_CACHE_TTL:
                del cache[key]
        key = (os.path.normcase(os.path.realpath(S.data_dir(env))), run_id, node_id, field, port)
        entry = cache.get(key)
        if entry is not None and entry["value"] == value:
            try:
                for (_rid, path) in entry["reads"]:
                    # .txt avoids reparsing already validated JSON. The original run
                    # value (including marker chars/type) must still match above.
                    _read_large_value(env, run_id, {"path": path, "file": "validated.txt"}, entry["reads"])
            except HTTPException:
                del cache[key]
                if not restart:
                    raise
            else:
                entry["touched"] = now
                cache.pop(key)
                cache[key] = entry
                return entry["snapshot"]
        else:
            cache.pop(key, None)
        reads, info = {}, {}
        kind, source = _expand_run_value(env, run_id, value, reads, info)
        hasher = hashlib.sha256()
        for part in (run_id, node_id, field, port, kind, source):
            try:
                data = part.encode("utf-8")
            except UnicodeEncodeError:
                raise HTTPException(422, "value is not valid UTF-8")
            hasher.update(f"str:{len(data)}:".encode("ascii"))
            hasher.update(data)
        snapshot = (kind, source, hasher.hexdigest(), bool(info.get("expanded")))
        stored_value = copy.deepcopy(value)
        weight = _value_memory_size((stored_value, reads, snapshot))
        if weight <= _VALUE_PAGE_CACHE_BYTES:
            while cache and (len(cache) >= _VALUE_PAGE_CACHE_ENTRIES or
                             sum(e["weight"] for e in cache.values()) + weight > _VALUE_PAGE_CACHE_BYTES):
                del cache[next(iter(cache))]
            cache[key] = {"value": stored_value, "reads": reads, "snapshot": snapshot,
                          "weight": weight, "touched": now}
        return snapshot


def _run_value(env, run_id: str, query: dict) -> dict:
    node_id = str(query.get("node") or "")
    port = str(query.get("port") or "")
    if not node_id:
        raise HTTPException(404, "node is required")
    if not port:
        raise HTTPException(404, "port is required")
    raw_consistent = query.get("consistent")
    if raw_consistent is None:
        consistent = False
    elif (isinstance(raw_consistent, str) and raw_consistent == "1") or (
        isinstance(raw_consistent, int) and not isinstance(raw_consistent, bool) and raw_consistent == 1
    ):
        consistent = True
    else:
        _bad("consistent must be 1")
    expected_version = None
    if consistent:
        raw_version = query.get("version")
        if raw_version is not None:
            if not isinstance(raw_version, str) or not re.fullmatch(r"[0-9a-f]{64}", raw_version):
                _bad("version must be 64 lowercase hex characters")
            expected_version = raw_version
    field = query.get("field", "outputs")
    if field not in ("outputs", "inputs"):
        _bad("field must be outputs or inputs")
    run = R.get_run(env, run_id)
    nodes = run.get("nodes")
    if not isinstance(nodes, dict) or node_id not in nodes:
        raise HTTPException(404, "node not found in run")
    node_state = nodes[node_id]
    if not isinstance(node_state, dict):
        raise HTTPException(404, "node not found in run")
    outputs = node_state.get(field)
    if not isinstance(outputs, dict) or port not in outputs:
        raise HTTPException(404, f"port not found in node {field}")
    value = outputs[port]
    raw_offset = query.get("offset")
    if raw_offset is None:
        offset = 0
    elif isinstance(raw_offset, int) and not isinstance(raw_offset, bool) and 0 <= raw_offset <= MAX_VALUE_BYTES:
        offset = raw_offset
    elif isinstance(raw_offset, str) and len(raw_offset) <= 10 and re.fullmatch(r"[0-9]+", raw_offset):
        offset = int(raw_offset)
        if offset > MAX_VALUE_BYTES:
            _bad("offset exceeds value length")
    else:
        _bad("offset must be a non-negative integer")

    version = None
    expanded = False
    if consistent:
        if offset != 0 and expected_version is None:
            _bad("version is required when offset is non-zero")
        kind, source, version, expanded = _value_snapshot(
            env, run_id, node_id, port, value, restart=(offset == 0 and expected_version is None), field=field)
        if expected_version is not None and expected_version != version:
            raise HTTPException(409, "value changed; restart pagination")
    else:
        kind, source = _expand_run_value(env, run_id, value)
        try:
            source.encode("utf-8")
        except UnicodeEncodeError:
            raise HTTPException(422, "value is not valid UTF-8")

    total_chars = len(source)
    if offset > total_chars:
        _bad("offset exceeds value length")

    limit = _int(query.get("limit"), 4000, 1, 65536)
    chunk = source[offset:offset + limit]
    next_offset = (offset + len(chunk)) if (offset + len(chunk) < total_chars) else None
    result = {
        "kind": kind,
        "chunk": chunk,
        "offset": offset,
        "next_offset": next_offset,
        "total_chars": total_chars,
    }
    if consistent:
        result["version"] = version
        result["expanded"] = expanded
    return result


# ----------------------------------------------------------------- routes

def _flows_collection(env, method, query, body):
    if method == "GET":
        return {"flows": S.list_flows(env)}
    if method == "POST":
        flow = S.create_flow(env, name=body.get("name") or None, template=body.get("template") or None,
                             description=body.get("description"))
        _emit_changed(env, flow, _origin(body, query), created=True)
        return {"flow": flow}
    raise HTTPException(405, "method not allowed")


def _flow_item(env, method, flow_id, query, body):
    if method == "GET":
        return {"flow": S.get_flow(env, flow_id)}
    if method == "PUT":
        flow = _check_flow_shape(body.get("flow"))
        if flow.get("id") not in (None, flow_id):
            _bad("flow id does not match the URL")
        saved = S.save_flow(env, dict(flow, id=flow_id), base_revision=body.get("base_revision"))
        _emit_changed(env, saved, _origin(body, query))
        return {"flow": saved}
    if method == "DELETE":
        trash = S.delete_flow(env, flow_id)
        _emit(env, "flow.changed", {"flow_id": flow_id, "revision": None,
                                    "origin": _origin(body, query), "deleted": True})
        return {"ok": True, "trash": trash}
    raise HTTPException(405, "method not allowed")


def _file_node_preview(env, flow_id, query) -> dict:
    """GET /x/flows/<id>/file?node=<id>&thumb=<px>: what the saved File node points at (G3).

    The path comes from the stored flow, not from the request. Images get a thumbnail; other files only name,
    kind and size. ``path_param`` echoes the stored value so the UI can ignore answers for an unsaved edit.
    """
    flow = S.get_flow(env, flow_id)
    node_id = str(query.get("node") or "")
    node = next((n for n in flow.get("nodes", []) if n.get("id") == node_id), None)
    if node is None:
        raise HTTPException(404, f"node {node_id} not in flow")
    if node.get("type") != "input.file":
        _bad("only File nodes have a file preview")
    raw = (node.get("params") or {}).get("path")
    raw = raw if isinstance(raw, str) else ""
    path = raw.strip().strip('"')
    out = {"path_param": raw, "path": path, "name": os.path.basename(path), "exists": False, "kind": None,
           "size": None, "data_url": None}
    if not path or M.blocked_local_path(path) or M.secret_reason(path):
        return out
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        return out
    out.update(path=path, exists=True, kind=M.kind_for(path), size=os.path.getsize(path))
    thumb = _int(query.get("thumb"), 0, 0, FILE_NODE_THUMB_PX)
    if thumb and out["kind"] == "image" and not path.lower().endswith(".svg"):
        preview = file_payload(path, thumb=thumb)
        if preview.get("thumb"):
            out["data_url"] = preview["data_url"]
    return out


def _templates_changed(env, template_id: str, origin: str, **extra) -> None:
    _emit(env, "templates.changed", {"template_id": template_id,
                                     "origin": origin if origin in ("agent", "ui", "api") else "api", **extra})


def _templates(env, method, template_id, query, body) -> dict:
    """GET templates (bundled + yours); POST templates {flow_id, name?, description?, clear_inputs?, replace?};
    PUT templates/<id> {name?, description?}; DELETE templates/<id>. Only your own (u-…) can change (G5)."""
    if template_id is None:
        if method == "GET":
            templates = S.list_templates(env, known_types=set(N.types_by_name(env)))
            for t in templates:   # name the real tool behind a missing preset
                t["missing_tools"] = [P.PRESET_TOOLS.get(m, m) for m in t["missing_tools"]]
            return {"templates": templates}
        if method == "POST":
            flow_id = body.get("flow_id")
            if not isinstance(flow_id, str) or not flow_id:
                _bad("flow_id is required")
            for key in ("name", "description", "replace"):
                if body.get(key) is not None and not isinstance(body.get(key), str):
                    _bad(f"{key} must be a string")
            template = S.save_template(env, S.get_flow(env, flow_id), name=body.get("name"),
                                       description=body.get("description"),
                                       clear_inputs=_truthy(body.get("clear_inputs")),
                                       replace=body.get("replace") or None)
            _templates_changed(env, template["id"], _origin(body, query), created=not body.get("replace"))
            return {"template": template}
        raise HTTPException(405, "method not allowed")
    if method == "PUT":
        for key in ("name", "description"):
            if body.get(key) is not None and not isinstance(body.get(key), str):
                _bad(f"{key} must be a string")
        template = S.update_template(env, template_id, name=body.get("name"), description=body.get("description"))
        _templates_changed(env, template["id"], _origin(body, query))
        return {"template": template}
    if method == "DELETE":
        trash = S.delete_template(env, template_id)
        _templates_changed(env, template_id, _origin(body, query), deleted=True)
        return {"deleted": template_id, "trash": trash}
    raise HTTPException(405, "method not allowed")


def _upload(env, body) -> dict:
    """POST /x/uploads -> {path, name, kind, size, deduped} (files dropped on the canvas, G3).

    Two bodies reach this: ``{name, data_url}`` (JSON, base64 — the route's original shape, still supported) and
    ``{name, data}`` with the raw bytes, which dashboard/plugin_api.py builds from a multipart body (review U-10).
    """
    try:
        if isinstance(body.get("data"), (bytes, bytearray, memoryview)):
            return M.save_upload_bytes(body["data"], body.get("name"), S.uploads_dir(env), max_bytes=M.MAX_UPLOAD_BYTES)
        return M.save_upload(body.get("name"), body.get("data_url"), S.uploads_dir(env), max_bytes=M.MAX_UPLOAD_BYTES)
    except M.MediaError as exc:
        raise HTTPException(413 if exc.code == "too_large" else 400,
                            {"code": exc.code, "message": str(exc), "max_bytes": M.MAX_UPLOAD_BYTES}) from None


def _flow_action(env, method, flow_id, action, query, body):
    if action == "file" and method == "GET":
        return _file_node_preview(env, flow_id, query)
    if action == "triggers" and method == "GET":
        from . import triggers as TR
        return TR.status(env, S.get_flow(env, flow_id), env.state.get("trigger_scheduler"))
    if method != "POST":
        raise HTTPException(405, "method not allowed")
    if action == "duplicate":
        flow = S.duplicate_flow(env, flow_id, name=body.get("name") or None)
        _emit_changed(env, flow, _origin(body, query), created=True)
        return {"flow": flow}
    if action == "restore":
        flow = S.restore_flow(env, flow_id)
        _emit_changed(env, flow, _origin(body, query), created=True)
        return {"flow": flow}
    if action == "ops":
        ops = body.get("ops")
        if not isinstance(ops, list):
            _bad("body.ops must be a list")
        types = N.types_by_name(env)
        results: list = []

        def mutate(flow):
            new_flow, op_results = G.apply_ops(flow, ops, types)
            results.extend(op_results)
            return new_flow
        flow = S.modify_flow(env, flow_id, mutate, base_revision=body.get("base_revision"))
        _emit_changed(env, flow, _origin(body, query))
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        return {"flow": flow, "results": results, "refs": refs}
    if action == "file-pick":
        # The canvas calls this right after the user chose a file in the native dialog (Browse…). It mints the
        # pick the run checks (picks.py); the canvas stores it in the node's picked_files with its next save.
        S.get_flow(env, flow_id)
        node_id, path = body.get("node_id"), body.get("path")
        try:
            token = PK.mint(env, flow_id, node_id, path, folder=body.get("folder") is True)
        except (ValueError, M.MediaError) as exc:
            _bad(str(exc))
        return {"node_id": node_id, "path": path.strip(), "token": token}
    if action == "messaging-optin":
        node_id = body.get("node_id")
        enable = body.get("enable") is True

        def mutate(flow):
            node = next((n for n in flow.get("nodes") or [] if isinstance(n, dict) and n.get("id") == node_id), None)
            if node is None or node.get("type") != MSG.NODE_TYPE:
                raise ValueError("node_id must name a Send message node in this flow")
            params = node.setdefault("params", {})
            target = params.get("target")
            target = target.strip() if isinstance(target, str) else ""
            if enable:
                if not target:
                    raise ValueError("choose a recipient before enabling sending")
                params["send_enabled"] = True
                params["authorized_target"] = target
                params["allow_attachments"] = body.get("allow_attachments") is True
                params["optin_token"] = MSG.optin_token(env, flow_id, node_id, target, params["allow_attachments"])
            else:
                params["send_enabled"] = False
                params.pop("authorized_target", None)
                params.pop("optin_token", None)
                params.pop("allow_attachments", None)
            return None
        flow = S.modify_flow(env, flow_id, mutate, base_revision=body.get("base_revision"), allow_optin=True)
        _emit_changed(env, flow, _origin(body, query))
        node = next((n for n in flow["nodes"] if n.get("id") == node_id), None)
        return {"flow": flow, "node": node}
    if action == "trigger":
        # Switch one trigger node on/off. A webhook gets its random URL part on first activation.
        from . import triggers as TR
        node_id = body.get("node_id")
        enable = body.get("active") is True

        def mutate(flow):
            node = next((n for n in flow.get("nodes") or [] if isinstance(n, dict) and n.get("id") == node_id), None)
            if node is None or not TR.is_trigger(node):
                raise ValueError("node_id must name a trigger node in this flow")
            params = node.setdefault("params", {})
            if enable:
                problems = [m for level, m in TR.validate_issues(node) if level == "error"]
                if problems:
                    raise ValueError(problems[0])
                if node.get("type") == TR.WEBHOOK and not params.get("hook_id"):
                    params["hook_id"] = TR.new_hook_id()
            if body.get("rotate") is True and node.get("type") == TR.WEBHOOK:
                params["hook_id"] = TR.new_hook_id()
            params["active"] = enable
            return None
        flow = S.modify_flow(env, flow_id, mutate, base_revision=body.get("base_revision"))
        _emit_changed(env, flow, _origin(body, query))
        sched = env.state.get("trigger_scheduler")
        if sched is not None and getattr(sched, "leader", None) and sched.leader.handle is not None:
            try:
                sched.tick(env)         # this process fires: apply at once (webhook listener, first RSS poll)
            except Exception as exc:  # noqa: BLE001 - status shows the error
                logger.info("arachne-flow: trigger tick after switch failed: %s", exc)
        return {"flow": flow, "status": TR.status(env, flow, sched)}
    if action == "layout":
        types = N.types_by_name(env)
        flow = S.modify_flow(env, flow_id, lambda f: L.auto_layout(f, types), base_revision=body.get("base_revision"))
        _emit_changed(env, flow, _origin(body, query))
        return {"flow": flow}
    raise HTTPException(404, f"no action {action!r}")


def _runs(env, method, query, body):
    if method == "GET":
        limit = _int(query.get("limit"), 20, 1, 200)
        flow_id = query.get("flow_id") or None
        active = {r["id"]: r for r in R.active_runs(env, flow_id)}
        runs = [S.summarize_run(active[r["id"]]) if r["id"] in active else r
                for r in S.list_runs(env, flow_id, limit=limit)]
        return {"runs": runs, "active": sorted(active)}
    if method == "POST":
        flow_id = body.get("flow_id")
        if not isinstance(flow_id, str) or not flow_id:
            _bad("body.flow_id is required")
        inputs = body.get("inputs")
        if inputs is not None and not isinstance(inputs, dict):
            _bad("body.inputs must be an object")
        handle = R.start_run(env, flow_id, target_node=body.get("target_node") or None,
                             fresh=R.parse_fresh(body.get("fresh", False)), inputs=inputs or None)
        run = handle.snapshot()
        return {"run_id": run["id"], "status": run["status"], "issues": run.get("issues", [])}
    raise HTTPException(405, "method not allowed")


def _run_item(env, method, run_id, rest, query, body):
    if not rest:
        if method != "GET":
            raise HTTPException(405, "method not allowed")
        return {"run": R.get_run(env, run_id)}
    if rest == ["cancel"] and method == "POST":
        return {"ok": R.cancel_run(env, run_id)}
    if rest == ["media"] and method == "GET":
        run = R.get_run(env, run_id)
        value = _run_media(run, str(query.get("node") or ""), str(query.get("port") or "media"),
                           _int(query.get("index"), 0, 0, 100))
        path = M.media_path(value)
        if not _servable(env, run, path):
            raise HTTPException(403, "this file is outside Arachne Flow's data and not picked in the flow")
        return file_payload(path, thumb=_int(query.get("thumb"), 0, 0, MAX_THUMB_PX))
    if rest == ["value"]:
        if method != "GET":
            raise HTTPException(405, "method not allowed")
        return _run_value(env, run_id, query)
    raise HTTPException(404, "no such run route")


def _files(env, method, run_id, name, query):
    if method != "GET":
        raise HTTPException(405, "method not allowed")
    if not _FILE_NAME.match(name or ""):
        _bad("invalid file name")
    folder = S.outputs_dir(env, run_id, create=False)
    path = os.path.join(folder, name)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(folder):
        _bad("invalid file name")
    return file_payload(path, thumb=_int(query.get("thumb"), 0, 0, MAX_THUMB_PX))


def _validate(env, body):
    flow = body.get("flow")
    if flow is None and isinstance(body.get("flow_id"), str):
        flow = S.get_flow(env, body["flow_id"])
    _check_flow_shape(flow)
    return {"issues": G.validate(flow, N.types_by_name(env))}


async def _options(env, query):
    """GET /x/options?type=<node type>&param=<name>[&model=<id>][&refresh=1].

    - model param (has ``options_source``): the model list; with ``model=`` the settings that model allows
      (``{model, found, label, fields, cost, price}``, G7) for the node's ``from_model`` params.
    - a ``from_model`` param (size, n, duration, resolution, aspect_ratio, quality): that model's choices
      ``{options, field, model, found, cost}``; ``model`` blank -> the model param's default (presets ship one).
    """
    type_name, param_name = str(query.get("type") or ""), str(query.get("param") or "")
    spec = N.get_type(env, type_name)
    if spec is None:
        raise HTTPException(404, f"unknown node type {type_name!r}")
    params = {p.get("name"): p for p in spec.get("params", [])}
    param = params.get(param_name)
    model_param = params.get(param.get("from_model")) if param and param.get("from_model") else param
    if not param or not model_param or not model_param.get("options_source"):
        raise HTTPException(404, f"{type_name}.{param_name} has no option list")
    refresh = _truthy(query.get("refresh"))
    model = str(query.get("model") or "").strip()[:300]
    try:
        if param is model_param and not model:
            return await O.fetch_options(env, param["options_source"], accepts=param.get("options_accepts"),
                                         refresh=refresh)
        model = model or str(model_param.get("default") or "")
        wanted = [n for n in params if n != model_param["name"]]  # any setting the model describes gets its choices
        claimed = O.claimed_args(spec) if spec.get("open_params") else None
        if not model:
            info = {"model": "", "found": False, "fields": {}, "params": [], "cost": None, "price": None,
                    "source": model_param["options_source"], "cached": False}
        else:
            info = await O.fetch_model_info(env, model_param["options_source"], model, wanted, refresh=refresh,
                                            claimed=claimed)
    except E.NodeError as exc:
        raise HTTPException(502, f"could not load options: {exc}") from None
    if param is model_param:
        return info
    field = info["fields"].get(param_name) or {}
    return {"options": field.get("options") or [], "field": field, "model": info["model"], "found": info["found"],
            "cost": info["cost"], "source": info["source"], "cached": info["cached"]}


async def _llm_info(env, query):
    """GET /x/llm-info?provider=&model=[&api_url=&name=] — what the provider's own model list says about the
    model of an LLM node (context, output limit, reasoning levels, token price). Hermes' picker data comes
    separately from the renderer; found=False is normal for providers without a list tool."""
    model = str(query.get("model") or "").strip()[:300]
    if not model:
        raise HTTPException(400, "model is required")
    return await O.llm_model_info(env, str(query.get("provider") or ""), model,
                                  api_url=str(query.get("api_url") or "")[:500],
                                  provider_name=str(query.get("name") or "")[:120],
                                  refresh=_truthy(query.get("refresh")))


async def handle(method: str, path: str, query: dict, body: dict, env) -> dict:
    method = (method or "GET").upper()
    query = query or {}
    body = body if isinstance(body, dict) else {}
    parts = [p for p in (path or "").strip("/").split("/") if p]
    try:
        R.ensure_startup(env)
        if parts == ["ping"] and method == "GET":
            return {"ok": True, "engine": VERSION, "bound": env.ctx is not None}
        if parts == ["flows"]:
            if method != "GET":
                return await asyncio.to_thread(_flows_collection, env, method, query, body)
            return _flows_collection(env, method, query, body)
        if parts == ["trash"] and method == "GET":
            return {"trash": S.list_trash(env)}
        if len(parts) == 2 and parts[0] == "flows":
            if method != "GET":
                return await asyncio.to_thread(_flow_item, env, method, parts[1], query, body)
            return _flow_item(env, method, parts[1], query, body)
        if len(parts) == 3 and parts[0] == "flows":
            # File-lock contention must not freeze the API loop or delay cancellation.
            return await asyncio.to_thread(_flow_action, env, method, parts[1], parts[2], query, body)
        if parts == ["validate"] and method == "POST":
            return _validate(env, body)
        if parts == ["uploads"] and method == "POST":
            return _upload(env, body)
        if parts == ["templates"]:
            return _templates(env, method, None, query, body)
        if len(parts) == 2 and parts[0] == "templates":
            return _templates(env, method, parts[1], query, body)
        if parts == ["llm-info"] and method == "GET":
            return await _llm_info(env, query)
        if parts == ["node-types"] and method == "GET":
            if _truthy(query.get("fresh")):
                N.invalidate(env)
            return N.node_types_payload(env)
        if parts == ["generate"] and method == "POST":
            result = await GEN.generate(env, body)
            _emit_changed(env, result["flow"], _origin(body, query))
            return result
        if parts == ["generate", "jobs"] and method == "POST":
            # Background build: answers at once; the UI polls GET generate/jobs/<id> (no long-held request).
            origin = _origin(body, query)
            return GEN.start_job(env, body, on_done=lambda result: _emit_changed(env, result["flow"], origin))
        if len(parts) == 3 and parts[:2] == ["generate", "jobs"]:
            if method == "GET":
                return await asyncio.to_thread(GEN.get_job, env, parts[2], query.get("wait") or 0)
            if method == "DELETE":
                return await asyncio.to_thread(GEN.cancel_job, env, parts[2])
        if parts == ["options"] and method == "GET":
            return await _options(env, query)
        if parts == ["runs"]:
            return _runs(env, method, query, body)
        if parts == ["timings"] and method == "GET":
            return T.stats(env)
        if len(parts) >= 2 and parts[0] == "runs":
            return _run_item(env, method, parts[1], parts[2:], query, body)
        if len(parts) == 3 and parts[0] == "files":
            return _files(env, method, parts[1], parts[2], query)
    except HTTPException:
        raise
    except S.ConflictError as exc:
        raise HTTPException(409, {"code": "conflict", "message": str(exc),
                                  "current_revision": exc.current_revision}) from None
    except TimeoutError:
        raise HTTPException(409, {"code": "flow_busy", "message":
                            "The flow is busy; this change was not applied. Wait for the current operation to finish."}) from None
    except S.NotFoundError as exc:
        raise HTTPException(404, str(exc)) from None
    except G.OpError as exc:
        raise HTTPException(400, {"code": "op_error", "index": exc.index, "message": str(exc)}) from None
    except GEN.GenerateError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    except (S.StoreError, R.RunError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from None
    raise HTTPException(404, f"no route {method} /x/{'/'.join(parts)}")
