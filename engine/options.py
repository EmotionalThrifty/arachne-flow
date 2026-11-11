"""Choice lists for tool settings that name a model (F6).

Any tool parameter called ``model`` (or ``model_id`` / ``*_model``) gets a dropdown when a sibling "list models"
tool exists on the same MCP server / in Hermes: ``nanogpt_image_generate`` -> ``nanogpt_list_image_models``.
No provider-specific code: the pairing is by name, the parsing walks the usual ``{data: [{id, name, ...}]}``.
"""
from __future__ import annotations

import json
import os
import re
import time

from . import executors as E
from . import media as M
from . import types as ptypes

MODEL_PARAM = re.compile(r"^(model|model_?id|model_?name|[a-z0-9]+_model)$", re.I)
_LIST_TOOL = re.compile(r"list_?\w*models?$", re.I)
OPTIONS_TTL_S = 600.0
MAX_OPTIONS = 2000

# Media kind a tool works on, guessed from its name; order matters ("image_to_3d" is 3D, "text_to_speech" audio).
_KINDS = (
    ("3d", ("3d", "mesh")),
    ("video", ("video",)),
    ("audio", ("audio", "speech", "tts", "transcri", "music", "voice", "sound")),
    ("image", ("image", "img", "picture", "photo")),
    ("text", ("chat", "text", "complet", "llm", "embed", "vision")),
)


def _server_prefix(name: str) -> str:
    """``mcp__nanogpt__nanogpt_x`` -> ``mcp__nanogpt__``; built-in tools share the empty prefix."""
    if name.startswith("mcp__") and name.count("__") >= 2:
        return name[: name.index("__", 5) + 2]
    return ""


def tool_kind(name: str):
    short = name.rsplit("__", 1)[-1].lower()
    for kind, words in _KINDS:
        if any(w in short for w in words):
            return kind
    return None


def is_model_param(name: str) -> bool:
    return bool(MODEL_PARAM.match(name or ""))


def options_source(tool_name: str, peers) -> str | None:
    """Name of the tool that lists models for ``tool_name``, or None. ``peers`` = every available tool name."""
    prefix = _server_prefix(tool_name)
    if not prefix:
        return None  # built-in Hermes tools pick their own model; only MCP servers expose list tools
    candidates = sorted(n for n in peers if n != tool_name and n.startswith(prefix)
                        and _LIST_TOOL.search(n.rsplit("__", 1)[-1]))
    if not candidates:
        return None
    kind = tool_kind(tool_name)
    if kind:
        words = dict(_KINDS)[kind]
        matching = [n for n in candidates if any(w in n.rsplit("__", 1)[-1].lower() for w in words)]
        if matching:
            return matching[0]
    return candidates[0] if len(candidates) == 1 else None


# ----------------------------------------------------------------- parsing

def _model_rows(value, depth=0):
    """First list of dicts carrying an ``id`` found in a tool result (data / models / structuredContent ...)."""
    if depth > 4:
        return []
    if isinstance(value, list):
        rows = [v for v in value if isinstance(v, dict) and isinstance(v.get("id") or v.get("model"), str)]
        if rows:
            return rows
        if value and all(isinstance(v, str) for v in value):
            return [{"id": v} for v in value]
        return []
    if isinstance(value, str):
        parsed = E.parse_tool_result(value)
        return _model_rows(parsed, depth + 1) if not isinstance(parsed, str) else []
    if isinstance(value, dict):
        for key in ("data", "models", "structuredContent", "result", "items"):
            if key in value:
                rows = _model_rows(value[key], depth + 1)
                if rows:
                    return rows
    return []


def _price(row: dict):
    pricing = row.get("pricing")
    if not isinstance(pricing, dict):
        return None
    for key in ("starting_at", "per_run", "per_image", "per_generation", "price", "per_second"):
        value = pricing.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
        if isinstance(value, dict):
            nums = [v for v in value.values() if isinstance(v, (int, float)) and v > 0]
            if nums:
                return float(min(nums))
    nums = []
    for value in pricing.values():
        if isinstance(value, dict):
            nums.extend(v for v in value.values() if isinstance(v, (int, float)) and v > 0)
    return float(min(nums)) if nums else None


def _modalities(row: dict):
    arch = row.get("architecture") if isinstance(row.get("architecture"), dict) else {}
    ins = arch.get("input_modalities") if isinstance(arch.get("input_modalities"), list) else None
    outs = arch.get("output_modalities") if isinstance(arch.get("output_modalities"), list) else None
    return ([str(x).lower() for x in ins] if ins is not None else None,
            [str(x).lower() for x in outs] if outs is not None else None)


def to_options(result, accepts=None) -> list:
    """Tool result -> ``[{value, label, group, price, description}]``. ``accepts`` keeps models whose
    input modalities include that kind (e.g. "image" for image-to-3D); rows without modality data stay."""
    out, seen = [], set()
    for row in _model_rows(result):
        value = row.get("id") or row.get("model")
        if not isinstance(value, str) or not value or value in seen:
            continue
        ins, _ = _modalities(row)
        if accepts and ins is not None and accepts not in ins:
            continue
        caps = row.get("capabilities") if isinstance(row.get("capabilities"), dict) else {}
        if caps.get("requires_mesh"):
            continue  # mesh post-processing models, not generators
        seen.add(value)
        name = row.get("name") if isinstance(row.get("name"), str) else ""
        group = row.get("owned_by") or row.get("provider") or (value.split("/", 1)[0] if "/" in value else "")
        description = row.get("description") if isinstance(row.get("description"), str) else ""
        pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
        unit = "/s" if isinstance(pricing.get("per_second"), (int, float)) and not any(
            isinstance(pricing.get(k), (int, float)) for k in ("starting_at", "per_run", "per_image")) else ""
        out.append({"value": value, "label": name or value, "group": str(group or "Other"),
                    "price": _price(row), "unit": unit, "description": description[:240]})
        if len(out) >= MAX_OPTIONS:
            break
    return out


async def _list_result(env, list_tool: str, refresh=False, args=None) -> tuple:
    """(raw list-tool result, cached?) — one call per tool+args every OPTIONS_TTL_S, shared by models and settings."""
    from . import nodes as N

    blocked, allowed = N.tool_policy(env)
    if N.is_blocked(list_tool, blocked, allowed):
        raise E.NodeError(f"{list_tool} is blocked in the Arachne Flow settings")
    state = env.state if isinstance(getattr(env, "state", None), dict) else {}
    cache = state.setdefault("options_cache", {})
    key = list_tool if not args else f"{list_tool}\u0000{json.dumps(args, sort_keys=True)}"
    hit = cache.get(key)
    cached = bool(hit and not refresh and time.monotonic() - hit[0] < OPTIONS_TTL_S)
    if cached:
        return hit[1], True
    result = await E.call_tool(env, list_tool, args or {}, timeout=90)
    cache[key] = (time.monotonic(), result)
    return result, False


async def fetch_options(env, list_tool: str, accepts=None, refresh=False) -> dict:
    """Call a model-list tool or the exact, dedicated messaging directory."""
    if list_tool == "messaging_channels":
        source = (env.state.get("options_sources") or {}).get(list_tool)
        if not source:
            raise E.NodeError("Hermes' official messaging bridge is not configured")
        result, cached = await _list_result(env, source["tool"], refresh, source.get("args") or {})
        # Env.state survives engine reloads. Never call a parser retained from
        # an older module instance: use the current messaging implementation.
        from . import messaging as MSG
        return {"options": MSG.channel_options(result), "source": source["tool"], "cached": cached}
    """Call the list tool (cached OPTIONS_TTL_S per tool) and return ``{options, source, cached}``."""
    result, cached = await _list_result(env, list_tool, refresh)
    return {"options": to_options(result, accepts=accepts), "source": list_tool, "cached": cached}


# ----------------------------------------------------------------- model-driven settings (G7)
# Which tool settings a model's list entry describes. Only shapes seen in the live NanoGPT lists (06.11.2026,
# fixture tests/fixtures/nanogpt_models.json) and named in the NanoGPT docs are read; no model id is special-cased.
#  - image lists (docs endpoint/image-models): supported_parameters.resolutions "to populate resolution or size
#    controls" -> `size` (the OpenAI-compatible /v1/images/generations that the MCP calls says size reads
#    resolutions), max_images "per request" -> max of `n`, fixed_image_count -> fixed `n`; aspect_ratio [..] and
#    quality [..] lists as seen live; pricing.per_image keyed like resolutions (+ "auto").
#  - video / 3D lists: supported_parameters.parameters.<name> = {type, label, options [{label, value}], default,
#    min, max} (seen live; docs: "duration, aspect_ratio, resolution"); pricing.supported_durations, per_second,
#    per_second_by_resolution, per_duration, per_video, per_run, minimum (smallest charge), note.
MODEL_FIELDS = ("size", "n", "duration", "resolution", "aspect_ratio", "quality")
_MAX_CHOICES = 200


def _num(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _choice(value, label=None, price=None, unit=""):
    out = {"value": str(value), "label": str(label) if label not in (None, "") else str(value)}
    if price is not None:
        out["price"], out["unit"] = price, unit
    return out


def _range(field: dict, src: dict) -> None:
    for key, out in (("min", "min"), ("max", "max"), ("step", "step")):
        n = _num(src.get(key))
        if n is not None:
            field[out] = n


def _from_descriptor(desc) -> dict:
    """``parameters.<name>`` (video/3D lists) or a documented ``{type: enum|range, values, min, max, default}``."""
    if isinstance(desc, list):
        values = [v for v in desc if isinstance(v, (str, int, float)) and not isinstance(v, bool)]
        return {"options": [_choice(v) for v in values[:_MAX_CHOICES]]} if values else {}
    if not isinstance(desc, dict):
        return {}
    field = {}
    options = desc.get("options") if isinstance(desc.get("options"), list) else \
        desc.get("values") if isinstance(desc.get("values"), list) else desc.get("enum")
    if isinstance(options, list):
        choices = []
        for o in options[:_MAX_CHOICES]:
            if isinstance(o, dict) and isinstance(o.get("value"), (str, int, float)) and not isinstance(o.get("value"), bool):
                choices.append(_choice(o["value"], o.get("label")))
            elif isinstance(o, (str, int, float)) and not isinstance(o, bool):
                choices.append(_choice(o))
        if choices:
            field["options"] = choices
    _range(field, desc)
    if desc.get("type") == "integer":
        field["integer"] = True
    if isinstance(desc.get("default"), (str, int, float)) and not isinstance(desc.get("default"), bool) \
            and desc.get("default") != "":
        field["default"] = str(desc["default"])
    if isinstance(desc.get("description"), str) and desc["description"].strip():
        field["description"] = desc["description"].strip()[:200]
    return field


def model_fields(row: dict) -> dict:
    """List-tool row -> ``{setting: {options?, min?, max?, step?, integer?, default?, description?}}`` for the
    image-list keys (MODEL_FIELDS) and every described ``parameters.<name>`` (G7b). Pure, tested."""
    sp = row.get("supported_parameters") if isinstance(row.get("supported_parameters"), dict) else {}
    pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
    described = sp.get("parameters") if isinstance(sp.get("parameters"), dict) else {}
    out = {}
    for name in list(MODEL_FIELDS) + [n for n in described if isinstance(n, str) and n not in MODEL_FIELDS]:
        field = _from_descriptor(described.get(name)) or (_from_descriptor(sp.get(name)) if name in MODEL_FIELDS else {})
        if field:
            out[name] = field
    if "size" not in out and isinstance(sp.get("resolutions"), list):
        field = _from_descriptor(sp["resolutions"])
        if field:
            out["size"] = field
    if "n" not in out and _num(sp.get("fixed_image_count")):
        k = _num(sp["fixed_image_count"])
        out["n"] = {"min": k, "max": k, "integer": True, "description": f"This model always returns {k:g} image(s)."}
    if "n" not in out and _num(sp.get("max_images")):
        out["n"] = {"min": 1.0, "max": _num(sp["max_images"]), "integer": True}
    durations = pricing.get("supported_durations")
    if "duration" not in out and isinstance(durations, list) and durations:
        out["duration"] = _from_descriptor(durations)
    per_image = pricing.get("per_image") if isinstance(pricing.get("per_image"), dict) else {}
    by_res = pricing.get("per_second_by_resolution") if isinstance(pricing.get("per_second_by_resolution"), dict) else {}
    per_duration = pricing.get("per_duration") if isinstance(pricing.get("per_duration"), dict) else {}
    for name, prices, unit in (("size", per_image, ""), ("resolution", by_res, "/s"), ("duration", per_duration, "")):
        for choice in (out.get(name) or {}).get("options", []):
            price = _num(prices.get(choice["value"]))
            if price is not None:
                choice["price"], choice["unit"] = price, unit
    return out


def model_cost(row: dict):
    """How a model is billed, as data the canvas multiplies out (``estimateCost`` in plugin.js). None when the
    list gives no simple rate (token or credit billing); ``note`` and ``minimum`` pass through. Pure, tested."""
    pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
    cost = None
    per_image = pricing.get("per_image")
    if isinstance(per_image, dict) and any(_num(v) is not None for v in per_image.values()):
        prices = {str(k): _num(v) for k, v in per_image.items() if _num(v) is not None}
        cost = {"unit": "image", "by": "size", "prices": prices, "times": "n"}
        if _num(per_image.get("auto")) is not None:
            cost["base"] = _num(per_image["auto"])
        elif len(set(prices.values())) == 1:
            cost["base"] = next(iter(prices.values()))
    elif _num(per_image) is not None:
        cost = {"unit": "image", "base": _num(per_image), "times": "n"}
    elif isinstance(pricing.get("per_second_by_resolution"), dict):
        prices = {str(k): _num(v) for k, v in pricing["per_second_by_resolution"].items() if _num(v) is not None}
        cost = {"unit": "second", "by": "resolution", "prices": prices, "times": "duration"}
    elif _num(pricing.get("per_second")) is not None:
        cost = {"unit": "second", "base": _num(pricing["per_second"]), "times": "duration"}
    elif isinstance(pricing.get("per_duration"), dict):
        prices = {str(k): _num(v) for k, v in pricing["per_duration"].items() if _num(v) is not None}
        cost = {"unit": "video", "by": "duration", "prices": prices}
    elif _num(pricing.get("per_video")) is not None:
        cost = {"unit": "video", "base": _num(pricing["per_video"])}
    elif _num(pricing.get("per_run")) is not None:
        cost = {"unit": "run", "base": _num(pricing["per_run"])}
        variants = pricing.get("per_run_by_variant") if isinstance(pricing.get("per_run_by_variant"), dict) else {}
        prices = sorted({_num(v) for v in variants.values() if _num(v) is not None})
        if len(prices) > 1:  # e.g. Meshy: textures / 2K / rigging change the price; the list names no mapping
            cost["range"] = [prices[0], prices[-1]]
    extra = {}
    if _num(pricing.get("minimum")):
        extra["minimum"] = _num(pricing["minimum"])
    if isinstance(pricing.get("note"), str) and pricing["note"].strip():
        extra["note"] = pricing["note"].strip()[:240]
    if cost is None:
        return extra or None
    if isinstance(pricing.get("currency"), str):
        cost["currency"] = pricing["currency"]
    return {**cost, **extra}


# The list's parameter types (live video/3D lists: select, switch, boolean, number, integer, text, string, array).
_DESC_KIND = {"select": "select", "switch": "boolean", "boolean": "boolean", "number": "number", "integer": "number",
              "text": "text", "string": "text", "array": "json"}
# Never offered as extra settings: what every media node handles itself, and NanoGPT upload ids (no canvas source).
NODE_OWNED = {"model", "prompt", "operation", "runId", "jobId", "requestId", "modelSlug", "include_raw",
              "response_format", "poll_interval_ms", "timeout_ms", "timeout_s", "cache", "provider"}
_UPLOAD_ID = re.compile(r"attachment_?ids?$", re.I)
MAX_EXTRA = 60


def model_params(row: dict) -> list:
    """Every setting a list row describes under ``supported_parameters.parameters`` as an inspector field:
    ``[{name, kind, label, options?, min?, max?, step?, integer?, default?, description?, show_when?, aliases?,
    required?, max_items?, max_length?}]``. Pure, tested."""
    sp = row.get("supported_parameters") if isinstance(row.get("supported_parameters"), dict) else {}
    described = sp.get("parameters") if isinstance(sp.get("parameters"), dict) else {}
    out = []
    from . import nodes as N  # late import: nodes uses this module while building tool specs
    for name, desc in described.items():
        if not isinstance(name, str) or not isinstance(desc, dict) or name in NODE_OWNED or _UPLOAD_ID.search(name):
            continue
        field = _from_descriptor(desc)
        kind = _DESC_KIND.get(desc.get("type")) or ("select" if field.get("options") else "text")
        media_kind = N.media_kind_for(name)
        if media_kind and desc.get("type") in ("text", "string"):
            kind = "media"
        elif media_kind and desc.get("type") == "array":
            kind = "media_list"
        # Catalogs sometimes type a bounded URL list as text (reference_images/reference_audios).
        if media_kind and re.search(r"(?:images|audios|videos|files|urls)$", name, re.I) \
                and (desc.get("max_items", desc.get("maxItems", 2)) != 1):
            kind = "media_list"
        if field.get("options") and kind in ("text", "number"):
            kind = "select"
        label = desc.get("label") if isinstance(desc.get("label"), str) and desc["label"].strip() else name
        item = {"name": name, "kind": kind, "label": label.strip()[:80], **field}
        if kind in ("media", "media_list"):
            item["media_kind"] = media_kind
        if desc.get("type") in ("number", "integer") and kind == "select":
            item["numeric"] = True
        if isinstance(desc.get("default"), bool):
            item["default"] = desc["default"]
        if isinstance(desc.get("showWhen"), dict) and desc["showWhen"]:
            item["show_when"] = {str(k): v for k, v in desc["showWhen"].items()
                                 if isinstance(v, (str, int, float, bool, list))}
        if isinstance(desc.get("aliases"), list):
            item["aliases"] = [a for a in desc["aliases"] if isinstance(a, str)][:12]
        if desc.get("required") is True:
            item["required"] = True
        for key, out_key in (("min_items", "min_items"), ("minItems", "min_items"),
                             ("max_items", "max_items"), ("maxItems", "max_items"), ("maxLength", "max_length")):
            if isinstance(desc.get(key), int) and not isinstance(desc.get(key), bool):
                item[out_key] = desc[key]
        if isinstance(desc.get("placeholder"), str) and desc["placeholder"].strip():
            item["placeholder"] = desc["placeholder"].strip()[:120]
        out.append(item)
        if len(out) >= MAX_EXTRA:
            break
    return out


def extra_params(row: dict, claimed) -> list:
    """``model_params`` minus what the node already covers (its tool's own arguments, also under an alias)."""
    taken = set(claimed or ())
    return [p for p in model_params(row) if p["name"] not in taken and not taken & set(p.get("aliases") or ())]


def model_info(result, model: str, wanted=None, claimed=None) -> dict:
    """``{model, found, label, fields, params, cost, price}`` for one model of a list result. ``wanted`` limits
    ``fields`` to the node's settings; ``claimed`` (tool arguments the node covers) enables ``params`` = the
    model's further settings, for tools that accept extra arguments; ``None`` = none."""
    row = next((r for r in _model_rows(result) if (r.get("id") or r.get("model")) == model), None)
    if row is None:
        return {"model": model, "found": False, "fields": {}, "params": [], "cost": None, "price": None}
    fields = model_fields(row)
    if wanted is not None:
        fields = {k: v for k, v in fields.items() if k in wanted}
    name = row.get("name") if isinstance(row.get("name"), str) else ""
    return {"model": model, "found": True, "label": name or model, "fields": fields,
            "params": extra_params(row, claimed) if claimed is not None else [], "cost": model_cost(row),
            "price": _price(row), "max_images": row_max_images(row)}


# ----------------------------------------------------------------- LLM node: what the provider says about the model (G7c)
# Hermes' model.options RPC gives the renderer pricing/capabilities only for some providers; a provider that also
# publishes a model list through an MCP tool (NanoGPT) tells us more, without reading keys or provider internals.
MAX_LL_LIST_TOOLS = 3
_HOST_STOP = {"api", "v1", "v2", "www", "com", "net", "org", "ai", "dev", "io", "openai", "anthropic"}


def llm_list_candidates(tools, provider: str, api_url: str = "", provider_name: str = "") -> list:
    """Text-model list tools of the enabled MCP servers, best match first for this provider (host or name).
    The LLM node also tries the rest, because a custom provider's slug says nothing about its catalog."""
    want = [n for n in tools if tool_kind(n) == "text" and _LIST_TOOL.search(n.rsplit("__", 1)[-1])]
    tokens = {t for part in (provider or "", api_url or "", provider_name or "") for t in re.split(r"[^a-z0-9]+", part.lower())
              if len(t) >= 4 and t not in _HOST_STOP}
    def score(name):
        server = _server_prefix(name).lower()
        return sum(1 for t in tokens if t in server)
    return sorted(want, key=lambda n: (-score(n), n))


def llm_pricing(row: dict):
    """A provider catalog's token price, normalized to USD per million tokens; only documented shapes."""
    pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
    unit = str(pricing.get("unit") or "")
    if unit != "per_million_tokens":
        return None
    inp, out = _num(pricing.get("prompt")), _num(pricing.get("completion"))
    if inp is None and out is None:
        return None
    result = {"input": inp, "output": out, "unit": "/Mtok"}
    for key, label in (("cacheReadInputPer1kTokens", "cache_read"), ("cacheWriteInputPer1kTokens", "cache_write")):
        if _num(pricing.get(key)) is not None:
            result[label] = _num(pricing[key]) * 1000
    return result


def llm_row_info(row: dict) -> dict:
    """One provider-catalog row (NanoGPT ``/api/v1/models?detailed=true``) -> the facts the LLM node shows."""
    caps = row.get("capabilities") if isinstance(row.get("capabilities"), dict) else {}
    arch = row.get("architecture") if isinstance(row.get("architecture"), dict) else {}
    info = {"label": row.get("name") or row.get("id"), "owned_by": row.get("owned_by") or "",
            "context_length": row.get("context_length") if isinstance(row.get("context_length"), int) else None,
            "max_output_tokens": row.get("max_output_tokens") if isinstance(row.get("max_output_tokens"), int) else None,
            "efforts": [str(x) for x in row.get("reasoning_efforts") or [] if isinstance(x, str)],
            "tiers": [str(x) for x in row.get("supported_service_tiers") or [] if isinstance(x, str)],
            "pricing": llm_pricing(row), "price_hint": _num(row.get("cost_estimate")),
            "input_modalities": [str(x) for x in arch.get("input_modalities") or [] if isinstance(x, str)],
            "capabilities": {k: bool(v) for k, v in caps.items() if isinstance(v, bool)}}
    if isinstance(row.get("description"), str) and row["description"].strip():
        info["description"] = row["description"].strip()[:600]
    return info


async def llm_model_info(env, provider: str, model: str, api_url: str = "", provider_name: str = "", refresh=False) -> dict:
    """``{found, source, info}`` for the LLM node: the model's catalog row from the provider's own list tool.
    A custom provider has no fixed catalog mapping, so each enabled text-list tool is tried until the model
    is listed. Returns found=False without raising when no provider knows the model (Hermes data still shows)."""
    tools = []
    try:
        from . import nodes as N
        tools = [t.get("name") for t in N.registry_tools(env)]
    except Exception:  # pragma: no cover - registry unavailable in a bare env
        tools = []
    for name in llm_list_candidates(tools, provider, api_url, provider_name)[:MAX_LL_LIST_TOOLS]:
        try:
            args = {"detailed": True}
            result, cached = await _list_result(env, name, refresh, args)
        except E.NodeError:
            continue
        row = next((r for r in _model_rows(result) if (r.get("id") or r.get("model")) == model), None)
        if row is not None:
            return {"found": True, "source": name, "cached": cached, "info": llm_row_info(row)}
    return {"found": False, "source": None, "info": {}}


async def fetch_model_info(env, list_tool: str, model: str, wanted=None, refresh=False, claimed=None) -> dict:
    result, cached = await _list_result(env, list_tool, refresh)
    return {**model_info(result, model, wanted, claimed), "source": list_tool, "cached": cached}


def row_max_images(row: dict):
    """How many input images a catalog row says the model takes: ``max_images``, else 4 for
    ``multi_image_to_3d``/``multiview_to_3d``, else 1 for an image model; ``None`` = the row makes no claim."""
    caps = row.get("capabilities") if isinstance(row.get("capabilities"), dict) else {}
    sp = row.get("supported_parameters") if isinstance(row.get("supported_parameters"), dict) else {}
    images = (sp.get("parameters") or {}).get("images") if isinstance(sp.get("parameters"), dict) else None
    limit = _num(caps.get("max_images")) or _num(sp.get("max_images")) or \
        (_num(images.get("maxItems") or images.get("max_items")) if isinstance(images, dict) else None)
    if limit:
        return max(1, int(limit))
    # meshy/v7.1/multi-image-to-3d sets no flag, only its id and tag say so (catalog 07.11.)
    names = " ".join([str(row.get("id") or "")] + [str(t) for t in row.get("tags") or [] if isinstance(t, str)]).lower()
    if caps.get("multi_image_to_3d") or caps.get("multiview_to_3d") or "multi-image" in names or "multiview" in names:
        return 4
    takes_images = any(caps.get(k) for k in ("image_to_3d", "image_to_video", "image_to_image"))
    return 1 if takes_images else None


async def model_max_images(env, spec: dict, node: dict):
    """The chosen model's image limit from the provider's (cached) catalog; ``None`` when the catalog is
    unreachable or does not list the model (then the node sends what it has, as before)."""
    model_param, model = node_model(spec, node)
    if not model_param or not model:
        return None
    try:
        result, _cached = await _list_result(env, model_param["options_source"])
    except E.NodeError:
        return None
    row = next((r for r in _model_rows(result) if (r.get("id") or r.get("model")) == model), None)
    return row_max_images(row) if row is not None else None


def node_model(spec: dict, node: dict):
    """(model param spec, model in effect) of a node; (None, "") without a model list."""
    params = (spec or {}).get("params") or []
    model_param = next((p for p in params if p.get("options_source")), None)
    if not model_param:
        return None, ""
    value = ((node or {}).get("params") or {}).get(model_param["name"])
    model = value if isinstance(value, str) and value.strip() else model_param.get("default")
    return model_param, str(model or "").strip()


def claimed_args(spec: dict) -> list:
    """Tool arguments a node covers itself: its settings plus every argument a preset renamed or dropped."""
    names = {p.get("name") for p in (spec or {}).get("params") or []}
    names.update(spec.get("claimed") or ())
    return sorted(n for n in names | NODE_OWNED if isinstance(n, str))


def _coerce(value, kind, name=""):
    if kind in ("media", "media_list"):
        values = value
        if isinstance(values, str) and values.lstrip().startswith("["):
            try:
                values = json.loads(values)
            except ValueError:
                pass
        many = kind == "media_list"
        items = values if isinstance(values, list) else [values]
        converted = []
        for item in items:
            try:
                if isinstance(item, str):
                    M.require_local_path(item)
                if ptypes.is_media(item):
                    M.require_local_path(item["$media"].get("path"))
                    meta = item["$media"]
                    if "url" in name.lower() and str(meta.get("source", "")).startswith("https://"):
                        converted.append(meta["source"])
                    else:
                        converted.append(M.data_url(meta["path"]))
                elif isinstance(item, str) and item and not item.startswith(("data:", "http://", "https://")) \
                        and os.path.isfile(item):
                    converted.append(M.data_url(item))
                else:
                    converted.append(item)
            except (M.MediaError, OSError, KeyError) as exc:
                raise E.NodeError(f"{name}: {exc}") from None
        return converted if many else converted[0]
    if kind == "number" and isinstance(value, str):
        try:
            return float(value) if "." in value else int(value)
        except ValueError:
            return value
    if kind == "json" and isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


async def model_extras(env, spec: dict, node: dict) -> dict:
    """Arguments for the model's own settings (G7b) that the node stores beside its tool settings. Only for tools
    that accept extra arguments; only names the chosen model lists (a value left from another model is dropped)."""
    if not (spec or {}).get("open_params"):
        return {}
    model_param, model = node_model(spec, node)
    taken = set(claimed_args(spec))
    stored = {k: v for k, v in ((node or {}).get("params") or {}).items()
              if k not in taken and v is not None and v != "" and v != []}
    if not model_param or not model or not stored:
        return {}
    try:
        info = await fetch_model_info(env, model_param["options_source"], model, wanted=(), claimed=sorted(taken))
    except E.NodeError:
        # Reuse only the last known schema of this list/model, never send untyped raw extras.
        hit = (env.state.get("options_cache") or {}).get(model_param["options_source"])
        info = model_info(hit[1], model, wanted=(), claimed=sorted(taken)) if hit else {}
        if not info.get("found"):
            raise E.NodeError("model settings catalog is unavailable; retry before running this node") from None
    kinds = {p["name"]: p["kind"] for p in info.get("params") or []}
    return {k: _coerce(v, kinds[k], k) for k, v in stored.items() if k in kinds}
