"""Review E-8: only tools that just read are cached by default; anything that may change something runs every time.

Read-only = a short allowlist of Hermes' read tools, or a tool entry flagged ``read_only`` (seam for a public
Hermes read-only flag; Hermes keeps MCP ``readOnlyHint`` in private core, which plugins must not import). Presets, the LLM and the logic nodes stay cached. The inspector switch overrides either way.
"""
import json
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N = E.runner, E.store, E.graph, E.nodes


def tool(name, **extra):
    return {"name": name, "toolset": "test", **extra,
            "parameters": {"type": "object", "properties": {"text": {"type": "string"}}}}


TOOLS = [tool("write_note"), tool("web_search"), tool("mcp__nanogpt__nanogpt_get_balance", read_only=True),
         tool("mcp__srv__lookup", read_only=True), tool("mcp__srv__publish", read_only=False),
         tool("mcp__srv__get_thing", read_only=False)]  # no hint: Hermes reports False, so no guessing from the name


class CacheDefaultTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.ctx = helpers.FakeCtx({t["name"]: (lambda args: json.dumps({"text": "ok"})) for t in TOOLS})
        self.env = E.env.Env(ctx=self.ctx, state={"tool_source": lambda: TOOLS})

    def twice(self, name, params=None):
        flow, _ = G.apply_ops(G.new_flow("t"), [
            {"op": "add_node", "ref": "a", "type": f"tool:{name}", "title": "A", "params": {"text": "x", **(params or {})}}],
            N.types_by_name(self.env))
        flow = S.save_flow(self.env, flow, create=True)
        nid = flow["nodes"][0]["id"]
        before = len(self.ctx.calls)
        R.run_sync(self.env, flow["id"], timeout_s=10)
        second = R.run_sync(self.env, flow["id"], timeout_s=10)["nodes"][nid]["status"]
        return second, len(self.ctx.calls) - before

    def test_a_tool_that_may_write_runs_every_time(self):
        self.assertEqual(self.twice("write_note"), ("done", 2))
        self.assertEqual(self.twice("mcp__srv__publish"), ("done", 2))
        self.assertEqual(self.twice("mcp__srv__get_thing"), ("done", 2))

    def test_read_only_tools_are_cached(self):
        for name in ("web_search", "mcp__nanogpt__nanogpt_get_balance", "mcp__srv__lookup"):
            with self.subTest(name):
                self.assertEqual(self.twice(name), ("cached", 1))

    def test_the_inspector_switch_overrides_the_default(self):
        self.assertEqual(self.twice("write_note", {"cache": True}), ("cached", 1))
        self.assertEqual(self.twice("web_search", {"cache": False}), ("done", 2))

    def test_specs_say_what_the_default_is(self):
        types = N.types_by_name(self.env)
        self.assertIs(types["tool:write_note"]["cache_default"], False)
        self.assertIs(types["tool:web_search"]["cache_default"], True)
        self.assertIs(types["tool:mcp__srv__lookup"]["cache_default"], True)
        self.assertNotEqual(types["llm.complete"].get("cache_default"), False)

    def test_never_cacheable_nodes_stay_off_even_when_switched_on(self):
        spec = {"cacheable": False}
        self.assertFalse(R.node_cacheable({"params": {"cache": True}}, spec, False))
        self.assertFalse(R.node_cacheable({"params": {"cache": True}}, {"cache_default": False}, True))


if __name__ == "__main__":
    unittest.main()
