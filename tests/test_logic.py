"""G10: If / Switch / Merge — conditions, dynamic Switch outputs, skip propagation along untaken branches."""
import asyncio
import json
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N, X = E.runner, E.store, E.graph, E.nodes, E.executors

TOOLS = [
    {"name": "echo", "toolset": "test", "read_only": True,  # a pure fake: cached by default (review E-8)
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "boom", "toolset": "test", "parameters": {"type": "object", "properties": {
        "text": {"type": "string"}}}},
]


class Ctx(helpers.FakeCtx):
    def __init__(self):
        super().__init__({"echo": lambda a: json.dumps({"text": "echo:" + a["text"]}),
                          "boom": lambda a: json.dumps({"success": False, "error": "boom"})})


def make_env():
    helpers.temp_data_dir()
    return E.env.Env(ctx=Ctx(), state={"tool_source": lambda: TOOLS}, emit=lambda e, p: None)


def build(env, ops):
    types = N.types_by_name(env)
    flow, results = G.apply_ops(G.new_flow("logic"), ops, types)
    refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
    return S.save_flow(env, flow, create=True), refs


def run(env, flow, **kw):
    return R.run_sync(env, flow["id"], timeout_s=10, **kw)


def condition(op, value, compare="", case_sensitive=False, wired=None):
    node = {"type": "logic.if", "params": {"op": op, "compare": compare, "case_sensitive": case_sensitive}}
    inputs = {"value": value}
    if wired is not None:
        inputs["compare"] = wired
    out = asyncio.run(X.execute(None, node, {"type": "logic.if"}, inputs, None))
    return out[X.BRANCH]


class IfConditionTest(unittest.TestCase):
    def test_text_conditions(self):
        self.assertEqual(condition("contains", "Hello World", "world"), "true")
        self.assertEqual(condition("contains", "Hello World", "world", case_sensitive=True), "false")
        self.assertEqual(condition("not contains", "Hello", "bye"), "true")
        self.assertEqual(condition("equals", "  yes ", "YES"), "true")
        self.assertEqual(condition("not equals", "yes", "no"), "true")
        self.assertEqual(condition("regex", "order #123", r"#\d+"), "true")
        self.assertEqual(condition("regex", "order", r"^ORD", case_sensitive=True), "false")

    def test_numbers(self):
        self.assertEqual(condition(">", 5, "3"), "true")
        self.assertEqual(condition(">=", "3", 3), "true")
        self.assertEqual(condition("<", "2.5", "10"), "true")
        self.assertEqual(condition("<=", 11, 10), "false")

    def test_empty(self):
        for value in ("", "   ", None, [], {}):
            self.assertEqual(condition("empty", value), "true", value)
        for value in ("x", 0, [1], {"a": 1}):
            self.assertEqual(condition("not empty", value), "true", value)

    def test_wired_compare_wins_over_the_setting(self):
        self.assertEqual(condition("equals", "b", "a", wired="b"), "true")
        self.assertEqual(condition(">", 5, "1", wired=9), "false")

    def test_bad_input_is_a_node_error(self):
        with self.assertRaisesRegex(X.NodeError, "not a number"):
            condition(">", "five", "3")
        with self.assertRaisesRegex(X.NodeError, "regular expression"):
            condition("regex", "x", "(")
        with self.assertRaisesRegex(X.NodeError, "condition"):
            condition("sometimes", "x", "y")

    def test_value_passes_through_the_taken_output(self):
        node = {"type": "logic.if", "params": {"op": "not empty"}}
        out = asyncio.run(X.execute(None, node, {"type": "logic.if"}, {"value": {"a": 1}}, None))
        self.assertEqual(out, {"true": {"a": 1}, X.BRANCH: "true"})


class SwitchPortsTest(unittest.TestCase):
    def test_one_output_per_case_line_plus_default(self):
        env = make_env()
        types = N.types_by_name(env)
        node = {"type": "logic.switch", "params": {"cases": "red\n\n  green \nblue"}}
        _, outs = G.node_ports(node, types)
        self.assertEqual([(p["name"], p["label"]) for p in outs],
                         [("case1", "red"), ("case2", "green"), ("case3", "blue"), ("default", "Default")])
        self.assertEqual(G.switch_cases("a\n" * 40), ["a"] * G.MAX_CASES)

    def test_edge_from_a_removed_case_is_invalid(self):
        env = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "t", "type": "input.text", "params": {"value": "x"}},
            {"op": "add_node", "ref": "s", "type": "logic.switch", "params": {"cases": "a\nb\nc"}},
            {"op": "add_node", "ref": "e", "type": "tool:echo"},
            {"op": "connect", "from": "t.text", "to": "s.value"},
            {"op": "connect", "from": "s.case3", "to": "e.text"},
        ])
        types = N.types_by_name(env)
        self.assertEqual([i for i in G.validate(flow, types) if i["level"] == "error"], [])
        switch = next(n for n in flow["nodes"] if n["type"] == "logic.switch")
        switch["params"]["cases"] = "a\nb"
        self.assertIn("node has no output 'case3'", [i["message"] for i in G.validate(flow, types)])

    def test_layout_counts_dynamic_outputs(self):
        env = make_env()
        spec = N.types_by_name(env)["logic.switch"]
        few = E.layout.estimate_height({"type": "logic.switch", "params": {"cases": "a"}}, spec)
        many = E.layout.estimate_height({"type": "logic.switch", "params": {"cases": "a\nb\nc\nd\ne"}}, spec)
        self.assertGreater(many, few)


def switch_branch(value, cases, op="equals"):
    node = {"type": "logic.switch", "params": {"cases": cases, "op": op}}
    return asyncio.run(X.execute(None, node, {"type": "logic.switch"}, {"value": value}, None))[X.BRANCH]


class SwitchMatchTest(unittest.TestCase):
    def test_first_matching_case_or_default(self):
        self.assertEqual(switch_branch("Green", "red\ngreen\nblue"), "case2")
        self.assertEqual(switch_branch("purple", "red\ngreen"), "default")
        self.assertEqual(switch_branch("a dark red car", "blue\nred\ndark", op="contains"), "case2")
        self.assertEqual(switch_branch("image: cat", "video\nimage", op="starts with"), "case2")
        self.assertEqual(switch_branch("v2.1", "^v1\n^v2", op="regex"), "case2")
        self.assertEqual(switch_branch("x", ""), "default")


def statuses(result):
    return {nid: st.get("status") for nid, st in result["nodes"].items()}


class BranchRunTest(unittest.TestCase):
    def setUp(self):
        self.env = make_env()

    def if_flow(self, text, merge=True, extra=()):
        ops = [
            {"op": "add_node", "ref": "t", "type": "input.text", "title": "Answer", "params": {"value": text}},
            {"op": "add_node", "ref": "if", "type": "logic.if", "title": "Is yes?",
             "params": {"op": "equals", "compare": "yes"}},
            {"op": "add_node", "ref": "a", "type": "tool:echo", "title": "Yes path"},
            {"op": "add_node", "ref": "b", "type": "tool:echo", "title": "No path"},
            {"op": "add_node", "ref": "b2", "type": "tool:echo", "title": "After no"},
            {"op": "connect", "from": "t.text", "to": "if.value"},
            {"op": "connect", "from": "if.true", "to": "a.text"},
            {"op": "connect", "from": "if.false", "to": "b.text"},
            {"op": "connect", "from": "b.text", "to": "b2.text"},
        ]
        if merge:
            ops += [{"op": "add_node", "ref": "m", "type": "logic.merge", "title": "Either"},
                    {"op": "connect", "from": "b2.text", "to": "m.value"},
                    {"op": "connect", "from": "a.text", "to": "m.value"},
                    {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
                    {"op": "connect", "from": "m.value", "to": "out.value"}]
        return build(self.env, ops + list(extra))

    def test_true_branch_runs_false_branch_is_skipped(self):
        flow, refs = self.if_flow("yes")
        res = run(self.env, flow)
        st = statuses(res)
        self.assertEqual(res["status"], "done")
        self.assertEqual(st[refs["if"]], "done")
        self.assertEqual(res["nodes"][refs["if"]]["branch"], "true")
        self.assertEqual(st[refs["a"]], "done")
        self.assertEqual((st[refs["b"]], st[refs["b2"]]), ("skipped", "skipped"))
        for ref in ("b", "b2"):
            state = res["nodes"][refs[ref]]
            self.assertEqual(state["skip"], "branch")
            self.assertNotIn("error", {k for k, v in state.items() if v})
            self.assertEqual(state["reason"], "Is yes? took “True”, not “False”")
        self.assertEqual(st[refs["m"]], "done")                     # Merge breaks the skip
        self.assertEqual(res["nodes"][refs["out"]]["outputs"]["value"], "echo:yes")

    def test_false_branch_and_merge_takes_the_live_wire(self):
        flow, refs = self.if_flow("no")
        res = run(self.env, flow)
        st = statuses(res)
        self.assertEqual(res["nodes"][refs["if"]]["branch"], "false")
        self.assertEqual(st[refs["a"]], "skipped")
        self.assertEqual(st[refs["b2"]], "done")
        self.assertEqual(res["nodes"][refs["out"]]["outputs"]["value"], "echo:echo:no")

    def test_merge_skips_on_when_no_wire_is_live(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "t", "type": "input.text", "params": {"value": "x"}},
            {"op": "add_node", "ref": "if", "type": "logic.if", "title": "Empty?", "params": {"op": "empty"}},
            {"op": "add_node", "ref": "m", "type": "logic.merge"},
            {"op": "add_node", "ref": "after", "type": "tool:echo"},
            {"op": "connect", "from": "t.text", "to": "if.value"},
            {"op": "connect", "from": "if.true", "to": "m.value"},
            {"op": "connect", "from": "m.value", "to": "after.text"},
        ])
        res = run(self.env, flow)
        st = statuses(res)
        self.assertEqual((st[refs["m"]], st[refs["after"]]), ("skipped", "skipped"))
        self.assertEqual(res["nodes"][refs["after"]]["skip"], "branch")
        self.assertEqual(res["status"], "done")

    def test_merge_takes_the_first_live_wire_in_flow_order(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "x", "type": "input.text", "params": {"value": "first"}},
            {"op": "add_node", "ref": "y", "type": "input.text", "params": {"value": "second"}},
            {"op": "add_node", "ref": "m", "type": "logic.merge"},
            {"op": "connect", "from": "y.text", "to": "m.value"},
            {"op": "connect", "from": "x.text", "to": "m.value"},
        ])
        res = run(self.env, flow)
        self.assertEqual(res["nodes"][refs["m"]]["outputs"]["value"], "second")

    def test_failure_beats_branch_skip(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "t", "type": "input.text", "params": {"value": "x"}},
            {"op": "add_node", "ref": "if", "type": "logic.if", "params": {"op": "empty"}},
            {"op": "add_node", "ref": "bad", "type": "tool:boom"},
            {"op": "add_node", "ref": "tpl", "type": "text.template", "params": {"template": "{{a}} {{b}}"}},
            {"op": "connect", "from": "t.text", "to": "if.value"},
            {"op": "connect", "from": "t.text", "to": "bad.text"},
            {"op": "connect", "from": "if.true", "to": "tpl.a"},
            {"op": "connect", "from": "bad.text", "to": "tpl.b"},
        ])
        res = run(self.env, flow)
        state = res["nodes"][refs["tpl"]]
        self.assertEqual(state["status"], "skipped")
        self.assertNotEqual(state.get("skip"), "branch")
        self.assertTrue(state["error"].startswith("upstream failed"))
        self.assertEqual(res["status"], "error")

    def test_switch_routes_one_case(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "t", "type": "input.text", "params": {"value": "green"}},
            {"op": "add_node", "ref": "s", "type": "logic.switch", "title": "Colour",
             "params": {"cases": "red\ngreen"}},
            {"op": "add_node", "ref": "r", "type": "tool:echo"},
            {"op": "add_node", "ref": "g", "type": "tool:echo"},
            {"op": "add_node", "ref": "d", "type": "tool:echo"},
            {"op": "connect", "from": "t.text", "to": "s.value"},
            {"op": "connect", "from": "s.case1", "to": "r.text"},
            {"op": "connect", "from": "s.case2", "to": "g.text"},
            {"op": "connect", "from": "s.default", "to": "d.text"},
        ])
        res = run(self.env, flow)
        st = statuses(res)
        self.assertEqual(res["nodes"][refs["s"]]["branch"], "case2")
        self.assertEqual((st[refs["r"]], st[refs["g"]], st[refs["d"]]), ("skipped", "done", "skipped"))
        self.assertEqual(res["nodes"][refs["d"]]["reason"], "Colour took “green”, not “Default”")

    def test_cached_branch_keeps_its_route(self):
        flow, refs = self.if_flow("no", merge=False)
        run(self.env, flow)
        res = run(self.env, flow)
        self.assertEqual(res["nodes"][refs["if"]]["status"], "cached")
        self.assertEqual(res["nodes"][refs["if"]]["branch"], "false")
        self.assertEqual(statuses(res)[refs["a"]], "skipped")
        self.assertEqual(statuses(res)[refs["b2"]], "cached")


class CatalogTest(unittest.TestCase):
    def test_build_with_hermes_sees_the_case_ports(self):
        env = make_env()
        rows = [json.loads(r) for r in E.generate.compact_catalog(N.types_by_name(env)).splitlines()]
        switch = next(r for r in rows if r["type"] == "logic.switch")
        self.assertIn("case1..caseN", switch["dynamic_outputs"])
        self.assertNotIn("dynamic_outputs", next(r for r in rows if r["type"] == "logic.if"))
        self.assertIn("logic.merge", E.generate._skill_rules())


if __name__ == "__main__":
    unittest.main()
