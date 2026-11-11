"""Legacy spilled values that lost characters on disk must fail loops and Merge, not feed them.

``tests/test_legacy_spill.py`` covers ``runner.load_value`` and the straight node-to-node path. This
file covers the two remaining places a *cached* value is loaded: the For each loop (its list input, the
per-item Collect, and a Merge inside the body) and a Merge on the main path.

The corruption is the real historical shape, built end to end and never faked at the loader:

1. a real run spills a >64 KiB value and a real cache entry is written;
2. the entry is rewritten the way older engines stored it (``$large`` marker pointing at the producer
   run's own file, no ``media_dir``), so ``cache_get`` has to adopt it;
3. that file is rewritten with bytes a pre-``newline=""`` Windows text-mode write would have left
   (every LF became CRLF) while ``$large.chars`` still counts the LF-only text.

So the second run loads a value whose on-disk length disagrees with its metadata. Nothing here asks the
engine to repair, trim or guess: the only acceptable outcomes are an explicit corruption error, a run
that reports failure, and no node fed with the damaged text.

Every path touched is a real file under the per-test scratch dir; no engine function is patched, no
network or model call is made, and the repository is not written to.
"""
import json
import os
import re
import shutil
import tempfile
import threading
import time
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N = E.runner, E.store, E.graph, E.nodes

CORRUPTION_MESSAGE = r"length mismatch|corrupt|chars"
ROWS_TEXT = "row\n" * 20000          # 80 000 chars: over LARGE_VALUE_CHARS, one item per line
SPILLED_CHARS = len(ROWS_TEXT)


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def write_bytes(path, data):
    with open(path, "wb") as fh:
        fh.write(data)


def legacy_windows_bytes(text):
    """What a text-mode write without newline='' left on Windows: every LF became CRLF."""
    return text.encode("utf-8").replace(b"\n", b"\r\n")


def per_item_text(item):
    """The body tool's result: over 64 KiB with newlines, so it spills and the corruptible bytes exist."""
    return "echo:" + item + "\n" + "row\n" * 20000


TOOLS = [
    {"name": "spill", "toolset": "test", "read_only": True,
     "parameters": {"type": "object", "properties": {}}},
    {"name": "body", "toolset": "test", "read_only": True,
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "echo", "toolset": "test", "read_only": True,
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]


class Ctx(helpers.FakeCtx):
    """spill: a big text; body: a big per-item text that can block; echo: small downstream call."""

    def __init__(self, config=None):
        self.release = threading.Event()
        self.entered = []        # (monotonic, text) when a body call started
        self.returned = []       # (monotonic, text) when a body call came back
        self.guard = threading.Lock()
        super().__init__({"spill": lambda args: json.dumps({"text": ROWS_TEXT}),
                          "body": self.body, "echo": self.echo})
        self.config = dict(config or {})

    def body(self, args):
        text = args.get("text", "")
        with self.guard:
            self.entered.append((time.monotonic(), text))
        self.release.wait(10)                       # tests release it only after run.finished
        with self.guard:
            self.returned.append((time.monotonic(), text))
        return json.dumps({"text": per_item_text(text)})

    def echo(self, args):
        return json.dumps({"text": "echo:" + args.get("text", "")})

    def get_config(self, key, default=None):
        return self.config.get(key, default)


class LoopSpillCase(unittest.TestCase):
    """Scratch dir, a real Env, and helpers that build and corrupt genuine legacy cache entries."""

    config = {}

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="flowcanvas-legacy-loops-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.previous_data_dir = os.environ.get("FLOWCANVAS_DATA_DIR")
        os.environ["FLOWCANVAS_DATA_DIR"] = self.root
        self.addCleanup(self._restore_data_dir)
        self.ctx = Ctx(self.config)
        self.events = []
        self.events_guard = threading.Lock()
        self.env = E.env.Env(ctx=self.ctx, state={"tool_source": lambda: TOOLS},
                             emit=self.record, data_dir=self.root)
        self.addCleanup(self.ctx.release.set)

    def _restore_data_dir(self):
        if self.previous_data_dir is None:
            os.environ.pop("FLOWCANVAS_DATA_DIR", None)
        else:
            os.environ["FLOWCANVAS_DATA_DIR"] = self.previous_data_dir

    # -- recording

    def record(self, event, payload):
        """Emit sink: stamped, ordered, and the place run.finished releases the blocked body calls."""
        with self.events_guard:
            self.events.append((time.monotonic(), event, payload))
        if event == "run.finished":
            self.ctx.release.set()

    def snapshot_events(self):
        with self.events_guard:
            return list(self.events)

    # -- flows

    def build(self, ops):
        types = N.types_by_name(self.env)
        flow, _results = G.apply_ops(G.new_flow("legacy-loops"), ops, types)
        return S.save_flow(self.env, flow, create=True)

    @staticmethod
    def ref(flow, title):
        return next(node["id"] for node in flow["nodes"] if node.get("title") == title)

    def set_input(self, flow, node_id, value):
        S.modify_flow(self.env, flow["id"], lambda f: next(
            n for n in f["nodes"] if n["id"] == node_id)["params"].update(value=value))

    # -- real on-disk fixtures

    def assert_under_scratch(self, path):
        root = os.path.normcase(os.path.realpath(self.root))
        real = os.path.normcase(os.path.realpath(path))
        self.assertTrue(real.startswith(root + os.sep),
                        f"refusing to touch {path!r}: outside this test's scratch dir")

    def cache_entry(self, node_type, preview_prefix):
        """The one cache entry for node_type whose spilled output starts with preview_prefix."""
        found = []
        for base, _dirs, files in os.walk(S.cache_dir(self.env)):
            for name in files:
                if not name.endswith(".json"):
                    continue
                path = os.path.join(base, name)
                try:
                    entry = S.read_json(path)
                except (OSError, ValueError):
                    continue
                if not isinstance(entry, dict) or entry.get("node_type") != node_type:
                    continue
                text = (entry.get("outputs") or {}).get("text")
                if isinstance(text, dict) and isinstance(text.get("$large"), dict):
                    preview = str(text["$large"].get("preview", ""))   # already a legacy marker
                else:
                    preview = text if isinstance(text, str) else ""    # the raw value a put stores
                if preview.startswith(preview_prefix):
                    found.append((path, entry))
        self.assertEqual(len(found), 1, f"fixture: expected one cached {node_type} entry, got {found}")
        return found[0]

    def relink_as_legacy(self, path, entry, marker):
        """Older engines stored the producer run's own marker: no media_dir, path outside the cache."""
        legacy = {"node_type": entry.get("node_type"), "created_at": entry.get("created_at"),
                  "outputs": {"text": json.loads(json.dumps(marker))}}
        S.write_json(path, legacy)
        return legacy

    def damage_spill(self, marker, text, stale_chars=True):
        """Rewrite the spill file with the pre-fix Windows bytes and return those bytes.

        With stale_chars (the historical bug) the metadata keeps the LF-only length, so the file
        decodes to more characters than $large.chars records.
        """
        path = marker["$large"]["path"]
        self.assert_under_scratch(path)
        damaged = legacy_windows_bytes(text)
        write_bytes(path, damaged)
        decoded = damaged.decode("utf-8")
        if stale_chars:
            self.assertEqual(len(decoded), marker["$large"]["chars"] + text.count("\n"),
                             "fixture: the damaged file must decode to more characters than chars records")
        else:
            marker["$large"]["chars"] = len(decoded)
            self.assertEqual(len(decoded), marker["$large"]["chars"])
        return damaged

    # -- assertions shared by the loop tests

    def corruption_errors(self, res):
        return {nid: st.get("error", "") for nid, st in res["nodes"].items()
                if st.get("error") and re.search(CORRUPTION_MESSAGE, st["error"].lower())}

    def assert_record_isolated(self, res):
        """Every file-backed value the run recorded lives in this test's scratch dir."""
        found = []

        def walk(value):
            if isinstance(value, dict):
                marker = value.get("$large") if isinstance(value.get("$large"), dict) else value.get("$media")
                if isinstance(marker, dict) and marker.get("path"):
                    found.append(marker["path"])
                for item in value.values():
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(res)
        self.assertTrue(found, "fixture: the run recorded no file-backed value to check")
        for path in found:
            self.assert_under_scratch(path)

    def assert_failed_loudly(self, res, note):
        self.assertEqual(res["status"], "error", f"{note}: the run did not report failure: {res['status']}")
        blame = self.corruption_errors(res)
        self.assertTrue(blame, f"{note}: no node error names the corruption: {res['nodes']}")
        first = next(nid for nid in res["order"] if res["nodes"].get(nid, {}).get("status") == "error")
        title = next(n.get("title") or first for n in S.get_flow(self.env, res["flow_id"])["nodes"]
                     if n["id"] == first)
        self.assertTrue(str(res.get("error", "")).startswith(f"{title}: "),
                        f"{note}: the run blames {res.get('error')!r} instead of {title!r}")
        self.assertRegex(str(res.get("error", "")).lower(), CORRUPTION_MESSAGE,
                         f"{note}: the run error does not name the corruption: {res.get('error')!r}")
        stuck = {nid: st.get("status") for nid, st in res["nodes"].items()
                 if st.get("status") in ("running", "queued")}
        self.assertEqual(stuck, {}, f"{note}: the run finished with nodes still marked live: {stuck}")
        return blame


LOOP = [
    {"op": "add_node", "ref": "src", "type": "input.text", "title": "Names", "params": {"value": "a\nb\nc"}},
    {"op": "add_node", "ref": "each", "type": "logic.foreach", "title": "Each"},
    {"op": "add_node", "ref": "body", "type": "tool:body", "title": "Body"},
    {"op": "add_node", "ref": "all", "type": "logic.collect", "title": "All"},
    {"op": "add_node", "ref": "show", "type": "output.preview", "title": "Show"},
    {"op": "connect", "from": "src.text", "to": "each.list"},
    {"op": "connect", "from": "each.item", "to": "body.text"},
    {"op": "connect", "from": "body.text", "to": "all.value"},
    {"op": "connect", "from": "all.list", "to": "show.value"},
]


class LoopListCorruptionTest(LoopSpillCase):
    """The For each list itself comes from a cached legacy spill: fail before running a single item."""

    def build_list_flow(self):
        flow = self.build([
            {"op": "add_node", "ref": "s", "type": "tool:spill", "title": "Spill"},
            {"op": "add_node", "ref": "each", "type": "logic.foreach", "title": "Each"},
            {"op": "add_node", "ref": "body", "type": "tool:echo", "title": "Body"},
            {"op": "add_node", "ref": "all", "type": "logic.collect", "title": "All"},
            {"op": "add_node", "ref": "show", "type": "output.preview", "title": "Show"},
            {"op": "connect", "from": "s.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "body.text"},
            {"op": "connect", "from": "body.text", "to": "all.value"},
            {"op": "connect", "from": "all.list", "to": "show.value"},
        ])
        ids = {t: self.ref(flow, t) for t in ("Spill", "Each", "Body", "All", "Show")}
        first = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)
        marker = first["nodes"][ids["Spill"]]["outputs"]["text"]
        self.assertIn("$large", marker, "fixture: the spill tool did not produce a spilled value")
        self.assertEqual(marker["$large"]["chars"], SPILLED_CHARS)
        entry_path, entry = self.cache_entry("tool:spill", "row")
        self.relink_as_legacy(entry_path, entry, marker)
        return flow, ids, marker, entry_path

    def test_corrupted_legacy_list_source_fails_the_loop_before_any_item_runs(self):
        flow, ids, marker, entry_path = self.build_list_flow()
        damaged = self.damage_spill(marker, ROWS_TEXT)

        calls_before = len(self.ctx.calls)
        second = R.run_sync(self.env, flow["id"], timeout_s=20)

        self.assertEqual(second["nodes"][ids["Spill"]]["status"], "cached",
                         "fixture: the legacy cache entry was not the one the run loaded")
        self.assert_record_isolated(second)
        blame = self.assert_failed_loudly(second, "corrupted For each list")
        self.assertEqual(list(blame), [ids["Each"]],
                         f"the corruption must be blamed on the step that loads it, got {blame}")
        self.assertNotIn(ids["Spill"], blame, "the cached producer was blamed for a value it wrote intact")

        new_calls = [name for name, _args in self.ctx.calls[calls_before:]]
        self.assertEqual(new_calls, [], f"the loop still ran body work on a corrupt list: {new_calls}")
        for ref in ("Body", "All", "Show"):
            state = second["nodes"][ids[ref]]
            self.assertEqual(state["status"], "skipped", f"{ref} ran although the list was corrupt: {state}")
            self.assertIn("upstream failed", state.get("error", ""), f"{ref}: {state}")
        self.assertNotIn("done", [st["status"] for st in second["nodes"].values()])

        self.assertEqual(read_bytes(marker["$large"]["path"]), damaged,
                         "the failed run rewrote the corrupted legacy file")
        kept = S.read_json(entry_path)["outputs"]["text"]["$large"]
        self.assertEqual(kept["chars"], SPILLED_CHARS, "the failed run rewrote the spill metadata")

    def test_consistent_legacy_crlf_list_still_feeds_the_loop(self):
        """Control: the same CRLF bytes with metadata that matches are a valid legacy value, not corruption."""
        flow, ids, marker, entry_path = self.build_list_flow()
        damaged = self.damage_spill(marker, ROWS_TEXT, stale_chars=False)
        S.write_json(entry_path, {"node_type": "tool:spill", "created_at": S.read_json(entry_path).get("created_at"),
                                  "outputs": {"text": marker}})

        second = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(second["status"], "done", second)
        self.assertEqual(second["nodes"][ids["Spill"]]["status"], "cached", "fixture: no legacy cache hit")
        each = second["nodes"][ids["Each"]]
        self.assertEqual(each["status"], "done", each)
        collected = second["nodes"][ids["All"]]["outputs"]["list"]
        self.assertEqual({entry.strip() for entry in collected}, {"echo:row"},
                         f"a consistent CRLF legacy value was changed or refused: {collected[:3]}")
        self.assertTrue(damaged.startswith(b"row\r\n"), "fixture: no CRLF bytes were written")


class _PerItemCorruptionCase(LoopSpillCase):
    """Fixture: one item ("b") has a real cached result that is then damaged on disk.

    The other items are cache misses, so a later run has them blocked inside the body tool while the
    damaged item is served instantly from the legacy cache hit.
    """

    def setUp(self):
        super().setUp()
        self.flow = self.build([dict(op) for op in LOOP])
        self.ids = {t: self.ref(self.flow, t) for t in ("Names", "Each", "Body", "All", "Show")}
        S.modify_flow(self.env, self.flow["id"], lambda f: next(
            n for n in f["nodes"] if n["id"] == self.ids["Names"])["params"].update(value="b"))
        self.ctx.release.set()
        first = R.run_sync(self.env, self.flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)
        marker = first["nodes"][self.ids["Body"]]["outputs"]["text"][0]
        self.assertIn("$large", marker, "fixture: the body result did not spill")
        self.assertEqual(marker["$large"]["chars"], len(per_item_text("b")))
        entry_path, entry = self.cache_entry("tool:body", "echo:b")
        self.relink_as_legacy(entry_path, entry, marker)
        self.damaged = self.damage_spill(marker, per_item_text("b"))
        self.marker, self.entry_path = marker, entry_path

    def run_three_items(self, block=True):
        """Items a and c are cache misses; item b is the corrupt cache hit.

        With block=True the misses stop inside the body tool until run.finished releases them, so a
        failure caused by item b aborts the run while two real item tasks are still in flight.
        """
        self.set_input(self.flow, self.ids["Names"], "a\nb\nc")
        if block:
            self.ctx.release.clear()
        else:
            self.ctx.release.set()
        with self.ctx.guard:
            self.ctx.entered.clear()
            self.ctx.returned.clear()
        with self.events_guard:
            self.events.clear()
        calls_before = len(self.ctx.calls)
        handle = R.start_run(self.env, self.flow["id"])
        self.assertTrue(handle.done.wait(30), "the run never finished with two body calls blocked")
        res = handle.snapshot()
        self.addCleanup(self.ctx.release.set)
        helpers.wait_until(lambda: len(self.ctx.returned) >= 2, 10)
        return res, self.snapshot_events(), self.ctx.calls[calls_before:]


class LoopCollectCorruptionTest(_PerItemCorruptionCase):
    """A per-item cached body result is corrupt: Collect's load must abort the loop, not the values."""

    def test_corrupted_per_item_cache_value_fails_the_run_without_feeding_the_tool(self):
        res, _events, calls = self.run_three_items()

        self.assert_record_isolated(res)
        self.assert_failed_loudly(res, "corrupted per-item cache value")
        body, all_, show = (res["nodes"][self.ids[t]] for t in ("Body", "All", "Show"))
        self.assertNotEqual(body["status"], "done", f"the body step reported success: {body}")
        self.assertEqual(all_["status"], "skipped", f"Collect ran on a failed loop: {all_}")
        self.assertIn("upstream failed", all_.get("error", ""))
        self.assertEqual(show["status"], "skipped", f"a downstream node ran anyway: {show}")

        fed = [args.get("text") for _name, args in calls]
        self.assertNotIn("b", fed, "the damaged cached value was handed to the body tool")
        self.assertEqual(sorted(fed), ["a", "c"], f"the loop did not run exactly the uncached items: {fed}")
        self.assertEqual(read_bytes(self.marker["$large"]["path"]), self.damaged,
                         "the failed run rewrote the corrupted legacy file")
        kept = S.read_json(self.entry_path)["outputs"]["text"]["$large"]
        self.assertEqual(kept["chars"], len(per_item_text("b")),
                         "the failed run rewrote the spill metadata to fit the damaged file")

    def test_partial_body_never_reports_success_after_the_collect_chokes(self):
        """Observed contract: a step that processed 1 of 3 items must not be announced as done/cached.

        ``finish_loop`` applies exactly that rule when a loop is cancelled ("finished < n -> cancelled"),
        but an exception on the Collect load leaves ``cancelled`` false, so the partial aggregate is
        published as its success status ('cached' when every processed item was a hit, 'done' when one
        really ran). A consumer of node.status paints the step green although two of three items were
        dropped; the scheduler only overwrites it with 'skipped' one tick later.
        """
        res, events, _calls = self.run_three_items()
        body_id = self.ids["Body"]
        items = res["nodes"][body_id].get("items") or {}
        self.assertEqual(items.get("total"), 3, f"fixture: expected 3 items, got {items}")
        self.assertEqual(items.get("done", 0) + items.get("cached", 0), 1,
                         f"fixture: exactly one item should have completed before the abort, got {items}")

        claimed = [payload["status"] for _ts, event, payload in events
                   if event == "node.status" and payload.get("run_id") == res["id"]
                   and payload.get("node_id") == body_id
                   and payload.get("status") in ("done", "cached")]
        claimed_items = [payload.get("items") for _ts, event, payload in events
                         if event == "node.status" and payload.get("run_id") == res["id"]
                         and payload.get("node_id") == body_id
                         and payload.get("status") in ("done", "cached")]
        self.assertEqual((claimed, claimed_items), ([], []),
                         f"the body step announced {claimed} {claimed_items} after 1 of 3 items "
                         f"(the final record only says {res['nodes'][body_id]['status']!r} because the "
                         f"scheduler overwrites it a tick later); the loop then failed with {res.get('error')!r}")

    def test_completed_body_may_report_success_after_later_collect_failure(self):
        class FinishSink:
            flow = {'nodes': [], 'edges': []}
            collected = {}
            loop_failed = {}
            def __init__(self):
                self.updates = []
            def set_node(self, nid, **fields):
                self.updates.append((nid, fields))

        sink = FinishSink()
        R._Execution.finish_loop(
            sink, 'loop', ['body'], [], 1,
            {'body': {'total': 1, 'done': 1, 'cached': 0, 'skipped': 0, 'error': 0}},
            {'body': [None]}, {'body': {}}, {'body': 0}, {}, {}, False, {'body': {}}, True,
        )
        self.assertEqual(sink.updates[0][1]['status'], 'done')

    def test_incomplete_failed_loop_is_not_reported_as_cancelled(self):
        res, events, _calls = self.run_three_items()
        self.assertEqual(res['status'], 'error')
        body_id = self.ids['Body']
        for _ts, event, payload in events:
            if event != 'node.status' or payload.get('run_id') != res['id'] or payload.get('node_id') != body_id:
                continue
            items = payload.get('items') or {}
            finished = sum(items.get(k, 0) for k in ('done', 'cached', 'skipped', 'error'))
            if items.get('total') and finished < items['total']:
                self.assertNotIn(payload.get('status'), ('done', 'cached', 'cancelled'))

    def test_in_flight_items_emit_nothing_after_run_finished(self):
        """gather() must not leave body items running past the run's last event."""
        res, events, _calls = self.run_three_items()

        finished_at = [ts for ts, event, payload in events
                       if event == "run.finished" and payload.get("run_id") == res["id"]]
        self.assertEqual(len(finished_at), 1, f"fixture: expected one run.finished, got {events[-3:]}")
        with self.ctx.guard:
            entered, returned = list(self.ctx.entered), list(self.ctx.returned)
        self.assertEqual(len(entered), 2, f"fixture: two items should have been running, got {entered}")
        self.assertTrue(all(ts < finished_at[0] for ts, _text in entered),
                        "fixture: a body call started after the run had already finished")
        self.assertTrue(all(ts > finished_at[0] for ts, _text in returned),
                        "fixture: the blocked body calls had already returned before run.finished; "
                        "nothing was in flight to leak")

        after = [(event, payload.get("node_id") or payload.get("status")) for ts, event, payload in events
                 if ts > finished_at[0]]
        self.assertEqual(after, [], f"node updates were emitted after run.finished: {after}")

        body = res["nodes"][self.ids["Body"]]
        self.assertLess(body["items"]["done"] + body["items"]["cached"], body["items"]["total"],
                        f"a body step counted items that never returned: {body['items']}")
        self.assertNotEqual(res["status"], "done", "the run finished successfully while items were dropped")


class MergeCorruptionTest(LoopSpillCase):
    """Merge on the main path: a corrupted legacy value must fail the Merge, never reach downstream."""

    def test_corrupted_legacy_value_fails_merge_and_skips_downstream(self):
        flow = self.build([
            {"op": "add_node", "ref": "s", "type": "tool:spill", "title": "Spill"},
            {"op": "add_node", "ref": "m", "type": "logic.merge", "title": "Merge"},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "After"},
            {"op": "connect", "from": "s.text", "to": "m.value"},
            {"op": "connect", "from": "m.value", "to": "e.text"},
        ])
        ids = {t: self.ref(flow, t) for t in ("Spill", "Merge", "After")}
        first = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)
        marker = first["nodes"][ids["Spill"]]["outputs"]["text"]
        self.assertIn("$large", marker, "fixture: the spill tool did not produce a spilled value")
        entry_path, entry = self.cache_entry("tool:spill", "row")
        self.relink_as_legacy(entry_path, entry, marker)
        damaged = self.damage_spill(marker, ROWS_TEXT)

        calls_before = len(self.ctx.calls)
        second = R.run_sync(self.env, flow["id"], timeout_s=20)

        self.assertEqual(second["nodes"][ids["Spill"]]["status"], "cached", "fixture: no legacy cache hit")
        blame = self.assert_failed_loudly(second, "corrupted Merge input")
        self.assertEqual(list(blame), [ids["Merge"]], f"Merge was not the step that failed: {blame}")
        merge, after = second["nodes"][ids["Merge"]], second["nodes"][ids["After"]]
        self.assertEqual(merge["status"], "error")
        self.assertNotIn("outputs", merge, f"Merge published a value it could not load: {merge}")
        self.assertEqual(after["status"], "skipped", f"downstream ran on a failed Merge: {after}")
        self.assertIn("upstream failed", after.get("error", ""))
        new_calls = [name for name, _args in self.ctx.calls[calls_before:]]
        self.assertEqual(new_calls, [], f"the damaged value reached a downstream tool: {new_calls}")
        self.assertTrue(str(second.get("error", "")).startswith("Merge: "),
                        f"the run blames the wrong step: {second.get('error')!r}")
        self.assertEqual(read_bytes(marker["$large"]["path"]), damaged,
                         "the failed run rewrote the corrupted legacy file")
        self.assertEqual(S.read_json(entry_path)["outputs"]["text"]["$large"]["chars"], SPILLED_CHARS,
                         "the failed run rewrote the spill metadata")


class MergeInLoopCorruptionTest(_PerItemCorruptionCase):
    """Merge inside a For each: the item fails on its own corrupted value and is named by position."""

    def setUp(self):
        LoopSpillCase.setUp(self)
        self.flow = self.build([
            {"op": "add_node", "ref": "src", "type": "input.text", "title": "Names", "params": {"value": "b"}},
            {"op": "add_node", "ref": "each", "type": "logic.foreach", "title": "Each"},
            {"op": "add_node", "ref": "body", "type": "tool:body", "title": "Body"},
            {"op": "add_node", "ref": "m", "type": "logic.merge", "title": "Join"},
            {"op": "add_node", "ref": "all", "type": "logic.collect", "title": "All"},
            {"op": "connect", "from": "src.text", "to": "each.list"},
            {"op": "connect", "from": "each.item", "to": "body.text"},
            {"op": "connect", "from": "body.text", "to": "m.value"},
            {"op": "connect", "from": "m.value", "to": "all.value"},
        ])
        self.ids = {t: self.ref(self.flow, t) for t in ("Names", "Each", "Body", "Join", "All")}
        S.modify_flow(self.env, self.flow["id"], lambda f: next(
            n for n in f["nodes"] if n["id"] == self.ids["Names"])["params"].update(value="b"))
        self.ctx.release.set()
        first = R.run_sync(self.env, self.flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)
        marker = first["nodes"][self.ids["Body"]]["outputs"]["text"][0]
        self.assertIn("$large", marker, "fixture: the body result did not spill")
        entry_path, entry = self.cache_entry("tool:body", "echo:b")
        self.relink_as_legacy(entry_path, entry, marker)
        self.damaged = self.damage_spill(marker, per_item_text("b"))
        self.marker, self.entry_path = marker, entry_path

    def test_corrupted_per_item_value_inside_a_merge_names_the_item(self):
        res, _events, calls = self.run_three_items(block=False)

        self.assert_failed_loudly(res, "corrupted value inside a Merge in the loop")
        body, join, all_ = (res["nodes"][self.ids[t]] for t in ("Body", "Join", "All"))
        self.assertEqual(join["status"], "error", f"the Merge step did not fail on its item: {join}")
        self.assertEqual(join["items"]["error"], 1, f"exactly one item was corrupt: {join['items']}")
        self.assertIn("item 2 of 3", join.get("error", ""),
                      f"the failure is not attributed to the corrupt item: {join.get('error')!r}")
        self.assertRegex(join.get("error", "").lower(), CORRUPTION_MESSAGE,
                         f"the item error does not name the corruption: {join.get('error')!r}")
        self.assertEqual(body["status"], "done", f"the healthy body step did not finish all items: {body}")
        self.assertEqual(body["items"]["total"], 3, f"the body step lost items: {body['items']}")
        self.assertEqual(all_["status"], "skipped", f"Collect ran on a failed loop: {all_}")
        self.assertNotIn("b", [args.get("text") for _name, args in calls],
                         "the damaged cached value was handed to the body tool")
        self.assertEqual(read_bytes(self.marker["$large"]["path"]), self.damaged,
                         "the failed run rewrote the corrupted legacy file")


if __name__ == "__main__":
    unittest.main()
