"""Inter-process consent-lock regression, synthetic targets and no dispatcher."""
import asyncio
import multiprocessing
import os
import queue
import time
import unittest
import helpers

E = helpers.load_engine()


def revoke_from_child(data_dir, flow_id, started, result):
    """Run a public disable route in a clean subprocess sharing only scratch storage."""
    engine = helpers.load_engine()
    env = engine.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=data_dir)
    started.set()
    try:
        res = asyncio.run(engine.api.handle("POST", "flows/" + flow_id + "/messaging-optin", {},
                                            {"node_id": "n_000001", "enable": False}, env))
        result.put({"disabled": res["flow"]["nodes"][0]["params"]["send_enabled"] is False})
    except Exception as exc:
        result.put({"error": type(exc).__name__})


class MessagingProcessLockTest(unittest.TestCase):
    def test_process_holding_flow_lock_serializes_disable(self):
        """A completed revoke cannot pass another process's occupied consent lock."""
        temp = helpers.temp_data_dir()
        env = E.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=temp)
        flow = E.store.save_flow(env, E.graph.new_flow(), create=True)
        flow["nodes"] = [{"id": "n_000001", "type": "output.send_message", "x": 0, "y": 0,
                          "params": {"target": "signal:synthetic"}}]
        flow = E.store.save_flow(env, flow)
        asyncio.run(E.api.handle("POST", "flows/" + flow["id"] + "/messaging-optin", {},
                                 {"node_id": "n_000001", "enable": True}, env))
        started = multiprocessing.Event()
        result = multiprocessing.Queue()
        proc = multiprocessing.Process(target=revoke_from_child, args=(temp, flow["id"], started, result))
        try:
            # Exercise the proposed shared consent lock, not the old process-local lock.
            with E.store.flow_lock(env, flow["id"]):
                proc.start()
                self.assertTrue(started.wait(10), "child did not start")
                try:
                    early = result.get(timeout=1)
                except queue.Empty:
                    early = None
                self.assertIsNone(early, "child revoked while parent held the flow lock")
                self.assertTrue(E.store.get_flow(env, flow["id"])["nodes"][0]["params"]["send_enabled"])
            self.assertEqual(result.get(timeout=10), {"disabled": True})
            proc.join(10)
            self.assertEqual(proc.exitcode, 0)
        finally:
            if proc.is_alive():
                proc.terminate()
                proc.join(5)
