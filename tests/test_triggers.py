"""Trigger nodes: schedule parsing and due logic, RSS/Atom parsing, webhook tokens + loopback listener, and real
triggered runs through the runner (event on the firing node, other triggers idle)."""
import asyncio
import json
import os
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from unittest.mock import patch

import helpers

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>Third</title><link>https://ex.org/3</link><guid>g3</guid><description>&lt;p&gt;Hello &amp; bye&lt;/p&gt;</description></item>
<item><title>Second</title><link>https://ex.org/2</link><guid>g2</guid><description>two</description></item>
<item><title>First</title><link>https://ex.org/1</link><guid>g1</guid></item>
</channel></rss>"""
ATOM = b"""<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title>Atom one</title><id>urn:a1</id><link rel="alternate" href="https://ex.org/a1"/><summary>s1</summary>
<updated>2026-11-12T10:00:00Z</updated></entry></feed>"""


class ScheduleParseTest(unittest.TestCase):
    def setUp(self):
        self.T = helpers.load_engine().triggers

    def test_intervals_and_their_minimum(self):
        self.assertEqual(self.T.parse_schedule("every 15m")["seconds"], 900)
        self.assertEqual(self.T.parse_schedule("Every 2 hours")["seconds"], 7200)
        self.assertEqual(self.T.parse_schedule("alle 30 min")["seconds"], 1800)
        self.assertEqual(self.T.parse_schedule("hourly")["seconds"], 3600)
        with self.assertRaises(self.T.ScheduleError):
            self.T.parse_schedule("every 10s")
        with self.assertRaises(self.T.ScheduleError):
            self.T.parse_schedule("every 5 fortnights")

    def test_calendar_forms_english_german_and_cron(self):
        d = self.T.parse_schedule("weekdays 08:00, 18:30")
        self.assertEqual((d["days"], d["slots"]), (set(range(5)), {(8, 0), (18, 30)}))
        self.assertEqual(self.T.parse_schedule("täglich um 7:15 Uhr")["slots"], {(7, 15)})
        self.assertEqual(self.T.parse_schedule("werktags 07:30")["days"], set(range(5)))
        self.assertEqual(self.T.parse_schedule("mon,fri 09:30")["days"], {0, 4})
        self.assertEqual(self.T.parse_schedule("di-do 10:00")["days"], {1, 2, 3})
        self.assertEqual(self.T.parse_schedule("sa-mo 10:00")["days"], {5, 6, 0})
        cron = self.T.parse_schedule("cron 0 8 * * 1-5")
        self.assertEqual((cron["minutes"], cron["hours"], cron["days"]), ({0}, {8}, set(range(5))))
        self.assertEqual(self.T.parse_schedule("*/15 * * * *")["minutes"], {0, 15, 30, 45})
        self.assertEqual(self.T.parse_schedule("0 9 * * 0")["days"], {6})       # cron Sunday = 0
        for bad in ("", "sometime", "daily 25:00", "blursday 08:00", "0 8 * * 9"):
            with self.assertRaises(self.T.ScheduleError, msg=bad):
                self.T.parse_schedule(bad)

    def test_next_slot_walks_to_the_next_matching_local_minute(self):
        spec = self.T.parse_schedule("weekdays 08:00")
        fri_9 = datetime(2026, 11, 13, 9, 0).timestamp()          # a Friday, after 08:00
        self.assertEqual(datetime.fromtimestamp(self.T.next_slot(spec, fri_9)), datetime(2026, 11, 16, 8, 0))
        cron = self.T.parse_schedule("30 6 1 * *")                 # first of each month 06:30
        self.assertEqual(datetime.fromtimestamp(self.T.next_slot(cron, fri_9)), datetime(2026, 12, 1, 6, 30))

    def test_due_logic_interval_calendar_grace_and_missed_slots(self):
        T = self.T
        every = T.parse_schedule("every 1h")
        t0 = datetime(2026, 11, 12, 10, 0).timestamp()
        self.assertEqual(T.schedule_due(every, {"armed_at": t0}, t0 + 1800)[:2], (False, t0 + 3600))
        self.assertTrue(T.schedule_due(every, {"armed_at": t0}, t0 + 3600)[0])
        fire, nxt, _ = T.schedule_due(every, {"armed_at": t0, "last_fire": t0}, t0 + 5 * 3600)   # down for hours
        self.assertTrue(fire)                                      # one catch-up run, not five
        self.assertEqual(nxt, t0 + 6 * 3600)
        daily = T.parse_schedule("daily 11:00")
        self.assertFalse(T.schedule_due(daily, {"armed_at": t0}, t0 + 1800)[0])
        self.assertTrue(T.schedule_due(daily, {"armed_at": t0}, t0 + 3600 + 60)[0])
        late = T.schedule_due(daily, {"armed_at": t0}, t0 + 3 * 3600)               # 2 h late: skipped
        self.assertFalse(late[0])
        self.assertEqual(datetime.fromtimestamp(late[1]), datetime(2026, 11, 13, 11, 0))


class FeedTest(unittest.TestCase):
    def setUp(self):
        self.T = helpers.load_engine().triggers

    def test_rss_and_atom_items(self):
        items = self.T.parse_feed(RSS)
        self.assertEqual([i["id"] for i in items], ["g3", "g2", "g1"])
        self.assertEqual(items[0]["summary"], "Hello & bye")
        self.assertEqual(items[0]["link"], "https://ex.org/3")
        atom = self.T.parse_feed(ATOM)
        self.assertEqual((atom[0]["id"], atom[0]["link"], atom[0]["summary"]), ("urn:a1", "https://ex.org/a1", "s1"))

    def test_hostile_documents_are_refused(self):
        bomb = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>'
        with self.assertRaises(ValueError):
            self.T.parse_feed(bomb)
        with self.assertRaises(ValueError):
            self.T.parse_feed(b"not xml at all")
        with self.assertRaises(ValueError):
            self.T.fetch_feed("file:///etc/passwd")


class _Env:
    def __init__(self, engine, ctx):
        self.engine, self.ctx = engine, ctx
        self.state = {"tool_source": lambda: []}

    def __call__(self):
        return self.engine.env.Env(ctx=self.ctx, state=self.state)


class TriggeredRunTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.E = helpers.load_engine()
        self.T = self.E.triggers
        self.make_env = _Env(self.E, helpers.FakeCtx({}))
        self.env = self.make_env()
        self.types = self.E.nodes.types_by_name(self.env)
        self.now = [datetime(2026, 11, 12, 10, 0).timestamp()]
        self.sched = self.T.Scheduler(self.make_env, clock=lambda: self.now[0], eligible_fn=lambda: True)

    def flow(self, *trigger_nodes, active=True):
        ops = []
        for ref, ntype, params in trigger_nodes:
            ops.append({"op": "add_node", "ref": ref, "type": ntype, "title": ref,
                        "params": {**params, "active": active}})
            ops.append({"op": "add_node", "ref": ref + "_out", "type": "text.template", "title": ref + " out",
                        "params": {"template": "got {{v}}"}})
            port = {"trigger.schedule": "time", "trigger.rss": "title", "trigger.webhook": "text"}[ntype]
            ops.append({"op": "connect", "from": f"{ref}.{port}", "to": f"{ref}_out.v"})
        flow, results = self.E.graph.apply_ops(self.E.graph.new_flow("Triggered"), ops, self.types)
        self.refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
        return self.E.store.save_flow(self.env, flow, create=True)

    def wait_run(self, run_id):
        self.E.runner.wait(self.env, run_id, 15)
        return self.E.runner.get_run(self.env, run_id)

    def test_schedule_fires_once_per_slot_and_other_triggers_stay_idle(self):
        flow = self.flow(("clock", "trigger.schedule", {"schedule": "every 1h"}),
                         ("hook", "trigger.webhook", {}))
        self.assertEqual(self.sched.tick(self.env), [])            # armed now; first run in an hour
        self.now[0] += 3600
        started = self.sched.tick(self.env)
        self.assertEqual(len(started), 1)
        run = self.wait_run(started[0][2])
        self.assertEqual(run["status"], "done")
        self.assertEqual(run["trigger"]["node"], self.refs["clock"])
        out = run["nodes"][self.refs["clock_out"]]
        self.assertEqual(out["status"], "done")
        self.assertTrue(str(out["outputs"]["text"]).startswith("got 2026-11-12T11:00"))
        hook_out = run["nodes"][self.refs["hook_out"]]
        self.assertEqual((hook_out["status"], hook_out.get("skip")), ("skipped", "branch"))   # idle trigger
        self.assertEqual(self.sched.tick(self.env), [])            # same hour: nothing new
        st = self.T.load_state(self.env)[self.T.key(flow["id"], self.refs["clock"])]
        self.assertEqual(st["fires"], 1)
        self.assertEqual(st["next"], self.now[0] + 3600)

    def test_inactive_triggers_never_fire_and_editing_the_schedule_rearms(self):
        flow = self.flow(("clock", "trigger.schedule", {"schedule": "every 1h"}), active=False)
        self.now[0] += 10 * 3600
        self.assertEqual(self.sched.tick(self.env), [])
        self.assertEqual(self.T.load_state(self.env), {})
        self.E.store.modify_flow(self.env, flow["id"], lambda f: next(
            n for n in f["nodes"] if n["id"] == self.refs["clock"])["params"].update(active=True))
        self.sched.tick(self.env)
        self.now[0] += 1800
        self.E.store.modify_flow(self.env, flow["id"], lambda f: next(
            n for n in f["nodes"] if n["id"] == self.refs["clock"])["params"].update(schedule="every 2h"))
        self.now[0] += 3600                                         # 1.5 h after arming, 1 h after the edit
        self.assertEqual(self.sched.tick(self.env), [])

    def test_rss_remembers_first_then_runs_once_per_new_item_oldest_first(self):
        feed = [RSS]
        flow = self.flow(("news", "trigger.rss", {"url": "https://ex.org/feed", "every_minutes": 5}))
        with patch.object(self.T, "fetch_feed", side_effect=lambda url: self.T.parse_feed(feed[0])):
            self.assertEqual(self.sched.tick(self.env), [])        # baseline: 3 existing items
            feed[0] = RSS.replace(b"<item><title>Third", b"<item><title>Fifth</title><guid>g5</guid></item>"
                                  b"<item><title>Fourth</title><guid>g4</guid></item><item><title>Third")
            self.now[0] += 301
            first = self.sched.tick(self.env)
            self.assertEqual(len(first), 1)
            run = self.wait_run(first[0][2])
            self.assertEqual(run["nodes"][self.refs["news_out"]]["outputs"]["text"], "got Fourth")
            self.now[0] += 1                                        # the pending item, without a new poll
            second = self.sched.tick(self.env)
            run = self.wait_run(second[0][2])
            self.assertEqual(run["nodes"][self.refs["news_out"]]["outputs"]["text"], "got Fifth")
            self.assertEqual(self.sched.tick(self.env), [])
        st = self.T.load_state(self.env)[self.T.key(flow["id"], self.refs["news"])]
        self.assertEqual(st["seen"][:2], ["g5", "g4"])

    def test_feed_errors_are_kept_on_the_trigger_and_do_not_stop_others(self):
        flow = self.flow(("news", "trigger.rss", {"url": "https://ex.org/feed"}),)
        with patch.object(self.T, "fetch_feed", side_effect=ValueError("feed down")):
            self.sched.tick(self.env)
        info = self.T.status(self.env, self.E.store.get_flow(self.env, flow["id"]))["nodes"][self.refs["news"]]
        self.assertEqual(info["error"], "feed down")

    def test_manual_run_samples_now_and_the_last_webhook(self):
        flow = self.flow(("clock", "trigger.schedule", {"schedule": "daily 08:00"}), ("hook", "trigger.webhook", {}),
                         active=False)
        run = self.E.runner.run_sync(self.env, flow["id"], timeout_s=15)
        self.assertEqual(run["status"], "done")
        self.assertTrue(run["nodes"][self.refs["clock_out"]]["outputs"]["text"].startswith("got 20"))
        self.assertEqual(run["nodes"][self.refs["hook_out"]]["outputs"]["text"], "got ")

    def test_validation_names_bad_schedules_and_missing_feed_urls(self):
        flow = self.flow(("clock", "trigger.schedule", {"schedule": "whenever"}),
                         ("news", "trigger.rss", {"url": ""}), active=False)
        msgs = {i["node"]: i["message"] for i in self.E.graph.validate(flow, self.types) if i["level"] == "error"}
        self.assertIn("schedule:", msgs[self.refs["clock"]])
        self.assertIn("feed URL", msgs[self.refs["news"]])

    def test_a_step_fed_by_two_triggers_is_flagged_unless_merged(self):
        ops = [{"op": "add_node", "ref": "a", "type": "trigger.schedule", "title": "Clock", "params": {"schedule": "every 1h"}},
               {"op": "add_node", "ref": "b", "type": "trigger.webhook", "title": "Hook"},
               {"op": "add_node", "ref": "t", "type": "text.template", "title": "Both", "params": {"template": "{{x}} {{y}}"}},
               {"op": "connect", "from": "a.time", "to": "t.x"}, {"op": "connect", "from": "b.text", "to": "t.y"}]
        flow, _ = self.E.graph.apply_ops(self.E.graph.new_flow("j"), ops, self.types)
        warn = [i for i in self.E.graph.validate(flow, self.types) if "several triggers" in i["message"]]
        self.assertEqual(len(warn), 1)
        self.assertIn("Clock, Hook", warn[0]["message"])
        merged, _ = self.E.graph.apply_ops(self.E.graph.new_flow("m"), [
            ops[0], ops[1], {"op": "add_node", "ref": "m", "type": "logic.merge"},
            {"op": "add_node", "ref": "t", "type": "text.template", "params": {"template": "{{x}}"}},
            {"op": "connect", "from": "a.time", "to": "m.value"}, {"op": "connect", "from": "b.text", "to": "m.value"},
            {"op": "connect", "from": "m.value", "to": "t.x"}], self.types)
        self.assertFalse([i for i in self.E.graph.validate(merged, self.types) if "several triggers" in i["message"]])
        run = self.E.runner.run_sync(self.env, self.E.store.save_flow(self.env, merged, create=True)["id"], timeout_s=15)
        self.assertEqual(run["status"], "done")

    def test_copies_and_templates_never_arrive_armed(self):
        flow = self.flow(("hook", "trigger.webhook", {"hook_id": "a" * 24}))
        copy_ = self.E.store.duplicate_flow(self.env, flow["id"])
        node = next(n for n in copy_["nodes"] if n["type"] == "trigger.webhook")
        self.assertFalse(node["params"]["active"])
        self.assertNotIn("hook_id", node["params"])
        tpl = self.E.store.template_from_flow(flow)
        self.assertFalse(next(n for n in tpl["nodes"] if n["type"] == "trigger.webhook")["params"]["active"])

    def test_build_with_hermes_cannot_switch_triggers(self):
        G = self.E.generate
        base = self.flow(("clock", "trigger.schedule", {"schedule": "every 1h"}))
        cand = json.loads(json.dumps(base))
        for n in cand["nodes"]:
            if n["type"] == "trigger.schedule":
                n["params"]["active"] = False
        cand["nodes"].append({"id": "n_000099", "type": "trigger.webhook", "params": {"active": True, "hook_id": "b" * 24}})
        G.keep_trigger_arming(base, cand)
        by_id = {n["id"]: n for n in cand["nodes"]}
        self.assertTrue(by_id[self.refs["clock"]]["params"]["active"])        # existing: kept on
        self.assertFalse(by_id["n_000099"]["params"]["active"])               # new: off, no URL
        self.assertNotIn("hook_id", by_id["n_000099"]["params"])


class WebhookTest(TriggeredRunTest):
    def test_tokens_bind_flow_node_and_hook_id(self):
        flow = self.flow(("hook", "trigger.webhook", {"hook_id": "c" * 24}))
        node = next(n for n in flow["nodes"] if n["type"] == "trigger.webhook")
        url = self.T.webhook_url(self.env, flow["id"], node, port=9999)
        token = url.rsplit("/", 1)[1]
        self.assertEqual(len(token), 40)
        self.assertIsNotNone(self.T.check_hook(self.env, flow["id"], node["id"], token))
        self.assertIsNone(self.T.check_hook(self.env, flow["id"], node["id"], token[:-1] + ("0" if token[-1] != "0" else "1")))
        self.assertIsNone(self.T.check_hook(self.env, flow["id"], "n_other", token))

    def test_listener_starts_a_run_with_the_posted_json_and_refuses_bad_requests(self):
        os.environ["ARACHNE_FLOW_WEBHOOK_PORT"] = "0"     # any free port
        self.addCleanup(os.environ.pop, "ARACHNE_FLOW_WEBHOOK_PORT", None)
        flow = self.flow(("hook", "trigger.webhook", {"hook_id": "d" * 24}))
        self.sched.tick(self.env)
        self.addCleanup(self.sched.shutdown)
        self.assertIsNotNone(self.sched.server)
        port = self.sched.server.server_address[1]
        node = next(n for n in flow["nodes"] if n["type"] == "trigger.webhook")
        url = self.T.webhook_url(self.env, flow["id"], node, port=port)

        def post(target, data, ctype="application/json"):
            req = urllib.request.Request(target, data=data, method="POST", headers={"Content-Type": ctype})
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return resp.status, json.loads(resp.read())
            except urllib.error.HTTPError as err:
                return err.code, json.loads(err.read() or b"{}")

        status, body = post(url, b'{"hello": "world"}')
        self.assertEqual(status, 202)
        run = self.wait_run(body["run_id"])
        self.assertEqual(run["nodes"][self.refs["hook"]]["outputs"]["body"], {"hello": "world"})
        self.assertEqual(run["nodes"][self.refs["hook_out"]]["outputs"]["text"], 'got {"hello": "world"}')
        self.assertEqual(post(url[:-3] + "fff", b"{}")[0], 404)
        self.assertEqual(post(f"http://127.0.0.1:{port}/other", b"{}")[0], 404)
        big = b"x" * (self.T.WEBHOOK_MAX_BYTES + 1)
        self.assertEqual(post(url, big, "text/plain")[0], 413)
        # switched off: the same URL stops working at once
        self.E.store.modify_flow(self.env, flow["id"], lambda f: next(
            n for n in f["nodes"] if n["type"] == "trigger.webhook")["params"].update(active=False))
        self.assertEqual(post(url, b"{}")[0], 404)
        self.sched.tick(self.env)
        self.assertIsNone(self.sched.server)                       # no active webhook: listener closed

    def test_requests_for_a_busy_flow_queue_and_run_next(self):
        flow = self.flow(("hook", "trigger.webhook", {"hook_id": "e" * 24}))
        node = next(n for n in flow["nodes"] if n["type"] == "trigger.webhook")
        token = self.T.webhook_url(self.env, flow["id"], node, port=1).rsplit("/", 1)[1]
        with patch.object(self.E.runner, "active_runs", return_value=[object()]):
            status, body = self.sched.receive(self.env, flow["id"], node["id"], token, b"queued")
        self.assertEqual((status, body["queued"]), (202, True))
        started = self.sched.tick(self.env)
        run = self.wait_run(started[0][2])
        self.assertEqual(run["nodes"][self.refs["hook_out"]]["outputs"]["text"], "got queued")


class LeaderTest(unittest.TestCase):
    def test_only_one_holder_and_release_on_close(self):
        T = helpers.load_engine().triggers
        path = os.path.join(helpers.temp_data_dir(), "locks", "triggers.lock")
        a, b = T._Leader(path), T._Leader(path)
        self.assertTrue(a.acquire())
        self.assertFalse(b.acquire())
        self.assertEqual(open(path + ".pid").read(), str(os.getpid()))
        a.release()
        self.assertTrue(b.acquire())
        b.release()

    def test_only_long_lived_processes_are_eligible(self):
        T = helpers.load_engine().triggers
        with patch.dict(os.environ, {"ARACHNE_FLOW_TRIGGERS": ""}), patch.object(T.sys, "argv", ["hermes", "chat"]):
            self.assertFalse(T.eligible())
            self.assertTrue(T.eligible(dashboard=True))
        with patch.dict(os.environ, {"ARACHNE_FLOW_TRIGGERS": ""}), \
                patch.object(T.sys, "argv", ["python", "-m", "hermes_cli.main", "gateway", "run"]):
            self.assertTrue(T.eligible())
        with patch.dict(os.environ, {"ARACHNE_FLOW_TRIGGERS": "0"}):
            self.assertFalse(T.eligible(dashboard=True))


if __name__ == "__main__":
    unittest.main()
