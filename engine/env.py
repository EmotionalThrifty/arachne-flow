"""What the engine may touch on the host, injected so tests can run without Hermes."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional


def _no_emit(event: str, payload: dict) -> None:
    return None


@dataclass
class Env:
    ctx: Any = None                                      # Hermes PluginContext (dispatch_tool, llm, ...)
    state: dict = field(default_factory=dict)            # survives engine hot reloads (active runs, caches)
    emit: Callable[[str, dict], None] = _no_emit          # broadcast plugin.flowcanvas.<event> to Desktop
    data_dir: Optional[str] = None                       # None -> plugin_data_dir("flowcanvas") or $FLOWCANVAS_DATA_DIR
    templates_dir: Optional[str] = None                  # None -> <plugin>/templates
