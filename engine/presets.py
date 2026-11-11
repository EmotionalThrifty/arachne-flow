"""Curated, typed presets over real Hermes tools.

Presets are listed only when their underlying tool is available. Execution reuses the normal
Hermes dispatch/error/timeout path; no provider API key or provider-specific network code lives here.
"""
from __future__ import annotations

import asyncio
import copy
import os
import time

from . import executors as E
from . import media as M
from . import types as ptypes

IMAGE_BUILTIN = "image_generate"
IMAGE_NANO = "mcp__nanogpt__nanogpt_image_generate"
TOOL_3D = "mcp__nanogpt__nanogpt_3d_generate"
TOOL_EDIT = "mcp__nanogpt__nanogpt_image_edit"
TOOL_VIDEO = "mcp__nanogpt__nanogpt_video_generate"
TOOL_YOUTUBE = "mcp__nanogpt__nanogpt_youtube_transcribe"
JOB_TYPES = ("preset.image_to_3d", "preset.text_to_3d", "preset.text_to_video", "preset.image_to_video")
# Tool parameters a preset never shows: job plumbing and raw-output switches the preset handles itself.
PLUMBING = ("operation", "runId", "jobId", "requestId", "modelSlug", "model_url", "include_raw", "response_format",
            "poll_interval_ms", "timeout_ms")
POLL_INTERVAL_S = 1.0
MAX_3D_S = 900.0
DONE_STATES = {"COMPLETE", "COMPLETED", "DONE", "SUCCESS", "SUCCEEDED"}
FAILED_STATES = {"CANCELLED", "CANCELED", "ERROR", "FAILED", "FAILURE", "TIMED_OUT"}


# Which Hermes tool a preset needs, for "missing" hints (template list) when the preset is not offered.
PRESET_TOOLS = {
    "preset.text_to_image": f"{IMAGE_BUILTIN} or {IMAGE_NANO}",
    "preset.image_to_3d": TOOL_3D, "preset.text_to_3d": TOOL_3D,
    "preset.vision": "vision_analyze", "preset.tts": "text_to_speech",
    "preset.web_search": "web_search", "preset.web_extract": "web_extract",
    "preset.image_edit": TOOL_EDIT, "preset.text_to_video": TOOL_VIDEO, "preset.image_to_video": TOOL_VIDEO,
    "preset.youtube_transcript": TOOL_YOUTUBE,
}


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

# Cheap, solid defaults so a fresh preset runs without picking a model first (F6). Prices: NanoGPT list, 11/2026.
DEFAULT_MODELS = {
    "preset.text_to_image": ("flux-2-klein-9b", "text"),            # FLUX.2 klein 9B, ~$0.01 / image
    "preset.image_to_3d": ("wavespeed-ai/hunyuan-3d-v3.1-rapid", "image"),  # ~$0.27 / model
    "preset.text_to_3d": ("wavespeed-ai/hunyuan-3d-v3.1-rapid", "text"),
    "preset.image_edit": ("blackforestlabs/flux-3/klein/edit-image", "image"),   # ~$0.008 / image
    "preset.text_to_video": ("lightricks-ltx-2-fast", "text"),                     # ~$0.04 / second
    "preset.image_to_video": ("lightricks-ltx-2-fast", "image"),
}
# Price of one run with that default model (same list); shown only when the default model really applies.
_VIDEO_COST = "~$0.04 per second of video with the default model (6 s ≈ $0.24)"
DEFAULT_COST = {
    "preset.text_to_image": "~$0.01 per image with the default model",
    "preset.image_to_3d": "~$0.27 per model with the default model",
    "preset.text_to_3d": "~$0.27 per model with the default model",
    "preset.image_edit": "~$0.008 per image with the default model",
    "preset.text_to_video": _VIDEO_COST,
    "preset.image_to_video": _VIDEO_COST,
}


def _spec(base, type_name, title, icon, description, inputs, outputs, rename=None, drop=(), timeout=0, defaults=None,
          typical=SECONDS, cost=""):
    params = _params(base, rename, tuple(drop) + PLUMBING)
    for param in params:
        if defaults and param["name"] in defaults:
            param["default"] = defaults[param["name"]]
            param["fallback"] = True  # blank value -> this default at run time (build_tool_args)
    if type_name in DEFAULT_MODELS:
        model, accepts = DEFAULT_MODELS[type_name]
        for param in params:
            if param["name"] == "model" and param.get("options_source"):
                param["default"] = model
                param["options_accepts"] = accepts
                param["description"] = (f"Which model to use. Default: {model} (cheap and reliable); "
                                        "open the list to compare models and prices.")
                cost = DEFAULT_COST.get(type_name, cost)
    if timeout and not any(p["name"] == "timeout_s" for p in params):
        params.append({"name": "timeout_s", "kind": "number", "label": "Timeout (seconds)",
                       "default": timeout, "description": "Total job deadline, including polling."})
    spec = {"type": type_name, "title": title, "category": "Presets", "icon": icon,
            "description": description, "kind": "preset", "tool": base["tool"],
            "inputs": inputs, "outputs": outputs, "params": params, "typical": typical,
            # G7b: the tool's own arguments (also renamed/dropped ones) are never offered again as model settings
            "claimed": sorted(p["name"] for p in base.get("params", []))}
    if base.get("open_params"):
        spec["open_params"] = True
    if cost:
        spec["cost"] = cost
    return spec


def preset_types(tools: list) -> list:
    """Build available preset specs from the already allow/block-filtered registry entries."""
    from . import nodes as N  # late import: nodes calls us after constructing tool specs

    peers = {t.get("name") for t in tools}
    bases = {t.get("name"): N.tool_node_type(t, peers) for t in tools}
    out = []
    image_name = IMAGE_BUILTIN if IMAGE_BUILTIN in bases else IMAGE_NANO if IMAGE_NANO in bases else None
    if image_name:
        out.append(_spec(bases[image_name], "preset.text_to_image", "Text to image", "file-media",
                         "Generate an image from a prompt.",
                         [_input("prompt", "text", "Prompt", "What the image should show. Concrete subjects, style and light "
                                                   "work best.")], [_output("image", "image", "Image")],
                         drop=("imageDataUrl", "imageDataUrls"),
                         cost="Paid per image; the price depends on the image provider"))
    if TOOL_3D in bases:
        base = bases[TOOL_3D]
        common_drop = ("imageDataUrl", "images")
        cost_3d = "Paid per model; the price depends on the model"
        out.append(_multi_image(_spec(base, "preset.image_to_3d", "Image to 3D", "package",
                         "Turn one or more images into a 3D model; polls the NanoGPT job until it finishes.",
                         [_input("image", "image", "Image", "Pictures of one object, optionally from several angles; a plain background gives the cleanest model.")],
                         [_output("model", "model3d", "3D model")],
                         rename={"imageUrl": ("image", "Images")}, drop=("prompt",) + common_drop,
                         timeout=int(MAX_3D_S), typical=JOB, cost=cost_3d), max_items=4))
        out.append(_spec(base, "preset.text_to_3d", "Text to 3D", "package",
                         "Turn a prompt into a 3D model; polls the NanoGPT job until it finishes.",
                         [_input("prompt", "text", "Prompt", "Description of the object to model.")],
                         [_output("model", "model3d", "3D model")],
                         drop=("imageUrl",) + common_drop, timeout=int(MAX_3D_S), typical=JOB, cost=cost_3d))
    if TOOL_EDIT in bases:
        out.append(_multi_image(_spec(bases[TOOL_EDIT], "preset.image_edit", "Edit image", "edit",
                         "Change one or more existing images with an instruction, e.g. 'make the background a beach'.",
                         [_input("image", "image", "Image", "The picture(s) to change or combine."),
                          _input("prompt", "text", "Instruction", "What to change, in plain words.")],
                         [_output("image", "image", "Image")],
                         rename={"imageDataUrl": ("image", "Images")}, drop=("imageDataUrls", "maskDataUrl"),
                         cost="Paid per image; the price depends on the model")))
    if TOOL_VIDEO in bases:
        video_drop = ("imageDataUrl", "videoUrl")
        cost_video = "Paid per second of video; the price depends on the model"
        out.append(_spec(bases[TOOL_VIDEO], "preset.text_to_video", "Text to video", "device-camera-video",
                         "Generate a short video clip from a prompt; waits for the NanoGPT job.",
                         [_input("prompt", "text", "Prompt", "What happens in the clip: subject, action, camera, mood.")],
                         [_output("video", "video", "Video")], drop=("imageUrl",) + video_drop,
                         timeout=int(MAX_3D_S), defaults={"duration": 6}, typical=JOB, cost=cost_video))
        out.append(_spec(bases[TOOL_VIDEO], "preset.image_to_video", "Image to video", "device-camera-video",
                         "Animate a still image into a short clip; waits for the NanoGPT job.",
                         [_input("image", "image", "Image", "The first frame of the clip."),
                          _input("prompt", "text", "Prompt", "How the scene should move.")],
                         [_output("video", "video", "Video")], rename={"imageUrl": ("image", "Image")},
                         drop=video_drop, timeout=int(MAX_3D_S), defaults={"duration": 6}, typical=JOB,
                         cost=cost_video))
    if TOOL_YOUTUBE in bases:
        out.append(_spec(bases[TOOL_YOUTUBE], "preset.youtube_transcript", "YouTube transcript", "play-circle",
                         "Get the spoken text of a YouTube video.",
                         [_input("url", "text", "Video URL", "Link to the video, e.g. https://youtu.be/…")],
                         [_output("text", "text", "Transcript")], rename={"urls": ("url", "Video URL")}))
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
        return M.data_url(meta["path"])
    if isinstance(value, str) and value and not value.startswith(("data:", "https://", "http://")) \
            and os.path.isfile(value):
        return M.data_url(value)
    return value


def _inline(value):
    if isinstance(value, str):
        M.require_local_path(value)
    if ptypes.is_media(value):
        return M.data_url(value["$media"]["path"])
    if isinstance(value, str) and value and not value.startswith(("data:", "https://", "http://")) \
            and os.path.isfile(value):
        return M.data_url(value)
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


def _tool_args(node, spec, inputs):
    args = E.build_tool_args(spec, node, inputs)
    args.pop("timeout_s", None)  # Arachne Flow job setting, never a provider argument
    type_name = node.get("type")
    if type_name in ("preset.image_to_3d", "preset.image_to_video") and "image" in args:
        args.pop("image")
        raw = _raw_images(node, inputs)
        values = raw if isinstance(raw, list) else [raw]
        try:
            if type_name == "preset.image_to_3d" and len(values) > 1:
                args["images"] = [_remote_or_inline(v) for v in values]
            else:
                value = _remote_or_inline(values[0]) if values else None
                if isinstance(value, str) and value.startswith("data:"):
                    args["imageDataUrl"] = value
                else:
                    args["imageUrl"] = value
        except (M.MediaError, OSError, KeyError) as exc:
            raise E.NodeError(f"image: {exc}") from None
    elif type_name == "preset.vision" and "image" in args:
        args["image_url"] = args.pop("image")
    elif type_name == "preset.image_edit" and "image" in args:
        args.pop("image")
        raw = _raw_images(node, inputs)
        values = raw if isinstance(raw, list) else [raw]
        try:  # the edit API takes images inline only
            if len(values) > 1:
                args["imageDataUrls"] = [_inline(v) for v in values]
            else:
                args["imageDataUrl"] = _inline(values[0]) if values else None
        except (M.MediaError, OSError, KeyError) as exc:
            raise E.NodeError(f"image: {exc}") from None
    elif type_name in ("preset.web_extract", "preset.youtube_transcript") and "url" in args:
        args["urls"] = [args.pop("url")]
    return args


def _job_media(result, nctx):
    """A finished job's media: the server's ``urls`` first (signed links carry no file extension, so the
    generic scan misses them), then whatever the generic scan finds."""
    for i, url in enumerate(_job_urls(result)):
        try:
            return [M.ingest(url, nctx.out_dir, f"{nctx.node_id}-job{i}", allow_download=nctx.allow_download)]
        except Exception as exc:  # noqa: BLE001 - try the next link, then the generic scan
            E.logger.info("flowcanvas: job media %s skipped: %s", url[:120], exc)
    return E.collect_media(result, nctx)


async def _media_output(result, nctx, output_name, kind, collect=None):
    media = await asyncio.to_thread(collect or E.collect_media, result, nctx)
    if not media:
        raise E.NodeError(f"tool returned no {kind} media")
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


async def _run_job(env, tool, args, timeout, nctx, label):
    """NanoGPT 3D/video job: submit once, then poll operation+runId (+modelSlug) until a terminal status or
    the node's timeout (capped at MAX_3D_S). Each new status reaches the node as a progress line."""
    deadline = time.monotonic() + timeout
    job_id = model_slug = None
    last_status = None

    async def call(call_args):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise E.NodeError(f"{label} generation timed out after {int(timeout)} s")
        return await E.call_tool(env, tool, call_args, timeout=remaining)

    result = await call({**args, "operation": "submit_and_poll"})
    while True:
        status = _job_status(result)
        if status in DONE_STATES:
            return result
        if status in FAILED_STATES:
            raise E.NodeError(_job_error(result, label))
        if status and status != last_status:
            nctx.log(f"{label} job: {status}")
            last_status = status
        job_id = _job_field(result, "runId", "run_id", "jobId", "job_id") or job_id
        model_slug = _job_field(result, "modelSlug", "model_slug") or model_slug
        if not job_id:
            # Only a status-less finished media payload may omit the polling identifier.
            if not status and (E.multimodal_refs(result) or M.find_refs(result)):
                return result
            raise E.NodeError(f"{label} job {status or 'response'} has no runId/jobId for polling; "
                              "check the provider job before retrying to avoid a duplicate charge")
        await asyncio.sleep(min(POLL_INTERVAL_S, max(0, deadline - time.monotonic())))
        poll = {"operation": "poll", "runId": job_id}
        if isinstance(model_slug, str) and model_slug:
            poll["modelSlug"] = model_slug
        result = await call(poll)


async def _fit_images(env, spec, node, args, nctx, O):
    """Several images, but the model takes fewer (live 07.11.: hunyuan-3d-v3.1-rapid takes one and ignores
    ``images``, so the job ran as text-to-3D and failed with "A prompt is required"): send what it takes."""
    limit = await O.model_max_images(env, spec, node)
    images = args["images"]
    if limit is None or len(images) <= limit:
        return
    _model_param, model = O.node_model(spec, node)
    if limit == 1:
        first = args.pop("images")[0]
        args["imageDataUrl" if first.startswith("data:") else "imageUrl"] = first
        nctx.log(f"{model} takes one image; using the first of {len(images)}")
    else:
        args["images"] = images[:limit]
        nctx.log(f"{model} takes up to {limit} images; using the first {limit} of {len(images)}")


async def execute(env, node, spec, inputs, nctx):
    type_name = node.get("type")
    args = _tool_args(node, spec, inputs)
    from . import options as O  # late import, like nodes -> presets

    args.update(await O.model_extras(env, spec, node))  # the chosen model's own settings (G7b)
    if isinstance(args.get("images"), list):
        await _fit_images(env, spec, node, args, nctx, O)
    if type_name in ("preset.image_to_3d", "preset.text_to_3d"):
        result = await _run_job(env, spec["tool"], args, _3d_timeout(node, nctx), nctx, "3D")
        return await _media_output(result, nctx, "model", "model3d", collect=_job_media)
    if type_name in ("preset.text_to_video", "preset.image_to_video"):
        result = await _run_job(env, spec["tool"], args, _3d_timeout(node, nctx), nctx, "Video")
        return await _media_output(result, nctx, "video", "video", collect=_job_media)

    result = await E.call_tool(env, spec["tool"], args, E.node_timeout(node, nctx))
    if type_name in ("preset.text_to_image", "preset.image_edit"):
        return await _media_output(result, nctx, "image", "image")
    if type_name == "preset.youtube_transcript":
        return {"text": _transcript_output(result)}
    if type_name == "preset.tts":
        return await _media_output(result, nctx, "audio", "audio")
    if type_name == "preset.web_search":
        return {"results": result, "text": _text_output(result)}
    if type_name in ("preset.vision", "preset.web_extract"):
        return {"text": _text_output(result)}
    raise E.NodeError(f"unknown preset {type_name!r}")
