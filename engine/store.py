"""Files on disk: flows, trash, templates, runs and run outputs.

Layout under the data dir: ``flows/<id>.json``, ``flows/.trash/<id>--<stamp>.json``,
``runs/<flow_id>/<run_id>.json``, ``outputs/<run_id>/``, ``cache/``.
Every write is atomic (temp file + os.replace). Read-modify-write sequences hold a per-key RLock that
lives in ``env.state`` so it survives engine hot reloads. Flow writes and messaging dispatch
also share an OS file lock across cooperating processes; a process-local lookup cache joins Env instances.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import unicodedata
from datetime import datetime, timezone

from . import graph
from . import messaging as MSG

logger = logging.getLogger("arachne-flow.store")

RUN_ID_RE = re.compile(r"^r_[0-9a-f]{10}$")
TEMPLATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
KEEP_RUNS = 30
ACTIVE_RUN_STATUSES = ("queued", "running")
# A running flow saves a heartbeat every runner.HEARTBEAT_S (30 s); older than this = its process hung or died.
HEARTBEAT_STALE_S = 120.0
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class StoreError(ValueError):
    """Bad input for a store operation (malformed id, not a flow, ...)."""


class NotFoundError(KeyError):
    def __init__(self, what: str, ident: str):
        super().__init__(f"{what} not found: {ident}")
        self.what = what
        self.ident = ident

    def __str__(self) -> str:
        return self.args[0]


class ConflictError(Exception):
    """Saved with a stale base_revision; the UI must reload or merge."""

    def __init__(self, flow_id: str, current_revision: int, base_revision):
        super().__init__(f"flow {flow_id} is at revision {current_revision}, not {base_revision}")
        self.flow_id = flow_id
        self.current_revision = current_revision
        self.base_revision = base_revision


# ----------------------------------------------------------------- paths

def data_dir(env) -> str:
    path = getattr(env, "data_dir", None) or os.environ.get("ARACHNE_FLOW_DATA_DIR")
    if not path:
        from plugins.plugin_storage import plugin_data_dir  # Hermes public surface
        path = str(plugin_data_dir("arachne-flow"))
    os.makedirs(path, exist_ok=True)
    return path


def _sub(env, *parts, create=True) -> str:
    path = os.path.join(data_dir(env), *parts)
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def flows_dir(env) -> str:
    return _sub(env, "flows")


def trash_dir(env) -> str:
    return _sub(env, "flows", ".trash")


def runs_dir(env, flow_id: str = None) -> str:
    return _sub(env, "runs", flow_id) if flow_id else _sub(env, "runs")


def cache_dir(env) -> str:
    return _sub(env, "cache")


def uploads_dir(env) -> str:
    """Files dropped onto the canvas (G3), named by content hash."""
    return _sub(env, "uploads")


def outputs_dir(env, run_id: str, create: bool = True) -> str:
    _check_run_id(run_id)
    return _sub(env, "outputs", run_id, create=create)


def templates_dir(env) -> str:
    return getattr(env, "templates_dir", None) or os.path.join(PLUGIN_ROOT, "templates")


def _check_flow_id(flow_id) -> str:
    if not isinstance(flow_id, str) or not graph.FLOW_ID_RE.match(flow_id):
        raise StoreError(f"invalid flow id: {flow_id!r}")
    return flow_id


def _check_run_id(run_id) -> str:
    if not isinstance(run_id, str) or not RUN_ID_RE.match(run_id):
        raise StoreError(f"invalid run id: {run_id!r}")
    return run_id


def _flow_path(env, flow_id: str) -> str:
    return os.path.join(flows_dir(env), _check_flow_id(flow_id) + ".json")


# ----------------------------------------------------------------- locks and atomic io

def lock(env, key: str):
    """Re-entrant lock for `key`, stored in env.state (survives engine reloads)."""
    locks = env.state.setdefault("store_locks", {})
    found = locks.get(key)
    if found is None:
        guard = env.state.setdefault("store_locks_guard", threading.Lock())
        with guard:
            found = locks.setdefault(key, threading.RLock())
    return found


import contextlib
import errno


# The lookup cache joins distinct Env instances. Ownership/reentrancy also lives in
# env.state so engine reloads retain the same entry. Only the OS lock guards disk.
_FLOW_LOCKS = {}
_FLOW_LOCKS_GUARD = threading.Lock()
_FLOW_LOCKS_PID = os.getpid()


def _close_inherited_lock(entry):
    handle = getattr(entry, "handle", None)
    entry.handle = None
    entry.count = 0
    if handle is not None:
        # Close our inherited descriptor; LOCK_UN would also unlock the parent's flock.
        try:
            if isinstance(handle, int):
                os.close(handle)
            else:
                handle.close()
        except OSError as exc:
            if exc.errno != errno.EBADF:
                raise


def _flow_lock_entry(env, canonical_path):
    from types import SimpleNamespace
    global _FLOW_LOCKS, _FLOW_LOCKS_GUARD, _FLOW_LOCKS_PID
    pid = os.getpid()
    # Never touch an inherited mutex after fork: its owner thread may not exist.
    if _FLOW_LOCKS_PID != pid:
        for entry in _FLOW_LOCKS.values():
            _close_inherited_lock(entry)
        _FLOW_LOCKS = {}
        _FLOW_LOCKS_GUARD = threading.Lock()
        _FLOW_LOCKS_PID = pid
    with _FLOW_LOCKS_GUARD:
        state = env.state
        if state.get("flow_file_locks_pid") != pid:
            for entry in state.get("flow_file_locks", {}).values():
                _close_inherited_lock(entry)
            state["flow_file_locks"] = {}
            state["flow_file_locks_guard"] = threading.Lock()
            state["flow_file_locks_pid"] = pid
        with state["flow_file_locks_guard"]:
            entries = state["flow_file_locks"]
            entry = entries.get(canonical_path) or _FLOW_LOCKS.get(canonical_path)
            if entry is None:
                entry = SimpleNamespace(rlock=threading.RLock(), count=0, handle=None)
            entries[canonical_path] = _FLOW_LOCKS[canonical_path] = entry
            return entry


@contextlib.contextmanager
def flow_lock(env, flow_id: str, timeout_s: float | None = 10):
    flow_id = _check_flow_id(flow_id)
    lock_dir = os.path.join(data_dir(env), "locks")
    os.makedirs(lock_dir, exist_ok=True)
    lock_path = os.path.join(lock_dir, f"{flow_id}.lock")
    canonical_path = os.path.normcase(os.path.realpath(lock_path))
    entry = _flow_lock_entry(env, canonical_path)

    deadline = (time.monotonic() + timeout_s) if timeout_s is not None else None

    if deadline is not None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Timed out acquiring local lock for flow {flow_id}")
        acquired = entry.rlock.acquire(timeout=remaining)
    else:
        acquired = entry.rlock.acquire()

    if not acquired:
        raise TimeoutError(f"Timed out acquiring local lock for flow {flow_id}")

    try:
        if entry.count > 0:
            entry.count += 1
            try:
                yield
            finally:
                entry.count -= 1
            return

        lock_obj = None
        try:
            if os.name == "nt":
                import msvcrt
                f = open(lock_path, "a+b", buffering=0)
                lock_obj = f
                if f.seek(0, os.SEEK_END) == 0:
                    f.write(b"\0")
                    f.flush()
                while True:
                    try:
                        f.seek(0)
                        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as exc:
                        is_contended = (
                            exc.errno in (errno.EACCES, errno.EAGAIN)
                            or getattr(exc, "winerror", None) in (33, 36)
                        )
                        if not is_contended:
                            raise
                        now = time.monotonic()
                        if deadline is not None:
                            if now >= deadline:
                                raise TimeoutError(f"Timed out acquiring file lock for flow {flow_id}") from exc
                            sleep_s = min(0.02, deadline - now)
                            if sleep_s > 0:
                                time.sleep(sleep_s)
                        else:
                            time.sleep(0.02)
            else:
                import fcntl
                fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o666)
                lock_obj = fd
                while True:
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError as exc:
                        is_contended = exc.errno in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK)
                        if not is_contended:
                            raise
                        now = time.monotonic()
                        if deadline is not None:
                            if now >= deadline:
                                raise TimeoutError(f"Timed out acquiring file lock for flow {flow_id}") from exc
                            sleep_s = min(0.02, deadline - now)
                            if sleep_s > 0:
                                time.sleep(sleep_s)
                        else:
                            time.sleep(0.02)

            entry.handle = lock_obj
            entry.count = 1
        except Exception:
            if lock_obj is not None:
                try:
                    if os.name == "nt":
                        lock_obj.close()
                    else:
                        os.close(lock_obj)
                except Exception:
                    pass
            raise

        try:
            yield
        finally:
            entry.count = 0
            entry.handle = None
            try:
                if os.name == "nt":
                    import msvcrt
                    try:
                        lock_obj.seek(0)
                        msvcrt.locking(lock_obj.fileno(), msvcrt.LK_UNLCK, 1)
                    finally:
                        lock_obj.close()
                else:
                    import fcntl
                    try:
                        fcntl.flock(lock_obj, fcntl.LOCK_UN)
                    finally:
                        os.close(lock_obj)
            except Exception:
                raise
    finally:
        entry.rlock.release()


def write_json(path: str, data) -> None:
    """Atomic JSON write: temp file in the same folder, fsync, os.replace (retried on Windows locks)."""
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.02 * (attempt + 1))
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def read_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _try_read(path: str):
    try:
        return read_json(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.warning("arachne-flow: unreadable file %s: %s", path, exc)
        return None


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


# ----------------------------------------------------------------- flows

def _normalize(flow: dict, flow_id: str, env, previous: dict = None, allow_optin: bool = False) -> dict:
    if not isinstance(flow, dict):
        raise StoreError("flow must be an object")
    out = copy.deepcopy(flow)
    for key in ("nodes", "edges"):
        value = out.get(key, [])
        if not isinstance(value, list):
            raise StoreError(f"flow.{key} must be a list")
        out[key] = value
    if not isinstance(out.get("viewport"), dict):
        out["viewport"] = {"x": 0, "y": 0, "zoom": 1}
    out["schema"] = graph.SCHEMA
    out["id"] = flow_id
    out["name"] = str(out.get("name") or "Untitled flow")
    out["description"] = str(out.get("description") or "")
    # Only the dedicated opt-in action may introduce consent. Ordinary writes may preserve
    # exactly the currently authorized flow/node/target, never a copied or revoked snapshot.
    previous_nodes = {node.get("id"): node for node in (previous or {}).get("nodes", [])
                      if isinstance(node, dict) and isinstance(node.get("id"), str)}
    for node in out["nodes"]:
        if not isinstance(node, dict):
            continue
        node["params"] = graph.messaging_params(node)
        if node.get("type") != MSG.NODE_TYPE:
            continue
        params = node["params"]
        node_id = node.get("id")
        keep = bool(allow_optin and isinstance(node_id, str)
                    and MSG.token_matches(env, flow_id, node_id, params))
        old = previous_nodes.get(node_id)
        if not keep and isinstance(old, dict) and old.get("type") == MSG.NODE_TYPE:
            old_params = old.get("params") or {}
            keep = (MSG.token_matches(env, flow_id, node_id, old_params)
                    and all(params.get(key) == old_params.get(key)
                            for key in ("send_enabled", "target", "authorized_target", "optin_token", "allow_attachments")))
        if not keep:
            params["send_enabled"] = False
            params.pop("authorized_target", None)
            params.pop("optin_token", None)
            params.pop("allow_attachments", None)
    return out


def flow_exists(env, flow_id: str) -> bool:
    return os.path.isfile(_flow_path(env, flow_id))


def get_flow(env, flow_id: str) -> dict:
    from . import messaging as MSG
    flow = _try_read(_flow_path(env, flow_id))
    if not isinstance(flow, dict):
        raise NotFoundError("flow", flow_id)
    nodes = flow.get("nodes")
    if not isinstance(nodes, list):
        return flow
    sanitized_nodes = []
    modified = False
    for node in nodes:
        if isinstance(node, dict) and node.get("type") == MSG.NODE_TYPE and isinstance(node.get("params"), dict):
            p = node["params"]
            if p.get("send_enabled") is True or p.get("optin_token"):
                if not MSG.token_matches(env, flow_id, node.get("id"), p):
                    np = dict(p)
                    np["send_enabled"] = False
                    np.pop("optin_token", None)
                    np.pop("authorized_target", None)
                    np.pop("allow_attachments", None)
                    sanitized_nodes.append(dict(node, params=np))
                    modified = True
                    continue
        sanitized_nodes.append(node)
    if modified:
        view = dict(flow)
        view["nodes"] = sanitized_nodes
        return view
    return flow


def _write_flow(env, flow: dict, previous: dict = None) -> dict:
    flow["revision"] = int((previous or {}).get("revision", 0)) + 1
    flow["created_at"] = (previous or {}).get("created_at") or flow.get("created_at") or graph.now_iso()
    flow["updated_at"] = graph.now_iso()
    write_json(_flow_path(env, flow["id"]), flow)
    return flow


def save_flow(env, flow: dict, base_revision=None, create: bool = False) -> dict:
    """Store `flow` under its id with revision+1. Stale base_revision -> ConflictError.

    base_revision None skips the check. create=False refuses unknown ids (NotFoundError).
    """
    if not isinstance(flow, dict):
        raise StoreError("flow must be an object")
    flow_id = _check_flow_id(flow.get("id"))
    with flow_lock(env, flow_id):
        previous = _try_read(_flow_path(env, flow_id))
        if previous is None and not create:
            raise NotFoundError("flow", flow_id)
        if previous is not None and base_revision is not None:
            current = int(previous.get("revision", 0))
            if int(base_revision) != current:
                raise ConflictError(flow_id, current, base_revision)
        return _write_flow(env, _normalize(flow, flow_id, env, previous=previous), previous)


def modify_flow(env, flow_id: str, mutate, base_revision=None, allow_optin: bool = False) -> dict:
    """Locked read-modify-write: mutate(copy) returns the new flow (or edits in place and returns None)."""
    with flow_lock(env, flow_id):
        current = get_flow(env, flow_id)
        if base_revision is not None and int(base_revision) != int(current.get("revision", 0)):
            raise ConflictError(flow_id, int(current.get("revision", 0)), base_revision)
        work = copy.deepcopy(current)
        result = mutate(work)
        return _write_flow(env, _normalize(work if result is None else result, flow_id, env,
                                           previous=current, allow_optin=allow_optin), current)


def _taken_ids(env) -> set:
    return {name[:-5] for name in os.listdir(flows_dir(env)) if name.endswith(".json")}


def create_flow(env, name: str = None, template: str = None, description: str = None) -> dict:
    """New empty flow, or a copy of template `template` with fresh ids."""
    with lock(env, "flows:create"):
        flow_id = graph.new_flow_id(_taken_ids(env))
        if template:
            flow = flow_from_template(env, template, flow_id, name=name, description=description)
        else:
            flow = graph.new_flow(name or "Untitled flow", description or "", flow_id)
        return save_flow(env, flow, create=True)


def duplicate_flow(env, flow_id: str, name: str = None) -> dict:
    source = get_flow(env, flow_id)
    with lock(env, "flows:create"):
        copy_ = graph.refresh_ids(source)
        copy_["id"] = graph.new_flow_id(_taken_ids(env))
        copy_["name"] = name or f"{source.get('name') or 'Untitled flow'} (copy)"
        copy_["revision"] = 0
        copy_["created_at"] = None
        from . import triggers as T
        T.disarm(copy_)          # a copy never starts by itself until its owner switches it on
        return save_flow(env, copy_, create=True)


def delete_flow(env, flow_id: str) -> str:
    """Move the flow file into flows/.trash/; returns the trash file name. Runs are kept."""
    with flow_lock(env, flow_id):
        path = _flow_path(env, flow_id)
        if not os.path.isfile(path):
            raise NotFoundError("flow", flow_id)
        name = f"{flow_id}--{_stamp()}.json"
        os.replace(path, os.path.join(trash_dir(env), name))
        return name


def list_trash(env) -> list:
    out = []
    for name in sorted(os.listdir(trash_dir(env)), reverse=True):
        if not name.endswith(".json") or "--" not in name:
            continue
        flow = _try_read(os.path.join(trash_dir(env), name))
        if isinstance(flow, dict):
            out.append({"file": name, "id": flow.get("id"), "name": flow.get("name"),
                        "deleted_at": name[:-5].split("--", 1)[1]})
    return out


def restore_flow(env, flow_id: str) -> dict:
    """Bring back the most recently trashed copy of `flow_id` (fails if the id is in use again)."""
    _check_flow_id(flow_id)
    with flow_lock(env, flow_id):
        candidates = sorted(n for n in os.listdir(trash_dir(env)) if n.startswith(flow_id + "--"))
        if not candidates:
            raise NotFoundError("trashed flow", flow_id)
        if flow_exists(env, flow_id):
            raise StoreError(f"flow {flow_id} already exists")
        src = os.path.join(trash_dir(env), candidates[-1])
        trashed = read_json(src)
        # Never make an armed historical snapshot visible in the active flows dir.
        restored = _normalize(trashed, flow_id, env, previous=None, allow_optin=False)
        restored = _write_flow(env, restored, previous=trashed)
        os.unlink(src)
        return restored


def list_flows(env) -> list:
    """Summaries per §3.5, newest first."""
    out = []
    folder = flows_dir(env)
    for name in os.listdir(folder):
        if not name.endswith(".json") or not graph.FLOW_ID_RE.match(name[:-5]):
            continue
        flow = _try_read(os.path.join(folder, name))
        if not isinstance(flow, dict):
            continue
        runs = list_runs(env, name[:-5], limit=1)
        last = runs[0] if runs else None
        out.append({
            "id": name[:-5], "name": flow.get("name", ""), "description": flow.get("description", ""),
            "updated_at": flow.get("updated_at"), "revision": flow.get("revision", 0),
            "node_count": len(flow.get("nodes") or []),
            "last_run": ({"id": last["id"], "status": last.get("status"),
                          "started_at": last.get("started_at"), "finished_at": last.get("finished_at")}
                         if last else None),
        })
    out.sort(key=lambda s: (s.get("updated_at") or "", s["id"]), reverse=True)
    return out


def find_flow(env, ref: str) -> dict:
    """Flow by id, else by exact name, else by unique case-insensitive name prefix."""
    ref = (ref or "").strip()
    if graph.FLOW_ID_RE.match(ref) and flow_exists(env, ref):
        return get_flow(env, ref)
    summaries = list_flows(env)
    exact = [s for s in summaries if s["name"] == ref]
    if not exact:
        exact = [s for s in summaries if s["name"].lower() == ref.lower()]
    if not exact:
        exact = [s for s in summaries if ref and s["name"].lower().startswith(ref.lower())]
    if len(exact) == 1:
        return get_flow(env, exact[0]["id"])
    if len(exact) > 1:
        raise StoreError(f"flow name {ref!r} is ambiguous: " + ", ".join(s["id"] for s in exact))
    raise NotFoundError("flow", ref)


# ----------------------------------------------------------------- templates

# Bundled templates ship in <plugin>/templates and are read-only. Your own templates (G5) live in
# <data>/templates/<id>.json; their ids always start with USER_TEMPLATE_PREFIX, which no bundled id uses,
# so an id alone says where the file is.
USER_TEMPLATE_PREFIX = "u-"
TEMPLATE_NAME_MAX = 80
TEMPLATE_DESCRIPTION_MAX = 500
# "Clear input values": what an input node's value params become (their node-type defaults).
INPUT_RESETS = {"input.text": {"value": ""}, "input.number": {"value": 0}, "input.file": {"path": ""}, "input.json": {"value": "{}"}}
_TEMPLATE_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]+")


def user_templates_dir(env, create: bool = True) -> str:
    return _sub(env, "templates", create=create)


def is_user_template(template_id) -> bool:
    return isinstance(template_id, str) and template_id.startswith(USER_TEMPLATE_PREFIX)


def _template_path(env, template_id) -> str:
    if not isinstance(template_id, str) or not TEMPLATE_ID_RE.match(template_id):
        raise StoreError(f"invalid template id: {template_id!r}")
    folder = user_templates_dir(env) if is_user_template(template_id) else templates_dir(env)
    return os.path.join(folder, template_id + ".json")


def _template_tools(flow: dict) -> list:
    return sorted({n.get("type", "") for n in flow.get("nodes", []) if isinstance(n, dict)})


def load_template(env, template_id: str) -> dict:
    data = _try_read(_template_path(env, template_id))
    if not isinstance(data, dict):
        raise NotFoundError("template", template_id)
    return data


def _template_summary(tid: str, data: dict, source: str, known_types=None) -> dict:
    missing = []
    if known_types is not None:
        known = set(known_types)
        for t in _template_tools(data):
            if t not in known:
                missing.append(t[5:] if t.startswith("tool:") else t)
    out = {"id": tid, "name": data.get("name") or tid, "description": data.get("description", ""),
           "source": source, "node_count": len(data.get("nodes") or []),
           "available": not missing, "missing_tools": missing}
    if source == "user":
        out.update(created_at=data.get("created_at"), updated_at=data.get("updated_at"))
    return out


def _read_templates(folder: str, user: bool) -> list:
    if not os.path.isdir(folder):
        return []
    found = []
    for name in os.listdir(folder):
        tid = name[:-5]
        if not name.endswith(".json") or not TEMPLATE_ID_RE.match(tid) or is_user_template(tid) != user:
            continue
        data = _try_read(os.path.join(folder, name))
        if isinstance(data, dict):
            found.append((tid, data))
    return found


def list_templates(env, known_types=None) -> list:
    """Bundled templates (by id), then your own (by name): [{id, name, description, source: bundled|user,
    node_count, available, missing_tools[, created_at, updated_at]}]. `known_types`: node type names available
    right now (None = don't check). Missing `tool:<x>` types are reported as `x`."""
    bundled = sorted(_read_templates(templates_dir(env), user=False))
    own = sorted(_read_templates(user_templates_dir(env, create=False), user=True),
                 key=lambda item: (str(item[1].get("name") or item[0]).casefold(), item[0]))
    return ([_template_summary(tid, data, "bundled", known_types) for tid, data in bundled]
            + [_template_summary(tid, data, "user", known_types) for tid, data in own])


def find_template(env, ref: str) -> str:
    """Template id for an id or an exact (case-insensitive) template name."""
    if not isinstance(ref, str) or not ref.strip():
        raise StoreError("template is required")
    ref = ref.strip()
    listed = list_templates(env)
    if any(t["id"] == ref for t in listed):
        return ref
    exact = [t["id"] for t in listed if str(t["name"]).casefold() == ref.casefold()]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise StoreError(f"template name {ref!r} is ambiguous: " + ", ".join(exact))
    raise NotFoundError("template", ref)


def _template_text(value, limit: int, multiline: bool = False) -> str:
    text = _TEMPLATE_CONTROL.sub(" ", str(value or ""))
    if not multiline:
        text = " ".join(text.split())
    return text.strip()[:limit].strip()


def template_slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")[:40].strip("-") or "template"


def template_from_flow(flow: dict, clear_inputs: bool = False) -> dict:
    """The graph part of a template: nodes, edges, viewport. clear_inputs resets Text/Number/File values."""
    nodes = copy.deepcopy([n for n in flow.get("nodes") or [] if isinstance(n, dict)])
    for node in nodes:
        if clear_inputs:
            reset = INPUT_RESETS.get(node.get("type"))
            if reset:
                params = node.get("params") if isinstance(node.get("params"), dict) else {}
                node["params"] = {**params, **reset}
        node["params"] = graph.messaging_params(node, copy_target=True)
        node["params"].pop("picked_files", None)   # picks belong to one flow and node (picks.py), never shared
        if str(node.get("type") or "").startswith("trigger."):
            node["params"]["active"] = False         # a template never arrives armed
            node["params"].pop("hook_id", None)
    viewport = flow.get("viewport") if isinstance(flow.get("viewport"), dict) else {"x": 0, "y": 0, "zoom": 1}
    return {"nodes": nodes, "edges": copy.deepcopy([e for e in flow.get("edges") or [] if isinstance(e, dict)]),
            "viewport": dict(viewport)}


def _check_user_template(template_id) -> str:
    if not isinstance(template_id, str) or not TEMPLATE_ID_RE.match(template_id):
        raise StoreError(f"invalid template id: {template_id!r}")
    if not is_user_template(template_id):
        raise StoreError(f"{template_id} is a built-in template; only your own templates can be changed")
    return template_id


def save_template(env, flow: dict, name: str = None, description: str = None, clear_inputs: bool = False,
                  replace: str = None) -> dict:
    """Store `flow` as one of your templates (new id from the name), or overwrite your template `replace`.
    Name/description default to the flow's. Returns the template's list entry."""
    if not isinstance(flow, dict):
        raise StoreError("flow must be an object")
    name = _template_text(flow.get("name") if name is None else name, TEMPLATE_NAME_MAX)
    if not name:
        raise StoreError("template name is required")
    description = _template_text(flow.get("description") if description is None else description,
                                 TEMPLATE_DESCRIPTION_MAX, multiline=True)
    with lock(env, "templates"):
        folder = user_templates_dir(env)
        now = graph.now_iso()
        previous = None
        if replace:
            tid = _check_user_template(replace)
            previous = _try_read(os.path.join(folder, tid + ".json"))
            if not isinstance(previous, dict):
                raise NotFoundError("template", tid)
        else:
            taken = {n[:-5] for n in os.listdir(folder) if n.endswith(".json")}
            base = USER_TEMPLATE_PREFIX + template_slug(name)
            tid, i = base, 2
            while tid in taken:
                tid, i = f"{base}-{i}", i + 1
        data = {"schema": graph.SCHEMA, "name": name, "description": description,
                **template_from_flow(flow, clear_inputs),
                "from_flow": flow.get("id"), "created_at": (previous or {}).get("created_at") or now,
                "updated_at": now}
        write_json(os.path.join(folder, tid + ".json"), data)
    return _template_summary(tid, data, "user")


def update_template(env, template_id: str, name: str = None, description: str = None) -> dict:
    """Rename / re-describe one of your templates."""
    tid = _check_user_template(template_id)
    with lock(env, "templates"):
        path = os.path.join(user_templates_dir(env), tid + ".json")
        data = _try_read(path)
        if not isinstance(data, dict):
            raise NotFoundError("template", tid)
        if name is not None:
            data["name"] = _template_text(name, TEMPLATE_NAME_MAX)
            if not data["name"]:
                raise StoreError("template name is required")
        if description is not None:
            data["description"] = _template_text(description, TEMPLATE_DESCRIPTION_MAX, multiline=True)
        data["updated_at"] = graph.now_iso()
        write_json(path, data)
    return _template_summary(tid, data, "user")


def delete_template(env, template_id: str) -> str:
    """Move one of your templates into <data>/templates/.trash/ (restorable by hand); returns that file name."""
    tid = _check_user_template(template_id)
    with lock(env, "templates"):
        path = os.path.join(user_templates_dir(env), tid + ".json")
        if not os.path.isfile(path):
            raise NotFoundError("template", tid)
        trash = os.path.join(user_templates_dir(env), ".trash")
        os.makedirs(trash, exist_ok=True)
        name = f"{tid}--{_stamp()}.json"
        os.replace(path, os.path.join(trash, name))
        return name


def flow_from_template(env, template_id: str, flow_id: str, name: str = None, description: str = None) -> dict:
    """Unsaved new flow `flow_id` copied from a template with fresh node/edge ids."""
    base = graph.refresh_ids(load_template(env, template_id))
    flow = graph.new_flow(name or base.get("name") or "Untitled flow",
                          description if description is not None else base.get("description", ""), flow_id)
    flow["nodes"] = base.get("nodes", [])
    flow["edges"] = base.get("edges", [])
    if isinstance(base.get("viewport"), dict):
        flow["viewport"] = base["viewport"]
    flow["template"] = template_id
    return flow


# ----------------------------------------------------------------- runs

def new_run_id() -> str:
    return "r_" + secrets.token_hex(5)


def _run_path(env, flow_id: str, run_id: str) -> str:
    return os.path.join(runs_dir(env, _check_flow_id(flow_id)), _check_run_id(run_id) + ".json")


def _locate_run(env, run_id: str):
    _check_run_id(run_id)
    root = runs_dir(env)
    for flow_id in os.listdir(root):
        path = os.path.join(root, flow_id, run_id + ".json")
        if os.path.isfile(path):
            return path
    return None


def save_run(env, run: dict, keep: int = KEEP_RUNS) -> dict:
    """Write the run record; on first save prune the flow's history to `keep` runs."""
    if not isinstance(run, dict):
        raise StoreError("run must be an object")
    flow_id, run_id = _check_flow_id(run.get("flow_id")), _check_run_id(run.get("id"))
    path = _run_path(env, flow_id, run_id)
    with lock(env, "runs:" + flow_id):
        is_new = not os.path.exists(path)
        write_json(path, run)
        if is_new:
            prune_runs(env, flow_id, keep=keep)
    return run


def load_run(env, run_id: str) -> dict:
    path = _locate_run(env, run_id)
    run = _try_read(path) if path else None
    if not isinstance(run, dict):
        raise NotFoundError("run", run_id)
    return run


def _sort_key(run: dict, path: str):
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        mtime = 0
    return (run.get("started_at") or "", mtime)


def _iter_runs(env, flow_id: str = None):
    root = runs_dir(env)
    flow_ids = [flow_id] if flow_id else [d for d in os.listdir(root) if graph.FLOW_ID_RE.match(d)]
    for fid in flow_ids:
        folder = os.path.join(root, _check_flow_id(fid))
        if not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            if name.endswith(".json") and RUN_ID_RE.match(name[:-5]):
                path = os.path.join(folder, name)
                run = _try_read(path)
                if isinstance(run, dict):
                    yield run, path


def summarize_run(run: dict) -> dict:
    counts: dict = {}
    for state in (run.get("nodes") or {}).values():
        status = (state or {}).get("status", "idle")
        counts[status] = counts.get(status, 0) + 1
    keys = ("id", "flow_id", "flow_revision", "status", "started_at", "finished_at", "ms", "target_node",
            "fresh")
    out = {k: run.get(k) for k in keys}
    out["node_counts"] = counts
    out["issue_count"] = len(run.get("issues") or [])
    return out


def list_runs(env, flow_id: str = None, limit: int = 50) -> list:
    """Run summaries, newest first."""
    pairs = sorted(_iter_runs(env, flow_id), key=lambda p: _sort_key(*p), reverse=True)
    if limit is not None:
        pairs = pairs[:max(0, int(limit))]
    return [summarize_run(run) for run, _path in pairs]


def delete_run(env, run_id: str) -> None:
    path = _locate_run(env, run_id)
    if path is None:
        raise NotFoundError("run", run_id)
    os.remove(path)
    shutil.rmtree(outputs_dir(env, run_id, create=False), ignore_errors=True)


def prune_runs(env, flow_id: str, keep: int = KEEP_RUNS) -> list:
    """Delete all but the newest `keep` runs of a flow (never active ones) plus their outputs."""
    with lock(env, "runs:" + _check_flow_id(flow_id)):
        pairs = sorted(_iter_runs(env, flow_id), key=lambda p: _sort_key(*p), reverse=True)
        removed = []
        for run, path in pairs[max(0, keep):]:
            if run.get("status") in ACTIVE_RUN_STATUSES:
                continue
            try:
                os.remove(path)
            except OSError as exc:
                logger.warning("arachne-flow: could not delete run %s: %s", path, exc)
                continue
            shutil.rmtree(outputs_dir(env, run["id"], create=False), ignore_errors=True)
            removed.append(run["id"])
        return removed


def _pid_alive(pid) -> bool:
    """Is process `pid` still running? Windows: OpenProcess + GetExitCodeProcess — never ``os.kill(pid, 0)``,
    which on Windows calls TerminateProcess and would kill the other process."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5             # ERROR_ACCESS_DENIED: exists, not ours
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True                                  # cannot tell: do not interrupt
            return code.value == 259                         # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


pid_alive = _pid_alive


# ----------------------------------------------------------------- housekeeping (review E-12)

TRASH_MAX_AGE_S = 30 * 24 * 3600.0     # a deleted flow stays restorable this long
UPLOAD_MAX_AGE_S = 30 * 24 * 3600.0    # a dropped file no flow names is kept this long


def _older_than(path: str, cutoff: float) -> bool:
    try:
        return os.path.getmtime(path) < cutoff
    except OSError:
        return False


def _norm_text(text: str) -> str:
    """Forward slashes, case-folded on Windows: the same file named either way compares equal."""
    return os.path.normcase(str(text).replace("\\", "/"))


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


def _flow_strings(env) -> str:
    """Every string of every saved and trashed flow, normalized, as one blob (trash included: it can be
    restored, so a flow in there still owns its uploads)."""
    chunks = []
    for folder, patterns in ((flows_dir(env), lambda n: n.endswith(".json") and graph.FLOW_ID_RE.match(n[:-5])),
                             (trash_dir(env), lambda n: n.endswith(".json"))):
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for name in names:
            if patterns(name):
                flow = _try_read(os.path.join(folder, name))
                if isinstance(flow, dict):
                    chunks.extend(_norm_text(text) for text in _strings(flow))
    return "\n".join(chunks)


def prune_stale_files(env, now: float = None, max_age_s: float = None) -> dict:
    """Delete trashed flows and unreferenced uploads older than 30 days -> {"trash": n, "uploads": m}.

    Age is the file's mtime (``max_age_s`` overrides both TRASH_MAX_AGE_S and UPLOAD_MAX_AGE_S, for tests).
    Uploads are kept while any saved or trashed flow names them; flows are only read when an upload is
    actually old enough to be a candidate, so the common startup sweep costs one listing.
    Runs once per process (runner.ensure_startup); failures are the caller's to swallow.
    """
    now = time.time() if now is None else float(now)
    age = UPLOAD_MAX_AGE_S if max_age_s is None else float(max_age_s)
    counts = {"trash": 0, "uploads": 0}
    cutoff = now - age

    folder = trash_dir(env)
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if name.endswith(".json") and _older_than(path, cutoff):
            try:
                os.remove(path)
            except OSError as exc:
                logger.warning("arachne-flow: could not delete trashed flow %s: %s", path, exc)
                continue
            counts["trash"] += 1

    root = uploads_dir(env)
    candidates = []
    for folder, _dirs, names in os.walk(root):
        for name in names:
            path = os.path.join(folder, name)
            if _older_than(path, cutoff):
                candidates.append(path)
    if candidates:
        named = _flow_strings(env)
        for path in candidates:
            rel = _norm_text(os.path.relpath(path, root))     # "<hash>/<name>": inside the flow's absolute path
            if rel in named:
                continue
            try:
                os.remove(path)
            except OSError as exc:
                logger.warning("arachne-flow: could not delete upload %s: %s", path, exc)
                continue
            counts["uploads"] += 1
            parent = os.path.dirname(path)
            try:
                if os.path.isdir(parent) and not os.listdir(parent):
                    os.rmdir(parent)                           # the <hash>/ folder only held this file
            except OSError:
                pass
    return counts


def _owner_alive(run: dict, boot, alive, now: float) -> bool:
    """Review E-7: plugin-data is shared by the Desktop backend, gateway, CLI and cron. A run stays untouched
    while its owner process lives and keeps its heartbeat fresh; legacy runs without an owner do not."""
    owner = run.get("owner")
    if not isinstance(owner, dict) or not owner.get("boot"):
        return False
    if boot is not None and owner.get("boot") == boot:
        return False                      # ours, but no thread of this process runs it any more
    if not alive(owner.get("pid")):
        return False
    beat = run.get("heartbeat")
    return isinstance(beat, (int, float)) and now - float(beat) <= HEARTBEAT_STALE_S


def mark_interrupted(env, active_ids=(), boot=None, pid_alive=None, now=None) -> list:
    """Runs left queued/running by a process that is gone (or hung) -> error "interrupted". Runs in
    `active_ids` (an iterable or a live lookup callback) and live owners are left alone."""
    active = active_ids if callable(active_ids) else lambda ids=set(active_ids): ids
    alive = pid_alive if pid_alive is not None else _pid_alive
    now = time.time() if now is None else now
    fixed = []
    for run, path in list(_iter_runs(env)):
        if run.get("status") not in ACTIVE_RUN_STATUSES or run.get("id") in active():
            continue
        if _owner_alive(run, boot, alive, now):
            continue
        with lock(env, "runs:" + run["flow_id"]):
            # Registration uses this lock too; recheck live handles and the latest disk state.
            current = _try_read(path)
            if not isinstance(current, dict) or current.get("status") not in ACTIVE_RUN_STATUSES \
                    or current.get("id") in active() or _owner_alive(current, boot, alive, now):
                continue
            run = current
            run["status"] = "error"
            run["error"] = "interrupted"
            run["finished_at"] = run.get("finished_at") or graph.now_iso()
            for state in (run.get("nodes") or {}).values():
                if isinstance(state, dict) and state.get("status") in ("queued", "running"):
                    state["status"] = "error" if state["status"] == "running" else "skipped"
                    if state["status"] == "error":
                        state["error"] = "interrupted"
            write_json(path, run)
        fixed.append(run["id"])
    return fixed
