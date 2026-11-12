"""arachne-flow — node-based flow editor for Hermes Desktop."""
from __future__ import annotations

import json
import logging
import os

from . import runtime as _runtime_module

# One shared instance per process, whether the package or plugin_api.py loads first.
runtime = _runtime_module.find_or_load()

logger = logging.getLogger(__name__)

def _backend():
    """backend.py, re-imported on change, so tool handlers pick up edits without a restart."""
    return runtime.load_backend()


def _agent_tool(name):
    def handle(args: dict, **kwargs) -> str:
        try:
            return _backend().tool_call(name, args, kwargs)
        except Exception as exc:  # noqa: BLE001 - agent handlers return errors as data
            logger.exception("arachne-flow: %s failed", name)
            return json.dumps({"error": f"{type(exc).__name__}: {exc}", "code": "internal"})
    return handle


def _agent_command(raw_args: str, **kwargs) -> str:
    try:
        return _backend().command(raw_args, kwargs)
    except Exception as exc:  # noqa: BLE001
        logger.exception("arachne-flow: /flow failed")
        return f"Error: {type(exc).__name__}: {exc}"


SKILL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "arachne-flow", "SKILL.md")
SKILL_DESCRIPTION = "Use when building, editing, debugging or running Arachne Flow node flows and tool/LLM pipelines."


def _register_skill(ctx) -> None:
    """Bundled agent skill, resolvable as ``arachne-flow:arachne-flow`` (hermes_cli/plugins_content.register_skill)."""
    register_skill = getattr(ctx, "register_skill", None)
    if not callable(register_skill):
        logger.info("arachne-flow: this Hermes cannot register plugin skills")
        return
    try:
        register_skill("arachne-flow", SKILL_PATH, description=SKILL_DESCRIPTION)
    except (ValueError, FileNotFoundError) as exc:
        logger.warning("arachne-flow: skill not registered: %s", exc)


def register(ctx) -> None:
    runtime.bind(ctx)
    for schema in _backend().engine().tool_schemas.SCHEMAS:
        ctx.register_tool(name=schema["name"], toolset="arachne_flow", schema=schema,
                          handler=_agent_tool(schema["name"]))
    ctx.register_command("flow", _agent_command, description="List, run, open and inspect flows in Arachne Flow",
                         args_hint="list | run <name> [--fresh] | open [name] | status <run_id>")
    _register_skill(ctx)
    try:
        _backend().start_triggers()
        on_unload = getattr(ctx, "on_unload", None)
        if callable(on_unload):
            on_unload(lambda: _backend().stop_triggers())
    except Exception:  # noqa: BLE001 - triggers must never keep the plugin from loading
        logger.exception("arachne-flow: trigger loop not started")
    logger.info("arachne-flow: registered (ctx bound)")
