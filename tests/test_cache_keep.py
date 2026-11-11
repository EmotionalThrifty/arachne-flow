"""Node cache bounds: each flow keeps its own newest entries, so one big loop cannot evict every other flow."""
import os
import unittest

import helpers

E = helpers.load_engine()
R, S = E.runner, E.store

NODE = {"type": "text.template"}


def make_env():
    helpers.temp_data_dir()
    return E.env.Env(ctx=helpers.FakeCtx(), state={}, emit=lambda e, p: None)


class CacheKeepTest(unittest.TestCase):
    def setUp(self):
        self.env = make_env()
        self.keep, self.total = R.CACHE_KEEP, R.CACHE_KEEP_TOTAL
        self.clock = 1_000_000

    def tearDown(self):
        R.CACHE_KEEP, R.CACHE_KEEP_TOTAL = self.keep, self.total

    def put(self, flow_id, key):
        R.cache_put(self.env, key, NODE, {"text": key}, flow_id)
        self.clock += 10   # strictly increasing mtimes, independent of the file system's resolution
        path = os.path.join(S.cache_dir(self.env), flow_id or "", key + ".json")
        os.utime(path, (self.clock, self.clock))

    def keys(self, flow_id):
        folder = os.path.join(S.cache_dir(self.env), flow_id)
        return sorted(n[:-5] for n in os.listdir(folder) if n.endswith(".json")) if os.path.isdir(folder) else []

    def test_a_big_flow_only_evicts_its_own_entries(self):
        R.CACHE_KEEP = 3
        for k in ("b1", "b2"):
            self.put("f_small", k)
        for i in range(6):
            self.put("f_big", f"a{i}")
        self.assertEqual(self.keys("f_small"), ["b1", "b2"])
        self.assertEqual(self.keys("f_big"), ["a3", "a4", "a5"])

    def test_total_cap_trims_the_largest_flow_first(self):
        R.CACHE_KEEP, R.CACHE_KEEP_TOTAL = 10, 6
        for k in ("b1", "b2", "b3"):
            self.put("f_small", k)
        for i in range(5):
            self.put("f_big", f"a{i}")
        self.assertEqual(self.keys("f_small"), ["b1", "b2", "b3"])
        self.assertEqual(self.keys("f_big"), ["a2", "a3", "a4"])

    def test_hits_come_from_this_flow_other_flows_and_the_old_flat_cache(self):
        self.put("f_one", "k1")
        self.assertEqual(R.cache_get(self.env, "k1", "f_one"), {"text": "k1"})
        self.assertEqual(R.cache_get(self.env, "k1", "f_two"), {"text": "k1"})   # a duplicated flow still hits
        S.write_json(os.path.join(S.cache_dir(self.env), "old.json"), {"outputs": {"text": "old"}})
        self.assertEqual(R.cache_get(self.env, "old", "f_one"), {"text": "old"})
        self.assertIsNone(R.cache_get(self.env, "missing", "f_one"))

    def test_runs_write_into_their_flow_folder(self):
        env = self.env
        flow = E.graph.new_flow("Cache", "")
        flow, _ = E.graph.apply_ops(flow, [
            {"op": "add_node", "ref": "t", "type": "input.text", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "tpl", "type": "text.template", "params": {"template": "{{x}}!"}},
            {"op": "connect", "from": "t.text", "to": "tpl.x"},
        ], E.nodes.types_by_name(env))
        flow = S.save_flow(env, flow, create=True)
        handle = R.start_run(env, flow["id"], fresh=False)
        self.assertTrue(handle.done.wait(10))
        self.assertTrue(self.keys(flow["id"]), "no cache entry in the flow's own folder")


if __name__ == "__main__":
    unittest.main()
