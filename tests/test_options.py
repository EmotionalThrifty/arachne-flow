"""F6: model dropdowns for tool settings, paired with a sibling "list models" tool."""
import asyncio
import json
import unittest

import helpers

E = helpers.load_engine()
O = E.options
IMG = "mcp__nanogpt__nanogpt_image_generate"
LIST_IMG = "mcp__nanogpt__nanogpt_list_image_models"
D3 = "mcp__nanogpt__nanogpt_3d_generate"
LIST_3D = "mcp__nanogpt__nanogpt_list_3d_models"
LIST_TEXT = "mcp__nanogpt__nanogpt_list_text_models"


def tool(name, props, required=()):
    return {"name": name, "toolset": "mcp-nanogpt", "description": f"Fake {name}",
            "parameters": {"type": "object", "properties": props, "required": list(required)}}


TOOLS = [
    tool(IMG, {"prompt": {"type": "string"}, "model": {"type": "string"}}, ["prompt"]),
    tool(D3, {"prompt": {"type": "string"}, "imageUrl": {"type": "string"}, "model": {"type": "string"}}),
    tool(LIST_IMG, {"detailed": {"type": "boolean"}}),
    tool(LIST_3D, {}),
    tool(LIST_TEXT, {}),
    tool("mcp__other__render", {"model": {"type": "string"}}),
    tool("image_generate", {"prompt": {"type": "string"}, "model": {"type": "string"}}),
]

# Shape of the real Hermes MCP handler output: {"result": text, "structuredContent": {...}}
IMAGE_LIST = json.dumps({"result": "Found 3 image model(s)", "structuredContent": {"data": [
    {"id": "flux-2-klein-9b", "name": "FLUX.2 [klein] 9B", "owned_by": "flux",
     "architecture": {"input_modalities": ["text"], "output_modalities": ["image"]},
     "pricing": {"per_image": {"1024*1024": 0.01, "auto": 0.01}}},
    {"id": "clarity-upscaler", "name": "Upscaler", "owned_by": "clarityai",
     "architecture": {"input_modalities": ["image"], "output_modalities": ["image"]}, "pricing": {"starting_at": 0.2}},
    {"id": "nano-banana", "name": "Nano Banana", "owned_by": "gemini",
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["image"]}},
]}})
LIST_3D_RESULT = json.dumps({"result": "Found 2", "structuredContent": {"data": [
    {"id": "hunyuan", "owned_by": "wavespeed", "architecture": {"input_modalities": ["text", "image"]},
     "pricing": {"per_run": 0.27}},
    {"id": "tripo3d/rig", "capabilities": {"requires_mesh": True}, "architecture": {"input_modalities": ["3d"]}},
]}})


def env_with(tools=None):
    ctx = helpers.FakeCtx(tools or {})
    return E.env.Env(ctx=ctx, state={}), ctx


class PairingTest(unittest.TestCase):
    def test_pairs_by_server_and_kind(self):
        peers = {t["name"] for t in TOOLS}
        self.assertEqual(O.options_source(IMG, peers), LIST_IMG)
        self.assertEqual(O.options_source(D3, peers), LIST_3D)
        self.assertIsNone(O.options_source("mcp__other__render", peers))  # no list tool on that server
        self.assertIsNone(O.options_source("image_generate", peers))      # built-in tools: no pairing
        self.assertEqual(O.options_source("mcp__x__make_thing", {"mcp__x__list_models"}), "mcp__x__list_models")
        self.assertTrue(O.is_model_param("model") and O.is_model_param("image_model"))
        self.assertFalse(O.is_model_param("modelSlug") or O.is_model_param("model_url"))

    def test_node_types_carry_the_source(self):
        env, _ = env_with()
        types = E.nodes.types_by_name(env, tools=TOOLS)
        model = next(p for p in types["tool:" + IMG]["params"] if p["name"] == "model")
        self.assertEqual(model["options_source"], LIST_IMG)
        self.assertIn("description", model)
        other = next(p for p in types["tool:mcp__other__render"]["params"] if p["name"] == "model")
        self.assertNotIn("options_source", other)

    def test_presets_pick_the_cheapest_model_when_blank(self):
        env, _ = env_with()
        types = E.nodes.types_by_name(env, tools=[t for t in TOOLS if t["name"] != "image_generate"])
        img = next(p for p in types["preset.text_to_image"]["params"] if p["name"] == "model")
        self.assertEqual((img.get("default"), img["options_accepts"], img["auto"]), (None, "text", E.presets.AUTO_PARAM))
        pick = E.presets.auto_pick([{"value": "b", "price": 0.2}, {"value": "a", "price": 0.01}, {"value": "c"}])
        self.assertEqual(pick["value"], "a")
        self.assertEqual(E.presets.auto_pick([{"value": "x"}, {"value": "y"}])["value"], "x")
        self.assertIsNone(E.presets.auto_pick([]))
        d3 = next(p for p in types["preset.image_to_3d"]["params"] if p["name"] == "model")
        self.assertEqual(d3["options_accepts"], "image")

    def test_blank_model_is_left_to_the_run(self):
        env, _ = env_with()
        spec = E.nodes.types_by_name(env, tools=[t for t in TOOLS if t["name"] != "image_generate"])["preset.text_to_image"]
        args = E.executors.build_tool_args(spec, {"params": {"model": ""}}, {"prompt": "a cat"})
        self.assertNotIn("model", args)        # presets.execute picks the cheapest listed model (_auto_model)
        args = E.executors.build_tool_args(spec, {"params": {"model": "nano-banana"}}, {"prompt": "a cat"})
        self.assertEqual(args["model"], "nano-banana")


class ParseTest(unittest.TestCase):
    def test_real_shape_and_filters(self):
        opts = O.to_options(E.executors.parse_tool_result(IMAGE_LIST), accepts="text")
        self.assertEqual([o["value"] for o in opts], ["flux-2-klein-9b", "nano-banana"])
        self.assertEqual(opts[0]["price"], 0.01)
        self.assertEqual(opts[0]["group"], "flux")
        self.assertEqual(len(O.to_options(E.executors.parse_tool_result(IMAGE_LIST))), 3)
        d3 = O.to_options(E.executors.parse_tool_result(LIST_3D_RESULT), accepts="image")
        self.assertEqual([(o["value"], o["price"]) for o in d3], [("hunyuan", 0.27)])

    def test_plain_lists(self):
        self.assertEqual([o["value"] for o in O.to_options({"models": ["a", "b"]})], ["a", "b"])
        self.assertEqual(O.to_options("no models here"), [])


class FetchTest(unittest.TestCase):
    def test_fetch_caches_and_respects_refresh(self):
        env, ctx = env_with({LIST_IMG: lambda args: IMAGE_LIST})
        first = asyncio.run(O.fetch_options(env, LIST_IMG, accepts="text"))
        second = asyncio.run(O.fetch_options(env, LIST_IMG, accepts="text"))
        self.assertEqual((first["cached"], second["cached"]), (False, True))
        self.assertEqual(len(ctx.calls), 1)
        asyncio.run(O.fetch_options(env, LIST_IMG, refresh=True))
        self.assertEqual(len(ctx.calls), 2)

    def test_api_route(self):
        env, _ = env_with({LIST_IMG: lambda args: IMAGE_LIST})
        env.state["node_types_cache"] = None
        E.nodes.list_node_types(env, tools=TOOLS)  # warm nothing: route resolves types itself
        orig = E.nodes.registry_tools
        E.nodes.registry_tools = lambda _env: [dict(t) for t in TOOLS]
        try:
            out = asyncio.run(E.api.handle("GET", "options", {"type": "tool:" + IMG, "param": "model"}, {}, env))
            self.assertEqual(out["source"], LIST_IMG)
            self.assertEqual(len(out["options"]), 3)
            with self.assertRaises(Exception):
                asyncio.run(E.api.handle("GET", "options", {"type": "tool:" + IMG, "param": "prompt"}, {}, env))
        finally:
            E.nodes.registry_tools = orig


NEW_TOOLS = TOOLS + [
    tool("mcp__nanogpt__nanogpt_image_edit", {"prompt": {"type": "string"}, "model": {"type": "string"},
                                              "imageDataUrl": {"type": "string"}, "maskDataUrl": {"type": "string"},
                                              "include_raw": {"type": "boolean"}}, ["prompt"]),
    tool("mcp__nanogpt__nanogpt_video_generate", {"operation": {"type": "string", "enum": ["submit", "poll", "status"]},
                                                  "model": {"type": "string"},
                                                  "prompt": {"type": "string"}, "imageUrl": {"type": "string"},
                                                  "imageDataUrl": {"type": "string"}, "duration": {"type": "number"},
                                                  "poll_interval_ms": {"type": "integer"}}),
    tool("mcp__nanogpt__nanogpt_list_video_models", {}),
    tool("mcp__nanogpt__nanogpt_youtube_transcribe", {"urls": {"type": "array"}}, ["urls"]),
]


class NewPresetTest(unittest.TestCase):
    def setUp(self):
        env, _ = env_with()
        self.types = E.nodes.types_by_name(env, tools=NEW_TOOLS)

    def test_listed_with_defaults_and_without_plumbing(self):
        for name in ("preset.image_edit", "preset.text_to_video", "preset.image_to_video", "preset.youtube_transcript"):
            self.assertIn(name, self.types)
        names = {p["name"] for p in self.types["preset.text_to_video"]["params"]}
        self.assertFalse(names & {"operation", "poll_interval_ms", "imageUrl"})
        video_model = next(p for p in self.types["preset.text_to_video"]["params"] if p["name"] == "model")
        self.assertEqual((video_model.get("default"), video_model["options_source"]),
                         (None, "mcp__nanogpt__nanogpt_list_video_models"))
        duration = next(p for p in self.types["preset.text_to_video"]["params"] if p["name"] == "duration")
        self.assertEqual(duration["default"], 6)
        edit = {p["name"] for p in self.types["preset.image_edit"]["params"]}
        self.assertFalse(edit & {"include_raw", "maskDataUrl"})

    def test_argument_mapping(self):
        node = {"type": "preset.youtube_transcript", "params": {}}
        args = E.presets._tool_args(node, self.types["preset.youtube_transcript"], {"url": "https://youtu.be/x"})
        self.assertEqual(args, {"urls": ["https://youtu.be/x"]})
        node = {"type": "preset.image_edit", "params": {}}
        args = E.presets._tool_args(node, self.types["preset.image_edit"], {"image": "data:image/png;base64,AA", "prompt": "p"})
        self.assertEqual(args["imageDataUrl"], "data:image/png;base64,AA")
        self.assertNotIn("model", args)
        node = {"type": "preset.image_to_video", "params": {}}
        args = E.presets._tool_args(node, self.types["preset.image_to_video"], {"image": "https://x/a.png", "prompt": "p"})
        self.assertEqual((args["imageUrl"], args["duration"]), ("https://x/a.png", 6))


if __name__ == "__main__":
    unittest.main()
