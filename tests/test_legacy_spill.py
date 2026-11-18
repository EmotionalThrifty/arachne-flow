"""Legacy spilled values must never feed a later node after silent corruption.

Before the ``newline=""`` fix, a Windows text-mode write turned every LF in a spilled value into CRLF
on disk, while ``$large.chars`` kept the original LF-only length. Reading that file back in text mode
now returns a longer string, and ``runner.load_value`` never compares it with ``chars``: the damaged
value flows into the next node as if it were intact.

These tests are deliberately RED against the current engine. They only *observe* the contract:
a mismatch must raise an explicit error, and the bytes/metadata on disk must stay untouched. Nothing
here asks the engine to guess which character was original, to repair, or to rewrite a file. The value
API already refuses the same situation with "stored value length mismatch; historical data may be
corrupted" (engine/api.py), so the run path is expected to agree.

All filesystem work is real and confined to a per-test temp dir; nothing is mocked and no repository
file is written.
"""
import json
import os
import shutil
import tempfile
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N = E.runner, E.store, E.graph, E.nodes

RUN_ID = "r_0123456789"
NODE = "n_000001"
CORRUPTION_MESSAGE = r"length mismatch|corrupt|chars"

# > LARGE_VALUE_CHARS (64 KiB) with LF, CRLF, a lone CR and a non-ASCII character in one value.
MIXED_TEXT = ("line-α\nrow\r\nsolo\rend\n" * 4000)
# LF only, so the pre-fix Windows writer is the *only* source of CR in the simulation below.
LF_TEXT = ("line-α\nrow\nsolo\n" * 5000)
# A legacy CRLF that is *legitimate*: the text really contains CRLF, so chars matches the bytes.
CRLF_TEXT = ("a\r\nb\rcé世\n" * 9000)
ROWS_TEXT = "row\n" * 20000          # plain LF text a tool would produce; 80 000 chars
BIG_DICT = {"kind": "rows", "rows": [{"i": i, "text": "é\n" + "v" * 40} for i in range(1500)]}
BIG_LIST = [{"i": i, "note": "世界\r\n"} for i in range(3000)]


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def write_bytes(path, data):
    with open(path, "wb") as fh:
        fh.write(data)


def legacy_windows_bytes(text):
    """What a text-mode write without newline='' left on Windows: every LF became CRLF."""
    return text.encode("utf-8").replace(b"\n", b"\r\n")


def marker_without_chars(marker):
    """A pre-metadata marker: the field simply did not exist yet, so it must keep working."""
    meta = dict(marker["$large"])
    meta.pop("chars", None)
    return {"$large": meta}


class ScratchCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="arachne-flow-legacy-spill-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.env = E.env.Env(state={}, data_dir=self.root)

    # -- helpers

    def record(self, value, port="value", node=NODE):
        return R.record_value(self.env, value, RUN_ID, node, port)

    def assert_under_scratch(self, path):
        root = os.path.normcase(os.path.realpath(self.root))
        real = os.path.normcase(os.path.realpath(path))
        self.assertTrue(real.startswith(root + os.sep),
                        f"refusing to touch {path!r}: outside this test's scratch dir")

    def assert_loud(self, marker, note):
        """An explicit, meaningful failure — never a silently returned (longer) value."""
        with self.assertRaises(Exception) as caught:   # any explicit error beats silent corruption
            R.load_value(marker, self.env)
        exc = caught.exception
        self.assertNotIsInstance(exc, (AttributeError, KeyError, IndexError),
                                 f"{note}: internal error instead of a corruption error: {exc!r}")
        self.assertRegex(str(exc).lower(), CORRUPTION_MESSAGE,
                         f"{note}: the error must say the stored value is corrupt/mismatched, got {exc!r}")


class LegacySpillLoadTest(ScratchCase):
    """runner.load_value: metadata is the only guard against a pre-fix CRLF spill."""

    def test_text_spill_round_trips_lf_crlf_cr_and_unicode(self):
        self.assertGreater(len(MIXED_TEXT), R.LARGE_VALUE_CHARS)
        marker = self.record(MIXED_TEXT)
        self.assertIn("$large", marker)
        meta = marker["$large"]
        path = meta["path"]
        self.assert_under_scratch(path)
        self.assertEqual(meta["chars"], len(MIXED_TEXT))
        self.assertEqual(read_bytes(path), MIXED_TEXT.encode("utf-8"),
                         "record_value translated newlines in the spill file")
        self.assertEqual(R.load_value(marker, self.env), MIXED_TEXT,
                         "a clean spill did not come back character for character")

    def test_legacy_crlf_spill_with_stale_chars_raises(self):
        """The historical shape: file written without newline='', metadata still counts LF only."""
        marker = self.record(LF_TEXT)
        path = marker["$large"]["path"]
        self.assert_under_scratch(path)
        before = json.loads(json.dumps(marker))
        damaged = legacy_windows_bytes(LF_TEXT)
        self.assertEqual(damaged.count(b"\r\r\n"), 0, "fixture: the corrupt file must not get a double CR")
        write_bytes(path, damaged)                       # simulate the pre-fix writer, metadata untouched
        decoded = damaged.decode("utf-8")
        self.assertEqual(len(decoded), marker["$large"]["chars"] + LF_TEXT.count("\n"),
                         "fixture: the legacy file must decode to more characters than chars records")

        self.assert_loud(marker, "legacy CRLF spill")
        self.assertEqual(read_bytes(path), damaged, "a failed read must not rewrite the legacy file")
        self.assertEqual(marker, before, "load_value rewrote the marker to hide the mismatch")

    def test_legacy_crlf_spill_one_extra_character_still_raises(self):
        """Drift of a single character is still corruption; no tolerance window."""
        text = "x" * R.LARGE_VALUE_CHARS + "\n"
        marker = self.record(text)
        self.assertIn("$large", marker)
        path = marker["$large"]["path"]
        self.assert_under_scratch(path)
        write_bytes(path, text.encode("utf-8").replace(b"\n", b"\r\n"))
        decoded = read_bytes(path).decode("utf-8")
        self.assertEqual(len(decoded), marker["$large"]["chars"] + 1)

        self.assert_loud(marker, "single-character CRLF drift")

    def test_matching_length_crlf_cr_unicode_spill_is_not_rejected(self):
        """The guard is a length comparison, not 'contains CR': a consistent CRLF file is valid."""
        marker = self.record(CRLF_TEXT)
        self.assertIn("$large", marker)
        meta = marker["$large"]
        self.assertEqual(meta["chars"], len(CRLF_TEXT))
        self.assertEqual(read_bytes(meta["path"]), CRLF_TEXT.encode("utf-8"))
        self.assertIn("\r\n", R.load_value(marker, self.env), "a legitimate CRLF was dropped or rejected")

        # Same shape, but hand-written metadata that is consistent with the bytes.
        hand = os.path.join(self.root, "outputs", RUN_ID, "hand-value.txt")   # spills live in run outputs
        os.makedirs(os.path.dirname(hand), exist_ok=True)
        write_bytes(hand, legacy_windows_bytes(CRLF_TEXT))
        crafted = {"$large": {"file": "value.txt", "path": hand,
                              "chars": len(CRLF_TEXT) + CRLF_TEXT.count("\n"), "preview": ""}}
        self.assertEqual(R.load_value(crafted, self.env), read_bytes(hand).decode("utf-8"))

    def test_json_spill_round_trips_dict_and_list(self):
        for value in (BIG_DICT, BIG_LIST):
            with self.subTest(kind=type(value).__name__):
                self.assertGreater(len(json.dumps(value, ensure_ascii=False)), R.LARGE_VALUE_CHARS)
                marker = self.record(value)
                self.assertIn("$large", marker)
                self.assertTrue(marker["$large"]["file"].endswith(".json"), marker["$large"])
                loaded = R.load_value(marker, self.env)
                self.assertEqual(type(loaded), type(value))
                self.assertEqual(loaded, value, "a clean JSON spill did not round-trip")

    def test_json_spill_metadata_mismatch_raises_even_when_it_still_parses(self):
        """chars disagrees with the file: the JSON parses, so only the length check can catch it."""
        marker = self.record(BIG_DICT)
        path = marker["$large"]["path"]
        self.assert_under_scratch(path)
        write_bytes(path, read_bytes(path) + b"\n")     # legacy one-char drift; json.loads ignores it
        self.assertEqual(len(read_bytes(path).decode("utf-8")), marker["$large"]["chars"] + 1)

        self.assert_loud(marker, "JSON spill with stale chars")

    def test_truncated_json_spill_raises_instead_of_degrading_to_text(self):
        """Today a parse failure returns the raw string: a dict silently becomes text downstream."""
        marker = self.record(BIG_DICT)
        path = marker["$large"]["path"]
        self.assert_under_scratch(path)
        raw = read_bytes(path)
        write_bytes(path, raw[: len(raw) // 2])

        self.assert_loud(marker, "truncated JSON spill")

    def test_marker_without_chars_still_loads(self):
        """Pre-metadata entries have no lengths to compare; compatibility means returning the text.

        This is the ambiguity these tests do *not* demand a fix for: with no recorded length the
        engine cannot tell a clean CRLF file from a damaged one.
        """
        text_marker = self.record(MIXED_TEXT)
        json_marker = self.record(BIG_DICT, port="rows")
        for marker, expected in ((text_marker, MIXED_TEXT), (json_marker, BIG_DICT)):
            with self.subTest(kind=marker["$large"]["file"].rsplit(".", 1)[-1]):
                legacy = marker_without_chars(marker)
                self.assertNotIn("chars", legacy["$large"])
                self.assertEqual(R.load_value(legacy, self.env), expected)

    def test_valid_json_kinds_load_without_a_marker_chars_field(self):
        """Scalar/array/object JSON spills are all valid legacy shapes."""
        folder = os.path.join(self.root, "outputs", RUN_ID, "kinds")       # spills live in run outputs
        os.makedirs(folder, exist_ok=True)
        cases = {"number": ("42", 42), "string": ('"hi"', "hi"),
                 "array": ("[1, 2, 3]", [1, 2, 3]), "object": ('{"a": 1}', {"a": 1})}
        for name, (raw, expected) in cases.items():
            with self.subTest(kind=name):
                path = os.path.join(folder, name + ".json")
                write_bytes(path, raw.encode("utf-8"))
                marker = {"$large": {"file": name + ".json", "path": path,
                                     "chars": len(raw), "preview": raw[:40]}}
                self.assertEqual(R.load_value(marker, self.env), expected)

    def test_load_does_not_mutate_the_file_or_the_marker(self):
        marker = self.record(MIXED_TEXT)
        path = marker["$large"]["path"]
        before_bytes, before_marker = read_bytes(path), json.loads(json.dumps(marker))
        R.load_value(marker, self.env)
        self.assertEqual(read_bytes(path), before_bytes)
        self.assertEqual(marker, before_marker)

        json_marker = self.record(BIG_DICT, port="rows")
        json_path = json_marker["$large"]["path"]
        json_before, marker_before = read_bytes(json_path), json.loads(json.dumps(json_marker))
        R.load_value(json_marker, self.env)
        self.assertEqual(read_bytes(json_path), json_before)
        self.assertEqual(json_marker, marker_before)

    def test_non_spilled_values_pass_through_unchanged(self):
        for value in (None, True, False, 0, 1.5, "short text", ["a"], {"k": "v"}):
            with self.subTest(value=value):
                self.assertEqual(R.load_value(value, self.env), value)

    def test_missing_spill_file_keeps_todays_marker_passthrough(self):
        """Out of scope to change: no file means the marker itself, and that must not crash."""
        gone = {"$large": {"file": "gone.txt", "path": os.path.join(self.root, "outputs", RUN_ID, "gone.txt"),
                           "chars": 10, "preview": ""}}
        self.assertEqual(R.load_value(gone, self.env), gone)
        self.assertFalse(os.path.exists(gone["$large"]["path"]),
                         "load_value created a file for a missing spill")


# --------------------------------------------------------------------------- real runner

TOOLS = [
    {"name": "spill", "toolset": "test", "read_only": True,
     "parameters": {"type": "object", "properties": {}}},
    {"name": "crlf", "toolset": "test", "read_only": True,
     "parameters": {"type": "object", "properties": {}}},
    {"name": "echo", "toolset": "test", "read_only": True,
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
]


class Ctx(helpers.FakeCtx):
    def __init__(self):
        super().__init__({
            "spill": lambda args: json.dumps({"text": ROWS_TEXT}),
            "crlf": lambda args: json.dumps({"text": CRLF_TEXT}),
            "echo": lambda args: json.dumps({"text": "echo:" + args["text"]}),
        })

    def get_config(self, key, default=None):
        return default


class LegacySpillRunnerTest(ScratchCase):
    """A corrupted legacy spill must fail the downstream node, not run it on damaged text."""

    def setUp(self):
        super().setUp()
        self.previous_data_dir = os.environ.get("ARACHNE_FLOW_DATA_DIR")
        os.environ["ARACHNE_FLOW_DATA_DIR"] = self.root
        self.addCleanup(self._restore_data_dir)
        self.rec_events = []
        self.env = E.env.Env(ctx=Ctx(), state={"tool_source": lambda: TOOLS},
                             emit=lambda event, payload: self.rec_events.append((event, payload)),
                             data_dir=self.root)

    def _restore_data_dir(self):
        if self.previous_data_dir is None:
            os.environ.pop("ARACHNE_FLOW_DATA_DIR", None)
        else:
            os.environ["ARACHNE_FLOW_DATA_DIR"] = self.previous_data_dir

    def build(self, ops):
        types = N.types_by_name(self.env)
        flow, _refs = G.apply_ops(G.new_flow("legacy"), ops, types)
        return S.save_flow(self.env, flow, create=True)

    @staticmethod
    def ref(flow, title):
        return next(node["id"] for node in flow["nodes"] if node.get("title") == title)

    def walk_files(self, folder, suffix):
        for base, _dirs, files in os.walk(folder):
            for name in files:
                if name.endswith(suffix):
                    yield os.path.join(base, name)

    def cache_entry(self, node_type):
        """The one cache entry this flow holds for a node type."""
        found = []
        for path in self.walk_files(S.cache_dir(self.env), ".json"):
            try:
                entry = S.read_json(path)
            except (OSError, ValueError):
                continue
            if isinstance(entry, dict) and entry.get("node_type") == node_type:
                found.append((path, entry))
        self.assertEqual(len(found), 1, f"fixture: expected one cached {node_type} entry, got {found}")
        return found[0]

    def as_legacy_entry(self, path, entry, marker):
        """Rewrite a cache entry the way older engine versions stored it: record_value markers that
        point at the producer run's own spill files, and no media_dir of its own."""
        legacy = {"node_type": entry.get("node_type"), "created_at": entry.get("created_at"),
                  "outputs": {"text": json.loads(json.dumps(marker))}}
        S.write_json(path, legacy)
        return legacy

    def test_corrupted_legacy_cache_spill_errors_instead_of_feeding_the_next_node(self):
        flow = self.build([
            {"op": "add_node", "ref": "s", "type": "tool:spill", "title": "Spill"},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "Echo"},
            {"op": "connect", "from": "s.text", "to": "e.text"},
        ])
        spill_id, echo_id = self.ref(flow, "Spill"), self.ref(flow, "Echo")
        first = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)

        marker = first["nodes"][spill_id]["outputs"]["text"]
        self.assertIn("$large", marker, "fixture: the spill tool produced no spilled value")
        self.assertEqual(marker["$large"]["chars"], len(ROWS_TEXT))
        path = marker["$large"]["path"]
        self.assert_under_scratch(path)
        self.assertEqual(read_bytes(path), ROWS_TEXT.encode("utf-8"),
                         "fixture: the clean spill file is not the text the tool produced")

        entry_path, entry = self.cache_entry("tool:spill")
        self.as_legacy_entry(entry_path, entry, marker)

        # Pre-fix Windows write: LF -> CRLF on disk; chars still counts the LF-only text.
        damaged = legacy_windows_bytes(ROWS_TEXT)
        write_bytes(path, damaged)
        self.assertEqual(len(damaged.decode("utf-8")), marker["$large"]["chars"] + ROWS_TEXT.count("\n"),
                         "fixture: the damaged file must decode to more chars than the metadata records")

        calls_before = len(self.env.ctx.calls)
        second = R.run_sync(self.env, flow["id"], timeout_s=20)

        self.assertEqual(second["nodes"][spill_id]["status"], "cached",
                         "fixture: the legacy cache entry was not the one the run loaded")
        echo_state = second["nodes"][echo_id]
        self.assertNotEqual(second["status"], "done",
                            "a corrupted legacy spill silently fed the next node (run still finished 'done')")
        self.assertEqual(echo_state["status"], "error",
                         f"downstream node did not fail on the corrupted spill: {echo_state}")
        self.assertRegex(str(echo_state.get("error", "")).lower(), CORRUPTION_MESSAGE,
                         f"downstream error does not name the corruption: {echo_state.get('error')!r}")

        new_calls = self.env.ctx.calls[calls_before:]
        self.assertFalse([call for call in new_calls if call[0] == "echo"],
                         "the damaged text was handed to the downstream tool: "
                         f"{[(name, len(str(args.get('text', '')))) for name, args in new_calls]}")
        self.assertEqual(read_bytes(path), damaged, "the run rewrote the corrupted legacy file")
        self.assertEqual(S.read_json(entry_path)["outputs"]["text"]["$large"]["chars"], len(ROWS_TEXT),
                         "the run rewrote the spill metadata to fit the damaged file")

    def test_consistent_crlf_unicode_spill_reaches_the_next_node_exactly(self):
        flow = self.build([
            {"op": "add_node", "ref": "c", "type": "tool:crlf", "title": "Crlf"},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "Echo"},
            {"op": "connect", "from": "c.text", "to": "e.text"},
        ])
        spill_id, echo_id = self.ref(flow, "Crlf"), self.ref(flow, "Echo")

        first = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)
        marker = first["nodes"][spill_id]["outputs"]["text"]
        self.assertIn("$large", marker, "fixture: the CRLF text did not spill")
        self.assertEqual(marker["$large"]["chars"], len(CRLF_TEXT))
        expected = "echo:" + CRLF_TEXT
        echo_marker = first["nodes"][echo_id]["outputs"]["text"]
        self.assertEqual(R.load_value(echo_marker, self.env), expected, "run 1 changed the CRLF/unicode text")

        entry_path, entry = self.cache_entry("tool:crlf")
        self.as_legacy_entry(entry_path, entry, marker)

        second = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(second["status"], "done", second)
        self.assertEqual(second["nodes"][spill_id]["status"], "cached", "fixture: no legacy cache hit")
        self.assertIn(second["nodes"][echo_id]["status"], ("cached", "done"))
        loaded = R.load_value(second["nodes"][echo_id]["outputs"]["text"])
        self.assertEqual(loaded, expected, "a consistent CRLF spill was changed or refused")
        self.assertEqual(loaded.count("\r\n"), expected.count("\r\n"))
        self.assertEqual(loaded.count("\r"), expected.count("\r"))

    def test_marker_without_chars_still_feeds_the_next_node(self):
        flow = self.build([
            {"op": "add_node", "ref": "s", "type": "tool:spill", "title": "Spill"},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "Echo"},
            {"op": "connect", "from": "s.text", "to": "e.text"},
        ])
        spill_id, echo_id = self.ref(flow, "Spill"), self.ref(flow, "Echo")
        first = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(first["status"], "done", first)

        marker = first["nodes"][spill_id]["outputs"]["text"]
        self.assertIn("$large", marker)
        entry_path, entry = self.cache_entry("tool:spill")
        legacy = self.as_legacy_entry(entry_path, entry, marker)
        del legacy["outputs"]["text"]["$large"]["chars"]
        S.write_json(entry_path, legacy)
        self.assertNotIn("chars", S.read_json(entry_path)["outputs"]["text"]["$large"])

        second = R.run_sync(self.env, flow["id"], timeout_s=20)
        self.assertEqual(second["status"], "done", second)
        self.assertEqual(second["nodes"][spill_id]["status"], "cached", "fixture: no legacy cache hit")
        self.assertEqual(R.load_value(second["nodes"][echo_id]["outputs"]["text"]), "echo:" + ROWS_TEXT,
                         "a pre-metadata spill was not passed through unchanged")


if __name__ == "__main__":
    unittest.main()
