"""A2: flow/run storage on disk (always in a temp data dir)."""
import json
import os
import shutil
import tempfile
import threading
import time as _time
import unittest

import helpers

E = helpers.load_engine()
S, G = E.store, E.graph


def make_env(templates=None):
    data = helpers.temp_data_dir()
    tdir = tempfile.mkdtemp(prefix="arachne-flow-tpl-")
    for tid, body in (templates or {}).items():
        with open(os.path.join(tdir, tid + ".json"), "w", encoding="utf-8") as fh:
            json.dump(body, fh)
    return E.env.Env(state={}, data_dir=data, templates_dir=tdir)


def run_record(flow_id, run_id=None, status="done", started="2026-11-05T01:00:00Z", nodes=None):
    return {"id": run_id or S.new_run_id(), "flow_id": flow_id, "flow_revision": 1, "status": status,
            "started_at": started, "finished_at": None, "ms": 5, "target_node": None, "fresh": False,
            "nodes": nodes or {}, "issues": []}


TEMPLATE = {
    "schema": "arachne-flow/1", "name": "Prompt to image", "description": "demo",
    "nodes": [{"id": "n_000001", "type": "input.text", "x": 80, "y": 80, "params": {"value": "robot"}},
              {"id": "n_000002", "type": "tool:image_generate", "x": 380, "y": 80, "params": {}}],
    "edges": [{"id": "e_000001", "from": {"node": "n_000001", "port": "text"},
               "to": {"node": "n_000002", "port": "prompt"}}],
}


class FlowCrudTest(unittest.TestCase):
    def setUp(self):
        self.env = make_env({"prompt-image": TEMPLATE})
        self.addCleanup(shutil.rmtree, self.env.data_dir, True)
        self.addCleanup(shutil.rmtree, self.env.templates_dir, True)

    def test_data_dir_from_env_var_when_env_has_none(self):
        env = E.env.Env(state={})
        self.assertEqual(S.data_dir(env), os.environ["ARACHNE_FLOW_DATA_DIR"])

    def test_create_get_roundtrip(self):
        flow = S.create_flow(self.env, name="Mine")
        self.assertRegex(flow["id"], G.FLOW_ID_RE)
        self.assertEqual(flow["revision"], 1)
        self.assertEqual(S.get_flow(self.env, flow["id"]), flow)
        self.assertTrue(os.path.isfile(os.path.join(self.env.data_dir, "flows", flow["id"] + ".json")))

    def test_save_bumps_revision_and_keeps_created_at(self):
        flow = S.create_flow(self.env, name="A")
        flow["name"] = "B"
        saved = S.save_flow(self.env, flow, base_revision=1)
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(saved["created_at"], flow["created_at"])
        self.assertEqual(S.get_flow(self.env, flow["id"])["name"], "B")

    def test_stale_base_revision_conflicts(self):
        flow = S.create_flow(self.env)
        S.save_flow(self.env, flow, base_revision=1)
        with self.assertRaises(S.ConflictError) as cm:
            S.save_flow(self.env, flow, base_revision=1)
        self.assertEqual(cm.exception.current_revision, 2)
        self.assertEqual(S.get_flow(self.env, flow["id"])["revision"], 2)

    def test_save_without_base_revision_skips_check(self):
        flow = S.create_flow(self.env)
        S.save_flow(self.env, flow)
        self.assertEqual(S.save_flow(self.env, flow)["revision"], 3)

    def test_save_unknown_flow_is_not_found(self):
        with self.assertRaises(S.NotFoundError):
            S.save_flow(self.env, G.new_flow("x"))

    def test_bad_ids_rejected(self):
        for bad in ("../etc", "f_123", None, "f_zzzzzzzzzz"):
            with self.assertRaises(S.StoreError):
                S.get_flow(self.env, bad)

    def test_save_rejects_malformed_flow(self):
        flow = S.create_flow(self.env)
        flow["nodes"] = "nope"
        with self.assertRaises(S.StoreError):
            S.save_flow(self.env, flow)

    def test_modify_flow_applies_ops(self):
        flow = S.create_flow(self.env)
        types = {"input.text": {"type": "input.text", "inputs": [], "outputs": [{"name": "text", "type": "text"}]}}

        def mutate(f):
            out, _ = G.apply_ops(f, [{"op": "add_node", "type": "input.text"}], types)
            return out
        saved = S.modify_flow(self.env, flow["id"], mutate, base_revision=1)
        self.assertEqual(saved["revision"], 2)
        self.assertEqual(len(S.get_flow(self.env, flow["id"])["nodes"]), 1)
        with self.assertRaises(S.ConflictError):
            S.modify_flow(self.env, flow["id"], mutate, base_revision=1)

    def test_list_flows_summaries(self):
        a = S.create_flow(self.env, name="A")
        b = S.create_flow(self.env, template="prompt-image")
        S.save_run(self.env, run_record(b["id"], status="error"))
        summaries = {s["id"]: s for s in S.list_flows(self.env)}
        self.assertEqual(set(summaries), {a["id"], b["id"]})
        self.assertEqual(summaries[b["id"]]["node_count"], 2)
        self.assertEqual(summaries[b["id"]]["last_run"]["status"], "error")
        self.assertIsNone(summaries[a["id"]]["last_run"])
        self.assertEqual(set(summaries[a["id"]]),
                         {"id", "name", "description", "updated_at", "revision", "node_count", "last_run"})

    def test_list_skips_corrupt_files(self):
        S.create_flow(self.env, name="ok")
        with open(os.path.join(S.flows_dir(self.env), "f_0123456789.json"), "w") as fh:
            fh.write("{broken")
        self.assertEqual([s["name"] for s in S.list_flows(self.env)], ["ok"])

    def test_delete_moves_to_trash_and_restore(self):
        flow = S.create_flow(self.env, name="gone")
        S.delete_flow(self.env, flow["id"])
        self.assertFalse(S.flow_exists(self.env, flow["id"]))
        self.assertEqual(S.list_flows(self.env), [])
        trash = S.list_trash(self.env)
        self.assertEqual([t["id"] for t in trash], [flow["id"]])
        with self.assertRaises(S.NotFoundError):
            S.delete_flow(self.env, flow["id"])
        restored = S.restore_flow(self.env, flow["id"])
        self.assertEqual(restored["name"], "gone")
        self.assertEqual(S.list_trash(self.env), [])

    def test_duplicate_gets_fresh_ids(self):
        src = S.create_flow(self.env, template="prompt-image")
        dup = S.duplicate_flow(self.env, src["id"])
        self.assertNotEqual(dup["id"], src["id"])
        self.assertEqual(dup["name"], "Prompt to image (copy)")
        self.assertEqual(dup["revision"], 1)
        self.assertFalse({n["id"] for n in dup["nodes"]} & {n["id"] for n in src["nodes"]})
        ids = {n["id"] for n in dup["nodes"]}
        for e in dup["edges"]:
            self.assertIn(e["from"]["node"], ids)
            self.assertIn(e["to"]["node"], ids)

    def test_find_flow_by_id_name_prefix(self):
        a = S.create_flow(self.env, name="Prompt to 3D")
        S.create_flow(self.env, name="Prompt to image")
        self.assertEqual(S.find_flow(self.env, a["id"])["id"], a["id"])
        self.assertEqual(S.find_flow(self.env, "prompt to 3d")["id"], a["id"])
        self.assertEqual(S.find_flow(self.env, "Prompt to 3")["id"], a["id"])
        with self.assertRaises(S.StoreError):
            S.find_flow(self.env, "Prompt")
        with self.assertRaises(S.NotFoundError):
            S.find_flow(self.env, "nothing")

    def test_concurrent_saves_never_lose_revisions(self):
        flow = S.create_flow(self.env)
        errors = []

        def bump():
            try:
                for _ in range(10):
                    S.modify_flow(self.env, flow["id"], lambda f: f.update(description=f["description"] + "x"))
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        threads = [threading.Thread(target=bump) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        final = S.get_flow(self.env, flow["id"])
        self.assertEqual(final["revision"], 41)
        self.assertEqual(len(final["description"]), 40)
        leftovers = [n for n in os.listdir(S.flows_dir(self.env)) if n.startswith(".tmp-")]
        self.assertEqual(leftovers, [])

    def test_locks_live_in_env_state(self):
        a = S.lock(self.env, "flow:x")
        self.assertIs(S.lock(self.env, "flow:x"), a)
        self.assertIn("flow:x", self.env.state["store_locks"])


class TemplateTest(unittest.TestCase):
    def setUp(self):
        self.env = make_env({"prompt-image": TEMPLATE, "broken": {}})
        with open(os.path.join(self.env.templates_dir, "bad.json"), "w") as fh:
            fh.write("not json")
        self.addCleanup(shutil.rmtree, self.env.data_dir, True)
        self.addCleanup(shutil.rmtree, self.env.templates_dir, True)

    def test_create_from_template_has_fresh_ids(self):
        flow = S.create_flow(self.env, template="prompt-image")
        self.assertEqual(flow["name"], "Prompt to image")
        self.assertEqual(flow["description"], "demo")
        self.assertNotIn("n_000001", {n["id"] for n in flow["nodes"]})
        self.assertEqual(flow["edges"][0]["to"]["node"], flow["nodes"][1]["id"])
        self.assertEqual(flow["template"], "prompt-image")

    def test_template_name_override(self):
        self.assertEqual(S.create_flow(self.env, name="X", template="prompt-image")["name"], "X")

    def test_unknown_or_bad_template(self):
        with self.assertRaises(S.NotFoundError):
            S.create_flow(self.env, template="nope")
        with self.assertRaises(S.StoreError):
            S.create_flow(self.env, template="../x")

    def test_list_templates_availability(self):
        listed = {t["id"]: t for t in S.list_templates(self.env, known_types={"input.text"})}
        self.assertNotIn("bad", listed)
        self.assertFalse(listed["prompt-image"]["available"])
        self.assertEqual(listed["prompt-image"]["missing_tools"], ["image_generate"])
        ok = {t["id"]: t for t in S.list_templates(self.env, {"input.text", "tool:image_generate"})}
        self.assertTrue(ok["prompt-image"]["available"])
        unchecked = {t["id"]: t for t in S.list_templates(self.env)}
        self.assertTrue(unchecked["prompt-image"]["available"])
        self.assertEqual(unchecked["broken"]["name"], "broken")

    def test_bundled_templates_dir_default(self):
        env = E.env.Env(state={}, data_dir=self.env.data_dir)
        self.assertEqual(os.path.normcase(S.templates_dir(env)),
                         os.path.normcase(os.path.join(helpers.ROOT, "templates")))
        self.assertIsInstance(S.list_templates(env), list)


class RunStoreTest(unittest.TestCase):
    def setUp(self):
        self.env = make_env()
        self.addCleanup(shutil.rmtree, self.env.data_dir, True)
        self.addCleanup(shutil.rmtree, self.env.templates_dir, True)
        self.flow = S.create_flow(self.env)

    def test_save_load_list(self):
        run = run_record(self.flow["id"], nodes={"n_aaaaaa": {"status": "done"}, "n_bbbbbb": {"status": "error"}})
        S.save_run(self.env, run)
        self.assertEqual(S.load_run(self.env, run["id"]), run)
        [summary] = S.list_runs(self.env, self.flow["id"])
        self.assertEqual(summary["id"], run["id"])
        self.assertEqual(summary["node_counts"], {"done": 1, "error": 1})
        self.assertNotIn("nodes", summary)
        with self.assertRaises(S.NotFoundError):
            S.load_run(self.env, S.new_run_id())
        with self.assertRaises(S.StoreError):
            S.load_run(self.env, "../../x")

    def test_list_newest_first_with_limit_and_all_flows(self):
        other = S.create_flow(self.env)
        for i in range(5):
            S.save_run(self.env, run_record(self.flow["id"], started=f"2026-11-05T01:00:0{i}Z"))
        S.save_run(self.env, run_record(other["id"], started="2026-11-05T02:00:00Z"))
        runs = S.list_runs(self.env, self.flow["id"], limit=3)
        self.assertEqual([r["started_at"][-3:-1] for r in runs], ["04", "03", "02"])
        self.assertEqual(len(S.list_runs(self.env)), 6)
        self.assertEqual(S.list_runs(self.env)[0]["flow_id"], other["id"])

    def test_prune_keeps_30_and_deletes_outputs(self):
        ids = []
        for i in range(32):
            run = run_record(self.flow["id"], started=f"2026-11-05T01:{i:02d}:00Z")
            os.makedirs(S.outputs_dir(self.env, run["id"]), exist_ok=True)
            with open(os.path.join(S.outputs_dir(self.env, run["id"]), "x.txt"), "w") as fh:
                fh.write("x")
            S.save_run(self.env, run)
            ids.append(run["id"])
        kept = {r["id"] for r in S.list_runs(self.env, self.flow["id"], limit=None)}
        self.assertEqual(kept, set(ids[2:]))
        for gone in ids[:2]:
            self.assertFalse(os.path.exists(os.path.join(self.env.data_dir, "outputs", gone)))
        self.assertTrue(os.path.exists(S.outputs_dir(self.env, ids[-1], create=False)))

    def test_prune_never_removes_active_runs(self):
        active = run_record(self.flow["id"], status="running", started="2026-11-05T00:00:00Z")
        S.save_run(self.env, active)
        for i in range(3):
            S.save_run(self.env, run_record(self.flow["id"], started=f"2026-11-05T01:0{i}:00Z"))
        removed = S.prune_runs(self.env, self.flow["id"], keep=1)
        self.assertEqual(len(removed), 2)
        self.assertEqual(S.load_run(self.env, active["id"])["status"], "running")

    def test_resave_does_not_prune(self):
        run = run_record(self.flow["id"])
        S.save_run(self.env, run, keep=0)  # first save prunes (itself is done, keep=0 removes it)
        run2 = run_record(self.flow["id"], status="running")
        S.save_run(self.env, run2, keep=0)
        run2["status"] = "done"
        S.save_run(self.env, run2, keep=0)  # update in place: no prune
        self.assertEqual(S.load_run(self.env, run2["id"])["status"], "done")

    def test_delete_run(self):
        run = run_record(self.flow["id"])
        S.save_run(self.env, run)
        S.delete_run(self.env, run["id"])
        self.assertEqual(S.list_runs(self.env, self.flow["id"]), [])

    def test_mark_interrupted(self):
        stale = run_record(self.flow["id"], status="running",
                           nodes={"n_aaaaaa": {"status": "done"}, "n_bbbbbb": {"status": "running"},
                                  "n_cccccc": {"status": "queued"}})
        live = run_record(self.flow["id"], status="running")
        S.save_run(self.env, stale)
        S.save_run(self.env, live)
        fixed = S.mark_interrupted(self.env, active_ids=[live["id"]])
        self.assertEqual(fixed, [stale["id"]])
        got = S.load_run(self.env, stale["id"])
        self.assertEqual((got["status"], got["error"]), ("error", "interrupted"))
        self.assertEqual({k: v["status"] for k, v in got["nodes"].items()},
                         {"n_aaaaaa": "done", "n_bbbbbb": "error", "n_cccccc": "skipped"})
        self.assertEqual(S.load_run(self.env, live["id"])["status"], "running")

    # Review E-7: Desktop backend, gateway, CLI and cron share plugin-data; only a dead owner interrupts a run.
    def owned(self, pid, boot, age_s=0.0):
        import time as _time
        run = run_record(self.flow["id"], status="running")
        run.update(owner={"pid": pid, "boot": boot}, heartbeat=_time.time() - age_s)
        return run

    def test_a_live_run_of_another_process_is_left_alone(self):
        other = self.owned(os.getpid(), "boot-other-process")
        S.save_run(self.env, other)
        self.assertEqual(S.mark_interrupted(self.env, boot="boot-this-process"), [])
        self.assertEqual(S.load_run(self.env, other["id"])["status"], "running")

    def test_dead_owner_stale_heartbeat_or_own_lost_run_is_interrupted(self):
        dead = self.owned(424242, "boot-dead")
        stale = self.owned(os.getpid(), "boot-hung", age_s=S.HEARTBEAT_STALE_S + 5)
        lost = self.owned(os.getpid(), "boot-this-process")      # ours, but no thread runs it any more
        legacy = run_record(self.flow["id"], status="running")   # written before E-7: no owner
        for run in (dead, stale, lost, legacy):
            S.save_run(self.env, run)
        fixed = S.mark_interrupted(self.env, boot="boot-this-process", pid_alive=lambda pid: pid == os.getpid())
        self.assertEqual(sorted(fixed), sorted(r["id"] for r in (dead, stale, lost, legacy)))

    def test_pid_alive(self):
        import subprocess
        import sys
        self.assertTrue(S.pid_alive(os.getpid()))
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        self.assertFalse(S.pid_alive(proc.pid))
        self.assertFalse(S.pid_alive(0))
        self.assertFalse(S.pid_alive("x"))

    def test_save_run_rejects_bad_ids(self):
        with self.assertRaises(S.StoreError):
            S.save_run(self.env, {"id": "x", "flow_id": self.flow["id"]})
        with self.assertRaises(S.StoreError):
            S.save_run(self.env, {"id": S.new_run_id(), "flow_id": "../x"})


class HousekeepingTest(unittest.TestCase):
    """Review E-12: trash and dropped uploads must not accumulate forever."""

    DAY = 24 * 3600
    OLD = 40 * DAY

    def setUp(self):
        self.env = make_env()
        self.addCleanup(shutil.rmtree, self.env.data_dir, True)
        self.addCleanup(shutil.rmtree, self.env.templates_dir, True)

    def upload(self, name="clip.mp4", age_s=0.0, digest="abc123def456"):
        path = os.path.join(S.uploads_dir(self.env), digest, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(b"media")
        when = _time.time() - age_s
        os.utime(path, (when, when))
        return path

    def flow_naming(self, path, title="File"):
        flow = S.create_flow(self.env, name="names " + title)
        flow["nodes"] = [{"id": "n_000001", "type": "input.file", "x": 0, "y": 0, "params": {"path": path}}]
        return S.save_flow(self.env, flow, base_revision=flow["revision"])

    def trash(self, flow_id, age_s=0.0):
        name = S.delete_flow(self.env, flow_id)
        path = os.path.join(S.trash_dir(self.env), name)
        when = _time.time() - age_s
        os.utime(path, (when, when))
        return path

    def test_old_trash_entries_go_and_recent_ones_stay(self):
        old = self.trash(S.create_flow(self.env, name="old")["id"], age_s=self.OLD)
        fresh = self.trash(S.create_flow(self.env, name="fresh")["id"], age_s=9 * self.DAY)
        counts = S.prune_stale_files(self.env)
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(fresh))
        self.assertEqual(counts["trash"], 1)
        self.assertEqual(len(S.list_trash(self.env)), 1)

    def test_old_upload_nobody_names_is_removed_with_its_hash_folder(self):
        old = self.upload(age_s=self.OLD)
        fresh = self.upload(name="new.mp4", age_s=5 * self.DAY, digest="fff000fff000")
        counts = S.prune_stale_files(self.env)
        self.assertFalse(os.path.exists(old))
        self.assertFalse(os.path.isdir(os.path.dirname(old)))   # the empty <hash>/ folder goes too
        self.assertTrue(os.path.exists(fresh))
        self.assertEqual(counts["uploads"], 1)

    def test_old_upload_named_by_a_flow_flow_params_is_kept(self):
        path = self.upload(age_s=self.OLD)
        self.flow_naming(path)
        counts = S.prune_stale_files(self.env)
        self.assertTrue(os.path.exists(path))
        self.assertEqual(counts["uploads"], 0)

    def test_old_upload_named_by_a_trashed_flow_is_kept(self):
        path = self.upload(age_s=self.OLD)
        flow = self.flow_naming(path, title="parked")
        self.trash(flow["id"], age_s=self.DAY)   # restorable, so its file must survive
        counts = S.prune_stale_files(self.env)
        self.assertTrue(os.path.exists(path))
        self.assertEqual(counts["uploads"], 0)

    def test_prune_keeps_everything_younger_than_the_cutoff(self):
        old = self.trash(S.create_flow(self.env, name="young")["id"], age_s=29 * self.DAY)
        upload = self.upload(age_s=29 * self.DAY)
        counts = S.prune_stale_files(self.env)
        self.assertTrue(os.path.exists(old))
        self.assertTrue(os.path.exists(upload))
        self.assertEqual(counts, {"trash": 0, "uploads": 0})

    def test_prune_never_scans_flows_when_no_upload_is_old(self):
        self.upload(age_s=self.DAY)
        scanned = []
        real = S._flow_strings
        S._flow_strings = lambda env: scanned.append(env) or real(env)
        self.addCleanup(setattr, S, "_flow_strings", real)
        S.prune_stale_files(self.env)
        self.assertEqual(scanned, [])   # cheap path: nothing to free, nothing to read


if __name__ == "__main__":
    unittest.main()
