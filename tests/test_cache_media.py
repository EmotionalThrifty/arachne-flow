"""EN-3 regression: cache-owned media must outlive the run and cache entry that produced it.

The cache is a promise that a later run can reuse a paid result without calling the tool again.
That promise is only worth anything while the result's media files still exist.  Today a cache hit
hands the new run the *first* run's media path, and deleting that run (or losing the cache entry)
takes the preview and the only copy with it.

These tests use the real public paths only: ``runner.run_sync`` for a real end-to-end flow,
``store.delete_run`` / ``store.prune_runs`` for the two real deletion paths, and the existing
``cache_put`` / ``cache_get`` interface for the direct cache check.  The fake tool is offline and
returns an inline PNG data URL; ``collect_media`` materializes it in the run's own output folder.
"""
import base64
import json
import os
import shutil
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N = E.runner, E.store, E.graph, E.nodes

# The same 1x1 PNG test_executors uses; no Pillow and no network needed.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()

TOOLS = [{
    "name": "seed_media", "toolset": "test", "read_only": True,   # cached by default, no approval
    "parameters": {"type": "object", "properties": {}},
}]


class MediaCtx(helpers.FakeCtx):
    """A read-only fake tool that returns one small PNG, fully offline."""

    def __init__(self):
        super().__init__({"seed_media": self._seed})

    def _seed(self, args):
        return json.dumps({"image": PNG_DATA_URL, "text": "seeded"})


def make_env():
    """A throwaway data dir inside the test scratch; FLOWCANVAS_CACHE also stays outside the repo."""
    data = helpers.temp_data_dir()
    os.environ["FLOWCANVAS_DATA_DIR"] = data
    ctx = MediaCtx()
    env = E.env.Env(ctx=ctx, state={"tool_source": lambda: TOOLS}, data_dir=data,
                    emit=lambda event, payload: None)
    return env, ctx


def build(env, name="media"):
    flow, _ = G.apply_ops(G.new_flow(name), [
        {"op": "add_node", "ref": "seed", "type": "tool:seed_media", "title": "Seed"},
    ], N.types_by_name(env))
    return S.save_flow(env, flow, create=True)


def media_paths(value):
    """Every media path in a (nested) outputs value, in document order."""
    found = []
    if isinstance(value, dict):
        if isinstance(value.get("$media"), dict):
            path = value["$media"].get("path")
            if path:
                found.append(path)
        else:
            for item in value.values():
                found.extend(media_paths(item))
    elif isinstance(value, (list, tuple)):
        for item in value:
            found.extend(media_paths(item))
    return found


def media_value(path, kind="image"):
    return {"$media": {"kind": kind, "file": os.path.basename(path), "mime": "image/png",
                       "path": os.path.abspath(path)}}


def under(path, folder):
    path, folder = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(folder))
    return path.startswith(folder + os.sep)


def body(path):
    with open(path, "rb") as fh:
        return fh.read()


class CacheMediaTest(unittest.TestCase):
    def setUp(self):
        self.env, self.ctx = make_env()

    def start(self):
        flow = build(self.env)
        return flow, flow["nodes"][0]["id"]

    def run_flow(self, flow):
        run = R.run_sync(self.env, flow["id"], timeout_s=10)
        self.assertEqual(run["status"], "done", run)
        return run

    def node_media(self, run, nid):
        state = run["nodes"][nid]
        outputs = state.get("outputs") or {}
        self.assertIsInstance(outputs.get("media"), dict,
                              f"node {state.get('status')} produced no media: {state.get('error') or outputs}")
        path = outputs["media"]["$media"]["path"]
        self.assertTrue(os.path.isfile(path), f"recorded media file is missing: {path}")
        return path

    def test_cache_hit_materializes_media_for_its_own_run(self):
        """Run 2 is cached, but its record must point at its own outputs/<run2>, not run 1's file."""
        flow, nid = self.start()
        first = self.run_flow(flow)
        self.assertEqual(first["nodes"][nid]["status"], "done")
        first_path = self.node_media(first, nid)
        self.assertTrue(under(first_path, S.outputs_dir(self.env, first["id"])))
        self.assertEqual(len(self.ctx.calls), 1)

        second = self.run_flow(flow)
        self.assertEqual(second["nodes"][nid]["status"], "cached")
        self.assertEqual(len(self.ctx.calls), 1, "a cache hit must not call the tool again")
        second_path = self.node_media(second, nid)
        self.assertNotEqual(second_path, first_path,
                            "cached run reused the producing run's media path")
        self.assertTrue(under(second_path, S.outputs_dir(self.env, second["id"], create=False)),
                        f"cached media is not under the cached run's own outputs folder: {second_path}")
        self.assertEqual(body(second_path), PNG)

        # Removing the cache entry together with all cache-owned media must not touch run 2's copy.
        cache_folder = S.cache_dir(self.env)  # cache_dir creates its folder; do not call it after removal
        shutil.rmtree(cache_folder)
        self.assertFalse(os.path.exists(cache_folder))
        self.assertTrue(os.path.isfile(second_path), "run 2's own media did not survive cache pruning")
        self.assertEqual(body(second_path), PNG)

    def test_cache_media_survives_deleting_the_producer_run(self):
        """The cache must own its media: deleting run 1 keeps run 2 cached with the same bytes."""
        flow, nid = self.start()
        first = self.run_flow(flow)
        first_path = self.node_media(first, nid)
        second = self.run_flow(flow)
        self.assertEqual(second["nodes"][nid]["status"], "cached")
        second_path = self.node_media(second, nid)
        self.assertEqual(len(self.ctx.calls), 1)

        S.delete_run(self.env, first["id"])
        self.assertFalse(os.path.exists(S.outputs_dir(self.env, first["id"], create=False)))
        self.assertTrue(os.path.isfile(second_path),
                        "cached media lived in the deleted run's outputs and disappeared with it")
        self.assertEqual(body(second_path), PNG,
                         "cached media changed after its producing run was deleted")

        third = self.run_flow(flow)
        self.assertEqual(third["nodes"][nid]["status"], "cached",
                         "the third run re-ran the paid tool after run 1 was deleted")
        self.assertEqual(len(self.ctx.calls), 1, "exactly one real tool call across all three runs")
        third_path = self.node_media(third, nid)
        self.assertTrue(under(third_path, S.outputs_dir(self.env, third["id"], create=False)),
                        f"third run's cached media is not its own copy: {third_path}")
        self.assertEqual(body(third_path), PNG)
        self.assertFalse(os.path.exists(first_path))

    def test_cache_get_keeps_nested_media_after_originals_are_gone(self):
        """cache_get must serve media nested in dicts/lists from its own copy, not the original files."""
        env, _ = self.env, self.ctx
        source = os.path.join(S.data_dir(env), "tool-output")
        os.makedirs(source, exist_ok=True)
        one = os.path.join(source, "one.png")
        two = os.path.join(source, "two.png")
        with open(one, "wb") as fh:
            fh.write(PNG)
        with open(two, "wb") as fh:
            fh.write(PNG + b"-second")

        payload = {
            "preview": media_value(one),
            "nested": {
                "items": [
                    {"inner": [media_value(two)]},
                    {"plain": "text"},
                ],
            },
        }
        key, flow_id = "nested-media", "f_000001"
        R.cache_put(env, key, {"type": "tool:seed_media"}, payload, flow_id)

        entry_path = os.path.join(S.cache_dir(env), flow_id, key + ".json")
        with open(entry_path, encoding="utf-8") as fh:
            entry = json.load(fh)
        cached_paths = media_paths(entry["outputs"])
        self.assertEqual(len(cached_paths), 2)
        for path in cached_paths:
            self.assertTrue(under(path, S.cache_dir(env)),
                            f"cache entry still points outside the cache: {path}")
            self.assertTrue(os.path.isfile(path))
        self.assertEqual([body(path) for path in cached_paths], [PNG, PNG + b"-second"])

        os.remove(one)
        os.remove(two)
        hit = R.cache_get(env, key, flow_id)
        self.assertIsNotNone(hit, "cache_get dropped an entry whose original media files are gone")
        hit_paths = media_paths(hit)
        self.assertEqual(len(hit_paths), 2)
        self.assertEqual([body(path) for path in hit_paths], [PNG, PNG + b"-second"])
        for path in hit_paths:
            self.assertTrue(under(path, S.cache_dir(env)))
            self.assertTrue(os.path.isfile(path))

    def test_eviction_removes_only_the_evicted_entries_media(self):
        source = os.path.join(S.data_dir(self.env), "seed.png")
        with open(source, "wb") as fh:
            fh.write(PNG)
        R.cache_put(self.env, "old", {"type": "test"}, {"media": media_value(source)}, "f_media")
        old = R.cache_get(self.env, "old", "f_media")["media"]["$media"]["path"]
        self.assertTrue(under(old, S.cache_dir(self.env)), "cache must own the evicted media first")
        old_entry = os.path.join(S.cache_dir(self.env), "f_media", "old.json")
        os.utime(old_entry, (1, 1))
        self.addCleanup(setattr, R, "CACHE_KEEP", R.CACHE_KEEP)
        R.CACHE_KEEP = 1
        R.cache_put(self.env, "new", {"type": "test"}, {"media": media_value(source)}, "f_media")
        self.assertIsNone(R.cache_get(self.env, "old", "f_media"))
        self.assertFalse(os.path.exists(old), "eviction must remove the owned media, not just its JSON")
        current = R.cache_get(self.env, "new", "f_media")["media"]["$media"]["path"]
        self.assertEqual(body(current), PNG)
        self.assertEqual(body(source), PNG, "cache eviction must never delete the source file")

    def test_pruning_old_runs_keeps_cached_media_alive(self):
        """Reduced 30-run history bound: pruning deletes the old run's outputs, not the cache's copy."""
        flow, nid = self.start()
        old_keep = S.KEEP_RUNS
        S.KEEP_RUNS = 2                       # the test-sized version of the real 30-run bound
        self.addCleanup(setattr, S, "KEEP_RUNS", old_keep)

        first = self.run_flow(flow)
        self.node_media(first, nid)
        second = self.run_flow(flow)
        self.assertEqual(second["nodes"][nid]["status"], "cached")
        second_path = self.node_media(second, nid)
        third = self.run_flow(flow)
        self.assertEqual(third["nodes"][nid]["status"], "cached")
        self.assertEqual(len(self.ctx.calls), 1)

        removed = S.prune_runs(self.env, flow["id"], keep=S.KEEP_RUNS)
        self.assertIn(first["id"], removed)
        with self.assertRaises(S.NotFoundError):
            S.load_run(self.env, first["id"])
        self.assertFalse(os.path.exists(S.outputs_dir(self.env, first["id"], create=False)))
        self.assertTrue(os.path.isfile(second_path),
                        "pruning the producer run deleted the cached run's media")
        self.assertEqual(body(second_path), PNG)

        fourth = self.run_flow(flow)
        self.assertEqual(fourth["nodes"][nid]["status"], "cached",
                         "the cache lost its media when the old run was pruned")
        self.assertEqual(len(self.ctx.calls), 1, "exactly one real tool call across all four runs")
        fourth_path = self.node_media(fourth, nid)
        self.assertTrue(under(fourth_path, S.outputs_dir(self.env, fourth["id"], create=False)))
        self.assertEqual(body(fourth_path), PNG)


if __name__ == "__main__":
    unittest.main()
