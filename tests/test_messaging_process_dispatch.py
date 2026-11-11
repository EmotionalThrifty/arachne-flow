"""An actual send executor and opt-out serialize across OS processes (synthetic host)."""
import asyncio
import json
import multiprocessing
import threading
import unittest
import helpers
from test_messaging import E, make_env, api
from test_messaging_lifecycle import enabled_flow, execute


def dispatch_in_child(data_dir, flow, started, release, output):
    def fake_host(_):
        started.set()
        if not release.wait(8):
            raise RuntimeError('synthetic coordination timeout')
        return json.dumps({'success': True})
    env, calls = make_env(fake_host)
    env.data_dir = data_dir
    try:
        asyncio.run(execute(env, flow))
        output.put(('reported', len(calls)))
    except Exception as exc:
        output.put((type(exc).__name__, len(calls)))


class MessagingDispatchProcessTest(unittest.TestCase):
    def test_completed_revoke_cannot_overtake_an_inflight_host_call(self):
        env, calls = make_env()
        flow = enabled_flow(env, timeout=5)
        started, release = multiprocessing.Event(), multiprocessing.Event()
        output = multiprocessing.Queue()
        child = multiprocessing.Process(target=dispatch_in_child,
                args=(env.data_dir, flow, started, release, output))
        done = threading.Event()
        errors = []
        def revoke():
            try:
                api(env, flow['id'], {'node_id': 'n_000001', 'enable': False})
            except Exception as exc:
                errors.append(type(exc).__name__)
            finally:
                done.set()
        thread = None
        try:
            child.start()
            self.assertTrue(started.wait(8), 'fake host not called')
            thread = threading.Thread(target=revoke, daemon=True)
            thread.start()
            returned_early = done.wait(.2)
            release.set()
            self.assertEqual(output.get(timeout=8), ('reported', 1))
            self.assertTrue(done.wait(8), 'revoke failed to settle')
            self.assertFalse(returned_early, 'revocation returned while older host call was still in flight')
            self.assertEqual(errors, [])
            e = E
            with self.assertRaisesRegex(e.executors.NodeError, 'authoriz|consent|enabled'):
                asyncio.run(execute(env, flow))
            self.assertEqual(calls, [])
            child.join(5)
            self.assertEqual(child.exitcode, 0)
        finally:
            release.set()
            if thread is not None:
                thread.join(3)
            child.join(3)
            if child.is_alive():
                child.terminate()
                child.join(3)
