"""Port types, compatibility and value conversion.

The compatibility table is owned here and served by the API (`GET /x/node-types` -> `compat`);
the UI never duplicates it.
"""
from __future__ import annotations

import json
from typing import Any

# name -> label + colour (an app CSS variable; the UI uses it verbatim)
PORT_TYPES: dict = {
    "text": {"label": "Text", "color": "--ui-text-secondary"},
    "number": {"label": "Number", "color": "--ui-cyan"},
    "boolean": {"label": "Boolean", "color": "--ui-orange"},
    "json": {"label": "JSON", "color": "--ui-yellow"},
    "image": {"label": "Image", "color": "--ui-purple"},
    "audio": {"label": "Audio", "color": "--ui-green"},
    "video": {"label": "Video", "color": "--ui-red"},
    "model3d": {"label": "3D model", "color": "--ui-blue"},
    "file": {"label": "File", "color": "--ui-warm"},
    "any": {"label": "Any", "color": "--ui-text-tertiary"},
}
TYPE_NAMES = tuple(PORT_TYPES)
MEDIA_KINDS = ("image", "audio", "video", "model3d")
_TO_TEXT = ("number", "boolean", "json")


def is_type(name: Any) -> bool:
    return isinstance(name, str) and name in PORT_TYPES


def compatible(src: str, dst: str) -> bool:
    """May an output of type `src` feed an input of type `dst`?"""
    if not (is_type(src) and is_type(dst)):
        return False
    if src == dst or dst == "any" or src == "any":
        return True
    if dst == "text" and src in _TO_TEXT:
        return True
    if dst == "file" and src in MEDIA_KINDS:
        return True
    return False


def compat_table() -> dict:
    """{src: [dst, ...]} for every port type, in TYPE_NAMES order."""
    return {src: [dst for dst in TYPE_NAMES if compatible(src, dst)] for src in TYPE_NAMES}


def port_types() -> dict:
    return {name: dict(spec) for name, spec in PORT_TYPES.items()}


# ----------------------------------------------------------------- values

def is_media(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("$media"), dict)


ENGINE_KEYS = ("$media", "$large")


def defang(value: Any, _depth: int = 0) -> Any:
    """Untrusted data (tool output, JSON text) with the engine's own value keys renamed (``$media`` ->
    ``_$media``): only the engine may create media/large values, never a tool or a web page (review E-2)."""
    if _depth > 64:
        # Never pass an original subtree through at the cutoff: it could still contain live engine keys.
        return "[truncated: maximum nesting depth exceeded]"
    if isinstance(value, dict):
        return {("_" + k if k in ENGINE_KEYS else k): defang(v, _depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [defang(v, _depth + 1) for v in value]
    return value


def loads_untrusted(text: str) -> Any:
    """``json.loads`` for text that came from outside the engine; see ``defang``."""
    return defang(json.loads(text))


def media_kind(value: Any):
    return value["$media"].get("kind") if is_media(value) else None


def value_type(value: Any) -> str:
    """Best-effort runtime type of a value (used when a source port is `any`)."""
    if is_media(value):
        kind = media_kind(value)
        return kind if kind in PORT_TYPES else "file"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "text"
    return "json"


def to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, int):
        return str(value)
    if is_media(value):
        m = value["$media"]
        return str(m.get("path") or m.get("source") or m.get("file") or "")
    return json.dumps(value, ensure_ascii=False, indent=2)


class ConversionError(ValueError):
    pass


def convert(value: Any, dst: str) -> Any:
    """Convert a runtime value for an input port of type `dst` (raises ConversionError)."""
    if dst == "any" or not is_type(dst):
        return value
    if dst == "text":
        return to_text(value)
    if dst == "number":
        if isinstance(value, bool):
            return int(value)
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            try:
                f = float(value.strip())
            except ValueError:
                raise ConversionError(f"cannot use {value[:40]!r} as a number") from None
            return int(f) if f.is_integer() and "." not in value and "e" not in value.lower() else f
        raise ConversionError(f"cannot use a {value_type(value)} value as a number")
    if dst == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str) and value.strip().lower() in ("true", "false", "yes", "no", "1", "0", "on", "off"):
            return value.strip().lower() in ("true", "yes", "1", "on")
        raise ConversionError(f"cannot use a {value_type(value)} value as a boolean")
    if dst == "json":
        if isinstance(value, str):
            try:
                return loads_untrusted(value)
            except ValueError:
                return value
        return value
    if dst == "file":
        if is_media(value):
            return value
        raise ConversionError(f"expected a file, got {value_type(value)}")
    if dst in MEDIA_KINDS:
        if is_media(value) and media_kind(value) in (dst, None, "file"):
            return value
        raise ConversionError(f"expected {dst}, got {value_type(value)}")
    return value
