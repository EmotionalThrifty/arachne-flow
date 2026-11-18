"""Curated, typed presets over real Hermes tools.

Presets are listed only when their underlying tool is available. Execution reuses the normal
Hermes dispatch/error/timeout path; no provider API key or provider-specific network code lives here.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import re
import time

from . import executors as E
from . import media as M
from . import types as ptypes

IMAGE_BUILTIN = "image_generate"
VIDEO_BUILTIN = "video_generate"
# Hermes' own media tools come first: they run on whatever backend the user configured in Hermes (FAL, OpenAI,
# OpenRouter, xAI, Nous subscription, ...). MCP servers are found by capability (provider_tools); no provider,
# server or model name is special-cased anywhere in the presets.
BUILTIN_FOR = {"image": IMAGE_BUILTIN, "image_edit": IMAGE_BUILTIN, "video": VIDEO_BUILTIN}
JOB_ROLES = ("image_to_3d", "text_to_3d", "edit_3d", "text_to_video", "image_to_video")
JOB_TYPES = tuple("preset." + r for r in JOB_ROLES)
# Tool parameters a preset never shows: job plumbing and raw-output switches the preset handles itself.
PLUMBING = ("operation", "runId", "jobId", "requestId", "modelSlug", "include_raw", "response_format",
            "poll_interval_ms", "timeout_ms")
POLL_INTERVAL_S = 1.0
MAX_3D_S = 900.0
DONE_STATES = {"COMPLETE", "COMPLETED", "DONE", "SUCCESS", "SUCCEEDED"}
FAILED_STATES = {"CANCELLED", "CANCELED", "ERROR", "FAILED", "FAILURE", "TIMED_OUT"}


# What a preset needs, for "missing" hints (template list) when the preset is not offered.
_ANY_3D = "a 3D generation tool from any MCP server"
_ANY_VIDEO = f"{VIDEO_BUILTIN} (a video backend set up in Hermes) or a video generation tool from any MCP server"
PRESET_TOOLS = {
    "preset.text_to_image": f"{IMAGE_BUILTIN} or an image generation tool from any MCP server",
    "preset.image_to_3d": _ANY_3D, "preset.text_to_3d": _ANY_3D, "preset.edit_3d": _ANY_3D,
    "preset.vision": "vision_analyze", "preset.tts": "text_to_speech",
    "preset.web_search": "web_search", "preset.web_extract": "web_extract",
    "preset.image_edit": f"{IMAGE_BUILTIN} with an edit-capable backend, or an image edit tool from any MCP server",
    "preset.text_to_video": _ANY_VIDEO, "preset.image_to_video": _ANY_VIDEO,
    "preset.youtube_transcript": "a YouTube transcript tool from any MCP server",
}


# ---------------------------------------------------------------- provider discovery
# A provider's tools are recognized by what they do (name words + arguments), never by provider name, so a
# Meshy, Tripo, fal, Replicate-style or own MCP server gets the same ready-made nodes. Argument names differ per
# provider; each role lists the usual spellings (compared lowercase without "_" / "-").
_ARG_ROLES = {
    "image": ("imageurl", "image", "inputimage", "inputimageurl", "imageuri", "sourceimage", "imagepath"),
    "image_data": ("imagedataurl", "imagebase64", "imageb64", "imagedata"),
    "images": ("images", "imageurls", "inputimages", "imagedataurls", "sourceimages", "referenceimageurls",
               "referenceimages"),
    "prompt": ("prompt", "text", "instruction", "description", "input"),
    "mesh": ("modelurl", "meshurl", "inputmodel", "inputmodelurl", "glburl", "modelfile", "mesh", "inputmesh",
             "sourcemodel", "modelfileurl"),
    # The same model sent inline: lets a local .glb (File node, earlier local step) reach the provider.
    "mesh_data": ("modeldataurl", "meshdataurl", "modelbase64", "meshbase64", "glbbase64", "glbdataurl",
                  "modeldata", "meshdata", "modelfilebase64"),
    "video": ("videourl", "inputvideo", "video"),
    "url": ("urls", "url", "videourl", "link"),
    # A handle the tool hands back when the render is not done yet; calling again with it keeps waiting.
    "resume": ("job", "jobhandle", "jobtoken", "resumetoken", "taskhandle"),
}
_GENERATE = re.compile(r"generat|creat|make|render|synthes|_gen$|^gen_", re.I)
_EDIT_3D = re.compile(r"rig|animat|remesh|retopo|retextur|uv_?unwrap|mesh", re.I)
_EXCLUDE = re.compile(r"list|status|poll|cancel|price|cost|balance|info|search|analy|describ|transcri|caption", re.I)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


_JOB_ID_FIELDS = ("runId", "run_id", "jobId", "job_id", "taskId", "task_id", "requestId", "request_id")


def _job_contract(props: dict):
    """A job protocol read from the schema (review R4): an ``operation`` argument that offers polling plus the
    field the poll call names the job by. Returns the exact values to send, or None (then one plain call)."""
    op = props.get("operation") if isinstance(props.get("operation"), dict) else {}
    if not op:
        return None
    values = [v for v in op.get("enum") or [] if isinstance(v, str)]
    hints = values + [str(op.get("default") or ""), str(op.get("description") or "")]
    if not any("poll" in h.lower() for h in hints):
        return None
    id_field = next((f for f in _JOB_ID_FIELDS if f in props), None)
    if values:
        submit = next((v for v in ("submit_and_poll", "submit", "start", "create") if v in values), None) or \
            next((v for v in values if "poll" not in v.lower() and "status" not in v.lower()), None)
        poll = "poll" if "poll" in values else next((v for v in values if "poll" in v.lower() or "status" in v.lower()), None)
    else:            # described, not enumerated: the documented submit_and_poll / poll pair
        submit, poll = "submit_and_poll", "poll"
    if not submit or not poll or not id_field:
        return None
    contract = {"submit": submit, "poll": poll, "id": id_field}
    for slug in ("modelSlug", "model_slug"):
        if slug in props:
            contract["slug"] = slug
            break
    return contract


def _tool_args_by_role(tool: dict) -> dict:
    schema = tool.get("parameters") if isinstance(tool.get("parameters"), dict) else {}
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    by_norm = {_norm(k): k for k in props}
    roles = {}
    for role, spellings in _ARG_ROLES.items():
        roles[role] = next((by_norm[s] for s in spellings if s in by_norm), None)
    roles["job"] = _job_contract(props)
    if roles["resume"] and roles["resume"] in (roles.get("prompt"), roles.get("image")):
        roles["resume"] = None
    return roles


def _short(name: str) -> str:
    return name.rsplit("__", 1)[-1].lower()


def _matches(name: str, task: str) -> bool:
    from . import options as O
    short = _short(name)
    if _EXCLUDE.search(short) and task != "youtube":
        return False
    kind = O.tool_kind(name)
    if task == "3d":
        return kind == "3d" and bool(_GENERATE.search(short))
    if task == "3d_edit":   # rig / animate / remesh / retexture tools, or a generator that also takes a model
        return kind == "3d" or bool(_EDIT_3D.search(short))
    if task == "video":
        return kind == "video" and bool(_GENERATE.search(short))
    if task == "image":
        return kind == "image" and bool(_GENERATE.search(short)) and "edit" not in short
    if task == "image_edit":
        return kind == "image" and ("edit" in short or "inpaint" in short)
    if task == "youtube":
        return "youtube" in short and "transcri" in short
    return False


def _rank(tool: dict, peers) -> tuple:
    """Most capable provider first, judged only by what the tool offers: a model list, a job protocol for long
    renders, and how many inputs it takes. Ties by name, so the order is stable."""
    from . import options as O
    roles = _tool_args_by_role(tool)
    has_list = bool(O.options_source(tool["name"], peers))
    inputs = sum(1 for k, v in roles.items() if k != "job" and v)
    return (-int(has_list), -int(bool(roles["job"])), -inputs, tool["name"])


def provider_tools(tools: list, task: str) -> list:
    """Every usable tool doing ``task`` (3d / video / image / image_edit / youtube), best first.
    Hermes' own tool for the task (BUILTIN_FOR) leads: it follows the user's Hermes setup."""
    peers = {t.get("name") for t in tools}
    mcp = [t for t in tools if str(t.get("name") or "").startswith("mcp__") and _matches(t["name"], task)]
    names = [t["name"] for t in sorted(mcp, key=lambda t: _rank(t, peers))]
    builtin = BUILTIN_FOR.get(task)
    if builtin in peers:
        names.insert(0, builtin)
    return list(dict.fromkeys(names))


# server id -> how the server's own tool descriptions spell it ("nanogpt" -> "NanoGPT"); learnt in preset_types so
# every node of one provider shows the same name, even when only some of its tools mention it.
_SPELLING: dict = {}


def _spelling_in(server: str, description: str):
    found = re.search(r"\b(" + re.escape(server.replace("_", "-")) + r")\b", description or "", re.I) \
        if len(server) >= 3 else None
    return found.group(1) if found and found.group(1) != found.group(1).lower() else None


def learn_spellings(tools: list) -> None:
    for tool in tools or []:
        name = str(tool.get("name") or "")
        if name.startswith("mcp__"):
            server = name.split("__")[1]
            if server not in _SPELLING:
                spelt = _spelling_in(server, str(tool.get("description") or ""))
                if spelt:
                    _SPELLING[server] = spelt


def provider_label(tool_name: str, description: str = "") -> str:
    """Display name of the provider behind a tool. The server's tool descriptions spell it best ("... with NanoGPT
    3D models" -> ``NanoGPT``); otherwise from the server id: ``fal-ai`` -> ``FAL AI``, ``meshy`` -> ``Meshy``."""
    if not tool_name.startswith("mcp__"):
        return "Hermes"
    server = tool_name.split("__")[1]
    spelt = _SPELLING.get(server) or _spelling_in(server, description)
    if spelt:
        return spelt
    words = [w for w in re.split(r"[-_ ]+", server) if w]
    return " ".join(w.upper() if len(w) <= 3 else w.capitalize() for w in words) or server


def _variant(type_name: str, title: str, tool_name: str, first: bool):
    """The first provider keeps the plain id (saved flows keep working); others get ``<id>~<server>``."""
    if first:
        return type_name, title
    server = tool_name.split("__")[1] if tool_name.startswith("mcp__") else tool_name
    return f"{type_name}~{re.sub(r'[^a-z0-9_-]', '', server.lower())}", f"{title} · {provider_label(tool_name)}"


def role_of(type_name: str) -> str:
    """``preset.image_to_3d~meshy`` -> ``image_to_3d``."""
    return (type_name or "").split("~", 1)[0].removeprefix("preset.")


def _input(name, type_name, label, description=""):
    port = {"name": name, "type": type_name, "required": True, "label": label}
    if description:
        port["description"] = description
    return port


def _output(name, type_name, label):
    return {"name": name, "type": type_name, "label": label}


def _params(base, rename=None, drop=()):
    """Reuse the tool's inspector schema while adapting curated input names."""
    rename = rename or {}
    ignored = set(drop)
    out = []
    for original in base.get("params", []):
        name = original["name"]
        if name in ignored:
            continue
        param = copy.deepcopy(original)
        if name in rename:
            new_name, label = rename[name]
            original_kind = param.get("kind")
            param.update(name=new_name, label=label)
            if original_kind not in ("media", "media_list"):
                param["kind"] = "text"
            if param.get("default") in (None, [], {}):
                param["default"] = [] if original_kind == "media_list" else ""
        out.append(param)
    return out


def _multi_image(spec, max_items=None):
    """Curated image input that maps several wires/files to the tool's media-array argument (G8)."""
    port = next((p for p in spec.get("inputs", []) if p.get("name") == "image"), None)
    param = next((p for p in spec.get("params", []) if p.get("name") == "image"), None)
    if port:
        port["multiple"] = True
        port["description"] = ((port.get("description") or "") +
                               " Connect several images or pick local files in the inspector.").strip()
        if max_items:
            port["max"] = max_items
    if param:
        param.update(kind="media_list", media_kind="image", default=[])
        if max_items:
            param["max_items"] = max_items
    return spec


# How long a preset usually takes (palette tooltip, G2). Coarse on purpose: real per-run averages are G9.
SECONDS = "seconds"
JOB = "minutes: waits for a background job (stops at the timeout, default 15 min)"

# Palette groups inside "Ready-made" (UI order: PRESET_GROUP_ORDER); a new ready-made node picks one here.
PRESET_GROUP_ORDER = ("General", "Image", "Video", "3D", "Audio")
PRESET_GROUP = {
    "web_search": "General", "web_extract": "General",
    "text_to_image": "Image", "image_edit": "Image", "vision": "Image",
    "text_to_video": "Video", "image_to_video": "Video", "youtube_transcript": "Video",
    "image_to_3d": "3D", "text_to_3d": "3D", "edit_3d": "3D",
    "tts": "Audio",
}

# A blank model setting is filled at run time from the provider's own list (_auto_model).
AUTO_PARAM = "model_auto"
AUTO_MODES = ("cheapest", "best")

# Which input the model must accept; the list keeps only those models (options.to_options). "3d" = edit models.
MODEL_ACCEPTS = {"text_to_image": "text", "image_to_3d": "image", "text_to_3d": "text", "edit_3d": "3d",
                 "image_edit": "image", "text_to_video": "text", "image_to_video": "image"}


def _spec(base, type_name, title, icon, description, inputs, outputs, rename=None, drop=(), timeout=0, defaults=None,
          typical=SECONDS, cost="", roles=None):
    # A renamed argument is the curated input itself: never drop it with the provider's other inputs.
    drop = tuple(d for d in tuple(drop) + PLUMBING if d not in (rename or {}))
    params = _params(base, rename, drop)
    for param in params:
        if defaults and param["name"] in defaults:
            param["default"] = defaults[param["name"]]
            param["fallback"] = True  # blank value -> this default at run time (build_tool_args)
    role = role_of(type_name)
    for i, param in enumerate(list(params)):
        if param.get("options_source") and role in MODEL_ACCEPTS:
            param["options_accepts"] = MODEL_ACCEPTS[role]
            param["required"] = False
            param["auto"] = AUTO_PARAM     # blank -> picked from this provider's list by AUTO_PARAM (execute)
            param["description"] = (f"Which {provider_label(base['tool'], base.get('description', ''))} model to use; the list shows only models "
                                    "for this step, with prices. Empty: picked automatically (see Auto model).")
            params.insert(i + 1, {"name": AUTO_PARAM, "kind": "select", "label": "Auto model",
                                  "options": list(AUTO_MODES), "default": AUTO_MODES[0],
                                  "description": "Only when no model is chosen: 'cheapest' takes the lowest-priced "
                                                 "fitting model, 'best' the highest-priced one (price as a quality "
                                                 "hint). The node shows which model that is."})
            break
    if not base["tool"].startswith("mcp__") and role in MODEL_ACCEPTS:
        cost = cost or "Uses the model and backend set up in Hermes' settings"
    if timeout and not any(p["name"] == "timeout_s" for p in params):
        params.append({"name": "timeout_s", "kind": "number", "label": "Timeout (seconds)",
                       "default": timeout, "description": "Total job deadline, including polling."})
    spec = {"type": type_name, "title": title, "category": "Presets", "icon": icon,
            "description": description, "kind": "preset", "tool": base["tool"], "provider": provider_label(base["tool"], base.get("description", "")),
            "group": PRESET_GROUP.get(role, "General"),
            "inputs": inputs, "outputs": outputs, "params": params, "typical": typical,
            # G7b: the tool's own arguments (also renamed/dropped ones) are never offered again as model settings
            "claimed": sorted(p["name"] for p in base.get("params", []))}
    if roles:
        spec["args"] = {k: v for k, v in roles.items() if v}     # curated input -> the provider's argument names
    if base.get("open_params"):
        spec["open_params"] = True
    if cost:
        spec["cost"] = cost
    return spec


def _role_drop(roles: dict, keep=()) -> tuple:
    """The provider's other input arguments (they belong to other presets of the same tool)."""
    return tuple(v for k, v in roles.items() if k not in keep and isinstance(v, str))


def _image_presets(tool, base, roles, first):
    out = []
    if roles["prompt"]:
        t, title = _variant("preset.text_to_image", "Text to image", tool, first)
        out.append(_spec(base, t, title, "file-media", "Generate an image from a prompt.",
                         [_input("prompt", "text", "Prompt", "What the image should show. Concrete subjects, style and light "
                                                   "work best.")], [_output("image", "image", "Image")],
                         rename={roles["prompt"]: ("prompt", "Prompt")} if roles["prompt"] != "prompt" else None,
                         drop=_role_drop(roles, ("prompt",)),
                         cost="Paid per image; the price depends on the image provider", roles=roles))
    return out


def _edit_presets(tool, base, roles, first):
    img = roles["image_data"] or roles["image"] or roles["images"]
    if not img or not roles["prompt"]:
        return []
    t, title = _variant("preset.image_edit", "Edit image", tool, first)
    rename = {img: ("image", "Images")}
    if roles["prompt"] != "prompt":
        rename[roles["prompt"]] = ("prompt", "Instruction")
    return [_multi_image(_spec(base, t, title, "edit",
                         "Change one or more existing images with an instruction, e.g. 'make the background a beach'.",
                         [_input("image", "image", "Image", "The picture(s) to change or combine."),
                          _input("prompt", "text", "Instruction", "What to change, in plain words.")],
                         [_output("image", "image", "Image")],
                         rename=rename, drop=_role_drop({**roles, "mask": "maskDataUrl"}, ("prompt",)) + ("maskDataUrl",),
                         cost="Paid per image; the price depends on the model", roles=roles))]


def _3d_presets(tool, base, roles, first):
    out = []
    label = provider_label(tool, base.get("description", ""))
    cost_3d = "Paid per model; the price depends on the model"
    img = roles["image"] or roles["image_data"] or roles["images"]
    if img:
        t, title = _variant("preset.image_to_3d", "Image to 3D", tool, first)
        out.append(_multi_image(_spec(base, t, title, "package",
                         f"Turn one or more images into a 3D model; waits for the {label} job until it finishes.",
                         [_input("image", "image", "Image", "Pictures of one object, optionally from several angles; a plain background gives the cleanest model.")],
                         [_output("model", "model3d", "3D model")],
                         rename={img: ("image", "Images")}, drop=_role_drop(roles, ()) ,
                         timeout=int(MAX_3D_S), typical=JOB, cost=cost_3d, roles=roles),
                         max_items=4 if roles["images"] else 1))
    if roles["prompt"]:
        t, title = _variant("preset.text_to_3d", "Text to 3D", tool, first)
        out.append(_spec(base, t, title, "package",
                         f"Turn a prompt into a 3D model; waits for the {label} job until it finishes.",
                         [_input("prompt", "text", "Prompt", "Description of the object to model.")],
                         [_output("model", "model3d", "3D model")],
                         rename={roles["prompt"]: ("prompt", "Prompt")} if roles["prompt"] != "prompt" else None,
                         drop=_role_drop(roles, ("prompt",)), timeout=int(MAX_3D_S), typical=JOB, cost=cost_3d,
                         roles=roles))
    return out


def _3d_edit_presets(tool, base, roles, first):
    out = []
    label = provider_label(tool, base.get("description", ""))
    cost_3d = "Paid per model; the price depends on the model"
    if roles["mesh"] or roles["mesh_data"]:
        t, title = _variant("preset.edit_3d", "Edit 3D model", tool, first)
        prompt_port = _input("prompt", "text", "Instruction", "Only for models that take one, e.g. a texture or "
                                                              "style description for retexturing.")
        prompt_port["required"] = False
        rename = {roles["mesh"] or roles["mesh_data"]: ("mesh", "3D model")}  # not "model": that is the model choice
        needs = ("a 3D model from an earlier step or a local .glb" if roles["mesh_data"] else
                 "a 3D model from an earlier provider step or an https link (this provider takes no local files)")
        if roles["prompt"] and roles["prompt"] != "prompt":
            rename[roles["prompt"]] = ("prompt", "Instruction")
        out.append(_spec(base, t, title, "package",
                         "Process an existing 3D model: rig, animate, remesh, retopologize, retexture, segment or "
                         f"convert it, depending on the {label} model you pick. Needs {needs}.",
                         [_input("mesh", "model3d", "3D model", "The 3D model to process, from an earlier 3D step."),
                          prompt_port] if roles["prompt"] else
                         [_input("mesh", "model3d", "3D model", "The 3D model to process, from an earlier 3D step.")],
                         [_output("model", "model3d", "3D model")],
                         rename=rename, drop=_role_drop(roles, ("mesh", "prompt")) + ((roles["mesh_data"],)
                                                                                     if roles["mesh"] and roles["mesh_data"] else ()),
                         timeout=int(MAX_3D_S), typical=JOB, cost=cost_3d, roles=roles))
    return out


def _video_presets(tool, base, roles, first):
    out = []
    label = provider_label(tool, base.get("description", ""))
    cost_video = "Paid per second of video; the price depends on the model"
    if roles["prompt"]:
        t, title = _variant("preset.text_to_video", "Text to video", tool, first)
        out.append(_spec(base, t, title, "device-camera-video",
                         f"Generate a short video clip from a prompt; waits for the {label} job.",
                         [_input("prompt", "text", "Prompt", "What happens in the clip: subject, action, camera, mood.")],
                         [_output("video", "video", "Video")],
                         rename={roles["prompt"]: ("prompt", "Prompt")} if roles["prompt"] != "prompt" else None,
                         drop=_role_drop(roles, ("prompt",)), timeout=int(MAX_3D_S), defaults={"duration": 6},
                         typical=JOB, cost=cost_video, roles=roles))
    img = roles["image"] or roles["image_data"]
    if img and roles["prompt"]:
        t, title = _variant("preset.image_to_video", "Image to video", tool, first)
        rename = {img: ("image", "Image")}
        if roles["prompt"] != "prompt":
            rename[roles["prompt"]] = ("prompt", "Prompt")
        out.append(_spec(base, t, title, "device-camera-video",
                         f"Animate a still image into a short clip; waits for the {label} job.",
                         [_input("image", "image", "Image", "The first frame of the clip."),
                          _input("prompt", "text", "Prompt", "How the scene should move.")],
                         [_output("video", "video", "Video")], rename=rename,
                         drop=_role_drop(roles, ("prompt",)), timeout=int(MAX_3D_S), defaults={"duration": 6},
                         typical=JOB, cost=cost_video, roles=roles))
    return out


def _youtube_presets(tool, base, roles, first):
    arg = roles["url"]
    if not arg:
        return []
    t, title = _variant("preset.youtube_transcript", "YouTube transcript", tool, first)
    return [_spec(base, t, title, "play-circle", "Get the spoken text of a YouTube video.",
                  [_input("url", "text", "Video URL", "Link to the video, e.g. https://youtu.be/…")],
                  [_output("text", "text", "Transcript")], rename={arg: ("url", "Video URL")}, roles=roles)]


_TASKS = (("image", _image_presets), ("image_edit", _edit_presets), ("3d", _3d_presets),
          ("3d_edit", _3d_edit_presets),
          ("video", _video_presets), ("youtube", _youtube_presets))


def _link_providers(specs: list) -> None:
    """One ready-made node per step: the plain id is the best available provider, every other provider of the
    same step is a hidden variant the node switches to (inspector "Provider"), with identical ports."""
    groups = {}
    for spec in specs:
        groups.setdefault(spec["type"].split("~", 1)[0], []).append(spec)
    for base, members in groups.items():
        choices = [{"type": m["type"], "label": m["provider"] + (" (best available)" if m["type"] == base else "")}
                   for m in members]
        for m in members:
            m["provider_group"] = base
            m["providers"] = choices
            if m["type"] != base:
                m["palette"] = False


def preset_types(tools: list) -> list:
    """Build available preset specs from the already allow/block-filtered registry entries.

    Provider-independent: every MCP tool that generates images / 3D / video (by name and arguments) gets the
    ready-made nodes; the first provider keeps the plain type id, every further one a ``~<server>`` variant.
    """
    from . import nodes as N  # late import: nodes calls us after constructing tool specs

    learn_spellings(tools)
    peers = {t.get("name") for t in tools}
    by_name = {t.get("name"): t for t in tools}
    bases = {t.get("name"): N.tool_node_type(t, peers) for t in tools}
    out = []
    seen = set()
    for task, build in _TASKS:
        names = provider_tools(tools, task)
        first_of_type = set()
        for name in names:
            roles = _tool_args_by_role(by_name[name])
            if name in (IMAGE_BUILTIN, VIDEO_BUILTIN) and not roles["prompt"]:
                roles["prompt"] = "prompt"
            for spec in build(name, bases[name], roles, False):
                base_type = spec["type"].split("~", 1)[0]
                if base_type not in first_of_type:           # first provider of this node: the plain id
                    first_of_type.add(base_type)
                    spec["type"] = base_type
                    spec["title"] = spec["title"].split(" · ", 1)[0]
                if spec["type"] not in seen:
                    seen.add(spec["type"])
                    out.append(spec)
    _link_providers(out)
    if "vision_analyze" in bases:
        out.append(_spec(bases["vision_analyze"], "preset.vision", "Vision", "eye",
                         "Ask a question about an image.",
                         [_input("image", "image", "Image", "The image to look at."),
                          _input("question", "text", "Question", "What you want to know about the image.")],
                         [_output("text", "text", "Answer")],
                         rename={"image_url": ("image", "Image URL")}, cost="Uses tokens of Hermes' vision model"))
    if "text_to_speech" in bases:
        out.append(_spec(bases["text_to_speech"], "preset.tts", "Text to speech", "unmute",
                         "Turn text into spoken audio.",
                         [_input("text", "text", "Text", "The text to read aloud.")], [_output("audio", "audio", "Audio")],
                         drop=("output_path",),  # Arachne stores the audio itself (run outputs folder)
                         cost="Depends on Hermes' speech provider (Edge TTS is free)"))
    if "web_search" in bases:
        out.append(_spec(bases["web_search"], "preset.web_search", "Web search", "globe",
                         "Search the web and return structured results plus text.",
                         [_input("query", "text", "Query", "Search words, like you would type into a search engine.")],
                         [_output("results", "json", "Results"), _output("text", "text", "Text")]))
    if "web_extract" in bases:
        out.append(_spec(bases["web_extract"], "preset.web_extract", "Web extract", "book",
                         "Extract readable page content from one URL.",
                         [_input("url", "text", "URL", "Full web address starting with https://.")],
                         [_output("text", "text", "Page text")],
                         rename={"urls": ("url", "URL")}))
    return out


# ---------------------------------------------------------------- execution
def _remote_or_inline(value):
    """HTTPS stays remote; a local file/media value becomes a data URL (accepted by the job tools)."""
    if isinstance(value, str):
        M.require_local_path(value)
    if ptypes.is_media(value):
        meta = value["$media"]
        M.require_local_path(meta.get("path"))
        if str(meta.get("source", "")).startswith("https://"):
            return meta["source"]
        return M.inline_local(meta["path"], engine_value=True)
    if isinstance(value, str) and value and not value.startswith(("data:", "https://", "http://")) \
            and os.path.isfile(value):
        return M.inline_local(value)
    return value


def _inline(value):
    if isinstance(value, str):
        M.require_local_path(value)
    if ptypes.is_media(value):
        return M.inline_local(value["$media"]["path"], engine_value=True)
    if isinstance(value, str) and value and not value.startswith(("data:", "https://", "http://")) \
            and os.path.isfile(value):
        return M.inline_local(value)
    return value


def _raw_images(node, inputs):
    """Direct files/URLs first, then wired images (the same order as build_tool_args)."""
    wired = inputs.get("image")
    direct = (node.get("params") or {}).get("image")
    if wired is None:
        return direct
    if direct in (None, "", []):
        return wired
    left = direct if isinstance(direct, list) else [direct]
    right = wired if isinstance(wired, list) else [wired]
    return list(left) + list(right)


MAX_INLINE_MESH = 20 * 1024 * 1024


def _local_mesh(value):
    """The local file behind a 3D value (media or path), or None for links/other values."""
    if ptypes.is_media(value):
        path = value["$media"].get("path")
    elif isinstance(value, str) and not value.startswith(("https://", "http://", "data:")):
        path = value
    else:
        return None
    if path:
        M.require_local_path(path)
    return path if path and os.path.isfile(path) else None


def _model_link(value, inline_arg=None, provider="this provider"):
    """A 3D model for an edit job -> ``(argument role, value)``.

    A public link always works (a provider 3D step keeps the job's link in ``$media.source``). A local file goes
    inline when the provider has an inline argument; otherwise the error says how to get a link.
    """
    if ptypes.is_media(value):
        source = str(value["$media"].get("source") or "")
        if source.startswith(("https://", "http://")):
            return "mesh", source
    if isinstance(value, str) and value.startswith(("https://", "http://")):
        return "mesh", value
    if isinstance(value, str) and value.startswith("data:") and inline_arg:
        return "mesh_data", value
    path = _local_mesh(value)
    if path and inline_arg:
        size = os.path.getsize(path)
        if size > MAX_INLINE_MESH:
            raise E.NodeError(f"3D model: {os.path.basename(path)} is {size // (1024 * 1024)} MB; {provider} takes "
                              f"local files up to {MAX_INLINE_MESH // (1024 * 1024)} MB")
        return "mesh_data", M.inline_local(path, engine_value=True)
    if path:
        raise E.NodeError(f"3D model: {provider} only takes a public link to the model, not a local file. Connect "
                          "the 3D output of an earlier provider step (it keeps the provider's link), or paste an "
                          "https link to the .glb into the 3D model field.")
    raise E.NodeError("3D model: connect a 3D model from an earlier 3D step, or paste its https link")


def _put(args, name, value):
    if name:
        args[name] = value


def _tool_args(node, spec, inputs, notes=None):
    """Curated inputs -> the provider's own argument names (spec["args"], found by preset discovery).
    ``notes`` collects what the node log should say about the mapping (e.g. images left out)."""
    args = E.build_tool_args(spec, node, inputs)
    args.pop("timeout_s", None)  # Arachne Flow job setting, never a provider argument
    args.pop(AUTO_PARAM, None)   # how a blank model is picked; Arachne's, not the provider's
    role = role_of(node.get("type") or spec.get("type"))
    names = spec.get("args") or {}
    if role in ("image_to_3d", "image_to_video", "image_edit") and "image" in args:
        args.pop("image")
        raw = _raw_images(node, inputs)
        values = [v for v in (raw if isinstance(raw, list) else [raw]) if v not in (None, "")]
        convert = _inline if role == "image_edit" and names.get("image_data") else _remote_or_inline
        try:
            values = [convert(v) for v in values]
        except (M.MediaError, OSError, KeyError) as exc:
            raise E.NodeError(f"image: {exc}") from None
        if len(values) > 1 and names.get("images"):
            args[names["images"]] = values
        elif values:
            if len(values) > 1 and notes is not None:
                notes.append(f"{spec.get('provider') or 'this provider'} takes one image; using the first of "
                             f"{len(values)}")
            value = values[0]
            inline = isinstance(value, str) and value.startswith("data:")
            _put(args, (names.get("image_data") if inline else names.get("image")) or names.get("image")
                 or names.get("image_data"), value)
            if not (names.get("image") or names.get("image_data")) and names.get("images"):
                args[names["images"]] = [value]
    elif role == "edit_3d" and "mesh" in args:
        value = args.pop("mesh")
        try:
            kind, sent = _model_link(inputs.get("mesh") or value, names.get("mesh_data"),
                                     spec.get("provider") or "this provider")
        except (M.MediaError, OSError) as exc:
            raise E.NodeError(f"3D model: {exc}") from None
        args[names.get(kind) or names.get("mesh") or names.get("mesh_data") or "model_url"] = sent
    elif role == "vision" and "image" in args:
        args["image_url"] = args.pop("image")
    elif role in ("web_extract", "youtube_transcript") and "url" in args:
        target = names.get("url") or "urls"
        url = args.pop("url")
        args[target] = [url] if target.lower().endswith("s") else url
    if "prompt" in args and names.get("prompt") and names["prompt"] != "prompt":
        args[names["prompt"]] = args.pop("prompt")
    return args


def _job_media(result, nctx):
    """A finished job's media: the server's ``urls`` first (signed links carry no file extension, so the
    generic scan misses them), then whatever the generic scan finds."""
    for i, url in enumerate(_job_urls(result)):
        try:
            return [M.ingest(url, nctx.out_dir, f"{nctx.node_id}-job{i}", allow_download=nctx.allow_download)]
        except Exception as exc:  # noqa: BLE001 - try the next link, then the generic scan
            E.logger.info("arachne-flow: job media %s skipped: %s", url[:120], exc)
    return E.collect_media(result, nctx)


_HANDLE_KEYS = ("job", "job_id", "jobId", "handle", "job_handle", "resume_token")
RESUME_EVERY_S = 5.0


def _handle(result):
    """The "not done yet, call again with this" handle of a finished-too-early call, or None."""
    data = result
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return None
    if isinstance(data, dict) and isinstance(data.get("structuredContent"), dict):
        data = data["structuredContent"]
    if not isinstance(data, dict) or _job_urls(data) or _job_status(data) in DONE_STATES | FAILED_STATES:
        return None
    for key in _HANDLE_KEYS:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


async def _call_and_resume(env, spec, args, timeout, nctx, label):
    """Call once; while the tool answers with a resume handle (and its schema takes one), call again with it."""
    deadline = time.monotonic() + timeout
    result = await E.call_tool(env, spec["tool"], args, timeout)
    resume = (spec.get("args") or {}).get("resume")
    while resume:
        handle = _handle(result)
        if not handle:
            return result
        remaining = deadline - time.monotonic()
        if remaining <= RESUME_EVERY_S:
            raise E.NodeError(f"{label} generation timed out after {int(timeout)} s (still rendering)")
        nctx.log(f"{label}: still rendering, waiting …")
        await asyncio.sleep(RESUME_EVERY_S)
        result = await E.call_tool(env, spec["tool"], {**args, resume: handle}, deadline - time.monotonic())
    return result


async def _media_output(result, nctx, output_name, kind, collect=None):
    media = await asyncio.to_thread(collect or E.collect_media, result, nctx)
    if not media:
        raise E.NodeError(f"the tool finished but returned no {kind} file. Some tools put their result straight "
                          "into another app (e.g. a 3D scene) instead; pick another provider in this node's "
                          "Provider setting, or use the tool as a plain tool node.")
    value = dict(media[0])
    value["$media"] = {**value.get("$media", {}), "kind": kind}
    return {output_name: value}


def _text_output(result):
    if isinstance(result, dict):
        analysis = result.get("analysis")
        if isinstance(analysis, str):
            return analysis
        structured = result.get("structuredContent")
        if isinstance(structured, dict) and isinstance(structured.get("analysis"), str):
            return structured["analysis"]
    return E.best_text(result)


def _transcript_output(result):
    """Extract transcripts from structuredContent to avoid the notice/preview problem."""
    data = result
    if isinstance(data, str):
        try:
            data = ptypes.loads_untrusted(data)
        except ValueError:
            data = None
    if isinstance(data, dict):
        structured = data.get("structuredContent")
        if isinstance(structured, str):
            try:
                structured = ptypes.loads_untrusted(structured)
            except ValueError:
                structured = None
        if isinstance(structured, dict):
            transcripts = structured.get("transcripts")
            if isinstance(transcripts, list):
                parts = []
                for entry in transcripts:
                    if isinstance(entry, dict):
                        t = entry.get("transcript")
                        if isinstance(t, str) and t.strip():
                            parts.append(t)
                if parts:
                    return "\n\n".join(parts)
    return _text_output(result)


def _job_containers(result):
    if not isinstance(result, dict):
        return []
    containers = [result]
    for key in ("structuredContent", "result", "data", "job"):
        value = result.get(key)
        if isinstance(value, dict):
            containers.append(value)
    return containers


def _job_field(result, *names):
    for container in _job_containers(result):
        for name in names:
            value = container.get(name)
            if value is not None and value != "":
                return value
    return None


def _status_object(result):
    """The job's own status record. @nanogpt/mcp puts the whole status JSON under ``status``
    (``{requestId, data: {status, output, error}, model}``); the job sits under ``data`` when present."""
    value = _job_field(result, "status", "state")
    for _ in range(2):
        if not isinstance(value, dict):
            break
        inner = value.get("data")
        if isinstance(inner, dict):
            value = inner
        nested = value.get("status") if value.get("status") not in (None, "") else value.get("state")
        if nested in (None, ""):
            return value, None
        if not isinstance(nested, dict):
            return value, nested
        value = nested
    return None, value if not isinstance(value, dict) else None


def _job_status(result):
    _, value = _status_object(result)
    return str(value).upper() if value not in (None, "") else ""


def _error_text(value):
    if isinstance(value, dict):
        value = value.get("message") or value.get("detail")
    return str(value) if value else ""


def _job_error(result, label="3D"):
    job, _ = _status_object(result)
    for source in ([job] if job else []):
        for name in ("error", "message", "detail"):
            text = _error_text(source.get(name))
            if text:
                return text
    text = _error_text(_job_field(result, "error", "lastPollError", "message", "detail"))
    if text:
        return text
    status = _job_status(result)
    return f"{label} generation failed" + (f" ({status})" if status else "")


def _job_urls(result):
    """``structuredContent.urls``: the finished job's HTTPS links, collected by the MCP server itself."""
    urls = _job_field(result, "urls")
    if not isinstance(urls, list):
        return []
    return [u for u in urls if isinstance(u, str) and u.startswith(("http://", "https://"))]


def _3d_timeout(node, nctx):
    params = dict(node.get("params") or {})
    if params.get("timeout_s") in (None, ""):
        params["timeout_s"] = int(MAX_3D_S)
    return min(MAX_3D_S, E.node_timeout({**node, "params": params}, nctx))


async def _run_job(env, tool, args, timeout, nctx, label, contract=None):
    """Long 3D/video job (tools whose ``operation`` offers ``poll``): submit once, then poll operation+runId (+modelSlug) until a terminal status or
    the node's timeout (capped at MAX_3D_S). Each new status reaches the node as a progress line."""
    deadline = time.monotonic() + timeout
    job_id = model_slug = None
    last_status = None

    async def call(call_args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise E.NodeError(f"{label} generation timed out after {int(timeout)} s")
        return await E.call_tool(env, tool, call_args, timeout=remaining)

    contract = contract if isinstance(contract, dict) else {"submit": "submit_and_poll", "poll": "poll", "id": "runId",
                                                            "slug": "modelSlug"}
    # The job id in an answer: the field the poll call takes (camel or snake), else the usual run/job ids. Never
    # another provider id like ``requestId`` unless the schema polls by it: polling with a wrong id never ends.
    snake = re.sub(r"(?<!^)(?=[A-Z])", "_", contract["id"]).lower()
    id_names = tuple(dict.fromkeys((contract["id"], snake, "runId", "run_id", "jobId", "job_id")))
    result = await call({**args, "operation": contract["submit"]})
    while True:
        status = _job_status(result)
        if status in DONE_STATES:
            return result
        if status in FAILED_STATES:
            raise E.NodeError(_job_error(result, label))
        if status and status != last_status:
            nctx.log(f"{label} job: {status}")
            last_status = status
        job_id = _job_field(result, *id_names) or job_id
        model_slug = _job_field(result, "modelSlug", "model_slug") or model_slug
        if not job_id:
            # Only a status-less finished media payload may omit the polling identifier.
            if not status and (E.multimodal_refs(result) or M.find_refs(result)):
                return result
            raise E.NodeError(f"{label} job {status or 'response'} has no runId/jobId for polling; "
                              "check the provider job before retrying to avoid a duplicate charge")
        await asyncio.sleep(min(POLL_INTERVAL_S, max(0, deadline - time.monotonic())))
        poll = {"operation": contract["poll"], contract["id"]: job_id}
        if isinstance(model_slug, str) and model_slug and contract.get("slug"):
            poll[contract["slug"]] = model_slug
        result = await call(poll)


async def _fit_images(env, spec, node, args, nctx, O):
    """Several images, but the model takes fewer (live 07.11.: hunyuan-3d-v3.1-rapid takes one and ignores
    ``images``, so the job ran as text-to-3D and failed with "A prompt is required"): send what it takes."""
    names = spec.get("args") or {}
    key = names["images"]
    limit = await O.model_max_images(env, spec, node)
    images = args[key]
    if limit is None or len(images) <= limit:
        return
    _model_param, model = O.node_model(spec, node)
    single = names.get("image_data") if str(images[0]).startswith("data:") else names.get("image")
    if limit == 1 and (single or names.get("image") or names.get("image_data")):
        first = args.pop(key)[0]
        args[single or names.get("image") or names.get("image_data")] = first
        nctx.log(f"{model} takes one image; using the first of {len(images)}")
    else:
        args[key] = images[:max(1, limit)]
        nctx.log(f"{model} takes up to {limit} images; using the first {limit} of {len(images)}")


def auto_pick(options: list, mode: str = "cheapest"):
    """The model a blank setting runs with: the cheapest (or for ``best`` the priciest) priced option, else the
    provider's first one. The UI mirrors this (autoPick in desktop/src/13-settings.js)."""
    priced = [o for o in options or [] if isinstance(o.get("price"), (int, float)) and o.get("value")]
    if priced:
        return (max if mode == "best" else min)(priced, key=lambda o: o["price"])
    return next((o for o in options or [] if o.get("value")), None)


async def _auto_model(env, spec, node, nctx):
    """A blank model setting -> the cheapest model of the provider's own list that fits this step."""
    param = next((p for p in spec.get("params") or [] if p.get("auto") and p.get("options_source")), None)
    if not param or not E._blank(param.get("default")):
        return node        # the tool's own schema default model wins (the inspector shows it as "Default")
    from . import options as O
    chosen = (node.get("params") or {}).get(param["name"])
    if not E._blank(chosen):
        # A model pinned elsewhere (template, shared flow, other provider) that this provider does not list.
        try:
            listed = (await O.fetch_options(env, param["options_source"]))["options"]
        except E.NodeError:
            return node
        if not listed or len(listed) >= O.MAX_OPTIONS or any(o.get("value") == chosen for o in listed):
            return node
        nctx.log(f"model {chosen} is not offered by {spec.get('provider') or 'this provider'}; using another")
    try:
        found = (await O.fetch_options(env, param["options_source"], accepts=param.get("options_accepts")))["options"]
    except E.NodeError:
        return node        # no list: the provider decides itself
    mode = (node.get("params") or {}).get(AUTO_PARAM) or AUTO_MODES[0]
    pick = auto_pick(found, mode)
    if not pick:
        return node
    nctx.log(f"model: {pick['value']} ({'highest-priced' if mode == 'best' else 'cheapest'} fitting model, auto)")
    return {**node, "params": {**(node.get("params") or {}), param["name"]: pick["value"]}}


async def execute(env, node, spec, inputs, nctx):
    role = role_of(node.get("type") or spec.get("type"))
    node = await _auto_model(env, spec, node, nctx)
    notes = []
    args = _tool_args(node, spec, inputs, notes)
    for note in notes:
        nctx.log(note)
    from . import options as O  # late import, like nodes -> presets

    args.update(await O.model_extras(env, spec, node))  # the chosen model's own settings (G7b)
    images_arg = (spec.get("args") or {}).get("images")
    if images_arg and isinstance(args.get(images_arg), list):
        await _fit_images(env, spec, node, args, nctx, O)
    job = (spec.get("args") or {}).get("job")
    if role in ("image_to_3d", "text_to_3d", "edit_3d", "text_to_video", "image_to_video"):
        kind, label, out = ("video", "Video", "video") if "video" in role else ("model3d", "3D", "model")
        if job:
            result = await _run_job(env, spec["tool"], args, _3d_timeout(node, nctx), nctx, label, job)
        else:   # a provider without a poll operation answers in one call, maybe with a handle to wait on
            result = await _call_and_resume(env, spec, args, _3d_timeout(node, nctx), nctx, label)
        return await _media_output(result, nctx, out, kind, collect=_job_media)

    result = await E.call_tool(env, spec["tool"], args, E.node_timeout(node, nctx))
    if role in ("text_to_image", "image_edit"):
        return await _media_output(result, nctx, "image", "image")
    if role == "youtube_transcript":
        return {"text": _transcript_output(result)}
    if role == "tts":
        return await _media_output(result, nctx, "audio", "audio")
    if role == "web_search":
        return {"results": result, "text": _text_output(result)}
    if role in ("vision", "web_extract"):
        return {"text": _text_output(result)}
    raise E.NodeError(f"unknown preset {node.get('type')!r}")
