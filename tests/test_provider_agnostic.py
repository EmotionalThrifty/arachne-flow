"""Ready-made nodes work with any provider: found by capability, one node per step, portable flows (13.11.2026)."""
import asyncio
import json
import unittest

import helpers

E = helpers.load_engine()
P = E.presets


def tool(name, props, required=()):
    return {"name": name, "toolset": "", "description": "",
            "parameters": {"type": "object", "properties": {k: {"type": "string"} for k in props},
                           "required": list(required)}}


BUILTINS = [tool("vision_analyze", ["image_url", "question"]), tool("text_to_speech", ["text"]),
            tool("web_search", ["query"]), tool("web_extract", ["urls"])]


def presets(tools):
    return {s["type"]: s for s in P.preset_types(tools)}


class Nctx:
    def __init__(self):
        self.lines = []

    def log(self, msg):
        self.lines.append(msg)


class DiscoveryTest(unittest.TestCase):
    def test_llm_gateway_only_shows_only_what_exists(self):
        found = presets(BUILTINS)          # LiteLLM / Portkey / Vercel: text models only, no media backend
        self.assertEqual(set(found), {"preset.vision", "preset.tts", "preset.web_search", "preset.web_extract"})

    def test_hermes_media_backends_come_first(self):
        found = presets(BUILTINS + [tool("image_generate", ["prompt", "image_url"]),
                                    tool("video_generate", ["prompt", "image_url"]),
                                    tool("mcp__acme__acme_image_generate", ["prompt", "model"])])
        self.assertEqual(found["preset.text_to_image"]["tool"], "image_generate")
        self.assertEqual(found["preset.text_to_video"]["tool"], "video_generate")
        self.assertEqual(found["preset.image_to_video"]["tool"], "video_generate")
        self.assertIn("preset.text_to_image~acme", found)
        self.assertNotIn("preset.text_to_3d", found)            # no 3D provider -> hidden

    def test_any_mcp_server_by_capability_and_argument_spelling(self):
        found = presets([tool("mcp__meshy__meshy_generate_3d", ["image_url", "prompt", "model"]),
                         tool("mcp__meshy__meshy_list_3d_models", []),
                         tool("mcp__tripo__create_3d_model", ["input_image", "text"]),
                         tool("mcp__tripo__tripo_rig_3d", ["model_url"])])
        self.assertEqual(found["preset.image_to_3d"]["provider"], "Meshy")     # has a model list -> best
        self.assertEqual(found["preset.image_to_3d~tripo"]["args"]["image"], "input_image")
        self.assertEqual(found["preset.text_to_3d~tripo"]["args"]["prompt"], "text")
        self.assertEqual(found["preset.edit_3d"]["args"]["mesh"], "model_url")
        model = {p["name"]: p for p in found["preset.image_to_3d"]["params"]}["model"]
        self.assertEqual((model["options_source"], model["auto"]), ("mcp__meshy__meshy_list_3d_models", P.AUTO_PARAM))
        for spec in found.values():
            self.assertNotIn("nanogpt", json.dumps(spec).lower())

    def test_one_palette_entry_per_step_with_a_provider_choice(self):
        found = presets([tool("mcp__a__a_3d_generate", ["prompt"]), tool("mcp__b__b_3d_generate", ["prompt"])])
        plain, other = found["preset.text_to_3d"], found["preset.text_to_3d~b"]
        self.assertNotEqual(plain.get("palette"), False)
        self.assertIs(other["palette"], False)
        self.assertEqual([c["type"] for c in plain["providers"]], ["preset.text_to_3d", "preset.text_to_3d~b"])
        self.assertEqual(plain["provider_group"], other["provider_group"])
        self.assertEqual([p["name"] for p in plain["inputs"]], [p["name"] for p in other["inputs"]])

    def test_groups(self):
        found = presets(BUILTINS + [tool("image_generate", ["prompt"]), tool("mcp__x__x_3d_generate", ["prompt"])])
        self.assertEqual(found["preset.text_to_image"]["group"], "Image")
        self.assertEqual(found["preset.text_to_3d"]["group"], "3D")
        self.assertEqual(found["preset.tts"]["group"], "Audio")
        self.assertEqual(found["preset.web_search"]["group"], "General")
        self.assertEqual(set(P.PRESET_GROUP.values()) - set(P.PRESET_GROUP_ORDER), set())

    def test_provider_spelling_is_shared_by_all_tools_of_a_server(self):
        speaks = tool("mcp__acmegen__acmegen_image_generate", ["prompt"])
        speaks["description"] = "Generate images with AcmeGen models."
        silent = tool("mcp__acmegen__acmegen_3d_generate", ["prompt"])     # its description never names the server
        found = presets([speaks, silent])
        self.assertEqual(found["preset.text_to_image"]["provider"], "AcmeGen")
        self.assertEqual(found["preset.text_to_3d"]["provider"], "AcmeGen")
        self.assertEqual(P.provider_label("mcp__fal_ai__generate"), "FAL AI")

    def test_tts_does_not_offer_an_output_path(self):
        speech = tool("text_to_speech", ["text", "output_path"])
        names = [p["name"] for p in presets([speech])["preset.tts"]["params"]]
        self.assertNotIn("output_path", names)

    def test_job_protocol_is_read_from_the_schema(self):
        job = tool("mcp__x__x_3d_generate", ["prompt"])
        job["parameters"]["properties"]["operation"] = {"type": "string", "enum": ["submit", "poll"]}
        job["parameters"]["properties"]["taskId"] = {"type": "string"}
        self.assertEqual(presets([job])["preset.text_to_3d"]["args"]["job"],
                         {"submit": "submit", "poll": "poll", "id": "taskId"})
        plain = presets([tool("mcp__x__x_3d_generate", ["prompt"])])["preset.text_to_3d"]
        self.assertNotIn("job", plain["args"])
        no_handle = tool("mcp__x__x_3d_generate", ["prompt"])        # polling offered, but no field to name the job
        no_handle["parameters"]["properties"]["operation"] = {"type": "string", "enum": ["submit", "poll"]}
        self.assertNotIn("job", presets([no_handle])["preset.text_to_3d"]["args"])

    def test_job_calls_follow_the_schema(self):
        """Review R4: a strict submit/poll enum with its own id field gets exactly those values, never submit_and_poll."""
        job = tool("mcp__x__x_3d_generate", ["prompt"])
        job["parameters"]["properties"]["operation"] = {"type": "string", "enum": ["submit", "poll"]}
        job["parameters"]["properties"]["taskId"] = {"type": "string"}
        spec = presets([job])["preset.text_to_3d"]
        calls = []

        async def fake_call(env, tool_name, args, timeout=None):
            calls.append(dict(args))
            if args["operation"] == "submit":
                return {"status": "queued", "taskId": "t-1"}
            return {"status": "completed", "url": "https://cdn.example.com/m.glb"}

        original, P.POLL_INTERVAL_S = P.POLL_INTERVAL_S, 0
        old_call, P.E.call_tool = P.E.call_tool, fake_call
        try:
            asyncio.run(P._run_job(None, spec["tool"], {"prompt": "chest"}, 30, Nctx(), "3D", spec["args"]["job"]))
        finally:
            P.POLL_INTERVAL_S, P.E.call_tool = original, old_call
        self.assertEqual(calls, [{"prompt": "chest", "operation": "submit"}, {"operation": "poll", "taskId": "t-1"}])


class PortableFlowTest(unittest.TestCase):
    def test_missing_provider_variant_falls_back_to_the_step(self):
        idx = E.nodes.TypeIndex({"preset.text_to_3d": {"type": "preset.text_to_3d"}})
        self.assertEqual(idx["preset.text_to_3d~gone"]["type"], "preset.text_to_3d")
        self.assertIn("preset.text_to_3d~gone", idx)
        self.assertIsNone(idx.get("preset.edit_3d~gone"))
        self.assertNotIn("tool:x~y", idx)
        flow = {"nodes": [{"id": "a", "type": "preset.text_to_3d~gone", "params": {"prompt": "chest"}}], "edges": []}
        self.assertFalse([i for i in E.graph.validate(flow, idx) if i.get("level") == "error"])


class RunTest(unittest.TestCase):
    def env(self, handlers, tools):
        return E.env.Env(ctx=helpers.FakeCtx(handlers), state={"tool_source": lambda: tools})

    def test_resume_handle_is_called_again_until_done(self):
        tools = [tool("mcp__blender__generate_3d", ["prompt", "job"])]
        spec = presets(tools)["preset.text_to_3d"]
        calls = []

        def handler(args):
            calls.append(args.get("job"))
            return json.dumps({"status": "pending", "job": "j-1"} if len(calls) < 3 else {"status": "done"})

        old = P.RESUME_EVERY_S
        P.RESUME_EVERY_S = 0.01
        try:
            nctx = Nctx()
            asyncio.run(P._call_and_resume(self.env({"mcp__blender__generate_3d": handler}, tools), spec,
                                           {"prompt": "chest"}, 30, nctx, "3D"))
        finally:
            P.RESUME_EVERY_S = old
        self.assertEqual(calls, [None, "j-1", "j-1"])
        self.assertTrue(nctx.lines)

    def test_no_resume_without_a_handle_argument(self):
        tools = [tool("mcp__x__x_3d_generate", ["prompt"])]
        spec = presets(tools)["preset.text_to_3d"]
        calls = []
        handler = lambda a: calls.append(a) or json.dumps({"status": "pending", "job": "j"})  # noqa: E731
        asyncio.run(P._call_and_resume(self.env({"mcp__x__x_3d_generate": handler}, tools), spec, {"prompt": "p"},
                                       30, Nctx(), "3D"))
        self.assertEqual(len(calls), 1)

    def test_blank_or_foreign_model_runs_with_the_cheapest_listed_one(self):
        tools = [tool("mcp__m__m_3d_generate", ["prompt", "model"]), tool("mcp__m__m_list_3d_models", [])]
        rows = [{"id": "pricey", "pricing": {"per_run": 1.0}}, {"id": "cheap", "pricing": {"per_run": 0.1}}]
        env = self.env({"mcp__m__m_list_3d_models": lambda a: json.dumps({"data": rows})}, tools)
        spec = presets(tools)["preset.text_to_3d"]
        for chosen, mode, expect in (("", None, "cheap"), ("tripo3d/h3.0", None, "cheap"), ("pricey", None, "pricey"),
                                     ("", "best", "pricey")):
            nctx = Nctx()
            params = {"model": chosen, **({P.AUTO_PARAM: mode} if mode else {})}
            node = asyncio.run(P._auto_model(env, spec, {"type": spec["type"], "params": params}, nctx))
            self.assertEqual(node["params"]["model"], expect, (chosen, mode))
        names = [p["name"] for p in spec["params"]]
        self.assertEqual(names[names.index("model") + 1], P.AUTO_PARAM)
        args = P._tool_args({"type": spec["type"], "params": {P.AUTO_PARAM: "best", "prompt": "p"}}, spec, {})
        self.assertNotIn(P.AUTO_PARAM, args)

    def test_edit_3d_link_and_local_files(self):
        import os, tempfile
        tools = [tool("mcp__t__t_rig_3d", ["model_url"])]
        spec = presets(tools)["preset.edit_3d"]
        node = {"type": "preset.edit_3d", "params": {}}
        args = P._tool_args(node, spec, {"mesh": {"$media": {"kind": "model3d", "source": "https://cdn/x.glb"}}})
        self.assertEqual(args, {"model_url": "https://cdn/x.glb"})
        self.assertIn("takes no local files", spec["description"])
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["ARACHNE_FLOW_MEDIA_ROOTS"] = tmp
            try:
                glb = os.path.join(tmp, "x.glb")
                with open(glb, "wb") as fh:
                    fh.write(b"glTF" + b"\0" * 16)
                local = {"mesh": {"$media": {"kind": "model3d", "path": glb}}}
                with self.assertRaisesRegex(E.executors.NodeError, "only takes a public link"):
                    P._tool_args(node, spec, local)
                inline = presets([tool("mcp__t__t_rig_3d", ["model_url", "modelDataUrl"])])["preset.edit_3d"]
                self.assertNotIn("modelDataUrl", [p["name"] for p in inline["params"]])
                sent = P._tool_args(node, inline, local)
                self.assertEqual(list(sent), ["modelDataUrl"])
                self.assertTrue(sent["modelDataUrl"].startswith("data:"))
                only_inline = presets([tool("mcp__t__t_rig_3d", ["glb_base64"])])["preset.edit_3d"]
                self.assertEqual(list(P._tool_args(node, only_inline, local)), ["glb_base64"])
            finally:
                os.environ.pop("ARACHNE_FLOW_MEDIA_ROOTS", None)


class EditModelListTest(unittest.TestCase):
    ROWS = [{"id": "gen", "architecture": {"input_modalities": ["image"]}},
            {"id": "rig", "capabilities": {"requires_mesh": True, "operation": "rigging"}}]

    def test_edit_models_only_in_edit_3d(self):
        self.assertEqual([o["value"] for o in E.options.to_options({"data": self.ROWS}, accepts="image")], ["gen"])
        edit = E.options.to_options({"data": self.ROWS}, accepts="3d")
        self.assertEqual([(o["value"], o.get("operation")) for o in edit], [("rig", "rigging")])


class RenameTest(unittest.TestCase):
    def test_only_an_explicit_request_renames(self):
        G = E.generate
        for prompt in ("benenn den flow in Demo um", "rename it to Demo", "nenn ihn Demo"):
            self.assertTrue(G.wants_rename(prompt), prompt)
        for prompt in ("füge eine node hinzu", "change the title of the LLM node"):
            self.assertFalse(G.wants_rename(prompt), prompt)
        candidate = {"name": "New"}
        G.keep_flow_name({"name": "Old"}, candidate, "add a node")
        self.assertEqual(candidate["name"], "Old")
        G.keep_flow_name(None, candidate, "add a node")
        self.assertEqual(candidate["name"], "Old")


class FeedDtdTest(unittest.TestCase):
    def test_a_dtd_after_a_long_comment_is_refused_but_cdata_is_fine(self):
        padded = b'<?xml version="1.0"?>\n<!--' + b"x" * 6000 + b'-->\n<!DOCTYPE r [<!ENTITY a "b">]><rss/>'
        with self.assertRaisesRegex(ValueError, "DOCTYPE"):
            E.triggers.parse_feed(padded)
        ok = (b'<?xml version="1.0"?><rss><channel><item><title>t</title><guid>1</guid>'
              b'<description><![CDATA[<!DOCTYPE html><p>x</p>]]></description></item></channel></rss>')
        self.assertEqual(len(E.triggers.parse_feed(ok)), 1)


if __name__ == "__main__":
    unittest.main()
