"""G9: real node durations — runner records type/model/start, timings averages the last runs per type and model."""
import asyncio
import json
import os
import time
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N, T, A = E.runner, E.store, E.graph, E.nodes, E.timings, E.api

TOOLS = [
    {"name": "echo", "toolset": "test", "read_only": True,  # a pure fake: cached by default (review E-8)
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]


class Ctx(helpers.FakeCtx):
    def __init__(self):
        super().__init__({"echo": lambda a: json.dumps({"text": "echo:" + a["text"]})})


def make_env():
    helpers.temp_data_dir()
    events = []
    env = E.env.Env(ctx=Ctx(), state={"tool_source": lambda: TOOLS}, emit=lambda e, p: events.append((e, dict(p))))
    return env, events


def build(env):
    types = N.types_by_name(env)
    flow, _ = G.apply_ops(G.new_flow("t"), [
        {"op": "add_node", "ref": "a", "type": "input.text", "title": "Idea", "params": {"value": "hi"}},
        {"op": "add_node", "ref": "b", "type": "tool:echo", "title": "Echo"},
        {"op": "connect", "from": "a.text", "to": "b.text"},
    ], types)
    flow = S.save_flow(env, flow, create=True)
    echo = next(n["id"] for n in flow["nodes"] if n["title"] == "Echo")
    return flow, echo


def node_state(type_, ms, minute, status="done", model=""):
    return {"type": type_, "model": model, "status": status, "ms": ms,
            "started_at": f"2026-11-01T10:{minute:02d}:00Z"}


def run_record(flow_id, minute, nodes):
    return {"id": S.new_run_id(), "flow_id": flow_id, "status": "done",
            "started_at": f"2026-11-01T10:{minute:02d}:00Z", "nodes": nodes}


MODEL_SPEC = {"type": "tool:img", "params": [
    {"name": "model", "kind": "text", "options_source": "list_models", "default": "cheap-1"},
    {"name": "prompt", "kind": "textarea"}]}


class ModelKeyTest(unittest.TestCase):
    def test_tool_model_setting_or_its_default(self):
        self.assertEqual(T.model_key(MODEL_SPEC, {"params": {"model": "big-2"}}), "big-2")
        self.assertEqual(T.model_key(MODEL_SPEC, {"params": {"model": "  "}}), "cheap-1")
        self.assertEqual(T.model_key(MODEL_SPEC, {"params": {}}), "cheap-1")

    def test_llm_model_and_plain_nodes(self):
        env, _ = make_env()
        types = N.types_by_name(env)
        llm = types["llm.complete"]
        self.assertEqual(T.model_key(llm, {"type": "llm.complete", "params": {"model": "glm-5"}}), "glm-5")
        self.assertEqual(T.model_key(llm, {"type": "llm.complete", "params": {}}), "")
        self.assertEqual(T.model_key(types["tool:echo"], {"type": "tool:echo", "params": {"text": "x"}}), "")
        self.assertEqual(T.model_key(None, {"type": "tool:gone"}), "")


class CollectTest(unittest.TestCase):
    def test_average_of_the_last_runs_per_type_and_model(self):
        runs = [run_record("f_a", m, {"n1": node_state("tool:img", m * 1000, m, model="m1")}) for m in range(1, 8)]
        runs.append(run_record("f_a", 9, {"n1": node_state("tool:img", 200, 9, model="m2")}))
        out = T.collect(runs, window=5)
        self.assertEqual(out["window"], 5)
        by = {(e["type"], e["model"]): e for e in out["nodes"]}
        self.assertEqual(by[("tool:img", "m1")], {"type": "tool:img", "model": "m1", "n": 5, "avg_ms": 5000,
                                                   "min_ms": 3000, "max_ms": 7000})
        self.assertEqual(by[("tool:img", "m2")]["n"], 1)
        self.assertEqual(by[("tool:img", "m2")]["avg_ms"], 200)
        types = {e["type"]: e for e in out["types"]}
        # every model counts for the type: newest five are m2 (200 ms) plus m1 at 7, 6, 5, 4 s
        self.assertEqual(types["tool:img"], {"type": "tool:img", "n": 5, "avg_ms": 4440, "min_ms": 200, "max_ms": 7000})

    def test_only_finished_real_work_counts(self):
        runs = [run_record("f_a", 1, {
            "ok": node_state("tool:echo", 1500, 1),
            "cached": node_state("tool:echo", 3, 1, status="cached"),
            "failed": node_state("tool:echo", 90000, 1, status="error"),
            "running": {"type": "tool:echo", "model": "", "status": "running", "started_at": "2026-11-01T10:01:00Z"},
            "old": {"status": "done", "ms": 7000},                   # recorded before G9: no type
            "bad_ms": {"type": "tool:echo", "status": "done", "ms": "slow"},
        })]
        out = T.collect(runs)
        self.assertEqual(out["nodes"], [{"type": "tool:echo", "model": "", "n": 1, "avg_ms": 1500,
                                         "min_ms": 1500, "max_ms": 1500}])
        self.assertEqual([e["type"] for e in out["types"]], ["tool:echo"])

    def test_empty(self):
        self.assertEqual(T.collect([]), {"window": T.WINDOW, "nodes": [], "types": []})


class RecordingTest(unittest.TestCase):
    def test_runner_records_type_model_and_start(self):
        env, events = make_env()
        flow, echo = build(env)
        run = R.run_sync(env, flow["id"], timeout_s=10)
        state = run["nodes"][echo]
        self.assertEqual(state["type"], "tool:echo")
        self.assertEqual(state["model"], "")
        self.assertRegex(state["started_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertIsInstance(state["ms"], int)
        running = [p for e, p in events if e == "node.status" and p["node_id"] == echo and p["status"] == "running"]
        self.assertEqual(running[0]["started_at"], state["started_at"])   # live clock starts at the real start

    def test_stats_follow_stored_runs(self):
        env, _ = make_env()
        flow, _ = build(env)
        self.assertEqual(T.stats(env)["nodes"], [])
        R.run_sync(env, flow["id"], timeout_s=10)
        R.run_sync(env, flow["id"], timeout_s=10, fresh=True)
        first = {e["type"]: e for e in T.stats(env)["nodes"]}
        self.assertEqual(first["tool:echo"]["n"], 2)
        self.assertEqual(first["input.text"]["n"], 2)
        R.run_sync(env, flow["id"], timeout_s=10)                     # cached: no new real duration
        self.assertEqual({e["type"]: e for e in T.stats(env)["nodes"]}["tool:echo"]["n"], 2)
        time.sleep(0.02)
        R.run_sync(env, flow["id"], timeout_s=10, fresh=True)
        self.assertEqual({e["type"]: e for e in T.stats(env)["nodes"]}["tool:echo"]["n"], 3)

    def test_stats_drop_deleted_runs(self):
        env, _ = make_env()
        flow, _ = build(env)
        run = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertTrue(T.stats(env)["nodes"])
        S.delete_run(env, run["id"])
        self.assertEqual(T.stats(env)["nodes"], [])

    def test_rest_route(self):
        env, _ = make_env()
        flow, _ = build(env)
        R.run_sync(env, flow["id"], timeout_s=10)
        out = asyncio.run(A.handle("GET", "/timings", {}, {}, env))
        self.assertEqual(out, T.stats(env))
        self.assertIn("tool:echo", [e["type"] for e in out["types"]])


if __name__ == "__main__":
    unittest.main()
