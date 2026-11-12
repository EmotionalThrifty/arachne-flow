"""arachne-flow backend router, mounted at /api/plugins/arachne-flow/.

Thin and stable: every route delegates to ../backend.py through runtime.load_backend() — the one loader the
agent half uses too (review E-14). Hot reload of backend/engine happens there, only with ARACHNE_FLOW_DEV=1.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys

from fastapi import APIRouter, HTTPException, Request

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime.py")

router = APIRouter()
# Review E-13: bounded before parsing. A 25 MB canvas drop travels as base64 (+33 %) inside JSON.
MAX_BODY_BYTES = 36 * 1024 * 1024


def _runtime():
    """The process-wide runtime module (the copy Hermes loaded with the package, else a fresh boot copy)."""
    for module in list(sys.modules.values()):
        path = getattr(module, "__file__", None)
        if path and hasattr(module, "find_or_load"):
            try:
                if os.path.normcase(os.path.realpath(path)) == os.path.normcase(RUNTIME):
                    return module.find_or_load()
            except OSError:
                continue
    spec = importlib.util.spec_from_file_location("arachne_flow_runtime_boot", RUNTIME)
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)
    return boot.find_or_load()


def backend():
    return _runtime().load_backend()


@router.api_route("/x/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def extra(path: str, request: Request):
    """Routes added during development land here without a router remount."""
    body = {}
    if request.method in ("POST", "PUT"):
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            raise HTTPException(413, f"request body over {MAX_BODY_BYTES // (1024 * 1024)} MB")
        multipart = request.headers.get("content-type", "").lower().lstrip().startswith("multipart/form-data")
        if multipart and path.strip("/") != "uploads":
            raise HTTPException(400, "multipart bodies are only accepted on /x/uploads")
        raw = await _bounded_body(request)
        if multipart:
            # Replay only the bounded bytes through Starlette's public Request API, never its private caches.
            async def receive_body():
                return {"type": "http.request", "body": raw, "more_body": False}
            body = await _multipart_body(Request(request.scope, receive_body))
        else:
            if raw.strip():
                try:
                    body = json.loads(raw)
                except ValueError:
                    raise HTTPException(400, "invalid JSON body") from None
    return await backend().route(request.method, path, dict(request.query_params), body)


async def _bounded_body(request: Request) -> bytes:
    """Stop at the crossing chunk, even if Content-Length is missing or understated."""
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, f"request body over {MAX_BODY_BYTES // (1024 * 1024)} MB")
        body.extend(chunk)
    return bytes(body)


async def _multipart_body(request: Request) -> dict:
    """One multipart file part into the body shape engine.api._upload takes: ``{name, data}`` with the raw bytes.

    The plugin SDK's `upload` option (PluginRestOptions) posts a single part named `file`; the desktop builds the
    multipart body in its main process. Size is bounded before parsing and again after reading, and the media layer
    still enforces MAX_UPLOAD_BYTES.
    """
    try:
        form = await request.form()
    except Exception:   # noqa: BLE001 — a truncated body or a server without python-multipart
        raise HTTPException(400, "invalid multipart body") from None
    try:
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            raise HTTPException(400, "multipart body needs one file part named \"file\"")
        data = await upload.read()
        name = getattr(upload, "filename", None) or ""
    finally:
        await form.close()
    if len(data) > MAX_BODY_BYTES:
        raise HTTPException(413, f"request body over {MAX_BODY_BYTES // (1024 * 1024)} MB")
    return {"name": name, "data": data}


# This process serves the canvas, so it is long-lived: it may fire triggers (engine/triggers.py).
try:
    _runtime().STATE["dashboard"] = True
    backend().start_triggers()
except Exception:  # noqa: BLE001 - the router must mount even if the trigger loop cannot start
    import logging
    logging.getLogger("arachne-flow.api").exception("arachne-flow: trigger loop not started")
