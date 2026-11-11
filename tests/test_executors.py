"""A4: media detection/ingest and node executors (no network: downloads are faked)."""
import asyncio
import base64
import json
import os
import tempfile
import unittest

import helpers

E = helpers.load_engine()
M, X, N, T = E.media, E.executors, E.nodes, E.types

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()


def run(coro):
    return asyncio.run(coro)


class FakeLLM:
    def __init__(self, reply="LLM says hi"):
        self.reply = reply
        self.calls = []

    def complete(self, messages, **kwargs):
        self.calls.append((messages, kwargs))

        class R:
            text = self.reply
        return R()


class Ctx(helpers.FakeCtx):
    def __init__(self, tools=None, llm=None):
        super().__init__(tools)
        self.llm = llm or FakeLLM()


class MediaTest(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="fc-media-")
        self.src = tempfile.mkdtemp(prefix="fc-src-")
        os.environ["FLOWCANVAS_DATA_DIR"] = self.src  # fake tool files live where real ones do: in Arachne Flow's (or Hermes') folders (review E-3)

    def write(self, name, data=b"x"):
        path = os.path.join(self.src, name)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def test_kind_for(self):
        self.assertEqual(M.kind_for("a/b/c.PNG"), "image")
        self.assertEqual(M.kind_for("https://x.io/m/robot.glb?sig=1"), "model3d")
        self.assertEqual(M.kind_for("audio/mpeg"), "audio")
        self.assertEqual(M.kind_for("model/gltf-binary"), "model3d")
        self.assertEqual(M.kind_for("C:/x/y.mp4"), "video")
        self.assertEqual(M.kind_for("notes.unknown"), "file")

    def test_data_url_ingest(self):
        m = M.ingest(PNG_DATA_URL, self.out, "n_000001-0")
        meta = m["$media"]
        self.assertEqual(meta["kind"], "image")
        self.assertTrue(meta["path"].endswith(".png"))
        with open(meta["path"], "rb") as fh:
            self.assertEqual(fh.read(), PNG)

    def test_local_copy_and_media_line(self):
        path = self.write("voice.mp3", b"ID3")
        m = M.ingest("MEDIA:" + path, self.out, "n_000002-0")
        self.assertEqual(m["$media"]["kind"], "audio")
        self.assertEqual(os.path.dirname(m["$media"]["path"]), os.path.abspath(self.out))
        self.assertTrue(os.path.exists(path))                    # source untouched
        again = M.from_local(m["$media"]["path"], self.out)       # already inside out dir: no copy
        self.assertEqual(again["$media"]["path"], m["$media"]["path"])

    def test_find_refs(self):
        local = self.write("robot.glb", b"glTF")
        result = {
            "success": True,
            "image": "https://cdn.example.com/a/b.png",
            "items": [{"url": "https://news.example.com/article"},          # plain page: not media
                      {"thumbnail": "https://img.example.com/t?id=7"}],     # media key, no extension
            "file_path": local,
            "media_tag": "MEDIA:" + local,
            "notes": "see https://x.example.com/clip.mp4 for the clip",
        }
        refs = M.find_refs(result)
        self.assertIn("https://cdn.example.com/a/b.png", refs)
        self.assertIn("https://img.example.com/t?id=7", refs)
        self.assertNotIn("https://news.example.com/article", refs)
        self.assertIn(local, refs)
        self.assertNotIn("https://x.example.com/clip.mp4", refs)          # URLs in prose only at top level
        self.assertIn("https://x.example.com/clip.mp4", M.find_refs("watch https://x.example.com/clip.mp4 now"))

    def test_extract_media_dedupes_and_skips_failures(self):
        local = self.write("tts.ogg", b"OggS")
        result = {"file_path": local, "media_tag": "MEDIA:" + local, "image": "https://bad.example/x.png"}
        original = M._http_get

        def fail(*a, **k):
            raise M.MediaError("offline")
        M._http_get = fail
        try:
            media = M.extract_media(result, self.out, "n_000003")
        finally:
            M._http_get = original
        self.assertEqual(len(media), 1)
        self.assertEqual(media[0]["$media"]["kind"], "audio")

    def test_download_with_fake_http(self):
        original = M._http_get

        def fake(url, dest, timeout, max_bytes):
            with open(dest, "wb") as fh:
                fh.write(PNG)
            return "image/png"
        M._http_get = fake
        try:
            m = M.ingest("https://cdn.example.com/file?id=1", self.out, "n_000004-0")
        finally:
            M._http_get = original
        self.assertEqual(m["$media"]["kind"], "image")
        self.assertTrue(m["$media"]["path"].endswith(".png"))
        self.assertEqual(m["$media"]["source"], "https://cdn.example.com/file?id=1")

    def test_private_address_refused(self):
        with self.assertRaises(M.MediaError):
            M._http_get("http://127.0.0.1:9/x.png", os.path.join(self.out, "x.png"), 5, 1000)

    def test_to_arg(self):
        path = self.write("pic.png", PNG)
        m = M.make_media(path, source="https://cdn.example.com/pic.png")
        self.assertEqual(M.to_arg(m, "image_url"), "https://cdn.example.com/pic.png")
        self.assertEqual(M.to_arg(m, "path"), os.path.abspath(path))
        self.assertTrue(M.to_arg(m, "imageDataUrl").startswith("data:image/png;base64,"))
        self.assertEqual(M.to_arg("plain", "x"), "plain")


class ExecutorTest(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp(prefix="fc-exec-")
        self.nctx = X.NodeContext(run_id="r_test", node_id="n_abcdef", out_dir=self.out, timeout_s=5,
                                  log=lambda msg: None)

    def spec(self, type_name, tools=()):
        env = E.env.Env(state={"tool_source": lambda: list(tools)})
        return N.get_type(env, type_name)

    def exec(self, node, inputs=None, ctx=None, tools=()):
        env = E.env.Env(ctx=ctx, state={})
        return run(X.execute(env, node, self.spec(node["type"], tools), inputs or {}, self.nctx))

    def test_inputs_and_template(self):
        self.assertEqual(self.exec({"type": "input.text", "params": {"value": "hi"}}), {"text": "hi"})
        self.assertEqual(self.exec({"type": "input.number", "params": {"value": "2.5"}}), {"number": 2.5})
        out = self.exec({"type": "text.template", "params": {"template": "A {{x}} and {{ y }}!"}},
                        {"x": 3, "y": {"k": 1}})
        self.assertEqual(out["text"], 'A 3 and {\n  "k": 1\n}!')

    def test_input_file(self):
        path = os.path.join(self.out, "in.png")
        with open(path, "wb") as fh:
            fh.write(PNG)
        out = self.exec({"type": "input.file", "params": {"path": path}})
        self.assertEqual(out["file"]["$media"]["kind"], "image")
        with self.assertRaises(X.NodeError):
            self.exec({"type": "input.file", "params": {"path": path + ".missing"}})

    def test_json_pick(self):
        data = {"result": {"items": [{"url": "u0"}, {"url": "u1"}]}}
        self.assertEqual(self.exec({"type": "json.pick", "params": {"path": "result.items[1].url"}},
                                   {"data": data})["value"], "u1")
        self.assertEqual(self.exec({"type": "json.pick", "params": {"path": "result.items.0.url"}},
                                   {"data": json.dumps(data)})["value"], "u0")
        with self.assertRaises(X.NodeError):
            self.exec({"type": "json.pick", "params": {"path": "result.nope"}}, {"data": data})

    def test_llm(self):
        llm = FakeLLM("A shiny robot")
        out = self.exec({"type": "llm.complete",
                         "params": {"system": "Be brief.", "template": "Improve: {{idea}}", "temperature": "0.3"}},
                        {"idea": "robot"}, ctx=Ctx(llm=llm))
        self.assertEqual(out, {"text": "A shiny robot"})
        messages, kwargs = llm.calls[0]
        self.assertEqual(messages[0], {"role": "system", "content": "Be brief."})
        self.assertEqual(messages[1]["content"], "Improve: robot")
        self.assertEqual(kwargs["temperature"], 0.3)
        with self.assertRaises(X.NodeError):
            self.exec({"type": "llm.complete", "params": {"template": "{{x}}"}}, {}, ctx=Ctx(llm=llm))
        self.assertNotIn("model", kwargs)
        self.assertNotIn("provider", kwargs)

    def test_llm_model_choice(self):
        llm = FakeLLM("ok")
        self.exec({"type": "llm.complete",
                   "params": {"template": "{{p}}", "provider": "custom", "model": " z-ai/glm-5.3-flash "}},
                  {"p": "hi"}, ctx=Ctx(llm=llm))
        _, kwargs = llm.calls[0]
        self.assertEqual((kwargs["provider"], kwargs["model"]), ("custom", "z-ai/glm-5.3-flash"))

    def test_llm_model_not_allowed(self):
        class Denied(FakeLLM):
            def complete(self, messages, **kwargs):
                raise PermissionError("cannot override the model")
        with self.assertRaises(X.NodeError) as cm:
            self.exec({"type": "llm.complete", "params": {"template": "{{p}}", "model": "x"}},
                      {"p": "hi"}, ctx=Ctx(llm=Denied()))
        self.assertIn("allow_model_override", str(cm.exception))

    def test_tool_node(self):
        tools = [{"name": "web_search", "toolset": "web", "parameters": {"type": "object", "properties": {
            "query": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["query"]}}]
        ctx = Ctx({"web_search": lambda a: json.dumps({"results": [{"title": "T", "url": "https://e.com"}],
                                                       "summary": "found 1"})})
        node = {"id": "n_abcdef", "type": "tool:web_search", "params": {"query": "fallback", "limit": "3"}}
        out = self.exec(node, {"query": "hermes"}, ctx=ctx, tools=tools)
        self.assertEqual(ctx.calls[0], ("web_search", {"query": "hermes", "limit": 3}))
        self.assertEqual(out["text"], "found 1")
        self.assertEqual(out["result"]["results"][0]["title"], "T")
        self.assertIsNone(out["media"])

    def test_tool_errors(self):
        tools = [{"name": "t", "toolset": "x", "parameters": {"type": "object", "properties": {
            "a": {"type": "string"}}, "required": ["a"]}}]
        node = {"id": "n_abcdef", "type": "tool:t", "params": {}}
        ctx = Ctx({"t": lambda a: json.dumps({"success": False, "error": "quota exceeded"})})
        with self.assertRaisesRegex(X.NodeError, "missing required input: a"):
            self.exec(node, {}, ctx=ctx, tools=tools)
        with self.assertRaisesRegex(X.NodeError, "quota exceeded"):
            self.exec(node, {"a": "x"}, ctx=ctx, tools=tools)
        ctx2 = Ctx({"t": lambda a: json.dumps({"error": "Unknown tool: t"})})
        with self.assertRaisesRegex(X.NodeError, "Unknown tool"):
            self.exec(node, {"a": "x"}, ctx=ctx2, tools=tools)
        with self.assertRaisesRegex(X.NodeError, "not available"):
            self.exec(node, {"a": "x"}, ctx=None, tools=tools)

    def test_tool_timeout(self):
        import time
        tools = [{"name": "slow", "toolset": "x", "parameters": {"type": "object", "properties": {}}}]
        ctx = Ctx({"slow": lambda a: (time.sleep(2), "{}")[1]})
        node = {"id": "n_abcdef", "type": "tool:slow", "params": {"timeout_s": 0.2}}
        with self.assertRaisesRegex(X.NodeError, "timed out"):
            self.exec(node, {}, ctx=ctx, tools=tools)

    def test_tool_media_and_multimodal(self):
        tools = [{"name": "img", "toolset": "image_gen", "parameters": {"type": "object", "properties": {
            "prompt": {"type": "string"}, "imageDataUrl": {"type": "string"}}}}]
        ctx = Ctx({"img": lambda a: {"_multimodal": True, "content": [
            {"type": "text", "text": "done"}, {"type": "image", "data": base64.b64encode(PNG).decode(),
                                                "mimeType": "image/png"}]}})
        out = self.exec({"id": "n_abcdef", "type": "tool:img", "params": {"prompt": "p"}}, {}, ctx=ctx, tools=tools)
        self.assertEqual(out["text"], "done")
        self.assertEqual(out["media"]["$media"]["kind"], "image")
        # media input -> data URL for a *DataUrl parameter
        src = M.make_media(out["media"]["$media"]["path"])
        self.exec({"id": "n_abcdef", "type": "tool:img", "params": {"prompt": "p"}},
                  {"imageDataUrl": src}, ctx=ctx, tools=tools)
        self.assertTrue(ctx.calls[-1][1]["imageDataUrl"].startswith("data:image/png;base64,"))

    def test_json_param_and_bad_json(self):
        tools = [{"name": "j", "toolset": "x", "parameters": {"type": "object", "properties": {
            "items": {"type": "array"}}}}]
        ctx = Ctx({"j": lambda a: json.dumps({"n": len(a["items"])})})
        out = self.exec({"id": "n_abcdef", "type": "tool:j", "params": {"items": "[1, 2]"}}, {}, ctx=ctx, tools=tools)
        self.assertEqual(out["result"], {"n": 2})
        with self.assertRaisesRegex(X.NodeError, "not valid JSON"):
            self.exec({"id": "n_abcdef", "type": "tool:j", "params": {"items": "[1,"}}, {}, ctx=ctx, tools=tools)

    def test_unknown_and_preview(self):
        with self.assertRaises(X.NodeError):
            run(X.execute(E.env.Env(), {"type": "tool:gone"}, None, {}, self.nctx))
        self.assertEqual(self.exec({"type": "output.preview"}, {"value": 7}), {"value": 7})

    def test_best_text_and_error_detection(self):
        self.assertEqual(X.best_text({"result": "Balance: $1", "structuredContent": {}}), "Balance: $1")
        self.assertEqual(X.best_text({"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}), "a\nb")
        self.assertIsNone(X.tool_error({"error": None, "data": 1}))
        self.assertIsNone(X.tool_error({"error": "x", "data": [1], "items": 2}))   # error key amid real data
        self.assertEqual(X.tool_error({"isError": True, "content": [{"type": "text", "text": "boom"}]}), "boom")


if __name__ == "__main__":
    unittest.main()
