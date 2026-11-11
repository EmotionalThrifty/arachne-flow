"""Process-wide handle shared by the agent half (register) and the dashboard backend.

Hermes loads the package through the plugin manager and dashboard/plugin_api.py by path. Both must
reach ONE module instance, so lookup is by real file path (junctions/symlinks resolved): the first
copy loaded in the process wins. STATE also holds everything that must survive a hot reload of
backend.py / engine/ (active runs, caches): never keep such state in engine modules.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
import threading

logger = logging.getLogger("flowcanvas.runtime")

HERE = os.path.dirname(os.path.realpath(__file__))
STATE: dict = {"ctx": None}
_BACKEND_LOCK = threading.RLock()


def _same_file(a: str, b: str) -> bool:
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    except OSError:
        return False


def _instances():
    wanted = os.path.join(HERE, "runtime.py")
    for module in list(sys.modules.values()):
        f = getattr(module, "__file__", None)
        if f and hasattr(module, "STATE") and _same_file(f, wanted):
            yield module


def find_or_load():
    """Return the shared instance: one already bound to a ctx, else any loaded copy, else a fresh load."""
    found = list(_instances())
    for module in found:
        if module.STATE.get("ctx") is not None:
            return module
    if found:
        return found[0]
    name = "flowcanvas_runtime"
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, "runtime.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def bind(ctx) -> None:
    # Bind every loaded copy so whichever one a caller holds sees the ctx.
    STATE["ctx"] = ctx
    for module in _instances():
        module.STATE["ctx"] = ctx


def bound() -> bool:
    return ctx() is not None


def ctx():
    if STATE["ctx"] is None:
        for module in _instances():
            if module.STATE.get("ctx") is not None:
                STATE["ctx"] = module.STATE["ctx"]
                break
    return STATE["ctx"]


def ensure_ctx():
    """The plugin ctx in THIS process, or None. Hermes Desktop's backend (hermes serve) loads agent
    plugins at startup, so register() has bound it before the first REST request arrives."""
    return ctx()


def dev_mode() -> bool:
    """Hot reload of backend.py / engine/ only for development (``FLOWCANVAS_DEV=1``, review E-9): an installed
    plugin updated by ``hermes plugins update`` must not swap modules under running flows."""
    return os.environ.get("FLOWCANVAS_DEV", "").strip() == "1"


def runs_active() -> bool:
    """True while a flow runs in this process; a reload then waits, so one run never mixes engine versions."""
    return bool((STATE.get("engine_state") or {}).get("active_runs"))


def load_backend():
    """backend.py, loaded once per process (the ONE loader: __init__.py and dashboard/plugin_api.py both use it).
    With FLOWCANVAS_DEV=1 it is re-imported after an edit, but never while a run is active."""
    path = os.path.join(HERE, "backend.py")
    with _BACKEND_LOCK:
        cached = STATE.get("backend")
        if cached is not None and (not dev_mode() or runs_active()):
            return cached
        mtime = os.path.getmtime(path)
        if cached is not None and STATE.get("backend_mtime") == mtime:
            return cached
        name = "flowcanvas_backend"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        STATE["backend"], STATE["backend_mtime"] = module, mtime
        return module


def diagnostics() -> dict:
    return {
        "pid": os.getpid(),
        "bound": ctx() is not None,
        "instances": [getattr(m, "__name__", "?") for m in _instances()],
    }
