"""Node library: built-in node types, one node type per available Hermes tool,
the tool block list (§3.9), and the payload served by ``GET /x/node-types``.

Tool nodes are generated from the Hermes tool registry: ``type = "tool:<name>"``, inputs AND
params from the tool's JSON-schema properties (same names, so a constant typed into the inspector
satisfies a required input — see graph.validate), outputs ``result`` / ``text`` / ``media``.
"""
from __future__ import annotations

import logging
import re
import time

from . import data_nodes as D
from . import executors as X
from . import graph as G
from . import types as ptypes

logger = logging.getLogger("arachne-flow.nodes")

TOOL_PREFIX = "tool:"
CACHE_TTL_S = 30.0

# Interactive, session-bound or dangerous tools: never offered as nodes unless allow_tools lists them.
DEFAULT_BLOCKED = (
    "terminal", "execute_code", "write_file", "patch", "process_manage", "computer_use", "browser_vault", "browser_cdp",
    "browser_dialog", "browser_exec", "delegate_task", "cronjob_manage", "clarify", "memory",
    "desktop_preview", "drive_preview", "annotate_preview", "focus_pane", "set_theme", "close_terminal",
    "read_terminal", "read_window_below", "desktop_project", "manage_catalog", "manage_connections",
    "setup_beat", "gui_tour", "show_tip", "todo_list", "skill_manage", "react_to_message", "discord",
    "discord_admin",
    # Egress: only the dedicated Send message node may send, with its own opt-in. The raw bridge tool
    # would bypass target pinning, the run lock and the no-retry rule.
    "mcp__messaging__messages_send",
    # Review E-10: MCP tools are blocked by name only; these run code in a live app (Blender, Godot editor/game).
    "mcp__blender__execute_blender_code", "mcp__godot_ai__editor_manage", "mcp__godot_ai__script_create",
    "mcp__godot_ai__script_patch",
)
# Kanban/flow tools would recurse into Hermes' own orchestration; messaging tools post to real chats.
BLOCKED_PREFIXES = ("kanban_", "flow_", "yb_", "feishu_", "send_message")

CATEGORY_ORDER = ("Triggers", "Inputs", "AI", "Text", "Data", "Logic", "Media", "Web", "Output", "Utility", "Presets")

# String properties whose names suggest a file/URL/media value accept any value (media is
# converted to a path or URL by the executor); everything else maps by JSON-schema type.
_MEDIA_HINT = re.compile(r"(image|img|photo|picture|audio|video|sound|voice|model|mesh|glb|file|path|url|uri)",
                         re.IGNORECASE)
_LONG_TEXT = re.compile(r"^(prompt|text|content|message|messages|code|system|instructions?|body|description|"
                        r"question|script|query_text|input|template|negative_prompt)$", re.IGNORECASE)

_TOOLSET_ICONS = {
    "web": "globe", "search": "search", "browser": "browser", "file": "file", "vision": "eye",
    "tts": "unmute", "image_gen": "file-media", "video": "device-camera-video", "memory": "database",
    "skills": "book", "session_search": "history",
}


# Palette tooltip hints (G2): how long a built-in usually takes and what it costs. Notes never run.
_BUILTIN_HINTS = {
    "llm.complete": {"typical": "seconds; longer for long answers or thinking models",
                     "cost": "Paid per token by the model's provider"},
    "note": {},
}


def _builtin_types() -> list:
    """The hand-written node types. Fresh dicts on every call: callers may mutate them."""
    from . import triggers as T
    types = _builtin_specs() + D.specs() + T.specs()
    for spec in types:
        spec.update(_BUILTIN_HINTS.get(spec["type"], {"typical": "instant"}))
    return types


def _builtin_specs() -> list:
    return [
        {
            "type": "input.text", "title": "Text", "category": "Inputs", "icon": "symbol-string",
            "description": "A piece of text you type in, e.g. a prompt or an idea.",
            "inputs": [],
            "outputs": [{"name": "text", "type": "text", "label": "Text"}],
            "params": [{"name": "value", "kind": "textarea", "label": "Text", "default": "",
                        "description": "The text this node sends out. Hermes can also override it per run "
                                       "(flow_run inputs, by node title)."}],
        },
        {
            "type": "input.number", "title": "Number", "category": "Inputs", "icon": "symbol-numeric",
            "description": "A number you type in.",
            "inputs": [],
            "outputs": [{"name": "number", "type": "number", "label": "Number"}],
            "params": [{"name": "value", "kind": "number", "label": "Number", "default": 0,
                        "description": "The number this node sends out. Decimals use a dot, e.g. 0.5."}],
        },
        {
            "type": "input.file", "title": "File", "category": "Inputs", "icon": "file",
            "description": "A local file (image, audio, video, 3D model or anything else).",
            "inputs": [],
            "outputs": [{"name": "file", "type": "any", "label": "File"}],
            "params": [
                {"name": "path", "kind": "text", "label": "Path", "default": "", "browse": "file",
                 "description": "Absolute path of a local file, e.g. C:\\Users\\you\\Pictures\\cat.png. "
                                "Browse… picks one; you can also drop files onto the canvas."},
                {"name": "kind", "kind": "select", "label": "Kind", "default": "auto",
                 "options": ["auto", "image", "audio", "video", "model3d", "file"],
                 "description": "What the file is. Auto guesses from the extension; set it when the guess is "
                                "wrong so the file fits image/audio/3D inputs."},
            ],
        },
        {
            "type": "text.template", "title": "Template", "category": "Text", "icon": "symbol-text",
            "description": "Build text from inputs: every {{name}} in the template becomes an input.",
            "inputs": [],
            "outputs": [{"name": "text", "type": "text", "label": "Text"}],
            "params": [{"name": "template", "kind": "textarea", "label": "Template",
                        "default": "{{text}}",
                        "description": "Text with {{placeholders}}. Each placeholder becomes an input port; "
                                       "connected values are filled in when the flow runs."}],
            "dynamic_inputs": "template",
        },
        {
            "type": "json.pick", "title": "Pick field", "category": "Data", "icon": "json",
            "description": "Take one value out of JSON with a path like result.items[0].url "
                           "(text that contains JSON is parsed first).",
            "inputs": [{"name": "data", "type": "any", "required": True, "label": "Data"}],
            "outputs": [{"name": "value", "type": "any", "label": "Value"}],
            "params": [{"name": "path", "kind": "text", "label": "Path", "default": "",
                        "description": "Where the value sits in the JSON: dots for keys, numbers or [n] for list "
                                       "items, e.g. results.0.url. Empty passes the whole value through."}],
        },
        {
            "type": "llm.complete", "title": "LLM", "category": "AI", "icon": "sparkle",
            "description": "Ask a language model. Every {{name}} in the template becomes an input.",
            "inputs": [],
            "outputs": [{"name": "text", "type": "text", "label": "Text"}],
            "params": [
                {"name": "model", "kind": "model", "label": "Model", "default": None,
                 "description": "Which model answers. Empty = Hermes' active model. The list shows every "
                                "provider you have configured in Hermes."},
                {"name": "provider", "kind": "provider", "label": "Provider", "default": None, "hidden": True,
                 "description": "Provider of the chosen model; set together with Model."},
                {"name": "system", "kind": "textarea", "label": "System prompt", "default": "",
                 "description": "Standing instructions for the model: role, tone, output format. "
                                "Optional."},
                {"name": "template", "kind": "textarea", "label": "Prompt template", "default": "{{prompt}}",
                 "description": "The message sent to the model. Each {{placeholder}} becomes an input port "
                                "and is replaced by the connected value."},
                {"name": "temperature", "kind": "number", "label": "Temperature", "default": None,
                 "min": 0, "max": 2,
                 "description": "Randomness from 0 (focused, repeatable) to about 1 (creative). "
                                "Empty = the model's default."},
                {"name": "max_tokens", "kind": "number", "label": "Max tokens", "default": None,
                 "min": 1, "integer": True,
                 "description": "Upper limit for the answer length (1 token is about 4 characters). "
                                "Empty = the model's default."},
            ],
            "dynamic_inputs": "template",
        },
        {
            "type": "logic.if", "title": "If", "category": "Logic", "icon": "symbol-boolean",
            "description": "Check a value and pass it on through True or False. Steps after the other output "
                           "are skipped in this run; a Merge brings the branches back together.",
            "inputs": [{"name": "value", "type": "any", "required": True, "label": "Value",
                        "description": "What is checked; it also goes out unchanged on the taken side."},
                       {"name": "compare", "type": "any", "required": False, "label": "Compare to",
                        "description": "Wire a value here to compare against it instead of the setting."}],
            "outputs": [{"name": "true", "type": "any", "label": "True"},
                        {"name": "false", "type": "any", "label": "False"}],
            "params": [
                {"name": "op", "kind": "select", "label": "Condition", "default": "contains", "options": list(X.IF_OPS),
                 "description": "contains / equals / regex compare text; > >= < <= compare numbers (dot for decimals); "
                                "empty is true for blank text, an empty list or nothing at all."},
                {"name": "compare", "kind": "text", "label": "Compare to", "default": "",
                 "description": "The text, number or regular expression to compare with. Not used by empty / not empty. "
                                "Regex: max 512 pattern / 16,384 text characters, 0.5 s deadline."},
                {"name": "case_sensitive", "kind": "boolean", "label": "Case sensitive", "default": False,
                 "description": "Off: Yes, YES and yes are the same for contains, equals and regex."},
            ],
        },
        {
            "type": "logic.switch", "title": "Switch", "category": "Logic", "icon": "symbol-enum",
            "description": "Send a value down the first matching case (one output per case line) or Default. "
                           "Steps after the other outputs are skipped in this run.",
            "inputs": [{"name": "value", "type": "any", "required": True, "label": "Value"}],
            "outputs": [{"name": "default", "type": "any", "label": "Default"}],
            "params": [
                {"name": "cases", "kind": "textarea", "label": "Cases", "default": "",
                 "description": f"One case per line; each line becomes an output (case1, case2, ...), at most "
                                f"{G.MAX_CASES}. The first match wins; nothing matches = Default."},
                {"name": "op", "kind": "select", "label": "Match", "default": "equals",
                 "options": list(X.SWITCH_OPS), "description": "How the value is compared with each case line. "
                                "Regex: max 512 pattern / 16,384 text characters, 0.5 s per case."},
                {"name": "case_sensitive", "kind": "boolean", "label": "Case sensitive", "default": False,
                 "description": "Off: Red and red match the same case."},
            ],
            "dynamic_outputs": "cases",
        },
        {
            "type": "logic.merge", "title": "Merge", "category": "Logic", "icon": "git-merge",
            "description": "Join branches again: passes on the first wired value whose branch ran (wire order). "
                           "Skipped only when none of them ran.",
            "inputs": [{"name": "value", "type": "any", "required": True, "multiple": True, "label": "Values",
                        "description": "Wire one output from each branch; the first one that ran wins."}],
            "outputs": [{"name": "value", "type": "any", "label": "Value"}],
            "params": [],
        },
        {
            "type": "logic.foreach", "title": "For each", "category": "Logic", "icon": "list-ordered",
            "description": "Run the next steps once per list item (a JSON list, or one item per text line). "
                           "A Collect after them gathers the results into a list.",
            "inputs": [{"name": "list", "type": "any", "required": True, "label": "List",
                        "description": "A list, a JSON list as text, or text with one item per line."}],
            "outputs": [{"name": "item", "type": "any", "label": "Item"},
                        {"name": "index", "type": "number", "label": "Index",
                         "description": "Position of the item: 1, 2, 3, ..."}],
            "params": [{"name": "limit", "kind": "number", "label": "Limit", "default": None, "min": 1,
                        "integer": True, "description": "Run at most this many items (the first ones). Empty = the "
                                                        "plugin setting Max items per For each (default 100)."}],
            "cacheable": False,
        },
        {
            "type": "logic.collect", "title": "Collect", "category": "Logic", "icon": "list-flat",
            "description": "Gather what the steps after a For each produced, one entry per item in item order. "
                           "Items that took another branch (If) are left out.",
            "inputs": [{"name": "value", "type": "any", "required": True, "label": "Value"}],
            "outputs": [{"name": "list", "type": "any", "label": "List"}],
            "params": [],
            "cacheable": False,
        },
        {
            "type": "output.preview", "title": "Preview", "category": "Output", "icon": "eye",
            "description": "Show a value on the canvas and mark it as a result of the flow.",
            "inputs": [{"name": "value", "type": "any", "required": True, "label": "Value"}],
            "outputs": [{"name": "value", "type": "any", "label": "Value"}],
            "params": [],
        },
        {
            "type": "note", "title": "Note", "category": "Utility", "icon": "note",
            "description": "A sticky note for the canvas. Never runs.",
            "inputs": [], "outputs": [],
            "params": [{"name": "text", "kind": "textarea", "label": "Note", "default": "",
                        "description": "Free text shown on the canvas, e.g. what this part of the flow does."}],
        },
    ]


def builtin_type_names() -> list:
    return [t["type"] for t in _builtin_types()]


# ----------------------------------------------------------------- configuration

def _config(env, key: str, default=None):
    getter = getattr(getattr(env, "ctx", None), "get_config", None)
    if not callable(getter):
        return default
    try:
        value = getter(key, default)
    except Exception as exc:  # noqa: BLE001 - a broken config read must not hide every tool
        logger.warning("arachne-flow: reading config %s failed: %s", key, exc)
        return default
    return default if value is None else value


def _fold_name(name) -> str:
    return str(name or "").strip().casefold()


class _FoldedSet(set):
    """A set whose entries are already casefolded tool names."""


_DEFAULT_BLOCKED_FOLDED = frozenset(_fold_name(n) for n in DEFAULT_BLOCKED)
_BLOCKED_PREFIXES_FOLDED = tuple(_fold_name(p) for p in BLOCKED_PREFIXES)
_FOLDED_POLICY_CACHE: dict = {}
_WARNED_UNKNOWN_POLICY_NAMES: set = set()


def _folded_set(names) -> _FoldedSet:
    if isinstance(names, _FoldedSet):
        return names
    if not names:
        return _FoldedSet()
    key = names if isinstance(names, frozenset) else frozenset(names)
    cached = _FOLDED_POLICY_CACHE.get(key)
    if cached is None:
        if len(_FOLDED_POLICY_CACHE) >= 64:
            _FOLDED_POLICY_CACHE.clear()
        cached = _FoldedSet(_fold_name(n) for n in key if _fold_name(n))
        _FOLDED_POLICY_CACHE[key] = cached
    return cached


def _as_name_list(value) -> list:
    if isinstance(value, str):
        value = [v.strip() for v in value.split(",")]
    if not isinstance(value, (list, tuple, set, frozenset)):
        return []
    return [_fold_name(v) for v in value if _fold_name(v)]


def tool_policy(env) -> tuple:
    """(blocked, allowed), casefolded. Custom blocks replace defaults except the raw sender."""
    from . import messaging as MSG
    configured = _config(env, "blocked_tools", None)
    blocked = _FoldedSet(_DEFAULT_BLOCKED_FOLDED) if configured is None else _FoldedSet(_as_name_list(configured))
    # A custom block list must not accidentally expose the raw sender. An explicit
    # allow_tools override remains a separate, deliberate user choice in is_blocked.
    blocked.add(_fold_name(MSG.SEND_TOOL))
    allowed = _FoldedSet(_as_name_list(_config(env, "allow_tools", [])))
    return blocked, allowed


def is_blocked(name: str, blocked, allowed) -> bool:
    folded = _fold_name(name)
    if folded in _folded_set(allowed):
        return False
    return folded in _folded_set(blocked) or any(folded.startswith(p) for p in _BLOCKED_PREFIXES_FOLDED)


def _warn_unknown_policy_names(env, available: list, blocked: set, allowed: set) -> None:
    configured = _config(env, "blocked_tools", None)
    checked = (_folded_set(blocked) if configured is not None else set()) | _folded_set(allowed)
    if not checked:
        return
    known = ({_fold_name(t.get("name")) for t in available if isinstance(t, dict) and t.get("name")}
             | _DEFAULT_BLOCKED_FOLDED
             | _READ_ONLY_FOLDED)
    unknown = sorted(n for n in checked if n not in known and n not in _WARNED_UNKNOWN_POLICY_NAMES)
    if unknown:
        _WARNED_UNKNOWN_POLICY_NAMES.update(unknown)
        logger.warning("arachne-flow: unknown tool name(s) in blocked_tools/allow_tools: %s", ", ".join(unknown))


# ----------------------------------------------------------------- registry access

def registry_tools(env) -> list:
    """Available tools as [{name, toolset, description, parameters}].

    Tests (and the dev server) inject ``env.state["tool_source"]``: a callable returning that list.
    Otherwise the Hermes registry is asked, keeping only tools whose availability check passes.
    """
    source = (getattr(env, "state", None) or {}).get("tool_source")
    if callable(source):
        return [dict(t) for t in source()]
    try:
        from tools.registry import registry
    except ImportError:  # outside Hermes (plain unit tests without injection)
        return []
    names = set(registry.get_all_tool_names())
    out = []
    for definition in registry.get_definitions(names, quiet=True):
        fn = definition.get("function") or {}
        name = fn.get("name")
        if not name:
            continue
        out.append({
            "name": name,
            "toolset": registry.get_toolset_for_tool(name) or "",
            "description": fn.get("description") or "",
            "parameters": fn.get("parameters") or {},
        })
    return out


# Hermes tools that only read. Everything else — every MCP tool included: Hermes records the server's
# readOnlyHint only in private core, which a plugin must not import (catalog rule 9) — is not cached by
# default, because a cached write would silently never run again (review E-8). Presets stay cached.
READ_ONLY_TOOLS = frozenset({
    "read_file", "search_files", "web_search", "web_extract", "vision_analyze", "session_search",
    "skills_list", "skill_view",
})
_READ_ONLY_FOLDED = frozenset(_fold_name(n) for n in READ_ONLY_TOOLS)


def tool_reads_only(tool: dict) -> bool:
    """Cached by default? Only for the allowlist or a tool entry flagged ``read_only`` (the seam for a public
    Hermes read-only flag; today only the dev server and tests set it). No guessing from names."""
    return tool.get("read_only") is True or str(tool.get("name") or "") in READ_ONLY_TOOLS


# ----------------------------------------------------------------- tool -> node type

def mcp_server(name: str):
    """'mcp__nanogpt__nanogpt_get_balance' -> 'nanogpt'; None for non-MCP tools."""
    if name.startswith("mcp__"):
        parts = name.split("__")
        if len(parts) >= 3 and parts[1]:
            return parts[1]
    return None


def tool_title(name: str) -> str:
    server = mcp_server(name)
    short = name
    if server:
        short = name.split("__", 2)[2]
        if short.startswith(server + "_"):
            short = short[len(server) + 1:]
    words = short.replace("__", "_").replace("-", "_").strip("_").split("_")
    text = " ".join(w for w in words if w)
    return (text[:1].upper() + text[1:]) if text else name


def tool_category(name: str, toolset: str) -> str:
    server = mcp_server(name)
    if server:
        return f"MCP · {server}"
    return f"Tools · {toolset or 'other'}"


def tool_icon(name: str, toolset: str) -> str:
    if mcp_server(name):
        return "plug"
    for key, icon in _TOOLSET_ICONS.items():
        if key in (toolset or "") or key in name:
            return icon
    return "tools"


_ACRONYMS = {"url": "URL", "urls": "URLs", "id": "ID", "ids": "IDs", "api": "API", "json": "JSON", "mcp": "MCP",
             "tts": "TTS", "3d": "3D", "llm": "LLM", "html": "HTML", "pdf": "PDF", "uri": "URI"}


def _label(name: str) -> str:
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name).replace("_", " ").replace("-", " ").strip()
    words = [_ACRONYMS.get(w.lower(), w.lower()) for w in text.split()]
    text = " ".join(words)
    return (text[:1].upper() + text[1:]) if text else name


def _schema_label(name: str, prop: dict) -> str:
    """Schema titles that only restate the property name ("Image Url" from pydantic) get our sentence case."""
    title = prop.get("title")
    if not isinstance(title, str) or not title.strip():
        return _label(name)
    if re.sub(r"[\s_-]", "", title).lower() == re.sub(r"[\s_-]", "", name).lower():
        return _label(name)
    return title.strip()


def _schema_type(prop: dict):
    t = prop.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), None)
    if t is None:
        for key in ("anyOf", "oneOf"):
            options = prop.get(key)
            if isinstance(options, list):
                kinds = {o.get("type") for o in options if isinstance(o, dict)} - {None, "null"}
                if len(kinds) == 1:
                    t = kinds.pop()
                elif kinds:
                    t = "mixed"
    return t


_SCALARS = {"string", "number", "integer", "boolean"}


def _scalar_union(prop: dict) -> set:
    """Kinds of an anyOf/oneOf made only of scalars (e.g. video ``duration``: number | string), else empty."""
    for key in ("anyOf", "oneOf"):
        options = prop.get(key)
        if isinstance(options, list):
            kinds = {o.get("type") for o in options if isinstance(o, dict)} - {None, "null"}
            return kinds if kinds and kinds <= _SCALARS and len(kinds) > 1 else set()
    return set()


def _bounds(param: dict, prop: dict, integer: bool) -> None:
    """JSON-schema minimum/maximum (also exclusive*, multipleOf) -> param min/max/step for the number field (G7)."""
    for key, out, flag in (("minimum", "min", ""), ("maximum", "max", ""),
                           ("exclusiveMinimum", "min", "min_exclusive"), ("exclusiveMaximum", "max", "max_exclusive")):
        value = prop.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):  # draft-04 booleans are skipped
            param[out] = value
            if flag:
                param[flag] = True
    if isinstance(prop.get("multipleOf"), (int, float)) and not isinstance(prop.get("multipleOf"), bool) \
            and prop["multipleOf"] > 0:
        param["step"] = prop["multipleOf"]
    if integer:
        param["integer"] = True


def media_kind_for(name: str):
    """Media kind implied by a schema argument name; None for ordinary text/URL settings.

    Exact ``url(s)`` stays a web/JSON setting. Names such as ``imageUrls`` or ``audioDataUrl``
    become media inputs, regardless of which provider owns the tool.
    """
    norm = name.lower().replace("-", "_")
    if norm in {"url", "urls", "uri", "uris", "model", "model_id", "model_name", "model_slug", "modelslug"} \
            or norm.endswith("_model") or re.search(r"attachment_?ids?$", norm):
        return None
    if re.search(r"(?:_prompt|_text|_description|_seed|_format|_quality|_size|_width|_height|_count|"
                 r"_steps|_duration|_resolution|_aspect_ratio|_strength|_scale|_guidance|_name|_config)$", norm):
        return None
    if not _MEDIA_HINT.search(norm):
        return None
    if any(word in norm for word in ("image", "img", "photo", "picture", "mask")):
        return "image"
    if any(word in norm for word in ("audio", "voice", "sound", "speech")):
        return "audio"
    if "video" in norm:
        return "video"
    if any(word in norm for word in ("model", "mesh", "glb")):
        return "model3d"
    if "file" in norm or "path" in norm:
        return "file"
    return "any"


def property_port(name: str, prop: dict, required: bool) -> tuple:
    """(input port, param spec) for one JSON-schema property."""
    prop = prop if isinstance(prop, dict) else {}
    t = _schema_type(prop)
    media_kind = media_kind_for(name)
    items = prop.get("items") if isinstance(prop.get("items"), dict) else {}
    if media_kind and (t in ("string", None) or (t == "array" and items.get("type", "string") == "string")):
        multiple = t == "array"
        label = _schema_label(name, prop)
        port = {"name": name, "type": media_kind if media_kind in ptypes.MEDIA_KINDS else "any",
                "required": bool(required), "label": label}
        param = {"name": name, "kind": "media_list" if multiple else "media", "label": label,
                 "default": [] if multiple else prop.get("default"), "media_kind": media_kind}
        if multiple:
            port["multiple"] = True
            for key, target in (("minItems", "min_items"), ("maxItems", "max_items")):
                if isinstance(prop.get(key), int) and not isinstance(prop.get(key), bool):
                    param[target] = prop[key]
                    port["min" if key == "minItems" else "max"] = prop[key]
        description = prop.get("description")
        if isinstance(description, str) and description:
            port["description"] = description[:300]
            param["description"] = description[:300]
        if required:
            param["required"] = True
        return port, param
    enum = prop.get("enum") if isinstance(prop.get("enum"), list) else None
    items = prop.get("items") if isinstance(prop.get("items"), dict) else {}
    item_enum = items.get("enum") if t == "array" and isinstance(items.get("enum"), list) else None
    union = _scalar_union(prop) if t == "mixed" else set()
    if t in ("number", "integer"):
        ptype, kind = "number", "select" if enum else "number"
    elif t == "boolean":
        ptype, kind = "boolean", "boolean"
    elif item_enum:
        ptype, kind = "json", "multiselect"
    elif union:
        ptype, kind = "json", "text"  # typed as text; numbers stay numbers (``numeric``), e.g. "auto" or 6
    elif t in ("array", "object", "mixed"):
        ptype, kind = "json", "json"
    elif t == "string" or t is None:
        if enum:
            ptype, kind = "text", "select"
        elif _MEDIA_HINT.search(name):
            ptype, kind = "any", "text"
        else:
            ptype, kind = "text", "textarea" if _LONG_TEXT.match(name) else "text"
    else:
        ptype, kind = "any", "json"
    label = _schema_label(name, prop)
    port = {"name": name, "type": ptype, "required": bool(required), "label": label}
    param = {"name": name, "kind": kind, "label": label, "default": prop.get("default")}
    description = prop.get("description")
    if isinstance(description, str) and description:
        port["description"] = description[:300]
        param["description"] = description[:300]
    if enum:
        param["options"] = [e for e in enum if isinstance(e, (str, int, float, bool))]
    if t in ("number", "integer") and not enum:
        _bounds(param, prop, t == "integer")
    if item_enum:
        param["options"] = [e for e in item_enum if isinstance(e, (str, int, float)) and not isinstance(e, bool)]
        for key, out in (("minItems", "min_items"), ("maxItems", "max_items")):
            if isinstance(prop.get(key), int) and not isinstance(prop.get(key), bool):
                param[out] = prop[key]
    if union & {"number", "integer"}:
        param["numeric"] = True
    if required:
        param["required"] = True
    return port, param


def tool_node_type(tool: dict, peers=()) -> dict:
    """Node spec for one registry tool. ``peers`` = names of the other usable tools (model list pairing)."""
    from . import options as O  # late import: options imports executors

    name = tool["name"]
    toolset = tool.get("toolset") or ""
    params_schema = tool.get("parameters") if isinstance(tool.get("parameters"), dict) else {}
    props = params_schema.get("properties") if isinstance(params_schema.get("properties"), dict) else {}
    required = set(params_schema.get("required") or []) if isinstance(params_schema.get("required"), list) else set()
    inputs, params = [], []
    source = None
    for prop_name, prop in props.items():
        port, param = property_port(prop_name, prop, prop_name in required)
        if param["kind"] == "text" and O.is_model_param(prop_name):
            source = source if source is not None else (O.options_source(name, peers) or "")
            if source:
                param["options_source"] = source
                param.setdefault("description", f"Which model to use. The list comes from {tool_title(source)}.")
        inputs.append(port)
        params.append(param)
    model_param = next((p["name"] for p in params if p.get("options_source")), None)
    if model_param:
        for param in params:  # G7: these settings follow the chosen model's list entry (GET /x/options&model=)
            if param["name"] in O.MODEL_FIELDS:
                param["from_model"] = model_param
    description = (tool.get("description") or "").strip()
    extra = {"open_params": True} if params_schema.get("additionalProperties") is True else {}
    return {
        **extra,
        "type": TOOL_PREFIX + name,
        "kind": "tool",
        "tool": name,
        "title": tool_title(name),
        "category": tool_category(name, toolset),
        "icon": tool_icon(name, toolset),
        "description": description[:400],
        "inputs": inputs,
        "outputs": [
            {"name": "result", "type": "json", "label": "Result"},
            {"name": "text", "type": "text", "label": "Text"},
            {"name": "media", "type": "any", "label": "Media"},
        ],
        "params": params,
        "cache_default": tool_reads_only(tool),  # review E-8; the inspector switch overrides it
    }


def _extra_types(env, tools: list, available=None) -> list:
    """Curated nodes over available tools. Messaging checks the whole registry, not just the usable subset:
    its send tool is blocked as a raw palette node on purpose, and only this node may use it."""
    from . import messaging as MSG
    from . import presets
    result = []
    if MSG.registered(available if available is not None else tools):
        sources = env.state.setdefault("options_sources", {})
        # Persist only data; callback objects would retain a pre-reload parser.
        sources["messaging_channels"] = {
            "tool": MSG.CHANNEL_TOOL, "args": {}, "options_path": "channels",
            "value": "target", "label": "target",
        }
        result.append(MSG.spec())
    return result + presets.preset_types(tools)


# ----------------------------------------------------------------- listing

def _category_rank(category: str) -> tuple:
    if category in CATEGORY_ORDER:
        return (0, CATEGORY_ORDER.index(category), category)
    if category.startswith("Tools · "):
        return (1, 0, category)
    if category.startswith("MCP · "):
        return (2, 0, category)
    return (3, 0, category)


def list_node_types(env, tools=None, fresh: bool = False) -> list:
    """Every node type the canvas may offer, built-ins first; cached CACHE_TTL_S in env.state."""
    state = env.state if isinstance(getattr(env, "state", None), dict) else {}
    blocked, allowed = tool_policy(env)
    cache_key = (tuple(sorted(blocked)), tuple(sorted(allowed)))
    cached = state.get("node_types_cache")
    if tools is None and not fresh and cached and cached[0] == cache_key and time.monotonic() - cached[1] < CACHE_TTL_S:
        return cached[2]
    available = registry_tools(env) if tools is None else [dict(t) for t in tools]
    _warn_unknown_policy_names(env, available, blocked, allowed)
    usable = [t for t in available if t.get("name") and not is_blocked(t["name"], blocked, allowed)]
    result = _builtin_types()
    peers = {t["name"] for t in usable}
    for tool in sorted(usable, key=lambda t: t["name"]):
        try:
            result.append(tool_node_type(tool, peers))
        except Exception as exc:  # noqa: BLE001 - one odd schema must not hide the rest
            logger.warning("arachne-flow: skipping tool %s: %s", tool.get("name"), exc)
    result.extend(_extra_types(env, usable, available))
    for spec in result:
        spec.setdefault("kind", "builtin")
    result.sort(key=lambda s: _category_rank(s.get("category", "")))
    if tools is None:
        state["node_types_cache"] = (cache_key, time.monotonic(), result)
    return result


def invalidate(env) -> None:
    if isinstance(getattr(env, "state", None), dict):
        env.state.pop("node_types_cache", None)


class TypeIndex(dict):
    """``{type: spec}``; a ready-made node pinned to a provider this setup lacks (``preset.x~server``) falls back
    to the same step on the best available provider, so shared flows and templates run anywhere."""

    def _fallback(self, key):
        if isinstance(key, str) and key.startswith("preset.") and "~" in key:
            return dict.get(self, key.split("~", 1)[0])
        return None

    def get(self, key, default=None):
        return dict.get(self, key) or self._fallback(key) or default

    def __contains__(self, key):
        return dict.__contains__(self, key) or self._fallback(key) is not None

    def __missing__(self, key):
        found = self._fallback(key)
        if found is None:
            raise KeyError(key)
        return found


def types_by_name(env, tools=None) -> dict:
    return TypeIndex((spec["type"], spec) for spec in list_node_types(env, tools=tools))


def get_type(env, type_name: str, tools=None):
    return types_by_name(env, tools=tools).get(type_name)


def categories(type_list: list) -> list:
    seen, out = set(), []
    for spec in type_list:
        c = spec.get("category", "")
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def node_types_payload(env, tools=None) -> dict:
    """Body of GET /x/node-types."""
    type_list = list_node_types(env, tools=tools)
    from . import media as M
    return {
        "types": type_list,
        "categories": categories(type_list),
        "port_types": ptypes.port_types(),
        "compat": ptypes.compat_table(),
        "ext_kinds": dict(M.EXT_KIND),          # File node: dialog filters and drop checks (G3)
        "upload_max_bytes": M.MAX_UPLOAD_BYTES,
    }
