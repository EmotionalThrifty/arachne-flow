"""Synthetic attachment egress: explicit scope, secure paths and real host boundary.

No external tool, recipient, account, or paid provider is touched in these tests.
"""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import helpers
from test_messaging import E, api, armed, make_env, run, saved_flow


class AttachmentTest(unittest.TestCase):
    def fixture(self, response=None):
        env, calls = make_env(response)
        params = armed(env)
        path = Path(E.store.data_dir(env)) / 'outputs' / 'r_0123456789' / 'sample.mp4'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'\x00\x00\x00\x18ftypmp42synthetic video')
        return env, calls, params, E.media.make_media(str(path), kind='video')

    def enable_files(self, env):
        return api(env, 'f_0123456789', {'node_id': 'n_test', 'enable': True,
                                        'allow_attachments': True})['node']['params']

    def test_graph_requires_message_or_attachment_before_other_nodes_can_run(self):
        env, calls = make_env()
        flow = E.graph.new_flow()
        flow['nodes'] = [{'id': 'n_000001', 'type': 'output.send_message',
                          'x': 0, 'y': 0, 'params': {'target': 'signal:synthetic'}}]
        issues = E.graph.validate(flow, E.nodes.types_by_name(env))
        self.assertTrue(any(i.get('level') == 'error' and 'message or attachment' in i.get('message', '').lower()
                            for i in issues), issues)
        self.assertEqual(calls, [])

    def test_attachment_has_a_distinct_file_port_and_text_is_optional(self):
        ports = {p['name']: p for p in E.messaging.spec()['inputs']}
        self.assertIn('attachment', ports)
        self.assertEqual(ports['attachment']['type'], 'file')
        self.assertFalse(ports['attachment'].get('required', False))
        self.assertFalse(ports['message'].get('required', False))

    def test_legacy_text_authorization_never_authorizes_attachment(self):
        env, calls, params, media = self.fixture()
        with self.assertRaisesRegex(E.executors.NodeError, 'attachment|file'):
            run(env, params, {'message': 'test', 'attachment': media})
        self.assertEqual(calls, [])

    def test_explicit_attachment_authorization_sends_one_native_media_reference(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        result = run(env, params, {'attachment': media})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['target'], 'signal:+491234')
        self.assertIn('MEDIA:', calls[0]['message'])
        self.assertIn('sample.mp4', calls[0]['message'])
        self.assertIn('reported', result['text'].lower())

    def test_text_with_attachment_sends_both_in_single_call(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        run(env, params, {'message': 'synthetic caption', 'attachment': media})
        self.assertEqual(len(calls), 1)
        self.assertIn('synthetic caption', calls[0]['message'])
        self.assertIn('MEDIA:', calls[0]['message'])

    def test_generic_write_cannot_upgrade_text_consent_to_attachment(self):
        env, calls, params, media = self.fixture()
        flow = E.store.get_flow(env, 'f_0123456789')
        flow['nodes'][0]['params']['allow_attachments'] = True
        saved = E.store.save_flow(env, flow)
        self.assertFalse(E.messaging.token_matches(env, flow['id'], 'n_test', saved['nodes'][0]['params']))
        with self.assertRaises(E.executors.NodeError):
            run(env, saved['nodes'][0]['params'], {'message': 'test', 'attachment': media})
        self.assertEqual(calls, [])

    def test_attachment_consent_cannot_be_revived_after_optout_or_reenable(self):
        env, calls, _, media = self.fixture()
        old = self.enable_files(env)
        api(env, 'f_0123456789', {'node_id': 'n_test', 'enable': False})
        with self.assertRaises(E.executors.NodeError):
            run(env, old, {'message': 'test', 'attachment': media})
        self.enable_files(env)
        with self.assertRaises(E.executors.NodeError):
            run(env, old, {'message': 'test', 'attachment': media})
        self.assertEqual(calls, [])

    def test_raw_path_and_forged_external_media_are_not_sent(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as f:
            f.write(b'external')
            external = f.name
        self.addCleanup(lambda: os.path.exists(external) and os.unlink(external))
        for bad in (external, E.media.make_media(external), {'$media': {'path': ''}}):
            with self.subTest(kind=type(bad).__name__):
                with self.assertRaises(E.executors.NodeError):
                    run(env, params, {'message': 'test', 'attachment': bad})
        self.assertEqual(calls, [])

    def test_unrelated_run_artifact_under_shared_outputs_is_refused(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        other = Path(E.store.data_dir(env)) / 'outputs' / 'r_aaaaaaaaaa' / 'other.mp4'
        other.parent.mkdir(parents=True)
        other.write_bytes(b'not this flow')
        with self.assertRaisesRegex(E.executors.NodeError, 'current run|own run'):
            run(env, params, {'attachment': E.media.make_media(str(other), kind='video')})
        self.assertEqual(calls, [])

    def test_cross_drive_path_is_readable_node_error_not_uncaught_exception(self):
        from unittest import mock
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        with mock.patch.object(E.messaging.os.path, 'commonpath', side_effect=ValueError('different drives')):
            with self.assertRaises(E.executors.NodeError):
                run(env, params, {'attachment': media})
        self.assertEqual(calls, [])

    def test_symlinked_run_output_cannot_escape_approved_root(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        outside = Path(E.store.data_dir(env)) / 'outside.mp4'
        outside.write_bytes(b'synthetic')
        link = Path(media['$media']['path']).with_name('escape.mp4')
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            # Still exercise realpath containment when the OS refuses symlink creation.
            with mock.patch.object(E.messaging.os.path, 'realpath', side_effect=lambda p: str(outside) if str(p) == str(link) else os.path.abspath(p)):
                with self.assertRaises(E.executors.NodeError):
                    run(env, params, {'attachment': {'$media': {'path': str(link)}}})
        else:
            with self.assertRaises(E.executors.NodeError):
                run(env, params, {'attachment': E.media.make_media(str(link))})
        self.assertEqual(calls, [])

    def test_confidential_credential_filename_inside_outputs_is_refused(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        path = Path(media['$media']['path']).with_name('service-account.json')
        path.write_text('{"synthetic":true}', encoding='utf8')
        with self.assertRaises(E.executors.NodeError):
            run(env, params, {'attachment': E.media.make_media(str(path))})
        self.assertEqual(calls, [])

    def test_missing_or_symlink_escape_media_is_refused(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        Path(media['$media']['path']).unlink()
        with self.assertRaises(E.executors.NodeError):
            run(env, params, {'message': 'test', 'attachment': media})
        self.assertEqual(calls, [])

    def test_user_text_cannot_inject_media_directives(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        for text in ('MEDIA:C:/Users/synthetic/private.mp4', 'media:C:/Users/synthetic/private.mp4', 'caption [[as_document]]', '[[audio_as_voice]]'):
            with self.subTest(text=text):
                with self.assertRaises(E.executors.NodeError):
                    run(env, params, {'message': text, 'attachment': media})
        self.assertEqual(calls, [])

    def test_attachment_warning_or_omitted_media_is_not_delivery_success(self):
        receipts = [
            {'success': True, 'warnings': ['Some media files were skipped (not found on disk)']},
            {'success': True, 'media_dropped': [{'reason': 'denied'}]},
            {'success': True, 'media_delivered': False},
            {'success': True, 'partial_success': True},
        ]
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                env, calls, _, media = self.fixture(lambda _: json.dumps(receipt))
                params = self.enable_files(env)
                with self.assertRaisesRegex(E.executors.NodeError, 'unconfirmed|incomplete'):
                    run(env, params, {'message': 'test', 'attachment': media})
                self.assertEqual(len(calls), 1)

    def test_file_from_other_run_is_not_sent_via_file_node(self):
        env, calls, _, media = self.fixture()
        video = media['$media']['path']
        original = {'nodes': [
            {'id': 'n_000001', 'type': 'input.file', 'params': {'path': video}, 'x': 0, 'y': 0},
            {'id': 'n_000002', 'type': 'output.preview', 'params': {}, 'x': 250, 'y': 0},
            {'id': 'n_000003', 'type': 'output.send_message', 'params': {'target': 'signal:synthetic'}, 'x': 500, 'y': 0},
        ], 'edges': [
            {'id': 'e_000001', 'from': {'node': 'n_000001', 'port': 'file'}, 'to': {'node': 'n_000002', 'port': 'value'}},
            {'id': 'e_000002', 'from': {'node': 'n_000002', 'port': 'value'}, 'to': {'node': 'n_000003', 'port': 'attachment'}},
        ]}
        flow = E.graph.new_flow()
        flow.update(original)
        flow = E.store.save_flow(env, flow, create=True)
        flow = helpers.pick_file(E, env, flow, 'n_000001', video)   # even a file the user picked in the canvas
        enabled = api(env, flow['id'], {'node_id': 'n_000003', 'enable': True, 'allow_attachments': True})['flow']
        result = E.runner.run_sync(env, enabled['id'])
        self.assertEqual(result['status'], 'error', result)
        self.assertIn('current run', result['nodes']['n_000003']['error'])
        self.assertEqual(calls, [])

    def test_real_runner_sends_cached_video_without_paid_generation(self):
        import shutil
        env, calls, _, media = self.fixture()
        async def generated(env_arg, node, spec, inputs, context):
            generated = Path(context.out_dir) / 'generated.mp4'
            shutil.copyfile(media['$media']['path'], generated)
            return {'file': E.media.make_media(str(generated), kind='video')}
        flow = saved_flow(env, [
            {'id': 'n_000001', 'type': 'input.file', 'x': 0, 'y': 0, 'params': {'path': media['$media']['path']}},
            {'id': 'n_000002', 'type': 'output.preview', 'x': 250, 'y': 0, 'params': {}},
            {'id': 'n_000003', 'type': 'output.send_message', 'x': 500, 'y': 0, 'params': {'target': 'signal:synthetic'}},
        ])
        flow['edges'] = [
            {'id': 'e_000001', 'from': {'node': 'n_000001', 'port': 'file'}, 'to': {'node': 'n_000002', 'port': 'value'}},
            {'id': 'e_000002', 'from': {'node': 'n_000002', 'port': 'value'}, 'to': {'node': 'n_000003', 'port': 'attachment'}},
        ]
        flow = E.store.save_flow(env, flow)
        enabled = api(env, flow['id'], {'node_id': 'n_000003', 'enable': True, 'allow_attachments': True})['flow']
        with mock.patch.dict(E.executors.BUILTIN, {'input.file': generated}):
            first = E.runner.run_sync(env, enabled['id'])
            second = E.runner.run_sync(env, enabled['id'])
        self.assertEqual(first['status'], 'done', first.get('issues'))
        self.assertEqual(second['status'], 'done', second.get('issues'))
        self.assertEqual(second['nodes']['n_000001']['status'], 'cached')
        self.assertEqual(second['nodes']['n_000002']['status'], 'cached')
        self.assertEqual(len(calls), 2)
        self.assertTrue(all('MEDIA:' in c['message'] for c in calls))

    def test_real_runner_wires_file_to_attachment_without_coercing_to_url(self):
        env, calls, _, media = self.fixture()
        def success(args):
            calls.append(args)
            return json.dumps({'success': True, 'platform': 'signal'})
        env.ctx.tools['mcp__messaging__messages_send'] = success
        from unittest import mock
        import shutil
        async def generated_fixture(env_arg, node, spec, inputs, context):
            generated = Path(context.out_dir) / 'generated.mp4'
            shutil.copyfile(media['$media']['path'], generated)
            return {'file': E.media.make_media(str(generated), kind='video')}
        flow = saved_flow(env, [
            {'id': 'n_000001', 'type': 'input.file', 'x': 0, 'y': 0,
             'params': {'path': media['$media']['path']}},
            {'id': 'n_000002', 'type': 'output.preview', 'x': 250, 'y': 0, 'params': {}},
            {'id': 'n_000003', 'type': 'output.send_message', 'x': 500, 'y': 0,
             'params': {'target': 'signal:synthetic'}},
        ])
        flow['edges'] = [
            {'id': 'e_000001', 'from': {'node': 'n_000001', 'port': 'file'},
             'to': {'node': 'n_000002', 'port': 'value'}},
            {'id': 'e_000002', 'from': {'node': 'n_000002', 'port': 'value'},
             'to': {'node': 'n_000003', 'port': 'attachment'}},
        ]
        flow = E.store.save_flow(env, flow)
        enabled = api(env, flow['id'], {'node_id': 'n_000003', 'enable': True,
                                       'allow_attachments': True})['flow']
        with mock.patch.dict(E.executors.BUILTIN, {'input.file': generated_fixture}):
            result = E.runner.run_sync(env, enabled['id'])
        self.assertEqual(result['status'], 'done', result.get('issues') or result.get('error'))
        self.assertEqual(result['nodes']['n_000003']['status'], 'done')
        self.assertEqual(len(calls), 1)
        self.assertIn('MEDIA:', calls[0]['message'])

    def test_attachment_scope_does_not_survive_copy_or_template(self):
        env, calls, _, media = self.fixture()
        params = self.enable_files(env)
        flow = E.store.get_flow(env, 'f_0123456789')
        for copied in (E.graph.refresh_ids(flow), E.store.template_from_flow(flow)):
            p = copied['nodes'][0]['params']
            self.assertIsNot(p.get('send_enabled'), True)
            self.assertIsNot(p.get('allow_attachments'), True)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
