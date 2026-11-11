"""Inter-process consent-lock regression, synthetic targets and no dispatcher."""
import asyncio
import multiprocessing
import threading
import unittest
import helpers

E = helpers.load_engine()


def competing_update(data_dir, flow_id, entered, release, finished):
    """Enter the real store's read/modify/write critical section, then pause."""
    engine = helpers.load_engine()
    env = engine.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=data_dir)
    def mutate(flow):
        entered.set()
        if not release.wait(10):
            raise RuntimeError("coordination timeout")
        flow["name"] = "Synthetic concurrent edit"
    try:
        engine.store.modify_flow(env, flow_id, mutate)
        finished.put("saved")
    except Exception as exc:
        finished.put(type(exc).__name__)


def hold_and_exit(data_dir, flow_id, entered, release):
    """Let Windows release an acquired OS lock when this child is terminated."""
    engine = helpers.load_engine()
    env = engine.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=data_dir)
    with engine.store.flow_lock(env, flow_id, timeout_s=3):
        entered.set()
        release.wait(20)


class MessagingProcessConcurrentTest(unittest.TestCase):
    def test_lock_timeout_and_recovery_after_process_termination(self):
        temp = helpers.temp_data_dir()
        env = E.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=temp)
        flow = E.store.save_flow(env, E.graph.new_flow(), create=True)
        entered, release = multiprocessing.Event(), multiprocessing.Event()
        child = multiprocessing.Process(target=hold_and_exit, args=(temp, flow['id'], entered, release))
        try:
            child.start()
            self.assertTrue(entered.wait(10), 'child failed to lock')
            with self.assertRaises(TimeoutError):
                with E.store.flow_lock(env, flow['id'], timeout_s=.2):
                    self.fail('contended lock was incorrectly acquired')
            child.terminate()
            child.join(5)
            self.assertFalse(child.is_alive())
            with E.store.flow_lock(env, flow['id'], timeout_s=2):
                self.assertEqual(E.store.get_flow(env, flow['id'])['id'], flow['id'])
        finally:
            if child.is_alive():
                release.set()
                child.join(3)
            if child.is_alive():
                child.terminate()
                child.join(5)

    def test_reentrant_lock_and_distinct_env_instances(self):
        temp = helpers.temp_data_dir()
        first = E.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=temp)
        second = E.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=temp)
        flow = E.store.save_flow(first, E.graph.new_flow(), create=True)
        with E.store.flow_lock(first, flow['id'], timeout_s=2):
            with E.store.flow_lock(second, flow['id'], timeout_s=2):
                self.assertEqual(E.store.get_flow(second, flow['id'])['id'], flow['id'])

    def test_inflight_flow_mutation_serializes_disable_from_another_process(self):
        """A completed revoke must not be overwritten by a stale cooperating writer."""
        temp = helpers.temp_data_dir()
        env = E.env.Env(ctx=helpers.FakeCtx(), state={}, data_dir=temp)
        flow = E.store.save_flow(env, E.graph.new_flow(), create=True)
        flow["nodes"] = [{"id": "n_000001", "type": "output.send_message", "x": 0, "y": 0,
                          "params": {"target": "signal:synthetic"}}]
        flow = E.store.save_flow(env, flow)
        asyncio.run(E.api.handle("POST", "flows/" + flow["id"] + "/messaging-optin", {},
                                 {"node_id": "n_000001", "enable": True}, env))
        entered, release = multiprocessing.Event(), multiprocessing.Event()
        finished = multiprocessing.Queue()
        proc = multiprocessing.Process(target=competing_update, args=(temp, flow["id"], entered, release, finished))
        done = threading.Event()
        result = []
        def disable():
            try:
                response = asyncio.run(E.api.handle("POST", "flows/" + flow["id"] + "/messaging-optin", {},
                                                    {"node_id": "n_000001", "enable": False}, env))
                result.append(response["flow"]["nodes"][0]["params"]["send_enabled"])
            except Exception as exc:
                result.append(type(exc).__name__)
            finally:
                done.set()
        thread = None
        try:
            proc.start()
            self.assertTrue(entered.wait(10), "child never entered mutation")
            thread = threading.Thread(target=disable, daemon=True)
            thread.start()
            early = done.wait(1)
            release.set()
            self.assertEqual(finished.get(timeout=10), "saved")
            self.assertTrue(done.wait(10), "disable did not settle")
            self.assertFalse(early, "disable returned before an older writer released its critical section")
            self.assertEqual(result, [False])
            self.assertFalse(E.store.get_flow(env, flow["id"])["nodes"][0]["params"]["send_enabled"])
        finally:
            release.set()
            if thread is not None:
                thread.join(3)
            proc.join(3)
            if proc.is_alive():
                proc.terminate()
                proc.join(3)
