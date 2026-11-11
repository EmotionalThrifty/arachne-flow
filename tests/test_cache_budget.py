'''EN-11: cache byte budgets (per entry and overall) and the crash-orphan sweep of .media-* staging dirs.

Tiny KB fixtures only. The future limits (CACHE_MAX_ENTRY_BYTES 256 MiB, CACHE_MAX_BYTES 2 GiB,
CACHE_ORPHAN_AGE_S 3600) are patched with create=True so missing limits fail as assertions, not AttributeErrors.
'''
import os
import shutil
import time
import unittest
from unittest import mock

import helpers

E = helpers.load_engine()
R, S = E.runner, E.store

ENTRY_MAX = 256 * 1024 * 1024
TOTAL_MAX = 2 * 1024 * 1024 * 1024
ORPHAN_AGE = 3600
KB = 1024


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(data)
    return os.path.abspath(path)


def body(path):
    with open(path, 'rb') as fh:
        return fh.read()


def media(path):
    return {'$media': {'kind': 'image', 'file': os.path.basename(path), 'mime': 'image/png', 'path': path}}


def large(path, chars):
    return {'$large': {'path': path, 'file': os.path.basename(path), 'chars': chars, 'preview': 'x'}}


def under(path, folder):
    path, folder = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(folder))
    return path.startswith(folder + os.sep)


def file_paths(value):
    '''Every $media/$large path in a nested outputs value, in document order.'''
    found = []
    if isinstance(value, dict):
        for marker in ('$media', '$large'):
            meta = value.get(marker)
            if isinstance(meta, dict) and meta.get('path'):
                return [meta['path']]
        for item in value.values():
            found.extend(file_paths(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(file_paths(item))
    return found


def dir_bytes(folder):
    '''Bytes of every file below folder (JSON entries and media), lock files excluded.'''
    total = 0
    for base, _, files in os.walk(folder):
        for name in files:
            if name.endswith('.lock') or name.startswith('.lock'):
                continue
            total += os.path.getsize(os.path.join(base, name))
    return total


class CacheBudgetTest(unittest.TestCase):
    def setUp(self):
        environ = mock.patch.dict(os.environ)   # temp_data_dir sets FLOWCANVAS_DATA_DIR; restore it afterwards
        environ.start()
        self.addCleanup(environ.stop)
        self.data = helpers.temp_data_dir()
        self.addCleanup(shutil.rmtree, self.data, ignore_errors=True)
        self.ctx = helpers.FakeCtx()
        self.env = E.env.Env(ctx=self.ctx, state={}, emit=lambda event, payload: None, data_dir=self.data)
        self.limits(CACHE_MAX_ENTRY_BYTES=ENTRY_MAX, CACHE_MAX_BYTES=TOTAL_MAX, CACHE_ORPHAN_AGE_S=ORPHAN_AGE)
        self.clock = 1_000_000

    def limits(self, **values):
        for name, value in values.items():
            patcher = mock.patch.object(R, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def src(self, name, data):
        return write(os.path.join(self.data, 'producer', name), data)

    def entry_path(self, flow_id, key):
        return os.path.join(S.cache_dir(self.env), flow_id, key + '.json')

    def put(self, flow_id, key, outputs):
        R.cache_put(self.env, key, {'type': 'test'}, outputs, flow_id)
        path = self.entry_path(flow_id, key)
        if os.path.isfile(path):
            self.clock += 10   # deterministic age order without sleeps; the entry being put is always newest
            os.utime(path, (self.clock, self.clock))
        return path

    def entry_bytes(self, path):
        entry = S.read_json(path)
        total = os.path.getsize(path)
        if entry.get('media_dir'):
            total += dir_bytes(os.path.join(os.path.dirname(path), entry['media_dir']))
        return total

    def keys(self, flow_id):
        folder = os.path.join(S.cache_dir(self.env), flow_id)
        if not os.path.isdir(folder):
            return []
        return sorted(n[:-5] for n in os.listdir(folder) if n.endswith('.json') and not n.startswith('.'))

    def media_dirs(self, flow_id):
        folder = os.path.join(S.cache_dir(self.env), flow_id)
        if not os.path.isdir(folder):
            return []
        return sorted(n for n in os.listdir(folder)
                      if n.startswith('.media-') and os.path.isdir(os.path.join(folder, n)))

    def test_small_entries_are_still_cached_and_hit(self):
        src = self.src('small.png', b's' * 512)
        self.put('f_small', 'plain', {'text': 'hi'})
        self.put('f_small', 'pic', {'img': media(src), 'text': 'ok'})
        self.assertEqual(R.cache_get(self.env, 'plain', 'f_small'), {'text': 'hi'})
        os.remove(src)
        hit = R.cache_get(self.env, 'pic', 'f_small')
        self.assertIsNotNone(hit, 'a small media entry must still be cached')
        self.assertEqual(hit['text'], 'ok')
        self.assertEqual(body(hit['img']['$media']['path']), b's' * 512)
        self.assertEqual(self.ctx.calls, [])

    def test_same_source_twice_counts_once_and_hits_without_a_tool_call(self):
        src = self.src('dup.png', b'd' * (3 * KB))
        self.limits(CACHE_MAX_ENTRY_BYTES=5 * KB)   # JSON + one 3 KB copy fits, two copies (6 KB) would not
        path = self.put('f_dup', 'dup', {'first': media(src), 'nested': {'list': [media(src)]}})
        self.assertTrue(os.path.isfile(path), 'an entry under the budget must be published')
        self.assertLess(os.path.getsize(path), 2 * KB, 'fixture JSON must stay small for this budget')
        owned = os.path.join(os.path.dirname(path), S.read_json(path)['media_dir'])
        self.assertEqual(len(os.listdir(owned)), 1, 'one source referenced twice is copied once')
        self.assertLessEqual(self.entry_bytes(path), 5 * KB)
        os.remove(src)
        run_dir = os.path.join(self.data, 'outputs', 'run_dup')
        hit = R.cache_get(self.env, 'dup', 'f_dup', out_dir=run_dir)
        self.assertIsNotNone(hit, 'the hit must not need the producer file')
        paths = file_paths(hit)
        self.assertEqual(len(paths), 2)
        self.assertEqual(len(set(paths)), 1)
        self.assertTrue(under(paths[0], run_dir))
        self.assertEqual(body(paths[0]), b'd' * (3 * KB))
        self.assertEqual(self.ctx.calls, [], 'a cache hit must not dispatch a tool')

    def test_entry_bytes_count_json_and_every_distinct_owned_file(self):
        one = self.src('one.png', b'a' * (3 * KB))
        two = self.src('two.png', b'b' * (3 * KB))
        self.limits(CACHE_MAX_ENTRY_BYTES=5 * KB)
        ok = self.put('f_cnt', 'one', {'img': media(one), 'text': 'y' * 500})
        self.assertTrue(os.path.isfile(ok), 'control: a 3 KB file plus small JSON fits 5 KB')
        self.assertLessEqual(self.entry_bytes(ok), 5 * KB)
        kept = self.media_dirs('f_cnt')
        self.assertFalse(os.path.isfile(self.put('f_cnt', 'two', {'a': media(one), 'b': media(two)})),
                         'two distinct 3 KB files exceed a 5 KB entry budget')
        self.assertFalse(os.path.isfile(self.put('f_cnt', 'text', {'img': media(one), 'text': 'y' * 2500})),
                         'JSON bytes count too: a 3 KB file plus 2.5 KB of text exceed 5 KB')
        self.assertIsNone(R.cache_get(self.env, 'two', 'f_cnt'))
        self.assertIsNone(R.cache_get(self.env, 'text', 'f_cnt'))
        self.assertEqual(self.media_dirs('f_cnt'), kept, 'a refused entry leaves no staging dir behind')
        self.assertEqual(body(one), b'a' * (3 * KB))
        self.assertEqual(body(two), b'b' * (3 * KB))

    def test_oversize_json_and_nested_files_are_not_published_and_producers_stay(self):
        self.limits(CACHE_MAX_ENTRY_BYTES=4 * KB)
        pic = self.src('big.png', b'p' * (8 * KB))
        text = self.src('big.txt', b't' * (8 * KB))
        cases = {
            'json': {'text': 'y' * (6 * KB)},
            'media': {'wrap': {'items': [{'note': 'n'}, {'img': [media(pic)]}]}},
            'large': {'deep': [{'value': large(text, 8 * KB)}]},
        }
        for key, outputs in cases.items():
            with self.subTest(key):
                self.assertFalse(os.path.isfile(self.put('f_big', key, outputs)),
                                 key + ' over the entry budget was published')
                self.assertIsNone(R.cache_get(self.env, key, 'f_big'))
        self.assertEqual(self.media_dirs('f_big'), [], 'refused entries leave no staging dirs behind')
        self.assertEqual(body(pic), b'p' * (8 * KB), 'the producer media file must survive')
        self.assertEqual(body(text), b't' * (8 * KB), 'the producer $large file must survive')

    def test_oversize_replace_keeps_the_old_usable_entry(self):
        self.limits(CACHE_MAX_ENTRY_BYTES=4 * KB)
        old_src = self.src('old.png', b'o' * KB)
        new_src = self.src('new.png', b'n' * (8 * KB))
        path = self.put('f_rep', 'k', {'img': media(old_src)})
        self.assertTrue(os.path.isfile(path))
        old_copy = R.cache_get(self.env, 'k', 'f_rep')['img']['$media']['path']
        self.put('f_rep', 'k', {'img': media(new_src)})
        hit = R.cache_get(self.env, 'k', 'f_rep')
        self.assertIsNotNone(hit, 'a refused replacement must not drop the old entry')
        self.assertEqual(body(hit['img']['$media']['path']), b'o' * KB, 'the old entry must stay in place')
        self.assertTrue(os.path.isfile(old_copy), 'the old entry keeps its owned media')
        self.assertEqual(len(self.media_dirs('f_rep')), 1)
        self.assertEqual(body(new_src), b'n' * (8 * KB), 'the refused producer file must survive')

    def test_global_budget_evicts_across_flows_but_spares_producers_and_hit_copies(self):
        self.limits(CACHE_MAX_ENTRY_BYTES=8 * KB, CACHE_MAX_BYTES=10 * KB)   # ~4.5 KB per entry: two fit
        run_dir = os.path.join(self.data, 'outputs', 'run_hit')
        sources, hit_copy = {}, None
        for i in range(1, 4):
            for flow_id, tag in (('f_a', 'a'), ('f_b', 'b')):
                key = tag + str(i)
                sources[key] = self.src(key + '.png', key.encode() * (2 * KB))
                self.assertTrue(os.path.isfile(self.put(flow_id, key, {'img': media(sources[key])})))
                if key == 'a1':
                    hit_copy = R.cache_get(self.env, 'a1', 'f_a', out_dir=run_dir)['img']['$media']['path']
        self.assertLessEqual(dir_bytes(S.cache_dir(self.env)), 10 * KB, 'cache root exceeds the byte budget')
        left = self.keys('f_a') + self.keys('f_b')
        self.assertLess(len(left), 6, 'nothing was evicted')
        self.assertIn('b3', left, 'the newest entry must survive')
        for key in left:
            self.assertIsNotNone(R.cache_get(self.env, key, 'f_' + key[0]), key + ' survived without its media')
        for key, path in sources.items():
            self.assertEqual(body(path), key.encode() * (2 * KB), 'eviction deleted a producer file')
        self.assertTrue(under(hit_copy, run_dir))
        self.assertEqual(body(hit_copy), b'a1' * (2 * KB), 'eviction deleted a materialized hit copy')

    def test_prune_sweeps_old_unreferenced_media_dirs_only(self):
        src = self.src('kept.png', b'k' * KB)
        path = self.put('f_orph', 'kept', {'img': media(src)})
        folder = os.path.dirname(path)
        referenced = os.path.join(folder, S.read_json(path)['media_dir'])
        stale = os.path.join(folder, '.media-crashed')
        fresh = os.path.join(folder, '.media-staging')
        write(os.path.join(stale, 'media-x.png'), b'c' * KB)
        write(os.path.join(fresh, 'media-y.png'), b'f' * KB)
        old = time.time() - 2 * ORPHAN_AGE
        for item in (stale, referenced):
            for base, _, files in os.walk(item):
                for name in files:
                    os.utime(os.path.join(base, name), (old, old))
            os.utime(item, (old, old))
        R._prune_cache(self.env, folder)
        self.assertFalse(os.path.exists(stale), 'an old unreferenced .media-* dir is a crash leftover')
        self.assertTrue(os.path.isdir(fresh), 'a fresh .media-* dir may belong to a put in progress')
        self.assertTrue(os.path.isdir(referenced), 'a referenced media dir must stay, however old')
        hit = R.cache_get(self.env, 'kept', 'f_orph')
        self.assertIsNotNone(hit)
        self.assertEqual(body(hit['img']['$media']['path']), b'k' * KB)
        self.assertEqual(body(src), b'k' * KB)


if __name__ == '__main__':
    unittest.main()
