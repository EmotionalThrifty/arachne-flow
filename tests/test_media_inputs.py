"""G8 media inputs — multi-image ports, values and conversion.

Contract these tests pin down:

* ``nodes.property_port``: image-ish string props become param kind ``media`` with
  ``media_kind = "image"``; image arrays become ``media_list`` and their input port carries
  ``multiple`` plus ``min``/``max`` (from ``minItems``/``maxItems``). Plain ``urls`` stay JSON,
  ``model`` stays a normal text setting, and so do ``image_format``/``image_prompt``/``image_model``
  (their names contain "image" but they are settings, not media values).
* presets: ``preset.image_to_3d`` accepts several images on its ``image`` input and maps them
  to the tool's ``images`` array (local files as data URLs, remote sources as https).
* graph: ``connect`` appends a second edge into a ``multiple`` input (single inputs still
  replace), validate only rejects duplicate edges on single inputs, ``disconnect`` by target
  drops every edge into that input.
* runner: a multiple input resolves to the source values in edge order and flattens list outputs.
* media: ``to_arg`` maps lists element-wise, turns a local path into a data URL for ``*DataUrl``
  names and keeps ``https://`` sources for ``*Url`` names; a scalar input takes the first item.
* options: a bounded ``reference_images`` model setting becomes a ``media_list`` of images, and
  ``_coerce`` inlines picked local files while keeping ``https://`` references.
"""
import asyncio
import copy
import json
import os
import tempfile
import unittest

import helpers

E = helpers.load_engine()
N, G, M, X, R, S = E.nodes, E.graph, E.media, E.executors, E.runner, E.store

NANO_3D = "mcp__nanogpt__nanogpt_3d_generate"


def tool(name, props, required=()):
    return {"name": name, "toolset": "test", "description": f"Fake {name}",
            "parameters": {"type": "object", "properties": props, "required": list(required)}}


TOOLS = [
    tool("image_gen", {"prompt": {"type": "string"}}, ["prompt"]),
    tool("src_a", {"image": {"type": "string"}}),
    tool("src_b", {"image": {"type": "string"}}),
    tool("multi_media", {
        "prompt": {"type": "string"},
        "images": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4},
        "imageUrls": {"type": "array", "items": {"type": "string"}},
        "imageDataUrls": {"type": "array", "items": {"type": "string"}},
        "imageUrl": {"type": "string"},
        "imageDataUrl": {"type": "string"},
        "urls": {"type": "array", "items": {"type": "string"}},
        "model": {"type": "string"},
    }, ["prompt"]),
    tool(NANO_3D, {
        "prompt": {"type": "string"},
        "images": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4},
        "imageUrl": {"type": "string"},
        "imageDataUrl": {"type": "string"},
        "operation": {"type": "string", "default": "submit_and_poll"},
        "model": {"type": "string", "default": "fast"},
    }),
]


def engine_types(tools=TOOLS):
    env = E.env.Env(ctx=helpers.FakeCtx(), state={})
    return N.types_by_name(env, tools=tools)


def write_file(folder, name, payload=b"\x89PNG\r\n\x1a\nfake"):
    path = os.path.join(folder, name)
    with open(path, "wb") as fh:
        fh.write(payload)
    return path


class PropertyPortTest(unittest.TestCase):
    def test_image_values_become_media_and_image_arrays_become_media_lists(self):
        port, param = N.property_port("imageUrl", {"type": "string"}, False)
        self.assertEqual(param["kind"], "media")
        self.assertEqual(param["media_kind"], "image")
        self.assertTrue(E.types.is_type(port["type"]))

        port, param = N.property_port("imageDataUrl", {"type": "string"}, False)
        self.assertEqual(param["kind"], "media")
        self.assertEqual(param["media_kind"], "image")

        prop = {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 4}
        port, param = N.property_port("images", prop, False)
        self.assertEqual(param["kind"], "media_list")
        self.assertEqual(param["media_kind"], "image")
        self.assertTrue(port.get("multiple"), "the images input takes several wires")
        self.assertEqual((port.get("min"), port.get("max")), (1, 4))

        # A generic URL list is not an image list and must stay JSON.
        port, param = N.property_port("urls", {"type": "array", "items": {"type": "string"}}, False)
        self.assertEqual(param["kind"], "json")
        self.assertNotIn("media_kind", param)
        self.assertFalse(port.get("multiple"))

        # "model" contains a media-ish word but is a plain setting.
        port, param = N.property_port("model", {"type": "string"}, False)
        self.assertEqual(param["kind"], "text")
        self.assertNotIn("media_kind", param)

    def test_image_attachment_id_is_text_while_image_data_url_stays_media(self):
        # An attachment id names an upload; it is not the image itself, so no media picker.
        port, param = N.property_port("imageAttachmentId", {"type": "string"}, False)
        self.assertEqual(param["kind"], "text", "imageAttachmentId is an ordinary text setting")
        self.assertNotIn("media_kind", param)
        self.assertNotIn(port["type"], E.types.MEDIA_KINDS)

        port, param = N.property_port("imageDataUrl", {"type": "string"}, False)
        self.assertEqual((param["kind"], param["media_kind"]), ("media", "image"),
                         "imageDataUrl still carries an image")


class ImageSettingNameTest(unittest.TestCase):
    """Names with "image" that are settings, not media: format, prompt and model."""

    NAMES = ("image_format", "image_prompt", "image_model")

    def test_property_port_keeps_image_settings_as_text(self):
        for name in self.NAMES:
            with self.subTest(name=name):
                port, param = N.property_port(name, {"type": "string"}, False)
                self.assertEqual(param["kind"], "text", f"{name} is an ordinary text setting")
                self.assertNotIn("media_kind", param)
                self.assertNotIn("multiple", port)
                self.assertNotIn(port["type"], E.types.MEDIA_KINDS)

    def test_tool_schema_keeps_image_settings_out_of_media(self):
        tools = [tool("image_settings", {
            "image_format": {"type": "string"},
            "image_prompt": {"type": "string"},
            "image_model": {"type": "string"},
        })]
        spec = engine_types(tools)["tool:image_settings"]
        params = {p["name"]: p for p in spec["params"]}
        ports = {p["name"]: p for p in spec["inputs"]}
        for name in self.NAMES:
            with self.subTest(name=name):
                self.assertEqual(params[name]["kind"], "text")
                self.assertNotIn(params[name]["kind"], ("media", "media_list"))
                self.assertNotIn("media_kind", params[name])
                self.assertFalse(ports[name].get("multiple"))
                self.assertNotIn(ports[name]["type"], E.types.MEDIA_KINDS)


class ModelParamMediaTest(unittest.TestCase):
    def test_bounded_reference_images_descriptor_is_a_media_list(self):
        row = {"supported_parameters": {"parameters": {
            "reference_images": {"type": "text", "max_items": 3}}}}  # catalogs type this URL list as text
        ref = {p["name"]: p for p in E.options.model_params(row)}["reference_images"]
        self.assertEqual((ref["kind"], ref["media_kind"], ref["max_items"]), ("media_list", "image", 3))


class GraphMediaTest(unittest.TestCase):
    def build(self, ops):
        types = engine_types()
        flow, results = G.apply_ops(G.new_flow("media"), ops, types)
        return flow, results, types

    def multi_flow(self):
        return self.build([
            {"op": "add_node", "ref": "a", "type": "tool:image_gen", "title": "A", "params": {"prompt": "a"}},
            {"op": "add_node", "ref": "b", "type": "tool:image_gen", "title": "B", "params": {"prompt": "b"}},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "a.media", "to": "m.images"},
            {"op": "connect", "from": "b.media", "to": "m.images"},
        ])

    def test_connect_appends_only_for_multiple_inputs(self):
        flow, res, _ = self.multi_flow()
        into = [e for e in flow["edges"] if e["to"]["node"] == res[2]["node"] and e["to"]["port"] == "images"]
        self.assertEqual(len(into), 2, "both wires survive on a multiple input")
        self.assertEqual([e["from"]["node"] for e in into], [res[0]["node"], res[1]["node"]])

        single, sres, _ = self.build([
            {"op": "add_node", "ref": "a", "type": "tool:image_gen", "title": "A", "params": {"prompt": "a"}},
            {"op": "add_node", "ref": "b", "type": "tool:image_gen", "title": "B", "params": {"prompt": "b"}},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "a.media", "to": "m.imageUrl"},
            {"op": "connect", "from": "b.media", "to": "m.imageUrl"},
        ])
        into = [e for e in single["edges"] if e["to"]["node"] == sres[2]["node"] and e["to"]["port"] == "imageUrl"]
        self.assertEqual(len(into), 1, "a single input still replaces its wire")
        self.assertEqual(into[0]["from"]["node"], sres[1]["node"])

    def test_validate_allows_multi_but_rejects_duplicate_single(self):
        flow, res, types = self.build([
            {"op": "add_node", "ref": "a", "type": "tool:image_gen", "title": "A", "params": {"prompt": "a"}},
            {"op": "add_node", "ref": "b", "type": "tool:image_gen", "title": "B", "params": {"prompt": "b"}},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "a.media", "to": "m.images"},
        ])
        several = copy.deepcopy(flow)
        several["edges"].append({"id": "e_abc123", "from": {"node": res[1]["node"], "port": "media"},
                                 "to": {"node": res[2]["node"], "port": "images"}})
        messages = [i["message"] for i in G.validate(several, types)]
        self.assertFalse(any("more than one connection" in m for m in messages),
                         "multiple inputs accept several edges")

        single, sres, types = self.build([
            {"op": "add_node", "ref": "a", "type": "tool:image_gen", "title": "A", "params": {"prompt": "a"}},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "a.media", "to": "m.imageUrl"},
        ])
        duplicate = copy.deepcopy(single)
        duplicate["edges"].append({**copy.deepcopy(single["edges"][0]), "id": "e_abcdef"})
        messages = [i["message"] for i in G.validate(duplicate, types)]
        self.assertTrue(any("more than one connection" in m for m in messages),
                        "single inputs still reject a second edge")

    def test_disconnect_by_target_removes_all_edges(self):
        flow, res, types = self.multi_flow()
        out, results = G.apply_ops(flow, [{"op": "disconnect", "to": f"{res[2]['node']}.images"}], types)
        self.assertEqual(len(results[0]["edges"]), 2, "all edges into the multiple input are removed")
        self.assertEqual([e for e in out["edges"] if e["to"]["port"] == "images"], [])
        self.assertEqual(len(out["edges"]), 0)


class RunnerMediaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="flowcanvas-g8-")
        self.addCleanup(self.tmp.cleanup)
        self.path_a = write_file(self.tmp.name, "a.png", b"\x89PNG\r\n\x1a\nA")
        self.path_b = write_file(self.tmp.name, "b.png", b"\x89PNG\r\n\x1a\nB")

    def make_env(self):
        os.environ["FLOWCANVAS_DATA_DIR"] = self.tmp.name  # fake tool files live where real ones do: in Arachne Flow's (or Hermes') folders (review E-3)
        captured = []

        def multi(args):
            captured.append(dict(args))
            return json.dumps({"text": "ok"})

        ctx = helpers.FakeCtx({
            "src_a": lambda args: json.dumps({"image": self.path_a}),
            "src_b": lambda args: json.dumps({"image": self.path_b}),
            "multi_media": multi,
        })
        env = E.env.Env(ctx=ctx, state={"tool_source": lambda: TOOLS})
        return env, captured

    def build(self, env, ops):
        types = N.types_by_name(env)
        flow, results = G.apply_ops(G.new_flow("media"), ops, types)
        return S.save_flow(env, flow, create=True), results

    def test_runner_collects_multiple_inputs_in_edge_order(self):
        env, captured = self.make_env()
        flow, res = self.build(env, [
            {"op": "add_node", "ref": "a", "type": "tool:src_a", "title": "A"},
            {"op": "add_node", "ref": "b", "type": "tool:src_b", "title": "B"},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "b.media", "to": "m.images"},
            {"op": "connect", "from": "a.media", "to": "m.images"},
        ])
        run = R.run_sync(env, flow["id"], timeout_s=20)
        self.assertEqual(run["status"], "done", run.get("issues") or run.get("error"))
        path_b = run["nodes"][res[1]["node"]]["outputs"]["media"]["$media"]["path"]
        path_a = run["nodes"][res[0]["node"]]["outputs"]["media"]["$media"]["path"]
        self.assertEqual(captured[0]["images"], [path_b, path_a], "edge order, not completion order")

    def test_resolve_inputs_flattens_list_outputs(self):
        env, _ = self.make_env()
        flow, res = self.build(env, [
            {"op": "add_node", "ref": "a", "type": "tool:image_gen", "title": "A", "params": {"prompt": "a"}},
            {"op": "add_node", "ref": "b", "type": "tool:image_gen", "title": "B", "params": {"prompt": "b"}},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "a.media", "to": "m.images"},
            {"op": "connect", "from": "b.media", "to": "m.images"},
        ])
        first = M.make_media(self.path_a, kind="image")
        second = M.make_media(self.path_b, kind="image")
        third = M.make_media(os.path.join(self.tmp.name, "c.png"), kind="image")
        run = {"id": S.new_run_id(), "flow_id": flow["id"], "order": [n["id"] for n in flow["nodes"]], "nodes": {}}
        execution = R._Execution(env, flow, N.types_by_name(env), R.RunHandle(run=run))
        execution.values = {res[0]["node"]: {"media": [first, second]}, res[1]["node"]: {"media": third}}
        inputs = execution.resolve_inputs(res[2]["node"])
        self.assertEqual(inputs["images"], [first, second, third])

    def test_single_image_input_takes_only_the_first_item_of_a_list_output(self):
        env, _ = self.make_env()
        flow, res = self.build(env, [
            {"op": "add_node", "ref": "a", "type": "tool:src_a", "title": "A"},
            {"op": "add_node", "ref": "m", "type": "tool:multi_media", "title": "M", "params": {"prompt": "x"}},
            {"op": "connect", "from": "a.media", "to": "m.imageUrl"},
        ])
        first = M.make_media(self.path_a, kind="image")
        second = M.make_media(self.path_b, kind="image")
        run = {"id": S.new_run_id(), "flow_id": flow["id"], "order": [n["id"] for n in flow["nodes"]], "nodes": {}}
        execution = R._Execution(env, flow, N.types_by_name(env), R.RunHandle(run=run))
        # One upstream node whose ``media`` output is a list of two images.
        execution.values = {res[0]["node"]: {"media": [first, second]}}
        inputs = execution.resolve_inputs(res[1]["node"])
        self.assertEqual(inputs["imageUrl"], first,
                         "a single input fed a list output takes its first image, not the whole list")


class MediaConversionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="flowcanvas-g8-")
        self.addCleanup(self.tmp.cleanup)
        self.local_path = write_file(self.tmp.name, "local.png")
        self.local = M.from_local(self.local_path, copy=False)
        self.remote = M.make_media(self.local_path, kind="image", source="https://example.com/remote.png")

    def test_to_arg_maps_local_paths_lists_and_remote_urls(self):
        self.assertTrue(M.to_arg(self.local_path, "imageDataUrl").startswith("data:image/png;base64,"),
                        "a local path for an imageDataUrl becomes a data URL")
        self.assertEqual(M.to_arg(self.remote, "imageUrl"), "https://example.com/remote.png")
        local_path = self.local["$media"]["path"]
        remote_path = self.remote["$media"]["path"]
        self.assertEqual(M.to_arg([self.local, self.remote], "images"), [local_path, remote_path])
        self.assertEqual(M.to_arg([self.local, self.remote], "imageUrls"),
                         [local_path, "https://example.com/remote.png"], "*Url keeps https")
        self.assertEqual(M.to_arg([self.local, self.remote], "imageDataUrls"),
                         [M.data_url(local_path), M.data_url(remote_path)])

    def test_coerce_media_list_inlines_local_files_and_keeps_remote_urls(self):
        values = E.options._coerce([self.local_path, "https://example.com/remote.png"], "media_list", "reference_images")
        self.assertEqual(len(values), 2)
        self.assertTrue(values[0].startswith("data:image/png;base64,"), "a picked file becomes a data URL")
        self.assertEqual(values[1], "https://example.com/remote.png", "a remote reference stays remote")
        stored = json.dumps([self.local_path, "https://example.com/remote.png"])  # the inspector stores a media list as JSON
        self.assertEqual(E.options._coerce(stored, "media_list", "reference_images"), values)

    def test_scalar_input_takes_the_first_list_item(self):
        spec = engine_types()["tool:multi_media"]
        node = {"id": "n_test", "type": "tool:multi_media", "params": {"prompt": "x"}}
        args = X.build_tool_args(spec, node, {"imageUrl": [self.remote, self.local]})
        self.assertEqual(args["imageUrl"], "https://example.com/remote.png")
        args = X.build_tool_args(spec, node, {"images": [self.local, self.remote]})
        self.assertEqual(args["images"], [self.local["$media"]["path"], self.remote["$media"]["path"]])


class PresetMediaTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="flowcanvas-g8-")
        self.addCleanup(self.tmp.cleanup)
        self.out = os.path.join(self.tmp.name, "outputs")
        os.makedirs(self.out)
        os.environ["FLOWCANVAS_DATA_DIR"] = self.tmp.name  # fake tool files live where real ones do: in Arachne Flow's (or Hermes') folders (review E-3)
        self.local_path = write_file(self.tmp.name, "local.png")
        self.local = M.from_local(self.local_path, copy=False)
        self.remote = M.make_media(self.local_path, kind="image", source="https://example.com/remote.png")

    def execute(self, type_name, ctx, inputs, params=None):
        engine = helpers.load_engine()
        spec = engine_types()[type_name]
        env = engine.env.Env(ctx=ctx, state={})
        node = {"id": "n_test", "type": type_name, "params": dict(params or {})}
        nctx = engine.executors.NodeContext(run_id="run_test", node_id="n_test", out_dir=self.out,
                                            allow_download=False, log=lambda msg: None)
        return asyncio.run(engine.executors.execute(env, node, spec, inputs, nctx))

    def test_image_to_3d_preset_has_a_multiple_image_input(self):
        spec = engine_types()["preset.image_to_3d"]
        port = spec["inputs"][0]
        self.assertEqual(port["name"], "image")
        self.assertEqual(port["type"], "image")
        self.assertTrue(port.get("multiple"))

    def test_two_images_map_to_the_images_argument(self):
        model = write_file(self.tmp.name, "model.glb", b"glTF")
        ctx = helpers.FakeCtx({NANO_3D: lambda args: json.dumps(
            {"structuredContent": {"status": "COMPLETED", "model_urls": {"glb": model}}})})
        result = self.execute("preset.image_to_3d", ctx, {"image": [self.local, self.remote]})
        args = ctx.calls[0][1]
        self.assertIn("images", args)
        self.assertEqual(len(args["images"]), 2)
        self.assertTrue(args["images"][0].startswith("data:image/png;base64,"))
        self.assertEqual(args["images"][1], "https://example.com/remote.png")
        for gone in ("image", "imageUrl", "imageDataUrl"):
            self.assertNotIn(gone, args)
        self.assertEqual(result["model"]["$media"]["kind"], "model3d")

    def test_direct_local_image_comes_before_the_wired_remote_one(self):
        model = write_file(self.tmp.name, "model.glb", b"glTF")
        ctx = helpers.FakeCtx({NANO_3D: lambda args: json.dumps(
            {"structuredContent": {"status": "COMPLETED", "model_urls": {"glb": model}}})})
        self.execute("preset.image_to_3d", ctx, {"image": self.remote}, params={"image": self.local_path})
        images = ctx.calls[0][1]["images"]
        self.assertEqual(len(images), 2)
        self.assertTrue(images[0].startswith("data:image/png;base64,"), "the picked file is inlined first")
        self.assertEqual(images[1], "https://example.com/remote.png", "the wired reference stays remote")


if __name__ == "__main__":
    unittest.main()
