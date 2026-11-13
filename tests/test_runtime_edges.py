"""Block 3 runtime edge RED tests: EN-7, EN-8, EN-10, EN-12.

All provider-shaped payloads below are synthetic API-robustness fixtures. They do not claim that a
live provider emits these shapes; no network or paid execution is involved.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import threading
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N, X = E.runner, E.store, E.graph, E.nodes, E.executors
P = importlib.import_module(E.__name__ + ".presets")


def tool(name, props):
    return {"name": name, "toolset": "test", "parameters": {"type": "object", "properties": props}}


ECHO = tool("echo", {"text": {"type": "string"}})
LATER = tool("later", {"text": {"type": "string"}})
SLOW = tool("slow", {"text": {"type": "string"}})


class Ctx(helpers.FakeCtx):
    def __init__(self, handlers=None, config=None):
        super().__init__(handlers)
        self.config = dict(config or {})

    def get_config(self, key, default=None):
        return self.config.get(key, default)


def make_env(tool_specs, handlers=None, config=None):
    helpers.temp_data_dir()
    return E.env.Env(ctx=Ctx(handlers, config), state={"tool_source": lambda: tool_specs},
                     emit=lambda event, payload: None)


def build(env, ops, save=True):
    flow, results = G.apply_ops(G.new_flow("runtime edges"), ops, N.types_by_name(env))
    refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
    return (S.save_flow(env, flow, create=True) if save else flow), refs


def foreach_ops(value, body_types):
    ops = [
        {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": value}},
        {"op": "add_node", "ref": "each", "type": "logic.foreach"},
        {"op": "add_node", "ref": "echo", "type": body_types[0]},
        {"op": "add_node", "ref": "later", "type": body_types[1]},
        {"op": "add_node", "ref": "all", "type": "logic.collect"},
        {"op": "connect", "from": "src.text", "to": "each.list"},
        {"op": "connect", "from": "each.item", "to": "echo.text"},
        {"op": "connect", "from": "echo.text", "to": "later.text"},
        {"op": "connect", "from": "later.text", "to": "all.value"},
    ]
    return ops


class ForeachCancelEventTest(unittest.TestCase):
    """EN-7: a cancel Event stops `one()` without raising; finish_loop must still cancel incomplete body nodes."""

    def test_cancel_event_on_first_item_cancels_incomplete_body_nodes(self):
        env = make_env([ECHO, LATER])
        flow, refs = build(env, foreach_ops("a\nb\nc", ("tool:echo", "tool:later")), save=False)
        run, effective, types = R.prepare(env, flow, fresh=True)
        self.assertEqual(run["status"], "queued")
        handle = R.RunHandle(run=run)
        execution = R._Execution(env, effective, types, handle)
        echo_calls, later_calls = [], []
        real_execute = X.execute

        async def controlled_execute(env_arg, node, spec, inputs, nctx):
            kind = node.get("type")
            if kind == "tool:echo":
                echo_calls.append(inputs.get("text"))
                if len(echo_calls) == 1:
                    handle.cancel.set()          # the first executed item cancels; no task.cancel / CancelledError
                return {"text": "echo:" + str(inputs.get("text"))}
            if kind == "tool:later":
                later_calls.append(inputs.get("text"))
                return {"text": "later:" + str(inputs.get("text"))}
            return await real_execute(env_arg, node, spec, inputs, nctx)

        X.execute = controlled_execute
        self.addCleanup(setattr, X, "execute", real_execute)

        async def scenario():
            execution.slots = asyncio.Semaphore(1)
            await execution.run_node(refs["src"])          # real input.text value: 3 non-empty items
            await execution.run_foreach(refs["each"])

        asyncio.run(scenario())

        self.assertTrue(handle.cancel.is_set())
        self.assertEqual(handle.run["nodes"][refs["each"]]["count"], 3)
        self.assertEqual(echo_calls, ["a"])
        self.assertEqual(later_calls, [])

        echo = handle.run["nodes"][refs["echo"]]
        later = handle.run["nodes"][refs["later"]]
        self.assertEqual(echo["items"], {"total": 3, "done": 1, "cached": 0, "skipped": 0, "error": 0})
        self.assertEqual(later["items"], {"total": 3, "done": 0, "cached": 0, "skipped": 0, "error": 0})
        for name, state in (("echo", echo), ("later", later)):
            self.assertEqual(state["status"], "cancelled", (name, state))
            self.assertNotEqual(state.get("skip"), "branch", (name, state))
            self.assertNotIn(state["status"], ("done", "cached"), (name, state))

    def test_real_cancelled_error_and_normal_full_and_empty_guards(self):
        started, release, calls = threading.Event(), threading.Event(), []

        def slow(args):
            calls.append(args.get("text"))
            started.set()
            release.wait(5)
            return json.dumps({"text": "slow:" + str(args.get("text"))})

        env = make_env([SLOW], {"slow": slow}, {"max_parallel": 1})
        flow, refs = build(env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "a\nb\nc\nd\ne"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "slow", "type": "tool:slow"},
            {"op": "add_node", "ref": "all", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "slow.text"},
            {"op": "connect", "from": "slow.text", "to": "all.value"},
        ])
        handle = R.start_run(env, flow["id"], fresh=True)
        self.assertTrue(started.wait(5), "fake slow tool never started")
        self.assertTrue(R.cancel_run(env, handle.run["id"]))
        release.set()
        self.assertTrue(handle.done.wait(5), "cancelled run did not finish")
        res = handle.snapshot()
        self.assertEqual(res["status"], "cancelled")
        self.assertEqual(res["nodes"][refs["each"]]["status"], "cancelled")
        self.assertEqual(res["nodes"][refs["slow"]]["status"], "cancelled")
        self.assertNotEqual(res["nodes"][refs["all"]]["status"], "done")
        self.assertLess(res["nodes"][refs["slow"]]["items"]["done"], 5)

        def echo(args):
            return json.dumps({"text": "echo:" + str(args.get("text"))})

        normal = make_env([ECHO], {"echo": echo})
        nflow, nrefs = build(normal, foreach_ops("a\nb\nc", ("tool:echo", "tool:echo")))
        full = R.run_sync(normal, nflow["id"], timeout_s=15, fresh=True)
        self.assertEqual(full["status"], "done")
        self.assertEqual(full["nodes"][nrefs["all"]]["outputs"]["list"],
                         ["echo:echo:a", "echo:echo:b", "echo:echo:c"])
        self.assertEqual(full["nodes"][nrefs["echo"]]["items"]["done"], 3)
        self.assertEqual(full["nodes"][nrefs["later"]]["items"]["done"], 3)

        S.modify_flow(normal, nflow["id"], lambda f: next(n for n in f["nodes"] if n["id"] == nrefs["src"])
                      ["params"].update(value=""))
        empty = R.run_sync(normal, nflow["id"], timeout_s=15, fresh=True)
        self.assertEqual(empty["status"], "done")
        self.assertEqual(empty["nodes"][nrefs["echo"]]["status"], "skipped")
        self.assertEqual(empty["nodes"][nrefs["echo"]]["skip"], "branch")
        self.assertEqual(empty["nodes"][nrefs["all"]]["outputs"]["list"], [])


class PendingJobIdentifierTest(unittest.TestCase):
    """EN-8: synthetic pending envelopes without a poll-able runId/jobId must not count as a finished job."""

    def setUp(self):
        path = helpers.temp_data_dir()
        self.out = os.path.join(path, "out")
        os.makedirs(self.out)

    def job(self, handler):
        ctx = helpers.FakeCtx({"mcp__acme__acme_3d_generate": handler})
        env = E.env.Env(ctx=ctx, state={})
        nctx = X.NodeContext(run_id="run_test", node_id="n_test", out_dir=self.out, log=lambda msg: None)
        return ctx, env, nctx

    def test_pending_without_run_id_or_job_id_raises_node_error(self):
        payloads = [
            {"requestId": "req-test", "status": "PENDING"},
            {"structuredContent": {"status": {"requestId": "req-nested", "status": "PENDING"}}},
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                ctx, env, nctx = self.job(lambda args, payload=payload: json.dumps(payload))
                with self.assertRaises(X.NodeError) as caught:
                    asyncio.run(P._run_job(env, "mcp__acme__acme_3d_generate", {"prompt": "a robot"}, 5, nctx, "3D"))
                text = str(caught.exception).lower()
                self.assertTrue("pending" in text or "identifier" in text or "runid" in text, text)
                self.assertTrue("job" in text or "run" in text or "poll" in text, text)
                self.assertEqual(len(ctx.calls), 1)

    def test_finished_media_done_and_failed_job_guards(self):
        finished = {"status": "DONE", "urls": ["https://example.invalid/model.glb"],
                    "requestId": "req-finished"}
        ctx, env, nctx = self.job(lambda args: json.dumps(finished))
        result = asyncio.run(P._run_job(env, "mcp__acme__acme_3d_generate", {"prompt": "a robot"}, 5, nctx, "3D"))
        self.assertEqual(result, finished)
        self.assertEqual(len(ctx.calls), 1)

        presets_interval = P.POLL_INTERVAL_S
        P.POLL_INTERVAL_S = 0.01
        self.addCleanup(setattr, P, "POLL_INTERVAL_S", presets_interval)
        done = {"structuredContent": {"status": "COMPLETED", "urls": ["https://example.invalid/video.mp4"]}}
        replies = iter([{"status": "PENDING", "runId": "run-abc", "modelSlug": "model-x"}, done])
        ctx, env, nctx = self.job(lambda args: json.dumps(next(replies)))
        result = asyncio.run(P._run_job(env, "mcp__acme__acme_3d_generate", {"prompt": "a robot"}, 5, nctx, "Video"))
        self.assertEqual(result, done)
        self.assertEqual(ctx.calls[0][1]["operation"], "submit_and_poll")
        self.assertEqual(ctx.calls[1][1], {"operation": "poll", "runId": "run-abc", "modelSlug": "model-x"})

        ctx, env, nctx = self.job(lambda args: json.dumps(
            {"status": "FAILED", "runId": "run-bad", "error": {"message": "synthetic provider failure"}}))
        with self.assertRaisesRegex(X.NodeError, "synthetic provider failure"):
            asyncio.run(P._run_job(env, "mcp__acme__acme_3d_generate", {"prompt": "a robot"}, 5, nctx, "3D"))


class StartupSweepInterleavingTest(unittest.TestCase):
    """EN-10: a run that becomes active during the sweep snapshot must stay queued/running on disk."""

    def test_new_active_run_of_the_same_boot_is_not_interrupted(self):
        helpers.temp_data_dir()
        env = E.env.Env(state={})
        types = N.types_by_name(env)
        flow, _ = G.apply_ops(G.new_flow("sweep"), [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "x"}},
        ], types)
        stale, _, _ = R.prepare(env, flow)
        new_run, _, _ = R.prepare(env, flow)
        self.assertEqual({stale["status"], new_run["status"]}, {"queued"})
        self.assertEqual(stale["owner"]["boot"], R.boot_token(env))
        self.assertEqual(new_run["owner"]["boot"], R.boot_token(env))
        S.save_run(env, stale)
        S.save_run(env, new_run)
        stale_path = S._run_path(env, stale["flow_id"], stale["id"])
        new_path = S._run_path(env, new_run["flow_id"], new_run["id"])
        seen = {}
        real_iter = S._iter_runs

        def interleaved(env_arg, flow_id=None):
            seen["snapshot"] = set(R._active(env_arg))
            yield stale, stale_path
            handle = R.RunHandle(run=new_run)     # real handle, queued run already on disk
            R._active(env_arg)[new_run["id"]] = handle
            seen["after"] = set(R._active(env_arg))
            yield new_run, new_path

        S._iter_runs = interleaved
        self.addCleanup(setattr, S, "_iter_runs", real_iter)

        R.ensure_startup(env)

        self.assertNotIn(new_run["id"], seen["snapshot"])
        self.assertIn(new_run["id"], seen["after"])
        self.assertIn(new_run["id"], R._active(env))
        new_disk = S.load_run(env, new_run["id"])
        self.assertEqual(new_disk["status"], "queued", new_disk)
        self.assertIsNone(new_disk.get("error"), new_disk)
        stale_disk = S.load_run(env, stale["id"])
        self.assertEqual(stale_disk["status"], "error", stale_disk)
        self.assertEqual(stale_disk["error"], "interrupted")


class SecondCollectDiagnosisTest(unittest.TestCase):
    """EN-12: a second Collect behind a first Collect needs its own diagnosis, not 'needs a For each'."""

    def setUp(self):
        self.env = make_env([ECHO])
        self.types = N.types_by_name(self.env)

    def messages(self, flow, ref):
        return [i["message"] for i in G.validate(flow, self.types)
                if i.get("level") == "error" and i.get("node") == ref]

    def test_second_collect_reports_collected_values_not_missing_foreach(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "a\nb"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach"},
            {"op": "add_node", "ref": "echo", "type": "tool:echo"},
            {"op": "add_node", "ref": "collect1", "type": "logic.collect"},
            {"op": "add_node", "ref": "collect2", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "echo.text"},
            {"op": "connect", "from": "echo.text", "to": "collect1.value"},
            {"op": "connect", "from": "collect1.list", "to": "collect2.value"},
        ], save=False)
        msgs = self.messages(flow, refs["collect2"])
        self.assertTrue(msgs, "no diagnosis for the second Collect")
        joined = " ".join(msgs).lower()
        self.assertNotIn("needs a for each", joined, msgs)
        specific = ("already", "outside", "per-item", "collected", "downstream")
        self.assertTrue(any(word in joined for word in specific), msgs)

    def test_true_collect_without_foreach_keeps_its_original_diagnosis(self):
        flow, refs = build(self.env, [
            {"op": "add_node", "ref": "src", "type": "input.text", "params": {"value": "x"}},
            {"op": "add_node", "ref": "collect", "type": "logic.collect"},
            {"op": "connect", "from": "src.text", "to": "collect.value"},
        ], save=False)
        self.assertIn("Collect needs a For each before it", self.messages(flow, refs["collect"]))


if __name__ == "__main__":
    unittest.main()
