"""Review EN-5/EN-6/EN-9 run contracts (second review, HEAD 6fdf762).

EN-5: a run aimed at a For each must include its body and Collects — plus inputs those take from
outside the loop — yet stop before nodes after the Collect.
EN-6: model extras are only sent after a catalog row described them. An unreachable list must reuse
a known row from the options cache (same coercion) or fail closed, never forward raw settings.
EN-9: fresh accepts only bool plus the legacy strings "true"/"false"; anything else is rejected
before a run starts.
"""
import asyncio
import base64
import json
import os
import tempfile
import time
import unittest
from unittest import mock

import helpers

E = helpers.load_engine()
R, S, G, N, O, X = E.runner, E.store, E.graph, E.nodes, E.options, E.executors
A, T = E.api, E.tools

from fastapi import HTTPException  # noqa: E402

CALLS = []
TOOLS = [{"name": "echo", "toolset": "test", "read_only": True,
          "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}]


def scratch_dir(prefix):
    """A throwaway directory under the Hermes scratch (TMPDIR), never the plugin-data."""
    return tempfile.mkdtemp(prefix=prefix, dir=os.environ.get("TMPDIR") or None)


def fresh_env(list_tools=None):
    helpers.temp_data_dir()
    tools = {"echo": lambda a: CALLS.append(a["text"]) or json.dumps({"text": "echo:" + a["text"]})}
    tools.update(list_tools or {})
    return E.env.Env(ctx=helpers.FakeCtx(tools), state={"tool_source": lambda: TOOLS,
                                                       "startup_done": True}, emit=lambda e, p: None)


def build(env, ops, save=True):
    flow, results = G.apply_ops(G.new_flow("contract"), ops, N.types_by_name(env))
    refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
    return (S.save_flow(env, flow, create=True) if save else flow), refs


def run(env, flow, **kw):
    return R.run_sync(env, flow["id"], timeout_s=15, **kw)


LOOP = [
    {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "anna\nbob\ncleo"}},
    {"op": "add_node", "ref": "prefix", "type": "input.text", "params": {"value": "P-"}},
    {"op": "add_node", "ref": "each", "type": "logic.foreach"},
    {"op": "add_node", "ref": "tmpl", "type": "text.template", "params": {"template": "{{prefix}}{{name}}"}},
    {"op": "add_node", "ref": "greet", "type": "tool:echo"},
    {"op": "add_node", "ref": "all", "type": "logic.collect"},
    {"op": "add_node", "ref": "show", "type": "output.preview"},
    {"op": "connect", "from": "src.text", "to": "each.list"},
    {"op": "connect", "from": "each.item", "to": "tmpl.name"},
    {"op": "connect", "from": "prefix.text", "to": "tmpl.prefix"},
    {"op": "connect", "from": "tmpl.text", "to": "greet.text"},
    {"op": "connect", "from": "greet.text", "to": "all.value"},
    {"op": "connect", "from": "all.list", "to": "show.value"},
]

LINEAR = [
    {"op": "add_node", "ref": "a", "type": "input.text", "params": {"value": "hi"}},
    {"op": "add_node", "ref": "b", "type": "tool:echo"},
    {"op": "add_node", "ref": "preview", "type": "output.preview"},
    {"op": "connect", "from": "a.text", "to": "b.text"},
    {"op": "connect", "from": "b.text", "to": "preview.value"},
]


class LoopTargetRunTest(unittest.TestCase):
    def setUp(self):
        CALLS.clear()
        self.env = fresh_env()

    def test_target_foreach_includes_body_collect_and_external_inputs(self):
        flow, refs = build(self.env, LOOP)
        res = run(self.env, flow, target_node=refs["each"])
        self.assertEqual(set(res["order"]),
                         {refs["src"], refs["prefix"], refs["each"], refs["tmpl"], refs["greet"], refs["all"]})
        self.assertNotIn(refs["show"], res["nodes"])  # downstream of the Collect: not in this run
        self.assertEqual(sorted(CALLS), ["P-anna", "P-bob", "P-cleo"])  # three items, prefix applied
        greet = res["nodes"].get(refs["greet"], {})
        self.assertEqual(greet.get("items"), {"total": 3, "done": 3, "cached": 0, "skipped": 0, "error": 0})
        collect = res["nodes"].get(refs["all"], {})
        self.assertEqual(collect.get("status"), "done")
        self.assertEqual(collect.get("outputs", {}).get("list"), ["echo:P-anna", "echo:P-bob", "echo:P-cleo"])
        self.assertEqual(res["status"], "done")

    def test_full_and_regular_target_sets_are_unchanged(self):
        flow, refs = build(self.env, LINEAR)
        full = run(self.env, flow)
        self.assertEqual(set(full["nodes"]), {refs["a"], refs["b"], refs["preview"]})
        self.assertEqual(full["nodes"].get(refs["preview"], {}).get("status"), "done")
        target = run(self.env, flow, target_node=refs["b"])
        self.assertEqual(set(target["nodes"]), {refs["a"], refs["b"]})
        self.assertNotIn(refs["preview"], target["nodes"])


LIST = "mcp__srv__list_models"
MODEL = "srv/model-x"
LISTING = json.dumps({"data": [{"id": MODEL, "name": "Mock Gen", "supported_parameters": {"parameters": {
    "style_image": {"type": "string", "label": "Style image"},
    "steps": {"type": "integer", "min": 1, "max": 50, "default": 8},
    "mode": {"type": "select", "options": ["fast", "slow"]}}}}]})
SPEC = {"open_params": True, "claimed": [], "params": [{"name": "model", "options_source": LIST}]}


def catalog_down(_args):
    raise X.NodeError("catalog offline")


class ModelExtrasFallbackTest(unittest.TestCase):
    """EN-6: extra settings are checked against the model's catalog row before they are sent."""

    def setUp(self):
        self.media_dir = scratch_dir("flowcanvas-media-")
        self.payload = b"\x89PNG\r\n\x1a\nreview-only"
        path = os.path.join(self.media_dir, "style.png")
        with open(path, "wb") as fh:
            fh.write(self.payload)
        self.data_url = "data:image/png;base64," + base64.b64encode(self.payload).decode("ascii")
        self.node = {"type": "tool:mcp__srv__gen", "params": {
            "model": MODEL, "style_image": {"$media": {"kind": "image", "file": "style.png", "path": path}},
            "steps": "12", "legacy_style": "wide"}}

    def env(self, list_tools):
        return fresh_env(dict(list_tools))

    def test_unreachable_catalog_without_known_row_fails_closed(self):
        env = self.env({LIST: catalog_down})
        with self.assertRaises(X.NodeError) as caught:
            asyncio.run(O.model_extras(env, SPEC, self.node))
        self.assertRegex(str(caught.exception), r"(?i)model|catalog|settings")
        self.assertNotIn("$media", str(caught.exception))

    def test_cached_model_row_coerces_stored_settings(self):
        env = self.env({})
        env.state["options_cache"] = {LIST: (time.monotonic(), LISTING)}
        extras = asyncio.run(O.model_extras(env, SPEC, self.node))
        self.assertEqual(extras, {"style_image": self.data_url, "steps": 12})
        self.assertEqual(env.ctx.calls, [])  # served from cache, no list call

    def test_expired_model_row_is_still_used_for_coercion_when_list_fails(self):
        env = self.env({LIST: catalog_down})
        env.state["options_cache"] = {LIST: (time.monotonic() - O.OPTIONS_TTL_S - 30, LISTING)}
        extras = asyncio.run(O.model_extras(env, SPEC, self.node))
        self.assertEqual(extras, {"style_image": self.data_url, "steps": 12})
        self.assertEqual([name for name, _args in env.ctx.calls], [LIST])


class FreshValidationTest(unittest.TestCase):
    """EN-9: only bool and the legacy strings "true"/"false" are accepted; invalid input never runs."""

    def setUp(self):
        CALLS.clear()
        self.env = fresh_env()

    def flow(self):
        return build(self.env, LINEAR, save=False)[0]

    def test_prepare_accepts_only_bool_and_legacy_fresh_strings(self):
        flow = self.flow()
        for value in (False, "false"):
            with self.subTest(fresh=value):
                prepared, _flow, _types = R.prepare(self.env, flow, fresh=value)
                self.assertIs(prepared["fresh"], False)
        for value in (True, "true"):
            with self.subTest(fresh=value):
                prepared, _flow, _types = R.prepare(self.env, flow, fresh=value)
                self.assertIs(prepared["fresh"], True)
        for value in ("nope", {}, [], 1):
            with self.subTest(fresh=value):
                with self.assertRaises(ValueError):
                    R.prepare(self.env, flow, fresh=value)

    def test_api_post_runs_validates_fresh_before_starting(self):
        handle = mock.Mock()
        handle.snapshot.return_value = {"id": "r_api", "status": "queued", "issues": []}
        for value, expected in ((False, False), ("false", False), (True, True), ("true", True)):
            with self.subTest(fresh=value), mock.patch.object(A.R, "start_run", return_value=handle) as start:
                out = asyncio.run(A.handle("POST", "runs", {}, {"flow_id": "f_contract", "fresh": value}, self.env))
                self.assertEqual(out["run_id"], "r_api")
                self.assertIs(start.call_args.kwargs["fresh"], expected)
        for value in ("nope", {}, [], 1):
            with self.subTest(fresh=value), mock.patch.object(A.R, "start_run", return_value=handle) as start:
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(A.handle("POST", "runs", {}, {"flow_id": "f_contract", "fresh": value}, self.env))
                self.assertEqual(caught.exception.status_code, 400)
                self.assertIn("fresh", str(caught.exception.detail))
                start.assert_not_called()

    def test_flow_run_tool_validates_fresh_before_starting(self):
        flow = build(self.env, LINEAR)[0]
        finished = {"id": "r_tool", "status": "queued", "ms": 0, "nodes": {}}
        for value, expected in ((False, False), ("false", False), (True, True), ("true", True)):
            with self.subTest(fresh=value), mock.patch.object(R, "run_sync", return_value=finished) as started:
                data = json.loads(T.handle("flow_run", {"flow": flow["id"], "fresh": value}, {}, self.env))
                self.assertNotIn("error", data, data)
                self.assertIs(started.call_args.kwargs["fresh"], expected)
        for value in ("nope", {}, [], 1):
            with self.subTest(fresh=value), mock.patch.object(R, "run_sync", return_value=finished) as started:
                data = json.loads(T.handle("flow_run", {"flow": flow["id"], "fresh": value}, {}, self.env))
                self.assertIn("error", data)
                self.assertIn("fresh", data["error"])
                started.assert_not_called()


if __name__ == "__main__":
    unittest.main()
