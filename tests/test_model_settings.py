"""G7: settings that follow a tool's JSON schema and the chosen model's list entry (NanoGPT shapes, live 06.11.2026)."""
import asyncio
import json
import os
import unittest

import helpers

E = helpers.load_engine()
O = E.options
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "fixtures", "nanogpt_models.json"), encoding="utf-8") as fh:
    LIVE = json.load(fh)
IMG = "mcp__nanogpt__nanogpt_image_generate"
D3 = "mcp__nanogpt__nanogpt_3d_generate"
LIST_3D = "mcp__nanogpt__nanogpt_list_3d_models"
LIST_IMG = "mcp__nanogpt__nanogpt_list_image_models"
VIDEO = "mcp__nanogpt__nanogpt_video_generate"
LIST_VIDEO = "mcp__nanogpt__nanogpt_list_video_models"


def row(kind, model_id):
    return next(r for r in LIVE[kind] if r["id"] == model_id)


def listing(kind):
    """The list tool's result as Hermes hands it over: text + structuredContent.data."""
    return json.dumps({"result": f"Found {len(LIVE[kind])}", "structuredContent": {"data": LIVE[kind]}})


def tool(name, props, required=()):
    return {"name": name, "toolset": "mcp-nanogpt", "description": f"Fake {name}",
            "parameters": {"type": "object", "properties": props, "required": list(required)}}


# Parameter schemas copied from the live @nanogpt/mcp 1.6.0 tools (tool_describe, 06.11.2026).
TOOLS = [
    tool(IMG, {"prompt": {"type": "string", "minLength": 1}, "model": {"type": "string"},
               "n": {"type": "number", "minimum": 1, "maximum": 10}, "size": {"type": "string"},
               "resolution": {"type": "string"}, "aspect_ratio": {"type": "string"}, "quality": {"type": "string"},
               "response_format": {"type": "string", "enum": ["url", "b64_json"]},
               "imageDataUrls": {"type": "array", "items": {"type": "string"}}}, ["prompt"]),
    tool(LIST_IMG, {"detailed": {"type": "boolean"}}),
    tool(VIDEO, {"operation": {"type": "string", "enum": ["submit", "status", "poll", "submit_and_poll"]},
                 "model": {"type": "string"}, "prompt": {"type": "string"}, "imageUrl": {"type": "string"},
                 "duration": {"anyOf": [{"type": "number", "exclusiveMinimum": 0}, {"type": "string", "minLength": 1}]},
                 "resolution": {"type": "string"}, "aspect_ratio": {"type": "string"},
                 "poll_interval_ms": {"type": "integer", "minimum": 1000, "maximum": 30000, "default": 5000}}),
    tool(LIST_VIDEO, {}),
    {**tool(D3, {"operation": {"type": "string"}, "model": {"type": "string"}, "prompt": {"type": "string"},
                 "imageUrl": {"type": "string"}, "imageDataUrl": {"type": "string"},
                 "images": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4}}),
     "parameters": {"type": "object", "additionalProperties": True,
                    "properties": {"operation": {"type": "string"}, "model": {"type": "string"},
                                   "prompt": {"type": "string"}, "imageUrl": {"type": "string"},
                                   "imageDataUrl": {"type": "string"}, "images": {"type": "array"}}}},
    tool(LIST_3D, {}),
    tool("mcp__nanogpt__nanogpt_list_text_models", {"detailed": {"type": "boolean"}}),
    tool("mcp__other__thing", {"styles": {"type": "array", "items": {"type": "string", "enum": ["a", "b", "c"]},
                                          "minItems": 1, "maxItems": 2},
                               "steps": {"type": "integer", "enum": [10, 20, 30]},
                               "weight": {"type": "number", "exclusiveMinimum": 0, "maximum": 2, "multipleOf": 0.5}}),
]


class SchemaFieldTest(unittest.TestCase):
    """(a) JSON schema -> field: enum -> select, minimum/maximum -> bounded number, array of enums -> multi-select."""

    def setUp(self):
        env = E.env.Env(ctx=helpers.FakeCtx({}), state={})
        self.types = E.nodes.types_by_name(env, tools=TOOLS)

    def params(self, type_name):
        return {p["name"]: p for p in self.types[type_name]["params"]}

    def test_bounds_and_integer(self):
        n = self.params("tool:" + IMG)["n"]
        self.assertEqual((n["kind"], n["min"], n["max"]), ("number", 1, 10))
        self.assertNotIn("integer", n)  # schema says number, not integer
        poll = self.params("tool:" + VIDEO)["poll_interval_ms"]
        self.assertEqual((poll["min"], poll["max"], poll["integer"], poll["default"]), (1000, 30000, True, 5000))
        weight = self.params("tool:mcp__other__thing")["weight"]
        self.assertEqual((weight["min"], weight["min_exclusive"], weight["max"], weight["step"]), (0, True, 2, 0.5))

    def test_enums(self):
        steps = self.params("tool:mcp__other__thing")["steps"]
        self.assertEqual((steps["kind"], steps["options"]), ("select", [10, 20, 30]))
        styles = self.params("tool:mcp__other__thing")["styles"]
        self.assertEqual((styles["kind"], styles["options"], styles["min_items"], styles["max_items"]),
                         ("multiselect", ["a", "b", "c"], 1, 2))
        port = next(p for p in self.types["tool:mcp__other__thing"]["inputs"] if p["name"] == "styles")
        self.assertEqual(port["type"], "json")  # wires still carry a list
        spec = self.types["tool:mcp__other__thing"]
        for given, want in ((["a", "c"], ["a", "c"]), ('["b"]', ["b"]), ("c", ["c"])):
            self.assertEqual(E.executors.build_tool_args(spec, {"params": {"styles": given}}, {})["styles"], want)

    def test_scalar_union_is_a_text_field_that_keeps_numbers(self):
        duration = self.params("tool:" + VIDEO)["duration"]
        self.assertEqual((duration["kind"], duration.get("numeric")), ("text", True))
        args = E.executors.build_tool_args(self.types["tool:" + VIDEO], {"params": {"duration": "auto"}}, {})
        self.assertEqual(args["duration"], "auto")  # was a JSON field: "auto" failed as invalid JSON

    def test_model_driven_settings_are_marked(self):
        p = self.params("tool:" + IMG)
        self.assertEqual({k for k, v in p.items() if v.get("from_model")}, {"n", "size", "resolution", "aspect_ratio",
                                                                             "quality"})
        self.assertEqual(p["size"]["from_model"], "model")
        video = self.params("preset.text_to_video")
        self.assertEqual(video["duration"]["from_model"], "model")
        self.assertNotIn("from_model", self.params("tool:mcp__other__thing")["steps"])  # no model list -> schema only


class ModelFieldTest(unittest.TestCase):
    """(b) a model's list entry -> the choices it really allows (shapes from the live lists only)."""

    def test_image_resolutions_become_size_with_prices(self):
        f = O.model_fields(row("image", "p-h3-image"))
        self.assertEqual([o["value"] for o in f["size"]["options"]], ["1k", "1.5k", "2k", "3k", "4k"])
        self.assertEqual(f["size"]["options"][4]["price"], 0.12)
        self.assertEqual(f["n"], {"min": 1.0, "max": 4.0, "integer": True})
        self.assertEqual(f["aspect_ratio"]["options"][0]["value"], "auto")
        self.assertNotIn("resolution", f)  # resolutions feed size (docs), never invented twice
        flare = O.model_fields(row("image", "gpt-image-2.6-flare"))
        self.assertEqual([o["value"] for o in flare["quality"]["options"]], ["low", "medium", "high", "xhigh", "max"])

    def test_video_parameters_and_durations(self):
        ltx = O.model_fields(row("video", "lightricks-ltx-2-fast"))
        self.assertEqual([o["value"] for o in ltx["duration"]["options"]], ["6", "8", "10", "12", "14", "16", "18", "20"])
        self.assertEqual((ltx["duration"]["default"], ltx["duration"]["options"][0]["label"]), ("6", "6 seconds"))
        self.assertNotIn("resolution", ltx)  # the model offers none -> the field stays free
        kling = O.model_fields(row("video", "kling-4.0"))
        self.assertEqual((kling["duration"]["min"], kling["duration"]["max"], kling["duration"]["integer"]), (3, 30, True))
        res = {o["value"]: o.get("price") for o in kling["resolution"]["options"]}
        self.assertEqual(res, {"720p": 0.1727, "1080p": 0.2585})
        per_clip = O.model_fields(row("video", "kling-v26-pro"))["duration"]["options"]
        self.assertEqual([(o["value"], o["price"]) for o in per_clip], [("5", 0.35), ("10", 0.7)])

    def test_supported_durations_fill_in_when_parameters_are_missing(self):
        bare = {"id": "x", "pricing": {"per_second": 0.1, "supported_durations": [5, 10]}, "supported_parameters": {}}
        self.assertEqual([o["value"] for o in O.model_fields(bare)["duration"]["options"]], ["5", "10"])
        self.assertEqual(O.model_fields({"id": "y"}), {})

    def test_cost_shapes(self):
        self.assertEqual(O.model_cost(row("image", "flux-2-klein-9b"))["base"], 0.01)
        ltx = O.model_cost(row("video", "lightricks-ltx-2-fast"))
        self.assertEqual((ltx["unit"], ltx["base"], ltx["times"]), ("second", 0.04, "duration"))
        kling = O.model_cost(row("video", "kling-4.0"))
        self.assertEqual((kling["by"], kling["minimum"]), ("resolution", 0.5181))
        self.assertIn("note", kling)
        self.assertEqual(O.model_cost(row("video", "kling-v26-pro"))["prices"], {"5": 0.35, "10": 0.7})
        self.assertEqual(O.model_cost(row("3d", "tripo3d/p1"))["base"], 0.48)
        self.assertEqual(O.model_cost(row("3d", "tripo3d/h3.0"))["base"], 0.36)
        minimax = O.model_cost(row("video", "minimax/h3-highspeed"))  # no rate, only a minimum + note
        self.assertEqual(set(minimax), {"minimum", "note"})
        self.assertIsNone(O.model_cost({"id": "z", "pricing": {"currency": "USD"}}))

    def test_whole_live_lists_parse(self):
        expected_ids = {
            "image": {"flux-2-klein-9b", "p-h3-image", "gpt-image-2.6-flare", "blackforestlabs/flux-3/klein/edit-image"},
            "video": {"lightricks-ltx-2-fast", "kling-4.0", "kling-v26-pro", "minimax/h3-highspeed", "openjutsu"},
            "3d": {"wavespeed-ai/hunyuan-3d-v3.1-rapid", "tripo3d/p1", "tripo3d/h3.0", "meshy/v7.1/multi-image-to-3d"},
        }
        for kind, must_have in expected_ids.items():
            rows = LIVE[kind]
            self.assertGreaterEqual(len(rows), len(must_have), kind)
            seen = set()
            with_fields = 0
            with_cost = 0
            for r in rows:
                mid = r.get("id")
                self.assertTrue(isinstance(mid, str) and mid, kind)
                seen.add(mid)
                fields = O.model_fields(r)
                self.assertIsInstance(fields, dict, mid)
                for fname, fspec in fields.items():
                    self.assertIsInstance(fname, str, mid)
                    self.assertIsInstance(fspec, dict, f"{mid}.{fname}")
                if fields:
                    with_fields += 1
                cost = O.model_cost(r)
                if cost is not None:
                    self.assertIsInstance(cost, dict, mid)
                    self.assertTrue(
                        {"base", "prices", "by", "minimum"} & set(cost),
                        f"{mid} cost has no recognized pricing key: {cost}",
                    )
                    with_cost += 1
            self.assertTrue(must_have.issubset(seen), f"{kind} missing {must_have - seen}")
            self.assertGreater(with_fields, 0, kind)
            self.assertGreater(with_cost, 0, kind)


MESHY = "meshy/v7.1/multi-image-to-3d"
LIST_TEXT = "mcp__nanogpt__nanogpt_list_text_models"
with open(os.path.join(HERE, "fixtures", "nanogpt_text_models.json"), encoding="utf-8") as _fh:
    TEXT_MODELS = json.load(_fh)["data"]
TEXT_RESULT = json.dumps({"structuredContent": {"data": TEXT_MODELS}})


class ModelParamsTest(unittest.TestCase):
    """G7b: every setting a model lists becomes a real control (the maintainer's screenshot: Image to 3D + Meshy)."""

    def test_meshy_settings_with_types_choices_and_defaults(self):
        ps = {p["name"]: p for p in O.model_params(row("3d", MESHY))}
        self.assertEqual(len(ps), 14)
        geo = ps["geometry_resolution"]
        self.assertEqual((geo["kind"], geo["default"]), ("select", "standard"))
        self.assertEqual([(o["value"], o["label"]) for o in geo["options"]], [("standard", "Standard"), ("2k", "2K (+$0.24)")])
        self.assertEqual((ps["enable_pbr"]["kind"], ps["enable_pbr"]["default"]), ("boolean", False))
        poly = ps["target_polycount"]
        self.assertEqual((poly["kind"], poly["min"], poly["max"], poly["step"]), ("number", 100, 300000, 1000))
        self.assertEqual(ps["texture_prompt"]["kind"], "text")
        self.assertEqual(O.model_cost(row("3d", MESHY))["range"], [0.96, 2.064])

    def test_show_when_aliases_and_owned_names(self):
        jutsu = {p["name"]: p for p in O.model_params(row("video", "openjutsu"))}
        self.assertEqual(jutsu["role_1"]["show_when"], {"swap_type": "character"})
        self.assertNotIn("prompt", jutsu)  # the node owns its prompt
        minimax = O.extra_params(row("video", "minimax/h3-highspeed"), ["imageUrl", "prompt"])
        self.assertNotIn("imageUrl", [p["name"] for p in minimax])
        self.assertIn("mode", [p["name"] for p in minimax])
        self.assertFalse(any(p["name"].lower().endswith("attachmentid") for p in O.model_params(row("video", "kling-4.0"))))

    def test_route_offers_them_only_where_the_tool_takes_extra_arguments(self):
        env = E.env.Env(ctx=helpers.FakeCtx({LIST_3D: lambda a: listing("3d"), LIST_IMG: lambda a: listing("image")}),
                        state={})
        orig = E.nodes.registry_tools
        E.nodes.registry_tools = lambda _env: [dict(t) for t in TOOLS]
        try:
            info = asyncio.run(E.api.handle("GET", "options", {"type": "preset.image_to_3d", "param": "model",
                                                              "model": MESHY}, {}, env))
            names = [p["name"] for p in info["params"]]
            self.assertEqual(len(names), 14)
            self.assertFalse(set(names) & {"images", "imageUrl", "imageDataUrl", "prompt", "model"})
            closed = asyncio.run(E.api.handle("GET", "options", {"type": "tool:" + IMG, "param": "model",
                                                                "model": "p-h3-image"}, {}, env))
            self.assertEqual(closed["params"], [])  # image tool drops unknown arguments -> nothing to offer
        finally:
            E.nodes.registry_tools = orig

    def test_run_sends_only_the_chosen_models_settings(self):
        env = E.env.Env(ctx=helpers.FakeCtx({LIST_3D: lambda a: listing("3d")}), state={})
        types = E.nodes.types_by_name(env, tools=TOOLS)
        spec = types["preset.image_to_3d"]
        node = {"type": "preset.image_to_3d", "params": {"model": MESHY, "geometry_resolution": "2k",
                                                          "target_polycount": "5000", "enable_pbr": True,
                                                          "generateAudio": True, "cache": False}}
        extras = asyncio.run(O.model_extras(env, spec, node))
        self.assertEqual(extras, {"geometry_resolution": "2k", "target_polycount": 5000, "enable_pbr": True})
        self.assertEqual(asyncio.run(O.model_extras(env, spec, {"params": {"model": MESHY}})), {})
        self.assertEqual(len(env.ctx.calls), 1)  # no list call when nothing extra is set
        closed = types["tool:" + IMG]
        self.assertEqual(asyncio.run(O.model_extras(env, closed, {"params": {"model": "x", "background": "auto"}})), {})


class LlmInfoTest(unittest.TestCase):
    """G7c: the LLM node reads the provider's own model catalog, grouped per provider."""

    def test_candidates_prefer_the_providers_server(self):
        names = [LIST_TEXT, LIST_IMG, LIST_VIDEO, "mcp__other__nanogpt_list_chat_models"]
        best = O.llm_list_candidates(names, "custom", "https://nano-gpt.com/api/v1", "NanoGPT")
        self.assertEqual(best[0], LIST_TEXT)
        self.assertNotIn(LIST_IMG, best)  # image list is not a text catalog

    def test_row_facts_and_price(self):
        row = next(r for r in TEXT_MODELS if r["id"] == "z-ai/glm-5.3-flash")
        info = O.llm_row_info(row)
        self.assertEqual((info["context_length"], info["max_output_tokens"]), (1048576, 131072))
        self.assertEqual(info["efforts"], ["low", "high", "max"])
        self.assertEqual(info["pricing"]["input"], 0.1)
        self.assertEqual(info["pricing"]["output"], 0.3)
        self.assertTrue(info["capabilities"]["vision"])
        self.assertEqual(O.llm_pricing({"pricing": {"prompt": 1, "completion": 2}}), None)  # unknown unit

    def test_lookup_uses_detailed_and_finds_the_model(self):
        ctx = helpers.FakeCtx({LIST_TEXT: lambda a: TEXT_RESULT})
        env = E.env.Env(ctx=ctx, state={"tool_source": lambda: [t for t in TOOLS if t["name"] == LIST_TEXT]})
        out = asyncio.run(O.llm_model_info(env, "custom", "z-ai/glm-5.3-flash", "https://nano-gpt.com/api/v1"))
        self.assertTrue(out["found"])
        self.assertEqual(out["info"]["label"], "GLM 5.3 Flash")
        self.assertEqual(ctx.calls[0][1], {"detailed": True})
        missing = asyncio.run(O.llm_model_info(env, "anthropic", "claude-opus-5-5"))
        self.assertFalse(missing["found"])
        self.assertEqual(len(ctx.calls), 1)

    def test_api_route(self):
        env = E.env.Env(ctx=helpers.FakeCtx({LIST_TEXT: lambda a: TEXT_RESULT}),
                        state={"tool_source": lambda: [t for t in TOOLS if t["name"] == LIST_TEXT]})
        out = asyncio.run(E.api.handle("GET", "llm-info", {"provider": "custom", "model": "z-ai/glm-5.3-flash",
                                                          "api_url": "https://nano-gpt.com/api/v1"}, {}, env))
        self.assertTrue(out["found"])
        self.assertEqual(out["info"]["max_output_tokens"], 131072)
        with self.assertRaises(Exception):
            asyncio.run(E.api.handle("GET", "llm-info", {"provider": "custom"}, {}, env))


class RouteTest(unittest.TestCase):
    def setUp(self):
        self.env = E.env.Env(ctx=helpers.FakeCtx({LIST_IMG: lambda a: listing("image"),
                                                  LIST_VIDEO: lambda a: listing("video")}), state={})
        self.orig = E.nodes.registry_tools
        E.nodes.registry_tools = lambda _env: [dict(t) for t in TOOLS]

    def tearDown(self):
        E.nodes.registry_tools = self.orig

    def get(self, **query):
        return asyncio.run(E.api.handle("GET", "options", query, {}, self.env))

    def test_model_info_for_all_settings_with_one_list_call(self):
        info = self.get(type="tool:" + IMG, param="model", model="p-h3-image")
        self.assertTrue(info["found"])
        self.assertEqual(set(info["fields"]), {"size", "n", "aspect_ratio"})
        self.assertEqual(info["cost"]["unit"], "image")
        size = self.get(type="tool:" + IMG, param="size", model="p-h3-image")
        self.assertEqual(size["options"][0]["value"], "1k")
        self.assertTrue(size["cached"])
        self.assertEqual(len(self.env.ctx.calls), 1)

    def test_preset_default_model_and_unknown_model(self):
        duration = self.get(type="preset.text_to_video", param="duration")  # blank -> lightricks-ltx-2-fast
        self.assertEqual((duration["model"], duration["options"][0]["value"]), ("lightricks-ltx-2-fast", "6"))
        missing = self.get(type="tool:" + IMG, param="model", model="no-such-model")
        self.assertEqual((missing["found"], missing["fields"]), (False, {}))
        blank = self.get(type="tool:" + IMG, param="size")  # no model chosen, no default -> nothing to offer
        self.assertEqual((blank["options"], blank["found"]), ([], False))
        with self.assertRaises(Exception):
            self.get(type="tool:" + IMG, param="prompt", model="p-h3-image")

    def test_model_list_unchanged_without_model(self):
        out = self.get(type="tool:" + IMG, param="model")
        self.assertEqual(len(out["options"]), len(LIVE["image"]))



class ImageLimitTest(unittest.TestCase):
    """Live 07.11.: the inspector said "0 / 4 files" for MoGe 2, which reconstructs from one image."""

    def test_the_catalog_says_how_many_images_a_model_takes(self):
        O = helpers.load_engine().options
        self.assertEqual(O.row_max_images({"capabilities": {"image_to_3d": True}}), 1)
        self.assertEqual(O.row_max_images({"capabilities": {"max_images": 4, "multi_image_to_3d": True}}), 4)
        self.assertEqual(O.row_max_images({"capabilities": {"multiview_to_3d": True}}), 4)
        self.assertIsNone(O.row_max_images({"capabilities": {"text_to_3d": True}}), "no image input: no limit claim")
        # real catalog shapes without the flags: an `images` parameter, or only the id/tag
        self.assertEqual(O.row_max_images({"capabilities": {"image_to_3d": True}, "supported_parameters": {
            "parameters": {"images": {"type": "array", "maxItems": 4, "minItems": 2}}}}), 4)
        self.assertEqual(O.row_max_images({"id": "meshy/v7.1/multi-image-to-3d", "capabilities": {"image_to_3d": True},
                                           "tags": ["multi-image-to-3d"]}), 4)

    def test_model_info_carries_the_limit(self):
        O = helpers.load_engine().options
        listing = {"data": [{"id": "microsoft/moge-2", "name": "MoGe 2", "capabilities": {"image_to_3d": True}}]}
        self.assertEqual(O.model_info(listing, "microsoft/moge-2")["max_images"], 1)
        self.assertIsNone(O.model_info(listing, "other/model").get("max_images"))


if __name__ == "__main__":
    unittest.main()
