"""Offline egress regressions: persisted consent and receipts, never real messaging."""
import asyncio
import copy
import json
import os
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
import helpers
from test_messaging import E, make_env, saved_flow, api


def enabled_flow(env, timeout=1):
    e = E
    flow = saved_flow(env, [{"id": "n_000001", "type": "output.send_message", "x": 0, "y": 0,
                            "params": {"target": "signal:synthetic", "message": "Synthetic", "timeout_s": timeout}}])
    return api(env, flow['id'], {"node_id": "n_000001", "enable": True})['flow']


def execute(env, flow):
    e = E
    node = flow['nodes'][0]
    ctx = e.executors.NodeContext('r_test', node['id'], 'unused', flow_id=flow['id'], log=lambda _: None)
    return e.executors.execute(env, node, e.messaging.spec(), {'message': 'Synthetic'}, ctx)


class MessagingLifecycleTest(unittest.TestCase):
    def test_delete_restore_clears_consent_on_disk_and_rejects_old_snapshot(self):
        e = E
        env, calls = make_env()
        old = enabled_flow(env)
        e.store.delete_flow(env, old['id'])
        with self.assertRaisesRegex(e.executors.NodeError, 'authoriz|consent|enabled'):
            asyncio.run(execute(env, old))
        restored = e.store.restore_flow(env, old['id'])
        disk = e.store.read_json(e.store._flow_path(env, old['id']))
        for view in (restored, disk):
            params = view['nodes'][0]['params']
            self.assertIs(params.get('send_enabled'), False)
            self.assertNotIn('optin_token', params)
            self.assertNotIn('authorized_target', params)
        api(env, old['id'], {'node_id': 'n_000001', 'enable': True})
        with self.assertRaisesRegex(e.executors.NodeError, 'authoriz|consent|enabled'):
            asyncio.run(execute(env, old))
        self.assertEqual(calls, [])

    def test_node_removed_or_retyped_cannot_use_old_authorization(self):
        e = E
        for change in ('remove', 'retype'):
            with self.subTest(change=change):
                env, calls = make_env()
                old = enabled_flow(env)
                def edit(flow):
                    if change == 'remove':
                        flow['nodes'] = []
                    else:
                        flow['nodes'][0]['type'] = 'input.text'
                e.store.modify_flow(env, old['id'], edit)
                with self.assertRaisesRegex(e.executors.NodeError, 'authoriz|consent|enabled'):
                    asyncio.run(execute(env, old))
                self.assertEqual(calls, [])

    def test_retyping_away_and_back_does_not_restore_old_consent(self):
        e = E
        env, calls = make_env()
        old = enabled_flow(env)
        changed = copy.deepcopy(old)
        changed['nodes'][0]['type'] = 'input.text'
        e.store.save_flow(env, changed)
        restored = e.store.save_flow(env, old)
        self.assertIs(restored['nodes'][0]['params'].get('send_enabled'), False)
        self.assertNotIn('optin_token', restored['nodes'][0]['params'])
        with self.assertRaisesRegex(e.executors.NodeError, 'authoriz|consent|sending|enabled'):
            asyncio.run(execute(env, old))
        self.assertEqual(calls, [])

    def test_receipt_success_cannot_mask_sibling_failure_or_ambiguous_shapes(self):
        e = E
        receipts = [
            {'success': True, 'structuredContent': {'success': False, 'error': 'sibling failure'}},
            {'result': {'success': True}, 'content': [{'type': 'text', 'text': json.dumps({'isError': True})}]},
            {'success': True, 'result': {'skipped': True}},
            {'success': True, 'result': {'delivery_unconfirmed': 'synthetic'}},
            {'success': True, 'status': 'pending_approval'},
            {'success': True, 'status': 'sending'},
            {'success': True, 'status': 'in_progress'},
            {'success': True, 'status': 'unknown_provider_state'},
            {'success': True, 'result': '{broken'},
            {'success': 'true'}, {'success': 1},
        ]
        hidden = {'success': False, 'error': 'too deep'}
        for _ in range(12):
            hidden = {'result': hidden}
        receipts.append({'success': True, 'structuredContent': hidden})
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                env, calls = make_env(lambda _: json.dumps(receipt))
                flow = enabled_flow(env)
                with self.assertRaises(e.executors.NodeError):
                    asyncio.run(execute(env, flow))
                self.assertEqual(len(calls), 1)

    def test_host_nodeerror_is_unconfirmed_and_never_retried(self):
        def broken_host(_):
            raise E.executors.NodeError('synthetic transport exception')
        env, calls = make_env(broken_host)
        flow = enabled_flow(env)
        with self.assertRaisesRegex(E.executors.NodeError, 'unconfirmed.*Do not re-run'):
            asyncio.run(execute(env, flow))
        self.assertEqual(len(calls), 1)

    def test_confirmed_mcp_envelopes_and_extra_provider_fields_still_work(self):
        receipts = [
            {'success': True, 'provider_metadata': {'opaque': 1}},
            {'success': True, 'status': 'Sent'},
            {'result': json.dumps({'success': True, 'chunks': 1})},
            {'structuredContent': {'result': json.dumps({'success': True})}},
            {'content': [{'type': 'text', 'text': json.dumps({'success': True})}]},
        ]
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                env, calls = make_env(lambda _: json.dumps(receipt))
                result = asyncio.run(execute(env, enabled_flow(env)))
                self.assertIn('reported', result['text'].lower())
                self.assertEqual(len(calls), 1)

    def test_cancelled_queued_worker_never_dispatches_after_lock_is_released(self):
        e = E
        env, calls = make_env()
        flow = enabled_flow(env, timeout=1)
        held, release, done = threading.Event(), threading.Event(), threading.Event()
        def hold():
            with e.store.flow_lock(env, flow['id']):
                held.set()
                release.wait(3)
            done.set()
        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        self.assertTrue(held.wait(2))
        async def scenario():
            task = asyncio.create_task(execute(env, flow))
            await asyncio.sleep(.03)
            task.cancel()
            try:
                with self.assertRaises(asyncio.CancelledError):
                    await task
            finally:
                release.set()
            await asyncio.sleep(.1)
        try:
            asyncio.run(scenario())
        finally:
            release.set()
            thread.join(3)
        self.assertTrue(done.is_set())
        self.assertEqual(calls, [])

    def test_corrupt_existing_secret_is_not_silently_replaced(self):
        e = E
        env, _ = make_env()
        path = os.path.join(e.store.data_dir(env), 'messaging-secret')
        with open(path, 'wb') as fh:
            fh.write(b'broken')
        with self.assertRaises((OSError, ValueError)):
            e.messaging.optin_token(env, 'f_0123456789', 'n_000001', 'signal:synthetic')
        with open(path, 'rb') as fh:
            self.assertEqual(fh.read(), b'broken')

    def test_concurrent_first_secret_creation_produces_verifiable_tokens(self):
        e = E
        env, _ = make_env()
        barrier = threading.Barrier(6)
        real_random = e.messaging.secrets.token_bytes
        def synchronized_random(size):
            value = real_random(size)
            if size == 32:
                barrier.wait(timeout=5)
            return value
        def mint(index):
            node = 'n_%06d' % index
            return node, e.messaging.optin_token(env, 'f_0123456789', node, 'signal:synthetic')
        with mock.patch.object(e.messaging.secrets, 'token_bytes', synchronized_random):
            with ThreadPoolExecutor(max_workers=6) as pool:
                results = list(pool.map(mint, range(6)))
        for node, token in results:
            self.assertTrue(e.messaging.token_matches(env, 'f_0123456789', node,
                            {'target': 'signal:synthetic', 'authorized_target': 'signal:synthetic',
                             'send_enabled': True, 'optin_token': token}))

    def test_optout_wait_does_not_block_the_api_event_loop(self):
        e = E
        env, _ = make_env()
        flow = enabled_flow(env)
        entered, release = threading.Event(), threading.Event()
        def hold():
            with e.store.flow_lock(env, flow['id']):
                entered.set()
                release.wait(1.5)
        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        self.assertTrue(entered.wait(2))
        async def scenario():
            task = asyncio.create_task(e.api.handle('POST', 'flows/' + flow['id'] + '/messaging-optin', {},
                                      {'node_id': 'n_000001', 'enable': False}, env))
            began = time.monotonic()
            try:
                await asyncio.sleep(.03)
                self.assertLess(time.monotonic() - began, .5, 'opt-out blocked the API event loop')
            finally:
                release.set()
                await task
        try:
            asyncio.run(scenario())
        finally:
            release.set()
            thread.join(3)

    def test_contended_mutation_timeout_is_a_readable_conflict(self):
        e = E
        env, _ = make_env()
        flow = enabled_flow(env)
        with mock.patch.object(e.api.S, 'modify_flow', side_effect=TimeoutError('synthetic contention')):
            with self.assertRaises(e.api.HTTPException) as caught:
                api(env, flow['id'], {'node_id': 'n_000001', 'enable': False})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail['code'], 'flow_busy')

    def test_hot_reload_reuses_shared_state_lock_without_self_deadlock(self):
        e = E
        env, _ = make_env()
        flow = enabled_flow(env)
        original = sys.modules[e.store.__name__]
        try:
            with e.store.flow_lock(env, flow['id'], timeout_s=1):
                reloaded = helpers.load_module('engine/store.py', e.store.__name__)
                with reloaded.flow_lock(env, flow['id'], timeout_s=.15):
                    self.assertEqual(reloaded.get_flow(env, flow['id'])['id'], flow['id'])
        finally:
            sys.modules[e.store.__name__] = original
