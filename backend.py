"""arachne-flow backend glue, loaded through runtime.load_backend().

The REST surface lives under /api/plugins/arachne-flow/x/<path>; every such request is handed to the
engine package (engine/). Both load once; with ARACHNE_FLOW_DEV=1 (development) they are re-imported after an
edit while no flow runs, so the running Hermes Desktop picks up backend and engine changes without a restart.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import sys
import threading

logger = logging.getLogger("arachne-flow.api")
PLUGIN_ID = "arachne-flow"
ROOT = os.path.dirname(os.path.realpath(__file__))
ENGINE_DIR = os.path.join(ROOT, "engine")
ENGINE_NAME = "arachne_flow_engine"
_ENGINE_LOCK = threading.RLock()


def _runtime():
    path = os.path.join(ROOT, "runtime.py")
    for module in list(sys.modules.values()):
        f = getattr(module, "__file__", None)
        if f and hasattr(module, "find_or_load"):
            try:
                if os.path.normcase(os.path.realpath(f)) == os.path.normcase(path):
                    return module.find_or_load()
            except OSError:
                continue
    spec = importlib.util.spec_from_file_location("arachne_flow_runtime_boot", path)
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)
    return boot.find_or_load()


def _emit(event: str, payload: dict) -> None:
    hook = _runtime().STATE.get("emit_hook")          # dev server / tests: mirror events
    if callable(hook):
        try:
            hook(event, payload)
        except Exception as exc:  # noqa: BLE001 - a broken mirror must not break the run
            logger.debug("arachne-flow: emit hook failed: %s", exc)
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
        broadcast_plugin_event(PLUGIN_ID, event, payload)
    except Exception as exc:  # noqa: BLE001 - delivery is best effort
        logger.debug("arachne-flow: event %s not delivered: %s", event, exc)


# ----------------------------------------------------------------- engine hot reload

def _engine_signature() -> tuple:
    sig = []
    for dirpath, _dirs, files in os.walk(ENGINE_DIR):
        for name in files:
            if name.endswith(".py"):
                p = os.path.join(dirpath, name)
                st = os.stat(p)
                sig.append((os.path.relpath(p, ENGINE_DIR), st.st_mtime_ns, st.st_size))
    return tuple(sorted(sig))


def _keep_loaded(rt) -> bool:
    """No reload outside dev mode or during a run. A runtime.py from before E-9 (still loaded in a Desktop that
    was not restarted) has no dev_mode(): keep its old behaviour, reload on change, instead of crashing."""
    dev, active = getattr(rt, "dev_mode", None), getattr(rt, "runs_active", None)
    if not callable(dev):
        return False
    return not dev() or (callable(active) and active())


def engine():
    """The engine package, loaded once (shared across reloads of this file). With ARACHNE_FLOW_DEV=1 it is
    re-imported when any engine/*.py changes, but not while a run is active (review E-9)."""
    rt = _runtime()
    with _ENGINE_LOCK:
        cached = rt.STATE.get("engine")
        if cached is not None and _keep_loaded(rt):
            return cached
        sig = _engine_signature()
        if cached is not None and rt.STATE.get("engine_sig") == sig:
            return cached
        for name in [n for n in sys.modules if n == ENGINE_NAME or n.startswith(ENGINE_NAME + ".")]:
            del sys.modules[name]
        spec = importlib.util.spec_from_file_location(
            ENGINE_NAME, os.path.join(ENGINE_DIR, "__init__.py"), submodule_search_locations=[ENGINE_DIR])
        module = importlib.util.module_from_spec(spec)
        sys.modules[ENGINE_NAME] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(ENGINE_NAME, None)
            raise
        rt.STATE["engine"], rt.STATE["engine_sig"] = module, sig
        return module


def env():
    """The engine's view of the host: ctx, reload-surviving state, event emitter."""
    rt = _runtime()
    eng = engine()
    return eng.env.Env(ctx=rt.ctx(), state=rt.STATE.setdefault("engine_state", {}), emit=_emit)


async def route(method: str, path: str, query: dict, body: dict):
    eng = engine()
    return await eng.api.handle(method, path, query, body, env())


def tool_call(name: str, args: dict, kwargs: dict) -> str:
    """Agent tool entry point (sync; Hermes runs tool handlers off the event loop)."""
    eng = engine()
    return eng.tools.handle(name, args, kwargs, env())


def command(raw_args: str, kwargs: dict) -> str:
    eng = engine()
    return eng.tools.command(raw_args, kwargs, env())
