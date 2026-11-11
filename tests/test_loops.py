"""G11: For each + Collect — loop bodies, per-item runs, filters via If, limits, per-item cache, errors, cancel."""
import asyncio
import json
import threading
import time
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N, X, T = E.runner, E.store, E.graph, E.nodes, E.executors, E.timings

TOOLS = [
    {"name": "echo", "toolset": "test", "read_only": True,  # a pure fake: cached by default (review E-8)
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "slow", "toolset": "test", "parameters": {"type": "object", "properties": {
        "text": {"type": "string"}}}},
    {"name": "picky", "toolset": "test", "parameters": {"type": "object", "properties": {
        "text": {"type": "string"}}}},
]
CALLS = []
STOP = threading.Event()


def _slow(a):
    STOP.wait(0.3)
    return json.dumps({"text": "slow:" + a.get("text", "")})


def _picky(a):
    if a.get("text") == "bad":
        return json.dumps({"success": False, "error": "cannot handle bad"})
    return json.dumps({"text": "ok:" + a.get("text", "")})


class Ctx(helpers.FakeCtx):
    def __init__(self, config=None):
        super().__init__({"echo": lambda a: CALLS.append(a["text"]) or json.dumps({"text": "echo:" + a["text"]}),
                          "slow": _slow, "picky": _picky})
        self.config = dict(config or {})

    def get_config(self, key, default=None):
        return self.config.get(key, default)


def make_env(config=None):
    helpers.temp_data_dir()
    CALLS.clear()
    STOP.clear()
    return E.env.Env(ctx=Ctx(config), state={"tool_source": lambda: TOOLS}, emit=lambda e, p: None)


def build(env, ops, save=True):
    types = N.types_by_name(env)
    flow, results = G.apply_ops(G.new_flow("loop"), ops, types)
    refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
    return (S.save_flow(env, flow, create=True) if save else flow), refs


def run(env, flow, **kw):
    return R.run_sync(env, flow["id"], timeout_s=15, **kw)


def items_of(value):
    return asyncio.run(X.execute(None, {"type": "logic.foreach", "params": {}}, {"type": "logic.foreach"},
                                 {"list": value}, None))["item"]


LOOP = [
    {"op": "add_node", "ref": "src", "type": "input.text", "title": "Names", "params": {"value": "anna\nbob\ncleo"}},
    {"op": "add_node", "ref": "each", "type": "logic.foreach", "title": "Each name"},
    {"op": "add_node", "ref": "greet", "type": "tool:echo", "title": "Greet"},
    {"op": "add_node", "ref": "all", "type": "logic.collect", "title": "All"},
    {"op": "add_node", "ref": "show", "type": "output.preview", "title": "Show"},
    {"op": "connect", "from": "src.text", "to": "each.list"},
    {"op": "connect", "from": "each.item", "to": "greet.text"},
    {"op": "connect", "from": "greet.text", "to": "all.value"},
    {"op": "connect", "from": "all.list", "to": "show.value"},
]


class ItemsTest(unittest.TestCase):
    def test_list_inputs(self):
        self.assertEqual(items_of(["a", 2, {"x": 1}]), ["a", 2, {"x": 1}])
        self.assertEqual(items_of('["a", "b"]'), ["a", "b"])
        self.assertEqual(items_of("one\n\n two \nthree\n"), ["one", "two", "three"])
        self.assertEqual(items_of(""), [])
        self.assertEqual(items_of(None), [])
        self.assertEqual(items_of(7), [7])
        self.assertEqual(items_of({"a": 1}), [{"a": 1}])


class LoopShapeTest(unittest.TestCase):
    def setUp(self):
        self.env = make_env()
        self.types = N.types_by_name(self.env)

    def errors(self, flow):
        return [i["message"] for i in G.validate(flow, self.types) if i["level"] == "error"]

    def test_body_is_everything_between_for_each_and_collect(self):
        flow, refs = build(self.env, LOOP + [
            {"op": "add_node", "ref": "side", "type": "output.preview", "title": "Per item"},
            {"op": "connect", "from": "greet.text", "to": "side.value"},
        ], save=False)
        loops, issues = G.loops(flow, self.types)
        self.assertEqual(issues, [])
        self.assertEqual(set(loops), {refs["each"]})
        loop = loops[refs["each"]]
        self.assertEqual(loop["body"], {refs["greet"], refs["side"]})
        self.assertEqual(loop["collects"], {refs["all"]})
        self.assertEqual(self.errors(flow), [])

    def test_collect_needs_a_for_each(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "t", "type": "input.text", "params": {"value": "x"}},
            {"op": "add_node", "ref": "c", "type": "logic.collect"},
            {"op": "connect", "from": "t.text", "to": "c.value"},
        ], save=False)
        self.assertIn("Collect needs a For each before it", self.errors(flow))

    def test_after_collect_cannot_read_per_item_values(self):
        flow, refs = build(self.env, LOOP + [
            {"op": "add_node", "ref": "mix", "type": "text.template", "params": {"template": "{{a}} {{b}}"}},
            {"op": "connect", "from": "all.list", "to": "mix.a"},
            {"op": "connect", "from": "greet.text", "to": "mix.b"},
        ], save=False)
        msgs = self.errors(flow)
        self.assertTrue(any("per-item value" in m for m in msgs), msgs)

    def test_collect_behind_collect_is_rejected(self):
        flow, refs = build(self.env, LOOP + [
            {"op": "add_node", "ref": "again", "type": "logic.collect"},
            {"op": "connect", "from": "all.list", "to": "again.value"},
        ], save=False)
        loops, issues = G.loops(flow, self.types)
        self.assertEqual(loops[refs["each"]]["collects"], {refs["all"]})
        self.assertIn({"level": "error", "message": "Collect is downstream of another Collect; its values are "
                       "already collected, not per-item", "node": refs["again"]}, issues)

    def test_nested_for_each_is_rejected(self):
        flow, _ = build(self.env, LOOP + [
            {"op": "add_node", "ref": "inner", "type": "logic.foreach"},
            {"op": "connect", "from": "greet.text", "to": "inner.list"},
        ], save=False)
        self.assertTrue(any("inside another For each" in m for m in self.errors(flow)))


def st(res, refs, ref):
    return res["nodes"][refs[ref]]


class LoopRunTest(unittest.TestCase):
    def test_body_runs_once_per_item_and_collect_keeps_item_order(self):
        env = make_env()
        flow, refs = build(env, LOOP)
        res = run(env, flow)
        self.assertEqual(res["status"], "done")
        self.assertEqual(sorted(CALLS), ["anna", "bob", "cleo"])
        self.assertEqual(st(res, refs, "all")["outputs"]["list"], ["echo:anna", "echo:bob", "echo:cleo"])
        self.assertEqual(st(res, refs, "show")["outputs"]["value"], ["echo:anna", "echo:bob", "echo:cleo"])
        greet = st(res, refs, "greet")
        self.assertEqual(greet["status"], "done")
        self.assertEqual(greet["items"], {"total": 3, "done": 3, "cached": 0, "skipped": 0, "error": 0})
        self.assertEqual(greet["outputs"]["text"], ["echo:anna", "echo:bob", "echo:cleo"])
        self.assertEqual([i["status"] for i in greet["iterations"]], ["done"] * 3)
        each = st(res, refs, "each")
        self.assertEqual(each["status"], "done")
        self.assertEqual(each["count"], 3)

    def test_second_run_is_cached_per_item(self):
        env = make_env()
        flow, refs = build(env, LOOP)
        run(env, flow)
        CALLS.clear()
        res = run(env, flow)
        self.assertEqual(CALLS, [])
        self.assertEqual(st(res, refs, "greet")["status"], "cached")
        self.assertEqual(st(res, refs, "greet")["items"]["cached"], 3)
        # one changed item reruns alone
        S.modify_flow(env, flow["id"], lambda f: next(n for n in f["nodes"] if n["id"] == refs["src"])
                      ["params"].update(value="anna\nbea\ncleo"))
        res = run(env, flow)
        self.assertEqual(CALLS, ["bea"])
        self.assertEqual(st(res, refs, "greet")["items"]["cached"], 2)
        self.assertEqual(st(res, refs, "greet")["status"], "done")

    def test_if_inside_the_loop_filters_items(self):
        env = make_env()
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "a\nb\nc"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "if", "type": "logic.if", "params": {"op": "not equals", "compare": "b"}},
            {"op": "add_node", "ref": "greet", "type": "tool:echo"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "if.value"},
            {"op": "connect", "from": "if.true", "to": "greet.text"},
            {"op": "connect", "from": "greet.text", "to": "all.value"},
        ])
        res = run(env, flow)
        self.assertEqual(res["status"], "done")
        self.assertEqual(st(res, refs, "all")["outputs"]["list"], ["echo:a", "echo:c"])
        greet = st(res, refs, "greet")
        self.assertEqual(greet["items"], {"total": 3, "done": 2, "cached": 0, "skipped": 1, "error": 0})
        self.assertEqual(greet["iterations"][1]["skip"], "branch")
        self.assertEqual(greet["outputs"]["text"], ["echo:a", None, "echo:c"])

    def test_one_failed_item_fails_the_step_but_the_others_finish(self):
        env = make_env()
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "x\nbad\ny"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "p", "type": "tool:picky", "title": "Picky"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "p.text"},
            {"op": "connect", "from": "p.text", "to": "all.value"},
        ])
        res = run(env, flow)
        self.assertEqual(res["status"], "error")
        picky = st(res, refs, "p")
        self.assertEqual(picky["status"], "error")
        self.assertEqual(picky["items"], {"total": 3, "done": 2, "cached": 0, "skipped": 0, "error": 1})
        self.assertIn("item 2 of 3", picky["error"])
        self.assertIn("cannot handle bad", picky["error"])
        self.assertEqual(st(res, refs, "all")["status"], "skipped")
        self.assertTrue(st(res, refs, "all")["error"].startswith("upstream failed"))

    def test_limit_from_the_node_and_the_config(self):
        env = make_env({"max_items": 4})
        ops = [dict(o) for o in LOOP]
        ops[0] = dict(ops[0], params={"value": "\n".join(f"n{i}" for i in range(7))})
        flow, refs = build(env, ops)
        res = run(env, flow)
        self.assertEqual(len(st(res, refs, "all")["outputs"]["list"]), 4)
        self.assertEqual(st(res, refs, "each")["count"], 4)
        self.assertIn("first 4 of 7", st(res, refs, "each")["note"])
        S.modify_flow(env, flow["id"], lambda f: next(n for n in f["nodes"] if n["id"] == refs["each"])
                      .setdefault("params", {}).update(limit=2))
        res = run(env, flow)
        self.assertEqual(len(st(res, refs, "all")["outputs"]["list"]), 2)

    def test_items_run_in_parallel_up_to_max_parallel(self):
        env = make_env({"max_parallel": 2})
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "1\n2\n3\n4"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "s", "type": "tool:slow"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "s.text"},
            {"op": "connect", "from": "s.text", "to": "all.value"},
        ])
        t0 = time.monotonic()
        res = run(env, flow, fresh=True)
        elapsed = time.monotonic() - t0
        self.assertEqual(st(res, refs, "all")["outputs"]["list"], ["slow:1", "slow:2", "slow:3", "slow:4"])
        self.assertLess(elapsed, 1.1)            # 4 x 0.3 s on 2 lanes ~ 0.6 s; sequential 1.2 s
        self.assertGreater(elapsed, 0.55)        # never more than 2 at once

    def test_index_output_and_empty_list(self):
        env = make_env()
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "a\nb"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.index", "to": "all.value"},
        ])
        self.assertEqual(st(run(env, flow), refs, "all")["outputs"]["list"], [1, 2])
        S.modify_flow(env, flow["id"], lambda f: next(n for n in f["nodes"] if n["id"] == refs["src"])
                      ["params"].update(value=""))
        res = run(env, flow)
        self.assertEqual(res["status"], "done")
        self.assertEqual(st(res, refs, "all")["outputs"]["list"], [])

    def test_empty_list_skips_the_body_and_collects_nothing(self):
        env = make_env()
        ops = [dict(o) for o in LOOP]
        ops[0] = dict(ops[0], params={"value": ""})
        flow, refs = build(env, ops)
        res = run(env, flow)
        self.assertEqual(res["status"], "done")
        greet = st(res, refs, "greet")
        self.assertEqual((greet["status"], greet["skip"], greet["reason"]), ("skipped", "branch", "The list was empty."))
        self.assertEqual(st(res, refs, "all")["outputs"]["list"], [])
        self.assertEqual(CALLS, [])

    def test_failure_after_item_500_is_reported(self):
        env = make_env({"max_items": 600})
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "x\n" * 519 + "bad"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "p", "type": "tool:picky"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "p.text"},
            {"op": "connect", "from": "p.text", "to": "all.value"},
        ])
        res = run(env, flow, fresh=True)
        picky = st(res, refs, "p")
        self.assertEqual(st(res, refs, "each")["status"], "done")
        self.assertEqual(picky["status"], "error")
        self.assertTrue(picky["error"].startswith("item 520 of 520: cannot handle bad"), picky["error"])
        self.assertEqual(len(picky["iterations"]), R.MAX_ITERATION_RECORDS)
        self.assertEqual(picky["items"]["done"], 519)

    def test_run_up_to_a_body_node(self):
        env = make_env()
        flow, refs = build(env, LOOP)
        res = run(env, flow, target_node=refs["greet"])
        self.assertEqual(set(res["nodes"]), {refs["src"], refs["each"], refs["greet"]})
        self.assertEqual(st(res, refs, "greet")["items"]["done"], 3)

    def test_for_each_skipped_upstream_skips_the_body(self):
        env = make_env()
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "a"}},
            {"op": "add_node", "ref": "if", "type": "logic.if", "title": "Gate", "params": {"op": "empty"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "greet", "type": "tool:echo"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "if.value"},
            {"op": "connect", "from": "if.true", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "greet.text"},
            {"op": "connect", "from": "greet.text", "to": "all.value"},
        ])
        res = run(env, flow)
        self.assertEqual(res["status"], "done")
        for ref in ("each", "greet", "all"):
            self.assertEqual(st(res, refs, ref)["status"], "skipped", ref)
            self.assertEqual(st(res, refs, ref)["skip"], "branch", ref)

    def test_cancel_stops_the_loop(self):
        env = make_env({"max_parallel": 1})
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "\n".join("abcdefgh")}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "s", "type": "tool:slow"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "s.text"},
            {"op": "connect", "from": "s.text", "to": "all.value"},
        ])
        handle = R.start_run(env, flow["id"], fresh=True)
        self.assertTrue(helpers.wait_until(lambda: st(handle.snapshot(), refs, "s")["status"] == "running"))
        R.cancel_run(env, handle.run["id"])
        STOP.set()
        self.assertTrue(handle.done.wait(5))
        res = handle.snapshot()
        self.assertEqual(res["status"], "cancelled")
        self.assertLess(st(res, refs, "s")["items"]["done"], 8)
        self.assertNotIn(st(res, refs, "s")["status"], ("running", "queued"))
        self.assertNotIn(st(res, refs, "all")["status"], ("running", "queued", "done"))

    def test_timings_count_each_item(self):
        env = make_env()
        flow, _ = build(env, LOOP)
        run(env, flow)
        echo = {e["type"]: e for e in T.stats(env)["nodes"]}["tool:echo"]
        self.assertEqual(echo["n"], 3)


if __name__ == "__main__":
    unittest.main()
