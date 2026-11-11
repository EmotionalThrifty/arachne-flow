"""A8: curated media/web presets and the NanoGPT 3D job lifecycle."""
import asyncio
import importlib
import json
import os
import tempfile
import unittest

import helpers

E = helpers.load_engine()
NANO_IMAGE = "mcp__nanogpt__nanogpt_image_generate"
NANO_3D = "mcp__nanogpt__nanogpt_3d_generate"


def tool(name, props, required=()):
    return {"name": name, "toolset": "test", "description": f"Fake {name}",
            "parameters": {"type": "object", "properties": props, "required": list(required)}}


TOOLS = [
    tool("image_generate", {"prompt": {"type": "string"},
                            "aspect_ratio": {"type": "string", "enum": ["square", "portrait"]}}, ["prompt"]),
    tool(NANO_IMAGE, {"prompt": {"type": "string"}}, ["prompt"]),
    tool(NANO_3D, {"prompt": {"type": "string"}, "imageUrl": {"type": "string"},
                   "imageDataUrl": {"type": "string"},
                   "operation": {"type": "string", "default": "submit_and_poll"},
                   "model": {"type": "string", "default": "fast"}}),
    tool("vision_analyze", {"image_url": {"type": "string"}, "question": {"type": "string"}},
         ["image_url", "question"]),
    tool("text_to_speech", {"text": {"type": "string"}, "voice": {"type": "string", "default": "alloy"}}, ["text"]),
    tool("web_search", {"query": {"type": "string"}, "limit": {"type": "integer", "default": 5}}, ["query"]),
    tool("web_extract", {"urls": {"type": "array", "items": {"type": "string"}}, "depth": {"type": "string"}}, ["urls"]),
]


def specs(tools=TOOLS):
    engine = helpers.load_engine()
    env = engine.env.Env(ctx=helpers.FakeCtx(), state={})
    return engine.nodes.types_by_name(env, tools=tools)


class PresetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="flowcanvas-presets-")
        self.addCleanup(self.tmp.cleanup)
        os.environ["FLOWCANVAS_DATA_DIR"] = self.tmp.name  # fake tool files live where real ones do: in Arachne Flow's (or Hermes') folders (review E-3)
        self.out = os.path.join(self.tmp.name, "outputs")
        os.makedirs(self.out)

    def file(self, name):
        path = os.path.join(self.tmp.name, name)
        with open(path, "wb") as fh:
            fh.write(b"fake media")
        return path

    def execute(self, type_name, ctx, inputs=None, params=None, all_tools=TOOLS, log=None, allow_download=False):
        engine = helpers.load_engine()
        spec = specs(all_tools)[type_name]
        env = engine.env.Env(ctx=ctx, state={})
        node = {"id": "n_test", "type": type_name, "params": params or {}}
        nctx = engine.executors.NodeContext(run_id="run_test", node_id="n_test", out_dir=self.out,
                                            allow_download=allow_download, log=log or (lambda msg: None))
        return asyncio.run(engine.executors.execute(env, node, spec, inputs or {}, nctx))

    def test_all_seven_presets_have_curated_typed_ports(self):
        found = specs()
        expected = {
            "preset.text_to_image": ("prompt", "text", "image", "image"),
            "preset.image_to_3d": ("image", "image", "model", "model3d"),
            "preset.text_to_3d": ("prompt", "text", "model", "model3d"),
            "preset.vision": ("image", "image", "text", "text"),
            "preset.tts": ("text", "text", "audio", "audio"),
            "preset.web_search": ("query", "text", "results", "json"),
            "preset.web_extract": ("url", "text", "text", "text"),
        }
        for name, (input_name, input_type, output_name, output_type) in expected.items():
            with self.subTest(name=name):
                spec = found[name]
                self.assertEqual(spec["kind"], "preset")
                self.assertEqual(spec["category"], "Presets")
                self.assertEqual(spec["inputs"][0]["name"], input_name)
                self.assertEqual(spec["inputs"][0]["type"], input_type)
                self.assertTrue(spec["inputs"][0]["required"])
                self.assertEqual(spec["outputs"][0]["name"], output_name)
                self.assertEqual(spec["outputs"][0]["type"], output_type)
        self.assertEqual(found["preset.text_to_image"]["tool"], "image_generate")
        timeout = {p["name"]: p for p in found["preset.text_to_3d"]["params"]}["timeout_s"]
        self.assertEqual(timeout["default"], 900)
        for name in ("preset.image_to_3d", "preset.text_to_3d"):
            params = {p["name"] for p in found[name]["params"]}
            self.assertNotIn("operation", params)
            self.assertNotIn("imageDataUrl", params)
            self.assertNotIn("images", params)

    def test_presets_follow_tool_availability_and_image_fallback(self):
        fallback = specs([tool(NANO_IMAGE, {"prompt": {"type": "string"}}, ["prompt"])])
        self.assertEqual(fallback["preset.text_to_image"]["tool"], NANO_IMAGE)
        self.assertNotIn("preset.text_to_3d", fallback)
        self.assertNotIn("preset.vision", fallback)
        none = specs([tool("web_search", {"query": {"type": "string"}}, ["query"])])
        self.assertEqual([n for n, s in none.items() if s.get("kind") == "preset"], ["preset.web_search"])

    def test_presets_carry_duration_and_cost_hints(self):
        found = specs()
        for name, spec in found.items():
            if spec.get("kind") == "preset":
                with self.subTest(name=name):
                    self.assertTrue(spec.get("typical"))
        self.assertEqual(found["preset.text_to_image"]["typical"], "seconds")
        self.assertTrue(found["preset.text_to_3d"]["typical"].startswith("minutes"))
        # the fixture's 3D tool has no model list -> no default model -> no default-model price
        self.assertEqual(found["preset.text_to_3d"]["cost"], "Paid per model; the price depends on the model")
        self.assertNotIn("cost", found["preset.web_search"])
        listed = TOOLS + [tool("mcp__nanogpt__nanogpt_list_3d_models", {})]
        paired = specs(listed)["preset.text_to_3d"]
        model = {p["name"]: p for p in paired["params"]}["model"]
        self.assertEqual(model["default"], "wavespeed-ai/hunyuan-3d-v3.1-rapid")
        self.assertEqual(paired["cost"], "~$0.27 per model with the default model")

    def test_text_to_image_returns_image_media(self):
        path = self.file("source.png")
        ctx = helpers.FakeCtx({"image_generate": lambda args: json.dumps({"success": True, "image": path})})
        result = self.execute("preset.text_to_image", ctx, {"prompt": "a robot"}, {"aspect_ratio": "square"})
        self.assertEqual(ctx.calls[0], ("image_generate", {"prompt": "a robot", "aspect_ratio": "square"}))
        self.assertEqual(result["image"]["$media"]["kind"], "image")
        self.assertTrue(os.path.isfile(result["image"]["$media"]["path"]))

    def test_tts_returns_audio_media(self):
        path = self.file("voice.wav")
        ctx = helpers.FakeCtx({"text_to_speech": lambda args: json.dumps({"file_path": path})})
        result = self.execute("preset.tts", ctx, {"text": "hello"}, {"voice": "alloy"})
        self.assertEqual(ctx.calls[0][1], {"text": "hello", "voice": "alloy"})
        self.assertEqual(result["audio"]["$media"]["kind"], "audio")

    def test_vision_maps_image_and_extracts_analysis(self):
        ctx = helpers.FakeCtx({"vision_analyze": lambda args: json.dumps({"analysis": "A purple robot"})})
        result = self.execute("preset.vision", ctx, {"image": "https://example.com/robot.png", "question": "What?"})
        self.assertEqual(ctx.calls[0][1], {"image_url": "https://example.com/robot.png", "question": "What?"})
        self.assertEqual(result["text"], "A purple robot")

    def test_web_search_returns_json_and_text(self):
        raw = {"success": True, "results": [{"title": "Hermes", "url": "https://example.com"}]}
        ctx = helpers.FakeCtx({"web_search": lambda args: json.dumps(raw)})
        result = self.execute("preset.web_search", ctx, {"query": "Hermes"}, {"limit": 5})
        self.assertEqual(ctx.calls[0][1], {"query": "Hermes", "limit": 5})
        self.assertEqual(result["results"], raw)
        self.assertIn("Hermes", result["text"])

    def test_web_extract_wraps_one_url_for_the_tool(self):
        ctx = helpers.FakeCtx({"web_extract": lambda args: json.dumps({"content": "# Page\nText"})})
        result = self.execute("preset.web_extract", ctx, {"url": "https://example.com"}, {"depth": "short"})
        self.assertEqual(ctx.calls[0][1], {"urls": ["https://example.com"], "depth": "short"})
        self.assertEqual(result["text"], "# Page\nText")

    def test_3d_job_polls_by_run_id_until_completed(self):
        presets = importlib.import_module(E.__name__ + ".presets")
        presets.POLL_INTERVAL_S = 0
        path = self.file("model.glb")
        polls = []

        def generate(args):
            if args["operation"] == "submit_and_poll":
                return json.dumps({"runId": "job-123", "status": "PENDING"})
            polls.append(args)
            if len(polls) == 1:
                return json.dumps({"structuredContent": {"runId": "job-123", "status": "RUNNING"}})
            return json.dumps({"structuredContent": {"status": "COMPLETED", "model_urls": {"glb": path}}})

        ctx = helpers.FakeCtx({NANO_3D: generate})
        result = self.execute("preset.image_to_3d", ctx, {"image": "https://example.com/robot.png"})
        self.assertEqual(ctx.calls[0][1], {"imageUrl": "https://example.com/robot.png", "operation": "submit_and_poll"})
        self.assertEqual(polls, [{"operation": "poll", "runId": "job-123"}, {"operation": "poll", "runId": "job-123"}])
        self.assertEqual(result["model"]["$media"]["kind"], "model3d")

    def test_3d_completed_submission_does_not_poll(self):
        path = self.file("model.glb")
        ctx = helpers.FakeCtx({NANO_3D: lambda args: json.dumps({
            "runId": "job-done", "structuredContent": {"status": "COMPLETED", "model_urls": {"glb": path}}})})
        result = self.execute("preset.text_to_3d", ctx, {"prompt": "a robot"})
        self.assertEqual(len(ctx.calls), 1)
        self.assertEqual(ctx.calls[0][1]["prompt"], "a robot")
        self.assertNotIn("timeout_s", ctx.calls[0][1])
        self.assertEqual(result["model"]["$media"]["kind"], "model3d")

    def test_3d_local_image_becomes_data_url_not_windows_path(self):
        engine = helpers.load_engine()
        image = engine.media.from_local(self.file("local.png"), copy=False)
        path = self.file("model.glb")
        ctx = helpers.FakeCtx({NANO_3D: lambda args: json.dumps({
            "structuredContent": {"status": "COMPLETED", "model_urls": {"glb": path}}})})
        result = self.execute("preset.image_to_3d", ctx, {"image": image})
        args = ctx.calls[0][1]
        self.assertTrue(args["imageDataUrl"].startswith("data:image/png;base64,"))
        self.assertNotIn("imageUrl", args)
        self.assertEqual(result["model"]["$media"]["kind"], "model3d")

    def _multi_view_run(self, rows, model=None):
        """Four views into Image to 3D with a model catalog; returns (args sent to the 3D tool, log lines)."""
        listed = TOOLS + [tool("mcp__nanogpt__nanogpt_list_3d_models", {})]
        path = self.file("model.glb")
        ctx = helpers.FakeCtx({
            "mcp__nanogpt__nanogpt_list_3d_models": lambda a: json.dumps({"structuredContent": {"data": rows}}),
            NANO_3D: lambda args: json.dumps({"structuredContent": {"status": "COMPLETED", "model_urls": {"glb": path}}})})
        views = [f"https://example.com/{v}.png" for v in ("front", "back", "left", "right")]
        lines = []
        self.execute("preset.image_to_3d", ctx, {"image": views}, {"model": model} if model else None,
                     all_tools=listed, log=lines.append)
        return next(a for name, a in ctx.calls if name == NANO_3D), lines

    def test_several_views_to_a_single_image_model_send_the_first_view(self):
        # Live 07.11.: hunyuan-3d-v3.1-rapid takes one image; `images` was ignored -> "A prompt is required".
        rows = [{"id": "wavespeed-ai/hunyuan-3d-v3.1-rapid", "capabilities": {"image_to_3d": True, "text_to_3d": True}}]
        args, lines = self._multi_view_run(rows)
        self.assertEqual(args.get("imageUrl"), "https://example.com/front.png")
        self.assertNotIn("images", args)
        self.assertTrue(any("one image" in l and "4" in l for l in lines), lines)

    def test_several_views_to_a_multi_image_model_stay_a_list(self):
        rows = [{"id": "meshy/v6-lite", "capabilities": {"image_to_3d": True, "max_images": 4, "multi_image_to_3d": True}}]
        args, _ = self._multi_view_run(rows, model="meshy/v6-lite")
        self.assertEqual(len(args.get("images") or []), 4)
        self.assertNotIn("imageUrl", args)

    def test_more_views_than_the_model_takes_are_cut(self):
        rows = [{"id": "m/two", "capabilities": {"image_to_3d": True, "max_images": 2}}]
        args, lines = self._multi_view_run(rows, model="m/two")
        self.assertEqual(args.get("images"), ["https://example.com/front.png", "https://example.com/back.png"])

    def test_3d_failed_job_becomes_node_error(self):
        ctx = helpers.FakeCtx({NANO_3D: lambda args: json.dumps({
            "runId": "job-bad", "structuredContent": {"status": "FAILED", "message": "model unavailable"}})})
        with self.assertRaisesRegex(helpers.load_engine().executors.NodeError, "model unavailable"):
            self.execute("preset.text_to_3d", ctx, {"prompt": "a robot"})



# ----------------------------------------------------------------- E-1: the real @nanogpt/mcp job payloads
# Shapes from @nanogpt/mcp 1.6.0 `runMediaJob` (dist/tools/generationExtras.js :496-528) as Hermes renders
# them (`mcp_tool_handlers._render_call_tool_result`: text block -> "result", plus "structuredContent").
# `status` is the whole /api/video/status JSON ({requestId, data: {status, output}, model}) or null.
NANO_VIDEO = "mcp__nanogpt__nanogpt_video_generate"
VIDEO_TOOLS = TOOLS + [tool(NANO_VIDEO, {"prompt": {"type": "string"}, "operation": {"type": "string"},
                                         "model": {"type": "string"}, "duration": {"type": "number"}})]
MODEL_SLUG = "wavespeed-ai/hunyuan-3d-v3.1-rapid"
CDN = "https://cdn.example.com/jobs/job-1/output"  # signed links carry no file extension


def nano_running(label="3D", status="IN_PROGRESS", run_id="job-1"):
    """submit_and_poll (or poll) whose wait ran out while the job still runs."""
    return json.dumps({
        "result": f"{label} job {run_id} is still running after 50s (status {status}, id {run_id}). Continue with "
                  f'operation "poll" (keep waiting) or "status" with runId "{run_id}" and modelSlug "{MODEL_SLUG}".',
        "structuredContent": {"submission": {"runId": run_id, "modelSlug": MODEL_SLUG}, "runId": run_id,
                              "modelSlug": MODEL_SLUG, "urls": [],
                              "status": {"requestId": run_id, "data": {"status": status}, "model": MODEL_SLUG}}})


def nano_finished(label="3D", status="COMPLETED", urls=(CDN,), output=None, error=None, run_id="job-1"):
    data = {"status": status, "output": output if output is not None else {}}
    if error is not None:
        data["error"] = error
    return json.dumps({
        "result": f"{label} generation status: status {status}, id {run_id}" + "".join(f", {u}" for u in urls),
        "structuredContent": {"runId": run_id, "modelSlug": MODEL_SLUG, "urls": list(urls),
                              "status": {"requestId": run_id, "data": data, "model": MODEL_SLUG}}})


class FakeDownloads:
    """Replaces media._http_get: every URL downloads as `mime` (no network)."""
    def __init__(self, mime):
        self.mime, self.urls = mime, []

    def __enter__(self):
        self.media = helpers.load_engine().media
        self.original = self.media._http_get

        def fake(url, dest, timeout, max_bytes):
            self.urls.append(url)
            with open(dest, "wb") as fh:
                fh.write(b"glTF fake")
            return self.mime
        self.media._http_get = fake
        return self

    def __exit__(self, *exc):
        self.media._http_get = self.original


class NanoJobTest(unittest.TestCase):
    file, execute = PresetTest.file, PresetTest.execute

    def setUp(self):
        PresetTest.setUp(self)
        presets = importlib.import_module(helpers.load_engine().__name__ + ".presets")
        self.addCleanup(setattr, presets, "POLL_INTERVAL_S", presets.POLL_INTERVAL_S)
        presets.POLL_INTERVAL_S = 0

    def test_3d_job_reads_the_real_status_object_and_urls(self):
        polls, logs = [], []

        def generate(args):
            if args["operation"] == "submit_and_poll":
                return nano_running()
            polls.append(args)
            if len(polls) == 1:
                return nano_running()
            return nano_finished(output={"model3d_assets": [{"url": CDN, "format": "glb"}]})

        ctx = helpers.FakeCtx({NANO_3D: generate})
        with FakeDownloads("model/gltf-binary") as dl:
            result = self.execute("preset.text_to_3d", ctx, {"prompt": "a robot"}, {"timeout_s": 5},
                                  log=logs.append, allow_download=True)
        self.assertEqual(polls, [{"operation": "poll", "runId": "job-1", "modelSlug": MODEL_SLUG}] * 2)
        self.assertEqual(logs, ["3D job: IN_PROGRESS"])
        self.assertEqual(dl.urls, [CDN])
        self.assertEqual(result["model"]["$media"]["kind"], "model3d")
        self.assertEqual(result["model"]["$media"]["source"], CDN)

    def test_3d_failed_status_object_becomes_node_error(self):
        ctx = helpers.FakeCtx({NANO_3D: lambda args: nano_finished(
            status="FAILED", urls=(), error={"message": "model unavailable"})})
        with self.assertRaisesRegex(helpers.load_engine().executors.NodeError, "model unavailable"):
            self.execute("preset.text_to_3d", ctx, {"prompt": "a robot"}, {"timeout_s": 2})

    def test_3d_timed_out_job_is_a_node_error(self):
        ctx = helpers.FakeCtx({NANO_3D: lambda args: nano_finished(status="timed_out", urls=())})
        with self.assertRaisesRegex(helpers.load_engine().executors.NodeError, "TIMED_OUT"):
            self.execute("preset.text_to_3d", ctx, {"prompt": "a robot"}, {"timeout_s": 2})

    def test_video_job_logs_with_the_video_label(self):
        logs = []
        replies = iter([nano_running(label="Video", status="in_progress"), nano_finished(label="Video")])
        ctx = helpers.FakeCtx({NANO_VIDEO: lambda args: next(replies)})
        with FakeDownloads("video/mp4"):
            result = self.execute("preset.text_to_video", ctx, {"prompt": "waves"}, {"timeout_s": 5},
                                  all_tools=VIDEO_TOOLS, log=logs.append, allow_download=True)
        self.assertEqual(logs, ["Video job: IN_PROGRESS"])
        self.assertEqual(result["video"]["$media"]["kind"], "video")

    def test_node_context_requires_a_log(self):
        X = helpers.load_engine().executors
        with self.assertRaises(TypeError):
            X.NodeContext(run_id="r", node_id="n", out_dir=self.out)

    def test_runner_shows_job_progress_on_the_node(self):
        engine = helpers.load_engine()
        helpers.temp_data_dir()
        events = []
        replies = iter([nano_running(), nano_finished()])
        ctx = helpers.FakeCtx({NANO_3D: lambda args: next(replies)})
        env = engine.env.Env(ctx=ctx, state={"tool_source": lambda: TOOLS}, emit=lambda e, p: events.append((e, dict(p))))
        flow, _ = engine.graph.apply_ops(engine.graph.new_flow("t"), [
            {"op": "add_node", "ref": "a", "type": "preset.text_to_3d", "title": "3D",
             "params": {"prompt": "a robot", "timeout_s": 5}}], engine.nodes.types_by_name(env))
        flow = engine.store.save_flow(env, flow, create=True)
        with FakeDownloads("model/gltf-binary"):
            run = engine.runner.run_sync(env, flow["id"], timeout_s=20)
        nid = flow["nodes"][0]["id"]
        self.assertEqual(run["nodes"][nid]["status"], "done", run["nodes"][nid])
        progress = [p.get("progress") for e, p in events if e == "node.status" and p["node_id"] == nid]
        self.assertIn("3D job: IN_PROGRESS", progress)


if __name__ == "__main__":
    unittest.main()
