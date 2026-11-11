"""Arachne Flow dev server: the real plugin router + fake Hermes tools, for the browser harness.

  bash scripts/hpy dev/dev_server.py [--port 9131]      then open http://127.0.0.1:9131/

Serves dev/harness.html (React from esm.sh, @hermes/plugin-sdk -> dev/sdk-stub.js), desktop/plugin.js,
the REAL dashboard/plugin_api.py router under /api/plugins/flowcanvas/ with a fake PluginContext,
plugin events as Server-Sent Events on /events, and /dev/reset?scenario=<name> to seed demo data.
Data lives in dev/out/data (git-ignored). Standalone local development and browser-harness tooling:
included in the repository for testing, never loaded by Hermes at plugin runtime.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import math
import os
import queue
import shutil
import struct
import sys
import threading
import time
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(HERE, "out", "data")
FILES = os.path.join(HERE, "out", "fake-files")
os.environ["FLOWCANVAS_DATA_DIR"] = DATA
os.environ["FLOWCANVAS_MEDIA_ROOTS"] = FILES   # fake tool outputs count as a tool's own folder (review E-3)
sys.path.insert(0, os.path.join(ROOT, "tests"))

import helpers  # noqa: E402

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse  # noqa: E402

DEV_TOOLS = [
    {"name": "web_search", "toolset": "web", "description": "Search the web (fake).",
     "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Search query"},
                                                     "limit": {"type": "integer", "default": 5}},
                    "required": ["query"]}},
    {"name": "web_extract", "toolset": "web", "description": "Read pages (fake).",
     "parameters": {"type": "object", "properties": {"urls": {"type": "array", "items": {"type": "string"}}},
                    "required": ["urls"]}},
    {"name": "image_generate", "toolset": "image_gen", "description": "Generate an image (fake).",
     "parameters": {"type": "object", "properties": {"prompt": {"type": "string"},
                                                     "aspect_ratio": {"type": "string",
                                                                      "enum": ["square", "landscape", "portrait"]}},
                    "required": ["prompt"]}},
    {"name": "text_to_speech", "toolset": "tts", "description": "Speak text (fake).",
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "vision_analyze", "toolset": "vision", "description": "Describe an image (fake).",
     "parameters": {"type": "object", "properties": {"image_url": {"type": "string"},
                                                     "question": {"type": "string"}},
                    "required": ["image_url", "question"]}},
    {"name": "mcp__nanogpt__nanogpt_3d_generate", "toolset": "mcp-nanogpt",
     "description": "Generate a 3D model (fake, takes 3 s).",
     "parameters": {"type": "object", "additionalProperties": True,
                    "properties": {"prompt": {"type": "string"}, "imageUrl": {"type": "string"},
                                   "imageDataUrl": {"type": "string"},
                                   "images": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4},
                                   "model": {"type": "string"}}}},
    {"name": "mcp__nanogpt__nanogpt_list_3d_models", "toolset": "mcp-nanogpt",
     "description": "List 3D models (fake).", "parameters": {"type": "object", "properties": {}}},
    # G7: schemas as the live @nanogpt/mcp 1.6.0 tools publish them; the lists answer with tests/fixtures rows.
    {"name": "mcp__nanogpt__nanogpt_image_generate", "toolset": "mcp-nanogpt", "description": "Generate images (fake).",
     "parameters": {"type": "object", "required": ["prompt"], "properties": {
         "prompt": {"type": "string", "minLength": 1}, "model": {"type": "string"},
         "n": {"type": "number", "minimum": 1, "maximum": 10}, "size": {"type": "string"},
         "resolution": {"type": "string"}, "aspect_ratio": {"type": "string"}, "quality": {"type": "string"},
         "response_format": {"type": "string", "enum": ["url", "b64_json"]}}}},
    {"name": "mcp__nanogpt__nanogpt_list_image_models", "toolset": "mcp-nanogpt",
     "description": "List image models (fake).", "parameters": {"type": "object", "properties": {}}},
    {"name": "mcp__nanogpt__nanogpt_video_generate", "toolset": "mcp-nanogpt", "description": "Generate videos (fake).",
     "parameters": {"type": "object", "additionalProperties": True, "properties": {
         "operation": {"type": "string", "enum": ["submit", "status", "poll", "submit_and_poll"]},
         "model": {"type": "string"}, "prompt": {"type": "string"}, "imageUrl": {"type": "string"},
         "duration": {"anyOf": [{"type": "number", "exclusiveMinimum": 0}, {"type": "string", "minLength": 1}]},
         "resolution": {"type": "string"}, "aspect_ratio": {"type": "string"}}}},
    {"name": "mcp__nanogpt__nanogpt_list_video_models", "toolset": "mcp-nanogpt",
     "description": "List video models (fake).", "parameters": {"type": "object", "properties": {}}},
    {"name": "mcp__nanogpt__nanogpt_list_text_models", "toolset": "mcp-nanogpt",
     "description": "List text models (fake, from the public catalog fixture).",
     "parameters": {"type": "object", "properties": {"detailed": {"type": "boolean"}}}},
    {"name": "slow_tool", "toolset": "dev", "description": "Sleeps, then echoes.",
     "parameters": {"type": "object", "properties": {"text": {"type": "string"},
                                                     "seconds": {"type": "number", "default": 2}}}},
    {"name": "fail_tool", "toolset": "dev", "description": "Always fails.",
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}}},
]
LIST_CALLS: list = []  # G7 probe: how often the image/video model lists were called (engine cache -> once each)
MEDIA_CALLS: list = []  # G8 probe: actual arguments received by the fake 3D tool
STOP_SLOW = threading.Event()  # set by drain_runs: running slow_tool calls return immediately


def _fixture_rows(kind: str, prefix: str = "") -> list:
    """Live NanoGPT list rows from tests/fixtures (G7): the dev lists answer with real shapes."""
    with open(os.path.join(ROOT, "tests", "fixtures", "nanogpt_models.json"), encoding="utf-8") as fh:
        return [r for r in json.load(fh)[kind] if r["id"].startswith(prefix)]


def _fixture_text_rows() -> list:
    with open(os.path.join(ROOT, "tests", "fixtures", "nanogpt_text_models.json"), encoding="utf-8") as fh:
        return json.load(fh)["data"]


def _png(color=(120, 90, 220), size=(512, 512)) -> bytes:
    from PIL import Image, ImageDraw
    img = Image.new("RGB", size, (24, 24, 30))
    draw = ImageDraw.Draw(img)
    w, h = size
    draw.ellipse((w * 0.2, h * 0.2, w * 0.8, h * 0.8), fill=color)
    draw.rectangle((w * 0.35, h * 0.1, w * 0.65, h * 0.3), fill=(230, 230, 240))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _wav(path: str, seconds: float = 1.0) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        frames = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000)))
                          for i in range(int(16000 * seconds)))
        w.writeframes(frames)


def _glb_cube() -> bytes:
    """A real 1-unit cube as binary glTF (positions, normals, indices, an orange material) for the 3D viewer."""
    import json as _json
    faces = [((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, 0, 1), (0, 1, 0)), ((0, 1, 0), (0, 0, 1), (1, 0, 0)),
             ((0, -1, 0), (1, 0, 0), (0, 0, 1)), ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (0, 1, 0), (1, 0, 0))]
    pos, nrm, idx = [], [], []
    for n, u, v in faces:
        base = len(pos) // 3
        for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            pos += [0.5 * (n[i] + su * u[i] + sv * v[i]) for i in range(3)]
            nrm += list(n)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    bin_ = struct.pack(f"<{len(pos)}f", *pos) + struct.pack(f"<{len(nrm)}f", *nrm) + struct.pack(f"<{len(idx)}H", *idx)
    bin_ += b"\0" * (-len(bin_) % 4)
    pb, nb = len(pos) * 4, len(nrm) * 4
    gltf = {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
            "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.95, 0.55, 0.2, 1]}}],
            "buffers": [{"byteLength": len(bin_)}],
            "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": pb}, {"buffer": 0, "byteOffset": pb, "byteLength": nb},
                            {"buffer": 0, "byteOffset": pb + nb, "byteLength": len(idx) * 2}],
            "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(pos) // 3, "type": "VEC3",
                           "min": [-0.5] * 3, "max": [0.5] * 3},
                          {"bufferView": 1, "componentType": 5126, "count": len(nrm) // 3, "type": "VEC3"},
                          {"bufferView": 2, "componentType": 5123, "count": len(idx), "type": "SCALAR"}]}
    js = _json.dumps(gltf).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(bin_), 0x004E4942) + bin_
    return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def _fake_file(name: str, data: bytes) -> str:
    os.makedirs(FILES, exist_ok=True)
    path = os.path.join(FILES, f"{int(time.time() * 1000)}-{name}")
    with open(path, "wb") as fh:
        fh.write(data)
    return path


class FakeLLM:
    def __init__(self):
        self.generate_calls = []

    def _generate(self, messages, kwargs):
        """G6 probe: one bad op repaired once, a provider/model override, then a persistent failure."""
        self.generate_calls.append({"messages": messages, **kwargs})
        number = len(self.generate_calls)
        current = messages[1]["content"].split("CURRENT FLOW (null means create a new flow)\n", 1)[-1]
        existing = not current.startswith("null\n")
        request = messages[1]["content"].rsplit("USER REQUEST\n", 1)[-1]
        if number == 1:
            text = json.dumps({"ops": [{"op": "add_node", "ref": "bad", "type": "not.a.node"}]})
        elif "fail" in request.lower():
            text = "still not JSON"
        elif existing:
            text = json.dumps({"ops": [
                {"op": "add_node", "ref": "note", "type": "note", "params": {"text": "Added by Hermes"}},
                {"op": "auto_layout"},
            ]})
        else:
            text = json.dumps({"name": "Generated text preview", "ops": [
                {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea", "params": {"value": "Hello"}},
                {"op": "add_node", "ref": "preview", "type": "output.preview", "title": "Preview"},
                {"op": "connect", "from": "idea.text", "to": "preview.value"},
                {"op": "auto_layout"},
            ]})
        return type("Result", (), {"text": text})()

    def complete(self, messages, **kwargs):
        time.sleep(0.8)
        if kwargs.get("purpose") == "flowcanvas generate":
            return self._generate(messages, kwargs)
        prompt = messages[-1]["content"]

        class R:
            text = ("A cute retro robot toy with rounded chrome body, glowing cyan eyes, studio lighting, "
                    "soft shadows, 3D render") if "robot" in prompt.lower() else f"(fake LLM) {prompt[:200]}"
        return R()


class DevCtx:
    """Stand-in PluginContext: dispatch_tool runs the fake tools above."""

    def __init__(self):
        self.llm = FakeLLM()

    def get_config(self, key, default=None):
        return default

    def dispatch_tool(self, name, args, **kwargs):
        time.sleep(0.4)
        if name == "web_search":
            q = args.get("query", "")
            return json.dumps({"success": True, "results": [
                {"title": f"Result {i + 1} for {q}", "url": f"https://example.com/{i}"} for i in range(3)]})
        if name == "web_extract":
            return json.dumps({"success": True, "content": "# Example page\n\nLorem ipsum dolor sit amet."})
        if name == "image_generate":
            time.sleep(1.2)
            return json.dumps({"success": True, "image": _fake_file("image.png", _png())})
        if name == "text_to_speech":
            path = os.path.join(FILES, f"{int(time.time() * 1000)}-speech.wav")
            os.makedirs(FILES, exist_ok=True)
            _wav(path)
            return json.dumps({"success": True, "file_path": path, "media_tag": "MEDIA:" + path})
        if name == "vision_analyze":
            return json.dumps({"success": True, "analysis": "A purple robot toy on a dark background."})
        if name == "mcp__nanogpt__nanogpt_3d_generate":
            MEDIA_CALLS.append(dict(args))
            time.sleep(3)
            return json.dumps({"result": "3D model ready", "structuredContent": {
                "status": "COMPLETED", "model_urls": {"glb": _fake_file("model.glb", _glb_cube())}}})
        if name == "mcp__nanogpt__nanogpt_list_text_models":
            import copy
            rows = _fixture_text_rows()
            if not args.get("detailed"):
                rows = [{"id": r["id"]} for r in rows]
            return json.dumps({"result": f"Found {len(rows)}", "structuredContent": {"data": rows}})
        if name == "mcp__nanogpt__nanogpt_list_3d_models":
            return json.dumps({"result": "Found 3 3D model(s)", "structuredContent": {"data": [
                {"id": "wavespeed-ai/hunyuan-3d-v3.1-rapid", "name": "Hunyuan 3D v3.1 Rapid", "owned_by": "wavespeed",
                 "architecture": {"input_modalities": ["text", "image"]}, "pricing": {"per_run": 0.27}},
                {"id": "tripo3d/p1", "name": "Tripo P1", "owned_by": "tripo",
                 "architecture": {"input_modalities": ["text", "image"]}, "pricing": {"per_run": 0.48}},
                {"id": "tripo3d/rig", "name": "Tripo Rig", "owned_by": "tripo", "capabilities": {"requires_mesh": True},
                 "architecture": {"input_modalities": ["3d"]}, "pricing": {"per_run": 0.3}}] + _fixture_rows("3d", "meshy/")}})
        if name in ("mcp__nanogpt__nanogpt_list_image_models", "mcp__nanogpt__nanogpt_list_video_models"):
            kind = "image" if "image" in name else "video"
            with open(os.path.join(ROOT, "tests", "fixtures", "nanogpt_models.json"), encoding="utf-8") as fh:
                rows = json.load(fh)[kind]
            LIST_CALLS.append(name)
            return json.dumps({"result": f"Found {len(rows)}", "structuredContent": {"data": rows}})
        if name == "mcp__nanogpt__nanogpt_image_generate":
            time.sleep(1.2)
            return json.dumps({"success": True, "image": _fake_file("nano.png", _png((200, 120, 60)))})
        if name == "slow_tool":
            # waits on an event, so drain_runs can end a long fake step at once instead of leaking its thread
            STOP_SLOW.wait(float(args.get("seconds") or 2))
            return json.dumps({"text": "slow: " + str(args.get("text", ""))})
        if name == "fail_tool":
            return json.dumps({"success": False, "error": "This tool always fails (dev)."})
        return json.dumps({"error": f"Unknown tool: {name}"})


# ----------------------------------------------------------------- events (SSE)

class EventHub:
    def __init__(self):
        self.lock = threading.Lock()
        self.queues: list = []

    def publish(self, event: str, payload: dict) -> None:
        line = json.dumps({"name": f"plugin.flowcanvas.{event}", "payload": payload}, default=str)
        with self.lock:
            for q in list(self.queues):
                q.put(line)

    def subscribe(self):
        q: queue.Queue = queue.Queue()
        with self.lock:
            self.queues.append(q)
        return q

    def unsubscribe(self, q) -> None:
        with self.lock:
            if q in self.queues:
                self.queues.remove(q)


HUB = EventHub()


def drain_runs(timeout=5) -> list:
    """Cancel and join fake runs so probes cannot leak threads into the next scenario/process exit."""
    env = _env()
    handles = list(env.state.get("active_runs", {}).values())
    for handle in handles:
        if not handle.done.is_set():
            handle.cancel.set()
    STOP_SLOW.set()
    pending = []
    for handle in handles:
        if not handle.done.wait(timeout):
            pending.append(handle.run["id"])
    STOP_SLOW.clear()
    return pending


# ----------------------------------------------------------------- scenarios

def _engine():
    return helpers.load_backend().engine()


def _env():
    return helpers.load_backend().env()


def reset(scenario: str) -> dict:
    """Wipe dev data and seed a scenario. Returns {flow_id, select, run_id}."""
    rt = setup_runtime()
    drain_runs()
    rt.ctx().llm.generate_calls = []
    LIST_CALLS.clear()
    MEDIA_CALLS.clear()
    shutil.rmtree(DATA, ignore_errors=True)
    os.makedirs(DATA, exist_ok=True)
    if scenario == "empty":
        return {"flow_id": None}
    E = _engine()
    env = _env()
    types = E.nodes.types_by_name(env)
    if scenario == "media_inputs":
        first = _fake_file("front.png", _png((80, 140, 220), (320, 240)))
        second = _fake_file("side.png", _png((220, 140, 80), (320, 240)))
        flow = E.graph.new_flow("Media inputs", "G8: two wired images plus a local file")
        flow, results = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "front", "type": "input.file", "title": "Front",
             "params": {"path": first, "kind": "image"}},
            {"op": "add_node", "ref": "side", "type": "input.file", "title": "Side",
             "params": {"path": second, "kind": "image"}},
            {"op": "add_node", "ref": "m3d", "type": "preset.image_to_3d", "title": "Multi 3D",
             "params": {"model": "meshy/v7.1/multi-image-to-3d", "image": []}},
            {"op": "connect", "from": "front.file", "to": "m3d.image"},
            {"op": "connect", "from": "side.file", "to": "m3d.image"},
            {"op": "auto_layout"},
        ], types)
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        # File cards grow once their image previews load; leave room so the post-run probe stays overlap-free.
        front = next(n for n in flow["nodes"] if n["id"] == refs["front"])
        side = next(n for n in flow["nodes"] if n["id"] == refs["side"])
        model = next(n for n in flow["nodes"] if n["id"] == refs["m3d"])
        side["y"] = front["y"] + 440
        model["x"], model["y"] = front["x"] + 420, front["y"]
        flow = E.store.save_flow(env, flow, create=True)
        return {"flow_id": flow["id"], "select": refs["m3d"], "run_id": None}
    if scenario == "model_settings":
        flow = E.graph.new_flow("Model settings", "G7: choices and cost follow the chosen model")
        flow, results = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea", "params": {"value": "a red fox"}},
            {"op": "add_node", "ref": "img", "type": "tool:mcp__nanogpt__nanogpt_image_generate", "title": "NanoGPT image",
             "params": {"model": "p-h3-image", "n": 6, "size": "4k"}},
            {"op": "add_node", "ref": "vid", "type": "preset.text_to_video", "title": "Video"},
            {"op": "add_node", "ref": "m3d", "type": "preset.image_to_3d", "title": "3D",
             "params": {"model": "meshy/v7.1/multi-image-to-3d"}},
            {"op": "connect", "from": "idea.text", "to": "img.prompt"},
            {"op": "connect", "from": "idea.text", "to": "vid.prompt"},
            {"op": "auto_layout"},
        ], types)
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        flow = E.store.save_flow(env, flow, create=True)
        return {"flow_id": flow["id"], "select": refs["img"], "run_id": None}
    if scenario == "inspector_error":
        flow = E.graph.new_flow("Failing tool", "A tool node that errors, for the inspector")
        flow, results = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "txt", "type": "input.text", "title": "Text", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "bad", "type": "tool:fail_tool", "title": "Broken step"},
            {"op": "connect", "from": "txt.text", "to": "bad.text"},
            {"op": "auto_layout"},
        ], types)
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        flow = E.store.save_flow(env, flow, create=True)
        handle = E.runner.start_run(env, flow["id"])
        handle.done.wait(30)
        return {"flow_id": flow["id"], "select": refs["bad"], "run_id": handle.run["id"]}
    if scenario == "loop":
        # G11: three names -> For each -> If (not bob) -> Hi template -> Collect -> Preview; a finished run.
        flow = E.graph.new_flow("Loop", "G11: For each, Collect")
        flow, results = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "src", "type": "input.text", "title": "Names", "params": {"value": "anna\nbob\ncleo"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach", "title": "Each name"},
            {"op": "add_node", "ref": "if", "type": "logic.if", "title": "Not Bob",
             "params": {"op": "not equals", "compare": "bob"}},
            {"op": "add_node", "ref": "hi", "type": "text.template", "title": "Greeting", "params": {"template": "Hi {{name}}"}},
            {"op": "add_node", "ref": "all", "type": "logic.collect", "title": "All greetings"},
            {"op": "add_node", "ref": "show", "type": "output.preview", "title": "Result"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "if.value"},
            {"op": "connect", "from": "if.true", "to": "hi.name"},
            {"op": "connect", "from": "hi.text", "to": "all.value"},
            {"op": "connect", "from": "all.list", "to": "show.value"},
            {"op": "auto_layout"},
        ], types)
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        flow = E.store.save_flow(env, flow, create=True)
        handle = E.runner.start_run(env, flow["id"], fresh=True)
        handle.done.wait(15)
        return {"flow_id": flow["id"], "select": refs["hi"], "run_id": handle.run["id"]}
    if scenario == "logic":
        # G10: Answer "no" -> If takes False; the True step is skipped (branch), Merge passes the False value on;
        # Switch "green" takes case2, case1 + Default are skipped.
        flow = E.graph.new_flow("Branches", "G10: If, Switch, Merge")
        flow, results = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "ans", "type": "input.text", "title": "Answer", "params": {"value": "no"}},
            {"op": "add_node", "ref": "if", "type": "logic.if", "title": "Is yes?",
             "params": {"op": "equals", "compare": "yes"}},
            {"op": "add_node", "ref": "yes", "type": "text.template", "title": "Yes text",
             "params": {"template": "Great: {{a}}"}},
            {"op": "add_node", "ref": "no", "type": "text.template", "title": "No text",
             "params": {"template": "Sorry: {{a}}"}},
            {"op": "add_node", "ref": "m", "type": "logic.merge", "title": "Either"},
            {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Reply"},
            {"op": "add_node", "ref": "col", "type": "input.text", "title": "Colour", "params": {"value": "green"}},
            {"op": "add_node", "ref": "sw", "type": "logic.switch", "title": "Which colour",
             "params": {"cases": "red\ngreen"}},
            {"op": "add_node", "ref": "r", "type": "output.preview", "title": "Red"},
            {"op": "add_node", "ref": "g", "type": "output.preview", "title": "Green"},
            {"op": "add_node", "ref": "d", "type": "output.preview", "title": "Other"},
            {"op": "connect", "from": "ans.text", "to": "if.value"},
            {"op": "connect", "from": "if.true", "to": "yes.a"},
            {"op": "connect", "from": "if.false", "to": "no.a"},
            {"op": "connect", "from": "yes.text", "to": "m.value"},
            {"op": "connect", "from": "no.text", "to": "m.value"},
            {"op": "connect", "from": "m.value", "to": "out.value"},
            {"op": "connect", "from": "col.text", "to": "sw.value"},
            {"op": "connect", "from": "sw.case1", "to": "r.value"},
            {"op": "connect", "from": "sw.case2", "to": "g.value"},
            {"op": "connect", "from": "sw.default", "to": "d.value"},
            {"op": "auto_layout"},
        ], types)
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        flow = E.store.save_flow(env, flow, create=True)
        handle = E.runner.start_run(env, flow["id"], fresh=True)
        handle.done.wait(15)
        return {"flow_id": flow["id"], "select": refs["sw"], "run_id": handle.run["id"], "refs": refs}
    if scenario == "timings":
        # G9: three earlier runs of the slow step (11/12/13 s) give a measured average; the live run keeps the
        # slow step running (clock) while the broken step has already failed (error tooltip).
        flow = E.graph.new_flow("Timings", "G9: live clock, measured durations, tooltips")
        flow, results = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "txt", "type": "input.text", "title": "Text", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "slow", "type": "tool:slow_tool", "title": "Slow step", "params": {"seconds": 25}},
            {"op": "add_node", "ref": "bad", "type": "tool:fail_tool", "title": "Broken step"},
            {"op": "connect", "from": "txt.text", "to": "slow.text"},
            {"op": "connect", "from": "txt.text", "to": "bad.text"},
            {"op": "auto_layout"},
        ], types)
        refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        flow = E.store.save_flow(env, flow, create=True)
        for i, ms in enumerate((11000, 12000, 13000)):
            at = f"2026-11-01T10:0{i}:00Z"
            E.store.save_run(env, {
                "id": E.store.new_run_id(), "flow_id": flow["id"], "flow_revision": flow.get("revision"),
                "status": "done", "started_at": at, "finished_at": at, "ms": ms, "target_node": None, "fresh": False,
                "order": [refs["slow"]], "nodes": {refs["slow"]: {
                    "type": "tool:slow_tool", "model": "", "status": "done", "ms": ms, "started_at": at}}})
        handle = E.runner.start_run(env, flow["id"], fresh=True)
        deadline = time.time() + 8
        while time.time() < deadline:
            nodes = handle.run["nodes"]
            if nodes.get(refs["bad"], {}).get("status") == "error" and nodes.get(refs["slow"], {}).get("status") == "running":
                break
            time.sleep(0.05)
        return {"flow_id": flow["id"], "select": refs["slow"], "run_id": handle.run["id"]}
    flow = E.graph.new_flow("Prompt to 3D", "Idea -> better prompt -> image -> 3D model")
    flow, results = E.graph.apply_ops(flow, [
        {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea",
         "params": {"value": "a cute robot toy"}},
        {"op": "add_node", "ref": "llm", "type": "llm.complete", "title": "Better prompt",
         "params": {"system": "You write vivid prompts for image models.",
                    "template": "Write an image prompt for: {{idea}}"}},
        {"op": "add_node", "ref": "img", "type": "tool:image_generate", "title": "Image",
         "params": {"aspect_ratio": "square"}},
        {"op": "add_node", "ref": "vis", "type": "tool:vision_analyze", "title": "Check image",
         "params": {"question": "Is this a robot toy?"}},
        {"op": "add_node", "ref": "m3d", "type": "tool:mcp__nanogpt__nanogpt_3d_generate", "title": "3D model"},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
        {"op": "add_node", "ref": "note", "type": "note", "title": "Note",
         "params": {"text": "Change the idea and press Run. Cached steps are skipped."}},
        {"op": "connect", "from": "idea.text", "to": "llm.idea"},
        {"op": "connect", "from": "llm.text", "to": "img.prompt"},
        {"op": "connect", "from": "img.media", "to": "vis.image_url"},
        {"op": "connect", "from": "img.media", "to": "m3d.imageUrl"},
        {"op": "connect", "from": "m3d.media", "to": "out.value"},
        {"op": "auto_layout"},
    ], types)
    refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
    note = E.graph.node_by_id(flow, refs["note"])
    note["x"], note["y"] = 80, 420
    flow = E.store.save_flow(env, flow, create=True)
    E.store.create_flow(env, name="Web research digest")
    out = {"flow_id": flow["id"], "select": None, "run_id": None}
    if scenario in ("running", "inspector", "inspector_llm", "inspector_3d", "done"):
        handle = E.runner.start_run(env, flow["id"])
        out["run_id"] = handle.run["id"]
        if scenario in ("inspector", "inspector_llm", "inspector_3d", "done"):
            handle.done.wait(30)
        else:
            time.sleep(2.5)
        if scenario == "inspector":
            out["select"] = refs["img"]
        if scenario == "inspector_llm":
            out["select"] = refs["llm"]
        if scenario == "inspector_3d":
            out["select"] = refs["m3d"]
    if scenario == "tool_swap":
        out["select"] = refs["vis"]
    return out


# ----------------------------------------------------------------- app

_RUNTIME = {}


def setup_runtime():
    """Idempotent: one shared runtime with the fake ctx, fake tools and the SSE event mirror."""
    if "rt" not in _RUNTIME:
        rt = helpers.load_module("runtime.py", "flowcanvas_runtime")
        rt.bind(DevCtx())
        state = rt.STATE.setdefault("engine_state", {})
        state["tool_source"] = lambda: DEV_TOOLS
        rt.STATE["emit_hook"] = HUB.publish
        _RUNTIME["rt"] = rt
    return _RUNTIME["rt"]


def build_app() -> FastAPI:
    setup_runtime()
    api_mod = helpers.load_module(os.path.join("dashboard", "plugin_api.py"), "flowcanvas_dev_api")
    app = FastAPI()
    app.include_router(api_mod.router, prefix="/api/plugins/flowcanvas")

    def no_cache(path: str, media_type: str) -> Response:
        with open(path, "rb") as fh:
            return Response(fh.read(), media_type=media_type, headers={"Cache-Control": "no-store"})

    @app.get("/")
    def index():
        return no_cache(os.path.join(HERE, "harness.html"), "text/html")

    @app.get("/plugin.js")
    def plugin_js():
        return no_cache(os.path.join(ROOT, "desktop", "plugin.js"), "text/javascript")

    @app.get("/{name}.js")
    def dev_js(name: str):
        if name not in ("sdk-stub", "boot"):
            return Response(status_code=404)
        return no_cache(os.path.join(HERE, name + ".js"), "text/javascript")

    @app.get("/dev/reset")
    def dev_reset(scenario: str = "template"):
        return reset(scenario)

    @app.get("/dev/generate-calls")
    def dev_generate_calls():
        calls = setup_runtime().ctx().llm.generate_calls
        return {"calls": [{k: v for k, v in call.items() if k != "messages"} for call in calls]}

    @app.get("/events")
    async def events(request: Request):
        q = HUB.subscribe()

        async def stream():
            try:
                yield "retry: 1000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        line = await asyncio.to_thread(q.get, True, 0.5)
                    except queue.Empty:
                        yield ": ping\n\n"
                        continue
                    yield f"data: {line}\n\n"
            finally:
                HUB.unsubscribe(q)
        return StreamingResponse(stream(), media_type="text/event-stream")

    return app


def serve(port: int = 9131, block: bool = True):
    import uvicorn
    config = uvicorn.Config(build_app(), host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    if block:
        server.run()
        return None
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9131)
    parser.add_argument("--scenario", default=None)
    args = parser.parse_args()
    if args.scenario:
        print(json.dumps(reset(args.scenario)))
    print(f"Arachne Flow dev server on http://127.0.0.1:{args.port}/")
    serve(args.port)
