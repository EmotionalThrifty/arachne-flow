"""RED regression tests for review findings in the run-value reader.

Four independent findings, each pinned to one test class:

1. A run whose own output folder is a real junction is refused by the shipped reader only because
   ``os.path.isjunction`` exists. If the runtime lacks that helper (older Python / stripped
   ``ntpath``), the junction must still be refused. The test builds a genuine junction on disk and
   narrows exactly one capability (``os.path.isjunction = None``) for the duration of one request —
   the filesystem is real, ``islink`` is untouched, nothing is mocked.
2. A for-each output list can contain ``$large`` marker dicts. Served as JSON, the marker leaks its
   spill-file path and internal metadata to the client. The reader must either expand each item to
   its real value or refuse explicitly; it must never hand marker internals out.
3. ``NaN`` / ``Infinity`` floats serialise to non-JSON tokens; a strict JSON client (JS
   ``JSON.parse``) rejects them. The reader must not present such bytes as valid JSON.
4. A legacy spill file written by the old Windows text-mode writer holds ``\\r\\r\\n`` sequences, so
   its on-disk length differs from the recorded ``chars``. The reader must signal the mismatch, not
   silently return corrupted bytes, and must not rewrite the old file.

Every test drives the real ``engine.api.handle`` against real saved run records and writes only
under a fresh ``ARACHNE_FLOW_DATA_DIR`` plus throwaway scratch folders.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

import helpers

E = helpers.load_engine()
A, R, S = E.api, E.runner, E.store

from fastapi import HTTPException  # noqa: E402

FLOW_ID = "f_0123456789"
RUN_A = "r_aaaaaaaaaa"
RUN_LEGACY = "r_bbbbbbbbbb"
RUN_JUNCTION = "r_cccccccccc"
NODE = "n_value01"
PORT = "text"

CONTRACT_KEYS = {"kind", "chunk", "offset", "next_offset", "total_chars"}
# Statuses that count as an explicit refusal of a value the reader cannot serve safely.
REFUSAL = (400, 403, 409, 413, 422, 502)
# A refusal must not masquerade as "the value does not exist": that hides the real reason.
MISMATCH_REFUSAL = (400, 409, 413, 422, 502)
_MISSING = object()


def strict_json(text: str):
    """Parse like a browser's JSON.parse: NaN, Infinity and -Infinity are syntax errors."""

    def _reject(token):
        raise ValueError(f"non-JSON constant {token}")

    return json.loads(text, parse_constant=_reject)


def clip(text: str, limit: int = 240) -> str:
    return text if len(text) <= limit else text[:limit] + f"… (+{len(text) - limit} chars)"


class ValueReviewTest(unittest.TestCase):
    def setUp(self):
        self._old_data_dir = os.environ.get("ARACHNE_FLOW_DATA_DIR")
        self._scratch_dirs: list[str] = []
        self._links: list[str] = []
        self.data_dir = helpers.temp_data_dir()
        self.env = E.env.Env(ctx=helpers.FakeCtx(), state={}, emit=lambda event, payload: None)

    def tearDown(self):
        # Junctions are removed with rmdir only: never recursively delete through a link.
        for link in self._links:
            try:
                os.rmdir(link)
            except OSError:
                pass
        for folder in self._scratch_dirs:
            shutil.rmtree(folder, ignore_errors=True)
        if self._old_data_dir is None:
            os.environ.pop("ARACHNE_FLOW_DATA_DIR", None)
        else:
            os.environ["ARACHNE_FLOW_DATA_DIR"] = self._old_data_dir
        shutil.rmtree(getattr(self, "data_dir", "") or os.path.join(tempfile.gettempdir(), "__fc_never__"),
                      ignore_errors=True)

    # ---------------------------------------------------------------- fixtures

    def _save_run(self, outputs: dict, run_id: str = RUN_A) -> dict:
        run = {
            "id": run_id,
            "flow_id": FLOW_ID,
            "status": "done",
            "started_at": "2026-11-09T10:00:00+00:00",
            "finished_at": "2026-11-09T10:00:01+00:00",
            "nodes": {NODE: {"status": "done", "outputs": outputs}},
        }
        S.save_run(self.env, run)
        return run

    def _record(self, value, run_id: str = RUN_A, port: str = PORT):
        return R.record_value(self.env, value, run_id, NODE, port)

    def _scratch(self, prefix: str) -> str:
        folder = tempfile.mkdtemp(prefix=prefix)
        self._scratch_dirs.append(folder)
        return folder

    def _make_junction(self, link: str, target: str) -> bool:
        """Create a real NTFS junction at `link` -> `target` (Windows only); False if unsupported."""
        if os.name != "nt":
            return False
        parent = os.path.dirname(link)
        os.makedirs(parent, exist_ok=True)
        done = subprocess.run(["cmd", "/c", "mklink", "/J", link, target],
                              capture_output=True)
        created = done.returncode == 0 and os.path.isdir(link)
        if created:
            self._links.append(link)
        return created

    # ---------------------------------------------------------------- API access

    def _try_value(self, run_id=RUN_A, node=NODE, port=PORT, **query):
        params = dict(query)
        params["node"] = node
        params["port"] = port
        try:
            response = asyncio.run(A.handle("GET", f"runs/{run_id}/value", params, {}, self.env))
        except HTTPException as exc:
            return None, (exc.status_code, exc.detail)
        return response, None

    def get_value(self, run_id=RUN_A, node=NODE, port=PORT, **query) -> dict:
        response, error = self._try_value(run_id, node, port, **query)
        if error is not None:
            self.fail(f"GET runs/{run_id}/value?node={node}&port={port}&{query} "
                      f"-> {error[0]}: {error[1]!r}")
        return response

    def _check_contract(self, response):
        self.assertIsInstance(response, dict)
        self.assertTrue(CONTRACT_KEYS.issubset(response), sorted(response))
        self.assertIn(response["kind"], ("text", "json"))
        self.assertIsInstance(response["chunk"], str)
        self.assertIsInstance(response["offset"], int)
        self.assertIsInstance(response["total_chars"], int)

    def _detail_text(self, detail) -> str:
        return json.dumps(detail, ensure_ascii=False, default=str)

    def _read_all(self, first, run_id=RUN_A, port=PORT):
        """Page a value like the viewer does; returns (full text, last response)."""
        parts, response, pages = [first["chunk"]], first, 0
        while response["next_offset"] is not None:
            pages += 1
            self.assertLess(pages, 100, "the reader paged forever")
            response = self.get_value(run_id=run_id, port=port,
                                      offset=response["next_offset"], limit="65536")
            parts.append(response["chunk"])
        return "".join(parts), response

    # ================================================================ finding 1
    # Run output folder is a junction; the runtime has no os.path.isjunction.

    def test_junction_run_root_is_refused_when_isjunction_is_missing(self):
        """A junctioned run root stays refused even if os.path.isjunction is unavailable.

        The junction is created at the run's output path before that path exists. Only the
        capability is hidden (attribute set to None), not the filesystem: realpath, islink, stat
        and the actual file read all stay real, so a reader that detects the reparse point another
        way still passes, and a reader that trusts realpath alone leaks the target.
        """
        S.outputs_dir(self.env, RUN_A)                     # materialise the shared outputs/ parent
        self._save_run({"text": "ordinary run"})
        self.assertEqual(self.get_value(limit="100")["chunk"], "ordinary run")   # endpoint control

        secret = "JUNCTION-SECRET-" + "j" * 6000
        target = self._scratch("arachne-flow-review-junction-")
        with open(os.path.join(target, "secret.txt"), "w", encoding="utf-8", newline="") as fh:
            fh.write(secret)

        run_root = S.outputs_dir(self.env, RUN_JUNCTION, create=False)
        self.assertFalse(os.path.exists(run_root), f"run root already exists: {run_root}")
        if not self._make_junction(run_root, target):
            self.skipTest("this host cannot create an NTFS junction for the run-root test")

        # Fixture sanity: this is a junction and islink does not already reveal it, so hiding
        # isjunction genuinely removes the only junction signal the shipped reader has.
        old = getattr(os.path, "isjunction", _MISSING)
        if old is not _MISSING:
            self.assertTrue(os.path.isjunction(run_root), "fixture is not a junction")
        self.assertFalse(os.path.islink(run_root),
                         "fixture host reports junctions as symlinks; the isjunction hole is untestable here")
        with open(os.path.join(run_root, "secret.txt"), encoding="utf-8", newline="") as fh:
            self.assertEqual(fh.read(), secret, "fixture junction does not resolve to the target")

        self._save_run({"text": {"$large": {"file": "secret.txt",
                                            "path": os.path.join(run_root, "secret.txt"),
                                            "chars": len(secret), "preview": secret[:2000]}}},
                       run_id=RUN_JUNCTION)

        setattr(os.path, "isjunction", None)
        try:
            self.assertIsNone(os.path.isjunction, "capability was not actually disabled")
            response, error = self._try_value(run_id=RUN_JUNCTION, offset="0", limit="1000000")
        finally:
            if old is _MISSING:
                try:
                    delattr(os.path, "isjunction")
                except AttributeError:
                    pass
            else:
                setattr(os.path, "isjunction", old)
        self.assertIs(getattr(os.path, "isjunction", _MISSING), old, "isjunction was not restored")

        self.assertIsNotNone(
            error,
            "the reader followed a junctioned run output folder while os.path.isjunction was "
            "unavailable (it served the link target)")
        self.assertIn(error[0], REFUSAL, f"junctioned run root -> {error[0]}: {error[1]!r}")
        self.assertIsNotNone(error[1], "the refusal carries no message")
        self.assertNotIn(secret[:40], self._detail_text(error[1]), "the refusal leaked the target")
        if response is not None:
            self.assertNotIn(secret[:40], json.dumps(response, ensure_ascii=False))

        # Non-destructive: the junction and its target survive the request untouched.
        self.assertTrue(os.path.isdir(run_root), "the reader removed the redirected run folder")
        self.assertTrue(os.path.isfile(os.path.join(run_root, "secret.txt")))
        with open(os.path.join(run_root, "secret.txt"), encoding="utf-8", newline="") as fh:
            self.assertEqual(fh.read(), secret, "the reader modified the redirect target")

    # ================================================================ finding 2
    # For-each output list that contains $large markers.

    def _assert_list_expanded_or_refused(self, response, error, marker_path, expected, label, port):
        """Either an explicit refusal without internals, or the list's real values."""
        if error is not None:
            # Acceptable until a bounded expansion exists: an explicit refusal, never a leak.
            self.assertIn(error[0], REFUSAL, f"{label} -> {error[0]}: {error[1]!r}")
            self.assertIsNotNone(error[1], f"{label}: the refusal carries no message")
            detail = self._detail_text(error[1])
            self.assertNotIn(marker_path, detail, f"{label}: the refusal leaked the spill-file path")
            self.assertNotIn(os.path.basename(marker_path), detail,
                             f"{label}: the refusal leaked the spill-file name")
            return

        total = response['total_chars']
        current_offset = 0
        chunks = []
        pages = 0
        while True:
            pages += 1
            self.assertLessEqual(pages, 100, f"{label}: pagination exceeded 100 pages")
            self._check_contract(response)
            self.assertEqual(response["kind"], "json")
            self.assertEqual(response["offset"], current_offset)
            self.assertEqual(response["total_chars"], total)
            blob = json.dumps(response, ensure_ascii=False)
            self.assertFalse("$large" in blob,
                             f"{label}: the response returned a $large marker to the client: {clip(blob)}")
            self.assertFalse(marker_path in blob,
                             f"{label}: the response leaked the spill-file path: {clip(blob)}")
            self.assertFalse(marker_path.replace("\\", "\\\\") in blob,
                             f"{label}: the response leaked the escaped path: {clip(blob)}")
            self.assertFalse(os.path.basename(marker_path) in blob,
                             f"{label}: the response leaked the internal spill-file name: {clip(blob)}")

            chunk = response["chunk"]
            chunks.append(chunk)
            offset = response["offset"]
            next_offset = response.get("next_offset")
            if next_offset is not None:
                self.assertEqual(next_offset, offset + len(chunk))
                self.assertGreater(next_offset, offset)
                self.assertLess(next_offset, total)
                current_offset = next_offset
                response = self.get_value(port=port, offset=next_offset, limit='65536')
            else:
                self.assertEqual(offset + len(chunk), total)
                break

        parsed = strict_json("".join(chunks))
        self.assertIsInstance(parsed, list, parsed)
        self.assertEqual(parsed, expected, f"{label}: the for-each list was not expanded to its real values")

    def test_for_each_list_never_returns_large_marker_internals(self):
        item = "FOR-EACH-ITEM-" + "v" * 70000
        marker = self._record(item, port="item0")
        self.assertIn("$large", marker, "fixture: the item did not spill")
        marker_path = marker["$large"]["path"]
        expected = [item, "plain-second", 7]
        self._save_run({"items": [marker, "plain-second", 7]})

        response, error = self._try_value(port="items", offset="0", limit="65536")
        self._assert_list_expanded_or_refused(response, error, marker_path, expected, "$large list", port="items")

    def test_for_each_marker_with_unknown_status_is_refused_or_reconstructed(self):
        """A marker that lost its ``chars``/``preview`` (old or half-written loop record) is still a
        marker: 409-style refusal or the fully reconstructed value, never marker internals."""
        item = "LOOP-UNKNOWN-STATUS-" + "u" * 68000
        marker = self._record(item, port="loopitem")
        self.assertIn("$large", marker, "fixture: the item did not spill")
        marker_path = marker["$large"]["path"]
        untrusted = {"$large": {"file": os.path.basename(marker_path), "path": marker_path}}
        expected = [item, "tail"]
        self._save_run({"iterations": [untrusted, "tail"]})

        response, error = self._try_value(port="iterations", offset="0", limit="65536")
        self._assert_list_expanded_or_refused(response, error, marker_path, expected,
                                              "unknown-status marker list", port="iterations")

    # ================================================================ finding 3
    # NaN / Infinity must not be presented as valid JSON.

    def test_nan_and_infinity_are_never_served_as_valid_json(self):
        for port, value in (("nan", float("nan")), ("posinf", float("inf")),
                            ("neginf", float("-inf")), ("nested", [float("nan"), {"x": float("inf")}])):
            with self.subTest(port=port):
                stored = self._record(value, port=port)
                self._save_run({port: stored})

                response, error = self._try_value(port=port, offset="0", limit="4096")
                if error is not None:
                    self.assertIn(error[0], REFUSAL,
                                  f"non-finite {port} -> {error[0]}: {error[1]!r}")
                    self.assertIsNotNone(error[1], f"the refusal of {port} carries no message")
                    continue

                self._check_contract(response)
                try:
                    strict_json(response["chunk"])
                except ValueError as exc:
                    self.fail(f"{port} was served as 'json' but is not strict JSON: {exc}; "
                              f"chunk={response['chunk'][:120]!r}")
                blob = json.dumps(response, ensure_ascii=False)
                self.assertNotIn("NaN", blob, f"{port} echoed a NaN token")
                self.assertNotIn("Infinity", blob, f"{port} echoed an Infinity token")

    # ================================================================ finding 4
    # Legacy Windows spill file whose chars metadata no longer matches the disk bytes.

    def test_legacy_windows_file_with_stale_chars_signals_mismatch(self):
        """meta.chars says N, disk holds more (old text-mode CRLF doubling): say so, don't serve it.

        The old writer opened the spill file in text mode, so every "\\n" became "\\r\\n" and an
        existing "\\r\\n" became "\\r\\r\\n". The recorded length is the pre-write length. Exact
        reconstruction is not always possible, so the acceptable answers are an explicit mismatch
        error or the original text; corrupted bytes are not acceptable. The legacy file must stay
        byte-identical.
        """
        original = ("Zeile ä\r\nZwei\r\nDrei\n" "x" * 40 + "\r\n") * 2000
        legacy_disk = original.replace("\n", "\r\n")        # what CPython text mode wrote back then
        self.assertNotEqual(legacy_disk, original)
        self.assertGreater(len(legacy_disk), len(original))
        self.assertIn("\r\r\n", legacy_disk)
        self.assertGreater(len(legacy_disk), 64 * 1024)

        folder = S.outputs_dir(self.env, RUN_LEGACY)
        path = os.path.join(folder, f"{NODE}-legacy.txt")
        with open(path, "wb") as fh:
            fh.write(legacy_disk.encode("utf-8"))
        with open(path, "rb") as fh:
            before = fh.read()
        self.assertEqual(len(before), len(legacy_disk.encode("utf-8")))

        self._save_run({"legacy": {"$large": {"file": os.path.basename(path), "path": path,
                                              "chars": len(original), "preview": original[:2000]}},
                        "control": "small value"}, run_id=RUN_LEGACY)

        control = self.get_value(run_id=RUN_LEGACY, port="control", limit="40")
        self.assertEqual(control["chunk"], "small value")     # endpoint + run are healthy

        response, error = self._try_value(run_id=RUN_LEGACY, port="legacy", offset="0", limit="65536")
        with open(path, "rb") as fh:
            after = fh.read()
        self.assertEqual(after, before, "the reader rewrote the legacy spill file")

        if error is not None:
            self.assertIn(error[0], MISMATCH_REFUSAL,
                          f"stale chars -> {error[0]}: {error[1]!r}")
            self.assertNotEqual(error[0], 404,
                                "a metadata mismatch was reported as a missing file")
            detail = self._detail_text(error[1])
            self.assertGreater(len(detail), 2, "the mismatch refusal carries no message")
            self.assertLess(len(detail), 4000, "the mismatch refusal is not bounded")
            self.assertNotIn(original[:200], detail, "the refusal leaked the value")
            return

        self._check_contract(response)
        self.assertEqual(response["kind"], "text")
        full, _last = self._read_all(response, run_id=RUN_LEGACY, port="legacy")
        if full != original:
            at = next((i for i, (a, b) in enumerate(zip(full, original)) if a != b),
                      min(len(full), len(original)))
            self.fail("the reader silently served the CRLF-corrupted legacy bytes: "
                      f"{len(full)} chars on the wire vs {len(original)} recorded; "
                      f"first difference at {at}: {full[at:at + 16]!r} vs {original[at:at + 16]!r}")
        self.assertEqual(response["total_chars"], len(original),
                         "total_chars did not report the recorded value length")

    def test_matching_chars_still_round_trips_exactly(self):
        """Control: when meta.chars matches the disk text, a CRLF value is served verbatim."""
        text = "eins\r\nzwei\rdrei\n" * 6000
        marker = self._record(text, port="match")
        self.assertIn("$large", marker, "fixture: value did not spill")
        self.assertEqual(marker["$large"]["chars"], len(text))
        self._save_run({"match": marker})

        response = self.get_value(port="match", offset="0", limit="65536")
        self._check_contract(response)
        self.assertEqual((response["kind"], response["total_chars"]), ("text", len(text)))
        full, _last = self._read_all(response, port="match")
        self.assertEqual(full, text)


if __name__ == "__main__":
    unittest.main()
