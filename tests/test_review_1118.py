"""External review 18.11.2026 (R1-R3): trigger state can only come from the user and the scheduler.

R1: a saved graph cannot carry a trigger's run-time event, and a value read from disk must live in Arachne's run
    outputs (a ``$large`` path a graph names is never opened).
R2: flow_apply / Build with Hermes / canvas saves never switch a trigger on or give it a webhook URL; only the
    dedicated trigger action does. Switching off stays possible everywhere.
R3: an RSS feed without new items is a quiet poll that respects the interval, not an error.
"""
import json
import os
import tempfile
import unittest

import helpers

E = helpers.load_engine()
S, G, N, R, T, TOOLS = E.store, E.graph, E.nodes, E.runner, E.triggers, E.tools


class _Case(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.env = E.env.Env(ctx=helpers.FakeCtx({}), state={"tool_source": lambda: []})
        self.types = N.types_by_name(self.env)

    def apply(self, ops, flow_id=None, base=None):
        args = {"ops": ops, **({"flow": flow_id, "base_revision": base} if flow_id else {"name": "t"})}
        res = json.loads(TOOLS.handle("flow_apply", args, {}, self.env))
        self.assertNotIn("error", res, res)
        return S.get_flow(self.env, res["flow"]["id"]), res.get("refs") or {}

    def trigger(self, flow):
        return next(n for n in flow["nodes"] if T.is_trigger(n))


class InjectedEventTest(_Case):
    def test_saved_event_is_dropped_and_never_reads_a_file(self):
        secret = os.path.join(tempfile.mkdtemp(), "secret.txt")
        with open(secret, "w", encoding="utf-8") as fh:
            fh.write("SENTINEL-SECRET")
        flow, _ = self.apply([
            {"op": "add_node", "ref": "s", "type": "trigger.schedule",
             "params": {"schedule": "every 1h", T.EVENT: {"time": {"$large": {"path": secret}}}, T.IDLE: False}},
            {"op": "add_node", "ref": "t", "type": "text.template", "params": {"template": "got {{text}}"}},
            {"op": "connect", "from": "s.time", "to": "t.text"}])
        params = self.trigger(flow)["params"]
        self.assertNotIn(T.EVENT, params)
        self.assertNotIn(T.IDLE, params)
        run = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertNotIn("SENTINEL-SECRET", json.dumps(run))

    def test_large_values_are_read_only_from_run_outputs(self):
        outside = os.path.join(tempfile.mkdtemp(), "x.txt")
        with open(outside, "w", encoding="utf-8") as fh:
            fh.write("abc")
        with self.assertRaises(R.ValueCorruptionError):
            R.load_value({"$large": {"path": outside, "chars": 3}}, self.env)
        inside = R.record_value(self.env, "y" * (R.LARGE_VALUE_CHARS + 5), "r_aaaaaaaaaa", "n_1", "text")
        self.assertEqual(R.load_value(inside, self.env), "y" * (R.LARGE_VALUE_CHARS + 5))


class ArmingTest(_Case):
    def test_flow_apply_cannot_switch_a_trigger_on(self):
        flow, refs = self.apply([{"op": "add_node", "ref": "s", "type": "trigger.webhook",
                                  "params": {"active": True, "hook_id": "attacker-chosen"}}])
        params = self.trigger(flow)["params"]
        self.assertFalse(T.active(self.trigger(flow)))
        self.assertNotIn("hook_id", params)
        flow, _ = self.apply([{"op": "update_node", "node": refs.get("s") or self.trigger(flow)["id"],
                               "params": {"active": True}}], flow["id"], flow["revision"])
        self.assertFalse(T.active(self.trigger(flow)))

    def test_user_activation_survives_edits_and_agents_may_switch_off(self):
        flow, _ = self.apply([{"op": "add_node", "ref": "s", "type": "trigger.schedule",
                               "params": {"schedule": "every 1h"}}])
        nid = self.trigger(flow)["id"]

        def arm(f):
            next(n for n in f["nodes"] if n["id"] == nid)["params"]["active"] = True
        flow = S.modify_flow(self.env, flow["id"], arm, allow_arming=True)      # the trigger action's path
        self.assertTrue(T.active(self.trigger(flow)))
        flow, _ = self.apply([{"op": "update_node", "node": nid, "params": {"schedule": "every 2h"}}],
                             flow["id"], flow["revision"])
        self.assertTrue(T.active(self.trigger(flow)), "an ordinary edit keeps the user's activation")
        flow, _ = self.apply([{"op": "update_node", "node": nid, "params": {"active": False}}],
                             flow["id"], flow["revision"])
        self.assertFalse(T.active(self.trigger(flow)), "switching off is always allowed")

    def test_canvas_save_cannot_arm(self):
        flow, _ = self.apply([{"op": "add_node", "ref": "s", "type": "trigger.schedule",
                               "params": {"schedule": "every 1h"}}])
        self.trigger(flow)["params"]["active"] = True
        saved = S.save_flow(self.env, flow, base_revision=flow["revision"])
        self.assertFalse(T.active(self.trigger(saved)))


class QuietFeedTest(_Case):
    def test_no_new_items_is_a_quiet_poll(self):
        items = [{"id": "a", "title": "A", "link": "https://e.example/a", "summary": ""}]
        flow, _ = self.apply([{"op": "add_node", "ref": "f", "type": "trigger.rss",
                               "params": {"url": "https://e.example/feed", "every_minutes": 5}}])
        node = self.trigger(flow)
        now = [1_800_000_000.0]
        sched = T.Scheduler(lambda: self.env, clock=lambda: now[0], eligible_fn=lambda: True)
        original = T.fetch_feed
        T.fetch_feed = lambda url: list(items)
        try:
            st = {}
            events, upd = sched._check(self.env, flow, node, st, now[0], False)      # first poll: remember
            st.update(upd)
            now[0] += 600
            events, upd = sched._check(self.env, flow, node, st, now[0], False)      # same feed: nothing new
            self.assertEqual(events, [])
            self.assertEqual(upd["polled_at"], now[0])
            self.assertEqual(upd["next"], now[0] + 300)
        finally:
            T.fetch_feed = original


if __name__ == "__main__":
    unittest.main()
