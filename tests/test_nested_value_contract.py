import asyncio
import copy
import json
import os
import shutil
import unittest
import helpers
from fastapi import HTTPException


class TestNestedLargeExpansion(unittest.TestCase):
    def setUp(self):
        self.orig_data_dir = os.environ.get('FLOWCANVAS_DATA_DIR')
        self.temp_dir = helpers.temp_data_dir()
        if not self.temp_dir or not isinstance(self.temp_dir, str):
            self.temp_dir = os.environ.get('FLOWCANVAS_DATA_DIR')
        self.E = helpers.load_engine()
        self.A, self.R, self.S = self.E.api, self.E.runner, self.E.store
        self.env = self.E.env.Env(ctx=helpers.FakeCtx(), state={}, emit=lambda event, payload: None)
        self.RUN = 'r_aaaaaaaaaa'
        self.FLOW = 'f_0123456789'
        self.NODE = 'n_value01'

    def tearDown(self):
        if self.temp_dir and os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)
        if self.orig_data_dir is not None:
            os.environ['FLOWCANVAS_DATA_DIR'] = self.orig_data_dir
        else:
            os.environ.pop('FLOWCANVAS_DATA_DIR', None)

    def _page_and_reconstruct(self, run_id, node_id, port, limit=65536):
        offset = 0
        chunks = []
        calls = 0
        outputs_dir = self.S.outputs_dir(self.env, run_id)

        while True:
            calls += 1
            self.assertLessEqual(calls, 10, "Pagination exceeded 10 calls limit")
            res = asyncio.run(
                self.A.handle(
                    'GET',
                    f'runs/{run_id}/value',
                    {'node': node_id, 'port': port, 'offset': offset, 'limit': limit},
                    {},
                    self.env
                )
            )

            res_str = json.dumps(res)
            self.assertNotIn('$large', res_str, f"Response contains $large on page {calls}")
            if self.temp_dir:
                self.assertNotIn(self.temp_dir, res_str, f"Response leaks temp_dir on page {calls}")
            if outputs_dir:
                self.assertNotIn(outputs_dir, res_str, f"Response leaks outputs_dir on page {calls}")

            self.assertEqual(res.get('kind'), 'json', f"Expected kind 'json', got {res.get('kind')}")
            self.assertEqual(res.get('offset'), offset, f"Expected contiguous offset {offset}, got {res.get('offset')}")

            total_chars = res.get('total_chars')
            self.assertIsInstance(total_chars, int, "total_chars must be an integer")
            if calls == 1:
                first_total_chars = total_chars
            else:
                self.assertEqual(total_chars, first_total_chars, "total_chars must be consistent across pages")

            self.assertIn('chunk', res, "API response must contain 'chunk'")
            chunk = res['chunk']
            self.assertIsInstance(chunk, str, "chunk must be a string")
            self.assertGreater(len(chunk), 0, "Pagination must make progress")
            chunks.append(chunk)

            accumulated_len = sum(len(c) for c in chunks)
            next_offset = res.get('next_offset')
            if next_offset is not None:
                self.assertEqual(next_offset, offset + len(chunk), "next_offset must be contiguous with offset + chunk length")
                self.assertGreater(next_offset, offset, "Pagination must make progress")
                self.assertLess(accumulated_len, total_chars, "next_offset must be null when accumulated length equals total_chars")
                offset = next_offset
            else:
                self.assertEqual(accumulated_len, total_chars, "next_offset must be null only when accumulated length equals total_chars")
                break

        reconstructed_text = "".join(chunks)
        self.assertEqual(len(reconstructed_text), total_chars, "Reconstructed text length does not match total_chars")
        return json.loads(reconstructed_text), calls

    def test_01_nested_structure_expands_spilled_text_and_json(self):
        spill_text = "Unicode \u2603 \U0001f600\nLine 2\nLine 3\n" + ("A" * 70000)
        spill_json = {
            "null_val": None,
            "bool_val": False,
            "zero_val": 0,
            "unicode_str": "Nested \u2764\nNewline",
            "padding": "B" * 70000
        }

        marker_text = self.R.record_value(self.env, spill_text, self.RUN, self.NODE, 'p_text')
        marker_json = self.R.record_value(self.env, spill_json, self.RUN, self.NODE, 'p_json')

        self.assertIn('$large', marker_text)
        self.assertIn('$large', marker_json)

        nested_output = {
            "text_field": marker_text,
            "list_field": [
                marker_json,
                {
                    "inline_null": None,
                    "inline_false": False,
                    "inline_zero": 0,
                    "inline_unicode": "Literal \u2603\n"
                }
            ]
        }
        expected_expanded = {
            "text_field": spill_text,
            "list_field": [
                spill_json,
                {
                    "inline_null": None,
                    "inline_false": False,
                    "inline_zero": 0,
                    "inline_unicode": "Literal \u2603\n"
                }
            ]
        }

        run = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {self.NODE: {'status': 'done', 'outputs': {'out': nested_output}}}
        }
        self.S.save_run(self.env, run)

        parsed, calls = self._page_and_reconstruct(self.RUN, self.NODE, 'out')
        self.assertGreater(calls, 1, "Expected pagination to require more than 1 page")
        self.assertEqual(parsed, expected_expanded)

    def test_02_json_spill_file_contains_embedded_marker(self):
        inner_val = "Inner spilled content \u2764\n" + ("X" * 70000)
        inner_marker = self.R.record_value(self.env, inner_val, self.RUN, self.NODE, 'p_inner')
        self.assertIn('$large', inner_marker)

        out_dir = self.S.outputs_dir(self.env, self.RUN)
        outer_filename = f"{self.NODE}_embedded.json"
        outer_filepath = os.path.join(out_dir, outer_filename)

        outer_payload = {
            "embedded": inner_marker,
            "flag": False,
            "count": 0,
            "empty": None,
            "uni": "Outer \u2603\n"
        }
        outer_json_str = json.dumps(outer_payload)
        with open(outer_filepath, 'w', encoding='utf-8', newline='') as f:
            f.write(outer_json_str)

        inner_large = inner_marker['$large']
        outer_large = dict(inner_large)
        outer_large['file'] = outer_filename
        if 'path' in inner_large:
            p_dir = os.path.dirname(inner_large['path'])
            outer_large['path'] = os.path.join(p_dir, outer_filename) if p_dir else outer_filename
        outer_large['chars'] = len(outer_json_str)
        outer_large['preview'] = outer_json_str[:120]
        outer_marker = {'$large': outer_large}

        run = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {self.NODE: {'status': 'done', 'outputs': {'out': outer_marker}}}
        }
        self.S.save_run(self.env, run)

        parsed, _ = self._page_and_reconstruct(self.RUN, self.NODE, 'out')
        expected = {
            "embedded": inner_val,
            "flag": False,
            "count": 0,
            "empty": None,
            "uni": "Outer \u2603\n"
        }
        self.assertEqual(parsed, expected)

    def test_03_conflicting_chars_metadata_refuses_409_no_leak(self):
        spill_val = "Identical file content " + ("M" * 70000)
        marker1 = self.R.record_value(self.env, spill_val, self.RUN, self.NODE, 'p_cache')
        self.assertIn('$large', marker1)

        marker2 = copy.deepcopy(marker1)
        marker2['$large']['chars'] = marker1['$large']['chars'] + 9999

        outputs = {'out': {'first': marker1, 'second': marker2}}
        run = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
        }
        self.S.save_run(self.env, run)

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                self.A.handle(
                    'GET',
                    f'runs/{self.RUN}/value',
                    {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                    {},
                    self.env
                )
            )

        self.assertEqual(ctx.exception.status_code, 409)
        detail = str(ctx.exception.detail)
        if self.temp_dir:
            self.assertNotIn(self.temp_dir, detail)
        if 'file' in marker1['$large']:
            self.assertNotIn(str(marker1['$large']['file']), detail)
        if 'path' in marker1['$large']:
            self.assertNotIn(str(marker1['$large']['path']), detail)

    def test_04_cross_run_marker_fails_4xx_no_leak(self):
        RUN_B = 'r_bbbbbbbbbb'
        secret_content = "SECRET_PAYLOAD_RUN_B_" + ("S" * 70000)
        marker_b = self.R.record_value(self.env, secret_content, RUN_B, self.NODE, 'p_cross')
        self.assertIn('$large', marker_b)

        outputs = {'out': {'cross_run': marker_b}}
        run_a = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
        }
        self.S.save_run(self.env, run_a)

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                self.A.handle(
                    'GET',
                    f'runs/{self.RUN}/value',
                    {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                    {},
                    self.env
                )
            )

        self.assertTrue(400 <= ctx.exception.status_code < 500, f"Expected 4xx status, got {ctx.exception.status_code}")
        detail = str(ctx.exception.detail)
        if self.temp_dir:
            self.assertNotIn(self.temp_dir, detail)
        self.assertNotIn("SECRET_PAYLOAD_RUN_B_", detail)
        if 'file' in marker_b['$large']:
            self.assertNotIn(str(marker_b['$large']['file']), detail)
        if 'path' in marker_b['$large']:
            self.assertNotIn(str(marker_b['$large']['path']), detail)

    def test_05_missing_file_and_invalid_json_corrupt_chars_return_4xx(self):
        out_dir = self.S.outputs_dir(self.env, self.RUN)

        with self.subTest(case="missing_file"):
            missing_fname = f"{self.NODE}_nonexistent.json"
            missing_marker = {
                '$large': {
                    'file': missing_fname,
                    'path': os.path.join(out_dir, missing_fname),
                    'chars': 1500,
                    'preview': 'missing preview'
                }
            }
            outputs = {'out': {'item': missing_marker}}
            run = {
                'id': self.RUN,
                'flow_id': self.FLOW,
                'status': 'done',
                'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
            }
            self.S.save_run(self.env, run)

            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(
                    self.A.handle(
                        'GET',
                        f'runs/{self.RUN}/value',
                        {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                        {},
                        self.env
                    )
                )

            self.assertEqual(ctx.exception.status_code, 404, f"Expected 404 for missing file, got {ctx.exception.status_code}")
            detail = str(ctx.exception.detail)
            if self.temp_dir:
                self.assertNotIn(self.temp_dir, detail)
            self.assertNotIn(missing_fname, detail)

        with self.subTest(case="invalid_json"):
            invalid_fname = f"{self.NODE}_invalid.json"
            invalid_path = os.path.join(out_dir, invalid_fname)
            invalid_content = "{\"malformed\": [true, null, "
            with open(invalid_path, 'w', encoding='utf-8', newline='') as f:
                f.write(invalid_content)

            invalid_marker = {
                '$large': {
                    'file': invalid_fname,
                    'path': invalid_path,
                    'chars': len(invalid_content),
                    'preview': invalid_content[:20]
                }
            }
            outputs = {'out': {'item': invalid_marker}}
            run = {
                'id': self.RUN,
                'flow_id': self.FLOW,
                'status': 'done',
                'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
            }
            self.S.save_run(self.env, run)

            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(
                    self.A.handle(
                        'GET',
                        f'runs/{self.RUN}/value',
                        {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                        {},
                        self.env
                    )
                )

            self.assertEqual(ctx.exception.status_code, 422, f"Expected 422 for invalid json, got {ctx.exception.status_code}")
            detail = str(ctx.exception.detail)
            if self.temp_dir:
                self.assertNotIn(self.temp_dir, detail)
            self.assertNotIn(invalid_fname, detail)
            self.assertNotIn(invalid_content, detail)

        with self.subTest(case="corrupt_chars"):
            corrupt_fname = f"{self.NODE}_corrupt_chars.json"
            corrupt_path = os.path.join(out_dir, corrupt_fname)
            corrupt_content = json.dumps({"valid_data": True, "count": 10})
            with open(corrupt_path, 'w', encoding='utf-8', newline='') as f:
                f.write(corrupt_content)

            corrupt_marker = {
                '$large': {
                    'file': corrupt_fname,
                    'path': corrupt_path,
                    'chars': len(corrupt_content) + 500,
                    'preview': corrupt_content[:20]
                }
            }
            outputs = {'out': {'item': corrupt_marker}}
            run = {
                'id': self.RUN,
                'flow_id': self.FLOW,
                'status': 'done',
                'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
            }
            self.S.save_run(self.env, run)

            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(
                    self.A.handle(
                        'GET',
                        f'runs/{self.RUN}/value',
                        {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                        {},
                        self.env
                    )
                )

            self.assertEqual(ctx.exception.status_code, 409, f"Expected 409 for corrupt chars, got {ctx.exception.status_code}")
            detail = str(ctx.exception.detail)
            if self.temp_dir:
                self.assertNotIn(self.temp_dir, detail)
            self.assertNotIn(corrupt_fname, detail)

    def test_06_self_referential_marker_explicit_refusal_no_leak(self):
        out_dir = self.S.outputs_dir(self.env, self.RUN)
        cycle_fname = f"{self.NODE}_self_ref.json"
        cycle_path = os.path.join(out_dir, cycle_fname)

        marker_payload = {
            '$large': {
                'file': cycle_fname,
                'path': cycle_path
            }
        }
        with open(cycle_path, 'w', encoding='utf-8', newline='') as f:
            json.dump(marker_payload, f)

        outputs = {'out': marker_payload}
        run = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
        }
        self.S.save_run(self.env, run)

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                self.A.handle(
                    'GET',
                    f'runs/{self.RUN}/value',
                    {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                    {},
                    self.env
                )
            )

        self.assertIn(ctx.exception.status_code, (409, 422), f"Expected 409 or 422 refusal for cycle, got {ctx.exception.status_code}")
        detail = str(ctx.exception.detail)
        if self.temp_dir:
            self.assertNotIn(self.temp_dir, detail)
        self.assertNotIn(cycle_fname, detail)

    def test_07_aggregate_limit_exceeded_requires_413_or_4xx_no_leak(self):
        payload_chunk = "AggregateLimitPayloadChunk_" + ("T" * 70000)
        marker = self.R.record_value(self.env, payload_chunk, self.RUN, self.NODE, 'p_agg')
        self.assertIn('$large', marker)

        repeated_markers = [marker for _ in range(260)]

        outputs = {'out': repeated_markers}
        run = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {self.NODE: {'status': 'done', 'outputs': outputs}}
        }
        self.S.save_run(self.env, run)

        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                self.A.handle(
                    'GET',
                    f'runs/{self.RUN}/value',
                    {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                    {},
                    self.env
                )
            )

        self.assertTrue(
            ctx.exception.status_code == 413 or (400 <= ctx.exception.status_code < 500),
            f"Expected 413 or 4xx, got {ctx.exception.status_code}"
        )
        detail = str(ctx.exception.detail)
        if self.temp_dir:
            self.assertNotIn(self.temp_dir, detail)
        self.assertNotIn("AggregateLimitPayloadChunk_", detail)
        if 'file' in marker['$large']:
            self.assertNotIn(str(marker['$large']['file']), detail)
        if 'path' in marker['$large']:
            self.assertNotIn(str(marker['$large']['path']), detail)

    def _value_get(self, node_id, port, offset, limit=65536, consistent=False, version=None):
        params = {'node': node_id, 'port': port, 'offset': offset, 'limit': limit}
        if consistent:
            params['consistent'] = '1'
        if version is not None:
            params['version'] = version
        return asyncio.run(
            self.A.handle('GET', f'runs/{self.RUN}/value', params, {}, self.env)
        )

    def _seed_value_run(self, outputs_by_node):
        nodes = {}
        markers = {}
        for node_id, (port, value) in outputs_by_node.items():
            marker = self.R.record_value(self.env, value, self.RUN, node_id, port)
            markers[node_id] = marker
            nodes[node_id] = {'status': 'done', 'outputs': {port: marker}}
        run = {'id': self.RUN, 'flow_id': self.FLOW, 'status': 'done', 'nodes': nodes}
        self.S.save_run(self.env, run)
        return markers

    def _spill_path_of(self, marker):
        self.assertIsInstance(marker, dict, 'record_value must return a marker dict for large values')
        self.assertIn('$large', marker, 'value must be spilled to a $large file for this test')
        path = marker['$large']['path']
        if not os.path.isabs(path):
            path = os.path.join(self.S.outputs_dir(self.env, self.RUN), path)
        self.assertTrue(os.path.isfile(path), 'spill file must exist on disk')
        return path

    def _mutate_spill_same_length(self, path, old_char, new_char):
        with open(path, 'r', encoding='utf-8', newline='') as f:
            original = f.read()
        mutated = original.replace(old_char * 1000, new_char * 1000)
        self.assertNotEqual(mutated, original, 'fixture mutation must change the spill content')
        self.assertEqual(len(mutated), len(original), 'fixture mutation must preserve length')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(mutated)
        with open(path, 'r', encoding='utf-8', newline='') as f:
            self.assertEqual(f.read(), mutated, 'fixture mutation must be persisted')

    def _exc_text(self, exc):
        detail = getattr(exc, 'detail', None)
        parts = [str(exc), repr(exc), str(detail), repr(detail)]
        try:
            parts.append(json.dumps(detail, default=str))
        except (TypeError, ValueError):
            pass
        return ' '.join(parts)

    def _assert_no_leak(self, text, extra=(), where='response'):
        self.assertNotIn('$large', text, f'{where} leaks $large marker')
        needles = [self.temp_dir, self.S.outputs_dir(self.env, self.RUN)] + list(extra)
        for needle in needles:
            if isinstance(needle, os.PathLike):
                needle = os.fspath(needle)
            if not needle or not isinstance(needle, str):
                continue
            for variant in {needle, needle.replace('\\', '/'), json.dumps(needle)[1:-1]}:
                self.assertNotIn(variant, text, f'{where} leaks a filesystem path')

    def test_paging_mutation_must_not_silently_combine_two_historical_results(self):
        # Opt-in consistency protocol: the client carries the version token between
        # pages; the server must not be assumed to keep an implicit snapshot.
        val_a = 'A' * 70000
        markers = self._seed_value_run({self.NODE: ('out', val_a)})
        spill_path = self._spill_path_of(markers[self.NODE])

        res1 = self._value_get(self.NODE, 'out', 0, 65536, consistent=True)
        self._assert_no_leak(json.dumps(res1), (spill_path,), 'consistent page 1')
        self.assertEqual(res1.get('offset'), 0)
        self.assertIn('chunk', res1, 'First page must contain chunk')
        chunk1 = res1['chunk']
        self.assertIsInstance(chunk1, str)
        self.assertIn('A' * 100, chunk1)
        version = res1.get('version')
        self.assertIsInstance(version, str, 'consistent=1 response must include a version token')
        self.assertTrue(version, 'version token must be non-empty')
        next_offset = res1.get('next_offset')
        self.assertIsInstance(next_offset, int, 'First page must return next_offset')
        self.assertEqual(next_offset, len(chunk1), 'next_offset must equal offset + len(chunk)')

        self._mutate_spill_same_length(spill_path, 'A', 'B')

        with self.assertRaises(HTTPException) as ctx:
            self._value_get(self.NODE, 'out', next_offset, 65536, consistent=True, version=version)
        exc = ctx.exception
        self.assertEqual(exc.status_code, 409, f'Expected HTTP 409 conflict, got {exc.status_code}')
        exc_str = self._exc_text(exc)
        self._assert_no_leak(exc_str, (spill_path,), 'HTTPException')
        self.assertNotIn('A' * 10, exc_str, 'HTTPException leaks spill content A')
        self.assertNotIn('B' * 10, exc_str, 'HTTPException leaks spill content B')

    def test_consistent_paging_unicode_three_pages_returns_exact_original(self):
        pattern = 'abcdefghijklmno \u00e9\u00fc\u6f22\U0001F389'
        value = {'label': '\u00e9t\u00e9 \u6f22\u5b57 \U0001F389', 'text': pattern * 3500}
        self.assertEqual(len(value['text']), 70000)
        self._seed_value_run({self.NODE: ('out', value)})

        probe = self._value_get(self.NODE, 'out', 0)
        total = probe.get('total_chars')
        self.assertIsInstance(total, int, 'total_chars must be an integer')
        limit = -(-total // 3) + 16
        self.assertLess(2 * limit, total, 'fixture must require exactly 3 pages')
        self.assertLessEqual(limit, 65536, 'fixture limit must stay within the normal page size')

        offset = 0
        version = None
        chunks = []
        offsets = []
        for page in (1, 2, 3):
            res = self._value_get(self.NODE, 'out', offset, limit, consistent=True, version=version)
            self._assert_no_leak(json.dumps(res), where=f'consistent page {page}')
            self.assertEqual(res.get('kind'), 'json')
            self.assertEqual(res.get('offset'), offset, f'page {page} offset must be contiguous')
            self.assertEqual(res.get('total_chars'), total, 'total_chars must be stable across pages')
            chunk = res.get('chunk')
            self.assertIsInstance(chunk, str)
            self.assertGreater(len(chunk), 0, 'Pagination must make progress')
            self.assertLessEqual(len(chunk), limit, 'chunk must respect limit')
            if page == 1:
                version = res.get('version')
                self.assertIsInstance(version, str, 'consistent=1 response must include a version token')
                self.assertTrue(version, 'version token must be non-empty')
            elif 'version' in res:
                self.assertEqual(res['version'], version, 'version must be stable for unchanged content')
            offsets.append(offset)
            chunks.append(chunk)
            next_offset = res.get('next_offset')
            if page < 3:
                self.assertEqual(next_offset, offset + len(chunk), 'next_offset must equal offset + len(chunk)')
                offset = next_offset
            else:
                self.assertIsNone(next_offset, 'third page must be the last page')

        text = ''.join(chunks)
        self.assertEqual(len(text), total)
        self.assertEqual(offsets, [0, len(chunks[0]), len(chunks[0]) + len(chunks[1])])
        self.assertEqual(json.loads(text), value)
        self.assertEqual(text[:len(probe['chunk'])], probe['chunk'])

    def test_consistent_paging_nonzero_offset_without_version_returns_400(self):
        self._seed_value_run({self.NODE: ('out', 'C' * 70000)})
        first = self._value_get(self.NODE, 'out', 0, 65536, consistent=True)
        self.assertIsInstance(first.get('version'), str)
        self.assertTrue(first.get('version'))
        next_offset = first.get('next_offset')
        self.assertIsInstance(next_offset, int)
        self.assertGreater(next_offset, 0)
        for offset in (next_offset, 1):
            with self.subTest(offset=offset):
                with self.assertRaises(HTTPException) as ctx:
                    self._value_get(self.NODE, 'out', offset, 65536, consistent=True)
                self.assertEqual(ctx.exception.status_code, 400, f'Expected HTTP 400, got {ctx.exception.status_code}')
                exc_str = self._exc_text(ctx.exception)
                self._assert_no_leak(exc_str, where='HTTPException')
                self.assertNotIn('C' * 10, exc_str, 'HTTPException leaks content')

    def test_consistent_paging_rejects_malformed_or_incorrect_version(self):
        other_node = 'n_value02'
        self._seed_value_run({
            self.NODE: ('out', 'D' * 70000),
            other_node: ('out', 'E' * 70000),
        })
        first = self._value_get(self.NODE, 'out', 0, 65536, consistent=True)
        good = first.get('version')
        self.assertIsInstance(good, str)
        self.assertTrue(good)
        next_offset = first.get('next_offset')
        self.assertIsInstance(next_offset, int)
        self.assertGreater(next_offset, 0)
        other = self._value_get(other_node, 'out', 0, 65536, consistent=True).get('version')
        self.assertIsInstance(other, str)
        self.assertTrue(other)
        self.assertNotEqual(other, good, 'different values must not share a version token')

        flipped = ('1' if good[0] == '0' else '0') + good[1:]
        bad_versions = ['', 'not-a-valid-version', '!!!', '../../etc/passwd', good + '0', good[:-1], flipped, other, 'x' * 4096]
        for bad in bad_versions:
            with self.subTest(version=bad[:40]):
                with self.assertRaises(HTTPException) as ctx:
                    self._value_get(self.NODE, 'out', next_offset, 65536, consistent=True, version=bad)
                status = ctx.exception.status_code
                self.assertGreaterEqual(status, 400, f'Expected 4xx, got {status}')
                self.assertLess(status, 500, f'Expected 4xx, got {status}')
                exc_str = self._exc_text(ctx.exception)
                self._assert_no_leak(exc_str, where='HTTPException')
                self.assertNotIn('D' * 10, exc_str, 'HTTPException leaks content D')
                self.assertNotIn('E' * 10, exc_str, 'HTTPException leaks content E')

        res = self._value_get(self.NODE, 'out', next_offset, 65536, consistent=True, version=good)
        self.assertEqual(res.get('offset'), next_offset)
        chunk2 = res.get('chunk')
        self.assertIsInstance(chunk2, str)
        self.assertIn('D' * 100, chunk2)
        self.assertEqual(len(first['chunk']) + len(chunk2), res.get('total_chars'))
        self.assertIsNone(res.get('next_offset'))

    def test_non_consistent_paging_contract_unchanged(self):
        value = {'rows': [{'i': i, 's': 'row-%05d \u00e9\u6f22' % i} for i in range(6000)]}
        self._seed_value_run({self.NODE: ('out', value)})

        obj, calls = self._page_and_reconstruct(self.RUN, self.NODE, 'out')
        self.assertEqual(obj, value, 'legacy paging must reconstruct the exact value')
        self.assertGreaterEqual(calls, 2, 'fixture must span multiple pages')

        first = self._value_get(self.NODE, 'out', 0)
        for key in ('kind', 'offset', 'total_chars', 'chunk', 'next_offset'):
            self.assertIn(key, first, f'legacy response must keep {key!r}')
        mid = first['next_offset']
        self.assertIsInstance(mid, int)
        self.assertGreater(mid, 0)

        legacy_mid = self._value_get(self.NODE, 'out', mid)
        self._assert_no_leak(json.dumps(legacy_mid), where='legacy page 2')
        self.assertEqual(legacy_mid.get('offset'), mid)
        self.assertEqual(legacy_mid.get('total_chars'), first['total_chars'])
        self.assertEqual(self._value_get(self.NODE, 'out', mid).get('chunk'), legacy_mid.get('chunk'))

        consistent_first = self._value_get(self.NODE, 'out', 0, consistent=True)
        self.assertEqual(consistent_first.get('chunk'), first['chunk'])
        self.assertEqual(consistent_first.get('total_chars'), first['total_chars'])
        self.assertEqual(consistent_first.get('next_offset'), mid)
        version = consistent_first.get('version')
        self.assertIsInstance(version, str)
        self.assertTrue(version)
        consistent_mid = self._value_get(self.NODE, 'out', mid, consistent=True, version=version)
        self.assertEqual(consistent_mid.get('chunk'), legacy_mid.get('chunk'))
        self.assertEqual(consistent_mid.get('next_offset'), legacy_mid.get('next_offset'))

    def test_same_file_modified_during_read_is_rejected(self):
        import builtins
        from unittest.mock import patch

        marker = self.R.record_value(self.env, 'A' * 70000, self.RUN, self.NODE, 'changing')
        source = marker['$large']['path']
        original_open = builtins.open
        modified = []

        class ChangingReader:
            def __init__(self, fh):
                self.fh = fh
            def __enter__(self):
                self.fh.__enter__()
                return self
            def __exit__(self, *args):
                return self.fh.__exit__(*args)
            def fileno(self):
                return self.fh.fileno()
            def read(self, *args):
                result = self.fh.read(*args)
                with original_open(source, 'wb') as writer:
                    writer.write(b'B' * 70000)
                os.utime(source, ns=(1_000_000_000, 1_000_000_000))
                modified.append(True)
                return result

        def race_open(path, mode='r', *args, **kwargs):
            fh = original_open(path, mode, *args, **kwargs)
            if os.path.normcase(os.fspath(path)) == os.path.normcase(source) and mode == 'rb':
                return ChangingReader(fh)
            return fh

        with patch('builtins.open', side_effect=race_open):
            with self.assertRaises(HTTPException) as err:
                self.A._read_large_value(self.env, self.RUN, marker['$large'])
        self.assertEqual(err.exception.status_code, 409)
        self.assertTrue(modified)

    def test_opened_file_identity_mismatch_is_rejected(self):
        import builtins
        import tempfile
        from unittest.mock import patch

        marker = self.R.record_value(self.env, 'A' * 70000, self.RUN, self.NODE, 'race')
        source = marker['$large']['path']
        secret_dir = tempfile.mkdtemp(prefix='flowcanvas-secret-')
        self.addCleanup(shutil.rmtree, secret_dir, ignore_errors=True)
        secret = os.path.join(secret_dir, 'secret.txt')
        with open(secret, 'w', encoding='utf-8') as fh:
            fh.write('SECRET' * 11666 + 'SECR')
        original_open = builtins.open
        secret_opened = []

        def race_open(path, mode='r', *args, **kwargs):
            if os.path.normcase(os.fspath(path)) == os.path.normcase(source) and mode == 'rb':
                secret_opened.append(True)
                return original_open(secret, mode, *args, **kwargs)
            return original_open(path, mode, *args, **kwargs)

        with patch('builtins.open', side_effect=race_open):
            with self.assertRaises(HTTPException):
                self.A._read_large_value(self.env, self.RUN, marker['$large'])
        self.assertTrue(secret_opened)

    def test_empty_container_crossing_budget_is_rejected(self):
        for value in ([], {}):
            with self.subTest(value=value):
                budget = [self.A.MAX_VALUE_BYTES - 1]
                with self.assertRaises(HTTPException) as err:
                    self.A._resolve_run_value(value, 0, budget, set(), set(), {}, self.env, self.RUN)
                self.assertEqual(err.exception.status_code, 413)

    def test_escaped_json_output_bound_before_serialization(self):
        from unittest.mock import patch

        huge_text = '\\' * (5 * 1024 * 1024)
        marker = self.R.record_value(self.env, huge_text, self.RUN, self.NODE, 'out')

        run = {
            "id": self.RUN,
            "flow_id": self.FLOW,
            "status": "done",
            "nodes": {
                self.NODE: {
                    "status": "done",
                    "outputs": {"out": [marker, marker]},
                }
            },
        }
        self.S.save_run(self.env, run)

        orig_json_dumps = json.dumps

        def guarded_dumps(obj, *args, **kwargs):
            if isinstance(obj, list) and len(obj) == 2:
                if isinstance(obj[0], str) and isinstance(obj[1], str) and obj[0] == huge_text and obj[1] == huge_text:
                    raise AssertionError("oversized JSON serialization was attempted")
            return orig_json_dumps(obj, *args, **kwargs)

        with self.assertRaises(HTTPException) as cm:
            with patch.object(self.A.json, 'dumps', side_effect=guarded_dumps):
                asyncio.run(
                    self.A.handle(
                        'GET',
                        f'runs/{self.RUN}/value',
                        {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                        {},
                        self.env,
                    )
                )

        exc = cm.exception
        self.assertEqual(exc.status_code, 413, f"Expected HTTP 413 Payload Too Large, got {exc.status_code}: {exc.detail}")
        exc_str = str(exc.detail) if hasattr(exc, 'detail') else str(exc)
        if self.temp_dir:
            self.assertNotIn(self.temp_dir, exc_str, "HTTPException leaks temp_dir")
        outputs_dir = self.S.outputs_dir(self.env, self.RUN)
        if outputs_dir:
            self.assertNotIn(outputs_dir, exc_str, "HTTPException leaks outputs_dir")
        spill_path = marker["$large"]["path"]
        if spill_path:
            self.assertNotIn(spill_path, exc_str, "HTTPException leaks spill_path")
        self.assertNotIn('\\' * 100, exc_str, "HTTPException leaks content")

    def test_repeated_spill_marker_reads_bounded(self):
        import builtins
        import unittest.mock

        marker = self.R.record_value(self.env, 'A' * 70000, self.RUN, self.NODE, 'repeat')
        self.assertIn('$large', marker)
        spill_path = marker['$large']['path']
        self.assertTrue(os.path.exists(spill_path))
        canonical_target = os.path.normcase(os.path.realpath(os.fspath(spill_path)))
        self.assertTrue(os.path.exists(canonical_target))

        run_payload = {
            'id': self.RUN,
            'flow_id': self.FLOW,
            'status': 'done',
            'nodes': {
                self.NODE: {
                    'status': 'done',
                    'outputs': {'out': [marker] * 64},
                },
            },
        }
        self.S.save_run(self.env, run_payload)

        open_count = 0
        orig_open = builtins.open

        def wrapped_open(*args, **kwargs):
            nonlocal open_count
            file_arg = args[0] if args else kwargs.get('file')
            mode_arg = args[1] if len(args) > 1 else kwargs.get('mode', 'r')
            if file_arg is not None:
                try:
                    target = os.path.normcase(os.path.realpath(os.fspath(file_arg)))
                    if target == canonical_target and 'r' in str(mode_arg):
                        open_count += 1
                except Exception:
                    pass
            return orig_open(*args, **kwargs)

        with unittest.mock.patch('builtins.open', new=wrapped_open):
            resp = asyncio.run(
                self.A.handle(
                    'GET',
                    f'runs/{self.RUN}/value',
                    {'node': self.NODE, 'port': 'out', 'offset': 0, 'limit': 65536},
                    {},
                    self.env,
                )
            )

        expected_full = json.dumps(['A' * 70000] * 64, ensure_ascii=False, allow_nan=False)
        self.assertEqual(resp['kind'], 'json')
        self.assertEqual(resp['chunk'], expected_full[:65536])
        self.assertEqual(resp['offset'], 0)
        self.assertEqual(resp['next_offset'], 65536)
        self.assertEqual(resp['total_chars'], len(expected_full))
        self.assertLessEqual(open_count, 2)




    def test_expanded_response_reports_provenance_without_claiming_original_json(self):
        inner = self.R.record_value(self.env, 'x' * 70000, self.RUN, self.NODE, 'inner')
        directory = self.S.outputs_dir(self.env, self.RUN)
        path = os.path.join(directory, 'precise.json')
        raw = '{"precise":1.0000000000000000000001,"inner":' + json.dumps(inner) + '}'
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(raw)
        outer = {'$large': {'path': path, 'file': 'precise.json', 'chars': len(raw)}}
        self._seed_value_run({self.NODE: ('out', outer)})
        page = self._value_get(self.NODE, 'out', 0, consistent=True)
        self.assertIs(page.get('expanded'), True)
        self.assertNotIn('expanded', self._value_get(self.NODE, 'out', 0))
        self._seed_value_run({self.NODE: ('out', {'precise': 1})})
        self.assertIs(self._value_get(self.NODE, 'out', 0, consistent=True).get('expanded'), False)

    def test_consistent_following_pages_do_not_reexpand_or_reopen_spills(self):
        import builtins
        from unittest.mock import patch
        marker = self.R.record_value(self.env, 'A' * 90000, self.RUN, self.NODE, 'cached')
        self._seed_value_run({self.NODE: ('out', {'inner': marker})})
        original_open = builtins.open
        spill_opens = []
        def counting_open(path, mode='r', *args, **kwargs):
            if os.path.normcase(os.fspath(path)) == os.path.normcase(marker['$large']['path']) and mode == 'rb':
                spill_opens.append(1)
            return original_open(path, mode, *args, **kwargs)
        with patch.object(self.A, '_expand_run_value', wraps=self.A._expand_run_value) as expand:
            with patch('builtins.open', side_effect=counting_open):
                first = self._value_get(self.NODE, 'out', 0, 30000, consistent=True)
                offset = first['next_offset']
                while offset is not None:
                    page = self._value_get(self.NODE, 'out', offset, 30000, consistent=True, version=first['version'])
                    offset = page['next_offset']
        self.assertEqual(expand.call_count, 1, 'one expansion per unchanged pagination sequence')
        self.assertEqual(len(spill_opens), 1, 'later pages validate metadata but do not reopen contents')

    def test_invalid_huge_offset_is_rejected_before_expansion(self):
        from unittest.mock import patch
        self._seed_value_run({self.NODE: ('out', 'x')})
        with patch.object(self.A, '_expand_run_value', wraps=self.A._expand_run_value) as expand:
            with self.assertRaises(HTTPException) as err:
                self._value_get(self.NODE, 'out', '9' * 5000, consistent=True)
        self.assertEqual(err.exception.status_code, 400)
        self.assertNotIn('sys.set_int_max_str_digits', str(err.exception.detail))
        self.assertEqual(expand.call_count, 0)


    def test_cached_pages_reject_removed_spill(self):
        marker = self.R.record_value(self.env, 'A' * 90000, self.RUN, self.NODE, 'removed')
        self._seed_value_run({self.NODE: ('out', {'inner': marker})})
        first = self._value_get(self.NODE, 'out', 0, consistent=True)
        os.unlink(marker['$large']['path'])
        with self.assertRaises(HTTPException) as err:
            self._value_get(self.NODE, 'out', first['next_offset'], consistent=True, version=first['version'])
        self.assertEqual(err.exception.status_code, 404)

    def test_cache_respects_expiry_and_memory_budget(self):
        from unittest.mock import patch
        marker = self.R.record_value(self.env, 'A' * 90000, self.RUN, self.NODE, 'ttl')
        self._seed_value_run({self.NODE: ('out', {'inner': marker})})
        with patch.object(self.A.time, 'monotonic', return_value=100):
            first = self._value_get(self.NODE, 'out', 0, consistent=True)
        with patch.object(self.A, '_expand_run_value', wraps=self.A._expand_run_value) as expand:
            with patch.object(self.A.time, 'monotonic', return_value=131):
                second = self._value_get(self.NODE, 'out', first['next_offset'], consistent=True, version=first['version'])
            self.assertEqual(expand.call_count, 1)
        self.assertEqual(second['version'], first['version'])
        self.env.state['value_page_cache'].clear()
        with patch.object(self.A, '_VALUE_PAGE_CACHE_BYTES', 1):
            self._value_get(self.NODE, 'out', 0, consistent=True)
            self.assertEqual(self.env.state['value_page_cache'], {})

    def test_cached_value_tracks_changed_record_and_different_data_root(self):
        self._seed_value_run({self.NODE: ('out', 'A' * 90000)})
        first = self._value_get(self.NODE, 'out', 0, consistent=True)
        self._seed_value_run({self.NODE: ('out', 'B' * 90000)})
        with self.assertRaises(HTTPException) as err:
            self._value_get(self.NODE, 'out', first['next_offset'], consistent=True, version=first['version'])
        self.assertEqual(err.exception.status_code, 409)
        self.assertTrue(self._value_get(self.NODE, 'out', 0, consistent=True)['chunk'].startswith('B'))
        self.assertEqual(len(self.env.state['value_page_cache']), 1)
        other_root = os.path.join(self.temp_dir, 'other-root')
        self.env.data_dir = other_root
        self._seed_value_run({self.NODE: ('out', 'C' * 90000)})
        self.assertTrue(self._value_get(self.NODE, 'out', 0, consistent=True)['chunk'].startswith('C'))
        self.assertEqual(len(self.env.state['value_page_cache']), 2)

    def test_verbatim_spill_json_preserves_numeric_lexemes(self):
        directory = self.S.outputs_dir(self.env, self.RUN)
        path = os.path.join(directory, 'verbatim.json')
        raw = '{"precise":1.000000000000000000001,"price":1.10,"tiny":1e-7}'
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(raw)
        self._seed_value_run({self.NODE: ('out', {'$large': {'path': path, 'file': 'verbatim.json', 'chars': len(raw)}})})
        first = self._value_get(self.NODE, 'out', 0, consistent=True)
        self.assertEqual(first['chunk'], raw)
        self.assertIs(first['expanded'], False)

    def test_expanded_lone_surrogate_is_a_controlled_error(self):
        inner = self.R.record_value(self.env, 'A' * 90000, self.RUN, self.NODE, 'surrogate')
        directory = self.S.outputs_dir(self.env, self.RUN)
        path = os.path.join(directory, 'surrogate.json')
        raw = json.dumps({'bad': chr(0xd800), 'inner': inner}, ensure_ascii=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(raw)
        self._seed_value_run({self.NODE: ('out', {'$large': {'path': path, 'file': 'surrogate.json', 'chars': len(raw)}})})
        with self.assertRaises(HTTPException) as err:
            self._value_get(self.NODE, 'out', 0, consistent=True)
        self.assertEqual(err.exception.status_code, 422)
