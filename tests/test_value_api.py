"""RED contract tests for the safe, paged run-value reader.

Target API (not implemented yet)::

    GET /x/runs/<run_id>/value?node=<id>&port=<port>&offset=<char offset>&limit=<page size>

Response::

    {"kind": "text"|"json", "chunk": str, "offset": int,
     "next_offset": int|None, "total_chars": int}

The reader must show stored run outputs exactly (Unicode, newlines, empty values), page long
values, resolve ``$large`` only from the run's own output folder and never from a client path.
These tests drive the real ``engine.api.handle`` with saved run records; nothing is mocked.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

import helpers

E = helpers.load_engine()
A, R, S = E.api, E.runner, E.store

from fastapi import HTTPException  # noqa: E402

FLOW_ID = "f_0123456789"
RUN_A = "r_aaaaaaaaaa"
RUN_B = "r_bbbbbbbbbb"
RUN_MISSING = "r_ffffffffff"
# Fresh run ids for the run-root redirect tests: the junction is built at these paths before they exist.
RUN_LINK_OUT = "r_eeeeeeeeee"
RUN_LINK_RUN = "r_dddddddddd"
NODE = "n_value01"
PORT = "text"

CONTRACT_KEYS = {"kind", "chunk", "offset", "next_offset", "total_chars"}
# Errors the reader may use for bad offsets / a refused page size / an unservable marker.
BAD_REQUEST = (400, 413, 422)
NO_EXPOSURE_ERRORS = (400, 403, 404, 413, 422)
# A single $large spill file above this size must be refused, never read into one response.
MAX_LARGE_FILE_BYTES = 16 * 1024 * 1024


class ValueApiTest(unittest.TestCase):
    def setUp(self):
        self._old_data_dir = os.environ.get("FLOWCANVAS_DATA_DIR")
        self._scratch_dirs: list[str] = []
        self._links: list[str] = []
        self.data_dir = helpers.temp_data_dir()
        self.env = E.env.Env(ctx=helpers.FakeCtx(), state={}, emit=lambda event, payload: None)

    def tearDown(self):
        for link in self._links:
            try:
                os.rmdir(link)          # removes a junction/link, never its target
            except OSError:
                pass
        for folder in self._scratch_dirs:
            shutil.rmtree(folder, ignore_errors=True)
        if self._old_data_dir is None:
            os.environ.pop("FLOWCANVAS_DATA_DIR", None)
        else:
            os.environ["FLOWCANVAS_DATA_DIR"] = self._old_data_dir
        shutil.rmtree(getattr(self, "data_dir", ""), ignore_errors=True)

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

    def _secret_file(self, text: str) -> str:
        folder = tempfile.mkdtemp(prefix="flowcanvas-value-secret-")
        self._scratch_dirs.append(folder)
        path = os.path.join(folder, "secret.txt")
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        return path

    def _assert_large_marker(self, marker, suffix: str, raw_text: str, run_id: str = RUN_A):
        self.assertIsInstance(marker, dict, marker)
        self.assertIn("$large", marker, marker)
        meta = marker["$large"]
        self.assertIsInstance(meta, dict)
        self.assertEqual(meta.get("chars"), len(raw_text), meta)
        path = meta.get("path")
        self.assertTrue(path, meta)
        self.assertEqual(os.path.splitext(path)[1].lower(), suffix, path)
        self.assertTrue(os.path.isfile(path), path)
        with open(path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), raw_text)
        root = os.path.normcase(os.path.realpath(S.outputs_dir(self.env, run_id)))
        target = os.path.normcase(os.path.realpath(path))
        self.assertEqual(os.path.commonpath([root, target]), root, (root, target))

    # ---------------------------------------------------------------- API access

    def _try_value(self, run_id=RUN_A, node=NODE, port=PORT, **query):
        """Return (response, None) or (None, (status, detail)) without failing the test."""
        params = dict(query)          # fresh dict: never mutate the caller's query
        params["node"] = node         # node/port are not query kwargs -- add them explicitly
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

    def status_of(self, run_id=RUN_A, node=NODE, port=PORT, **query):
        _response, error = self._try_value(run_id, node, port, **query)
        return error if error is not None else (200, None)

    def _check_contract(self, response):
        self.assertIsInstance(response, dict)
        self.assertTrue(CONTRACT_KEYS.issubset(response), sorted(response))
        self.assertIn(response["kind"], ("text", "json"))
        self.assertIsInstance(response["chunk"], str)
        self.assertIsInstance(response["offset"], int)
        self.assertFalse(isinstance(response["offset"], bool))
        if response["next_offset"] is not None:
            self.assertIsInstance(response["next_offset"], int)
            self.assertFalse(isinstance(response["next_offset"], bool))
        self.assertIsInstance(response["total_chars"], int)
        self.assertGreaterEqual(response["total_chars"], 0)

    def _read_all(self, run_id=RUN_A, node=NODE, port=PORT, page: int = 4096):
        """Read a whole value page by page; checks the paging invariants on every page."""
        offset = 0
        chunks: list[str] = []
        total = None
        kind = None
        for _ in range(100000):
            response = self.get_value(run_id=run_id, node=node, port=port,
                                      offset=str(offset), limit=str(page))
            self._check_contract(response)
            if kind is None:
                kind = response["kind"]
            else:
                self.assertEqual(response["kind"], kind)
            if total is None:
                total = response["total_chars"]
            else:
                self.assertEqual(response["total_chars"], total)
            self.assertEqual(response["offset"], offset)
            self.assertLessEqual(len(response["chunk"]), page)
            chunks.append(response["chunk"])
            next_offset = response["next_offset"]
            if next_offset is None:
                break
            self.assertGreater(next_offset, offset)
            self.assertEqual(next_offset, offset + len(response["chunk"]))
            offset = next_offset
        else:
            self.fail("paging did not terminate")
        joined = "".join(chunks)
        self.assertEqual(total, len(joined))
        return kind, joined, total

    # ---------------------------------------------------------------- text

    def test_small_text_is_returned_verbatim(self):
        text = "line 1\nline 2\r\n\tEnde – üñï 🌍"
        self._save_run({"text": text})

        response = self.get_value(limit="4096")
        self._check_contract(response)
        self.assertEqual(response["kind"], "text")
        self.assertEqual(response["chunk"], text)
        self.assertEqual(response["offset"], 0)
        self.assertIsNone(response["next_offset"])
        self.assertEqual(response["total_chars"], len(text))

    def test_empty_text_and_unicode_paging_are_not_lost(self):
        text = "a🌍b\n"
        self._save_run({"empty": "", "unicode": text})

        empty = self.get_value(port="empty", limit="10")
        self._check_contract(empty)
        self.assertEqual(empty["kind"], "text")
        self.assertEqual(empty["chunk"], "")
        self.assertEqual(empty["offset"], 0)
        self.assertIsNone(empty["next_offset"])
        self.assertEqual(empty["total_chars"], 0)

        kind, joined, total = self._read_all(port="unicode", page=1)
        self.assertEqual(kind, "text")
        self.assertEqual(joined, text)
        self.assertEqual(total, len(text))

    # ---------------------------------------------------------------- JSON

    def test_json_scalars_and_empty_containers_round_trip(self):
        values = {"null": None, "false": False, "true": True, "zero": 0, "list": [], "dict": {}}
        self._save_run(dict(values))

        for port, value in values.items():
            with self.subTest(port=port):
                kind, joined, total = self._read_all(port=port, page=2)
                self.assertEqual(kind, "json")
                self.assertEqual(total, len(joined))
                parsed = json.loads(joined)
                self.assertEqual(type(parsed), type(value), (port, joined))
                self.assertEqual(parsed, value, (port, joined))

    def test_nested_mixed_json_with_media_round_trips(self):
        value = {
            "items": [
                None, False, 0, {}, [],
                {"name": "Ä\nZeile", "media": {"$media": {"kind": "image", "file": "pic.png",
                                                          "mime": "image/png",
                                                          "path": "C:/flowcanvas-data/pic.png"}}},
            ],
            "nested": {"x": [1, 2.5, True], "empty": ""},
        }
        self._save_run({"json": value})

        kind, joined, total = self._read_all(port="json", page=7)
        self.assertEqual(kind, "json")
        self.assertEqual(total, len(joined))
        self.assertEqual(json.loads(joined), value)

    # ---------------------------------------------------------------- $large paging

    def test_large_text_value_is_a_real_txt_and_pages_reassemble(self):
        text = "Zeile ä\n🌍 " * 8000
        self.assertGreater(len(text), 64 * 1024)
        marker = self._record(text)
        self._assert_large_marker(marker, ".txt", text)
        self._save_run({"text": marker})

        kind, joined, total = self._read_all(port="text", page=4096)
        self.assertEqual(kind, "text")
        self.assertEqual(joined, text)
        self.assertEqual(total, len(text))

    def test_large_json_value_is_a_real_json_file_and_pages_reassemble(self):
        value = {
            "meta": {"none": None, "false": False, "zero": 0,
                     "media": {"$media": {"kind": "image", "file": "pic.png", "path": "C:/data/pic.png"}}},
            "rows": [{"i": i, "text": "ü" * 40, "ok": i % 2 == 0, "none": None} for i in range(1500)],
        }
        raw = json.dumps(value, ensure_ascii=False)
        self.assertGreater(len(raw), 64 * 1024)
        marker = self._record(value, port="json")
        self._assert_large_marker(marker, ".json", raw)
        self._save_run({"json": marker})

        kind, joined, total = self._read_all(port="json", page=4096)
        self.assertEqual(kind, "json")
        self.assertEqual(total, len(joined))
        self.assertEqual(json.loads(joined), value)

    def test_each_run_serves_only_its_own_output_directory(self):
        text_a = "RUN-A-" + "a" * 70000
        text_b = "RUN-B-" + "b" * 70000
        self._save_run({"text": self._record(text_a, run_id=RUN_A)}, run_id=RUN_A)
        self._save_run({"text": self._record(text_b, run_id=RUN_B)}, run_id=RUN_B)

        root_a = os.path.normcase(os.path.realpath(S.outputs_dir(self.env, RUN_A)))
        root_b = os.path.normcase(os.path.realpath(S.outputs_dir(self.env, RUN_B)))
        self.assertNotEqual(root_a, root_b)
        self.assertFalse(root_b.startswith(root_a + os.sep), (root_a, root_b))
        self.assertFalse(root_a.startswith(root_b + os.sep), (root_a, root_b))

        kind, joined, _total = self._read_all(run_id=RUN_A, page=8192)
        self.assertEqual((kind, joined), ("text", text_a))
        kind, joined, _total = self._read_all(run_id=RUN_B, page=8192)
        self.assertEqual((kind, joined), ("text", text_b))

    # ---------------------------------------------------------------- limits / offsets

    def test_excessive_limit_is_clamped_or_refused(self):
        size = 3_000_000
        text = "x" * size
        marker = self._record(text, port="huge")
        self.assertIn("$large", marker)
        self._save_run({"huge": marker})

        response, error = self._try_value(port="huge", offset="0", limit=str(10 ** 9))
        if error is not None:
            self.assertIn(error[0], BAD_REQUEST, f"excessive limit -> {error[0]}: {error[1]!r}")
            return
        self._check_contract(response)
        self.assertEqual(response["kind"], "text")
        self.assertEqual(response["offset"], 0)
        self.assertEqual(response["total_chars"], size)
        # Either a bounded page came back, or the request should have been refused.
        self.assertLess(len(response["chunk"]), size, "excessive limit returned the whole value")
        self.assertEqual(response["next_offset"], len(response["chunk"]))

    def test_invalid_offsets_are_rejected(self):
        self._save_run({"text": "abcdef"})
        for bad in ("-1", "-999", "abc", "1.5"):
            with self.subTest(offset=bad):
                code, detail = self.status_of(offset=bad, limit="4")
                self.assertIn(code, BAD_REQUEST, f"offset={bad!r} -> {code}: {detail!r}")
                self.assertIsNotNone(detail)

    # ---------------------------------------------------------------- missing data

    def test_missing_run_node_or_port_is_404_not_null(self):
        self._save_run({"text": "known"})
        self.assertEqual(self.get_value(limit="10")["chunk"], "known")   # endpoint exists

        for label, kwargs in (
            ("run", {"run_id": RUN_MISSING}),
            ("node", {"node": "n_missing"}),
            ("port", {"port": "missing_port"}),
        ):
            with self.subTest(missing=label):
                code, detail = self.status_of(limit="10", **kwargs)
                self.assertEqual(code, 404, f"missing {label} -> {code}: {detail!r}")
                self.assertIsNotNone(detail)

    def test_stored_null_is_viewable_and_distinct_from_missing(self):
        self._save_run({"null": None, "false": False, "zero": 0})

        for port, value in (("null", None), ("false", False), ("zero", 0)):
            with self.subTest(port=port):
                response = self.get_value(port=port, limit="10")
                self._check_contract(response)
                self.assertEqual(response["kind"], "json")
                parsed = json.loads(response["chunk"])
                self.assertEqual(type(parsed), type(value))
                self.assertEqual(parsed, value)

    # ---------------------------------------------------------------- security

    def test_client_supplied_path_cannot_redirect_the_reader(self):
        text = "CLIENT-PATH-IGNORED-" + "q" * 70000
        marker = self._record(text)
        self.assertIn("$large", marker)
        self._save_run({"text": marker, "short": "short value"})
        secret = self._secret_file("CLIENT-PATH-SECRET-" + "S" * 5000)

        response = self.get_value(port="text", offset="0", limit="500",
                                  path=secret, file=secret, source=secret, dir=secret)
        self._check_contract(response)
        self.assertEqual(response["kind"], "text")
        self.assertEqual(response["chunk"], text[:500])
        self.assertNotIn("CLIENT-PATH-SECRET", json.dumps(response))

        short = self.get_value(port="short", limit="100", path=secret)
        self.assertEqual(short["chunk"], "short value")
        self.assertNotIn("CLIENT-PATH-SECRET", json.dumps(short))

        code, _detail = self.status_of(port="does_not_exist", path=secret)
        self.assertEqual(code, 404)

    def test_large_marker_cannot_leave_the_runs_own_output_directory(self):
        external_secret = "EXTERNAL-SECRET-" + "e" * 5000
        external_path = self._secret_file(external_secret)
        data_secret = "TRAVERSAL-SECRET-" + "t" * 5000
        outside_path = os.path.join(self.data_dir, "outside.txt")
        with open(outside_path, "w", encoding="utf-8") as fh:
            fh.write(data_secret)
        cross_secret = "CROSS-RUN-SECRET-" + "c" * 70000
        cross_marker = self._record(cross_secret, run_id=RUN_A, port="crosssrc")
        self.assertIn("$large", cross_marker)

        def marker(path, content):
            return {"$large": {"file": os.path.basename(path), "path": path,
                               "chars": len(content), "preview": content[:2000]}}

        outputs = {
            "safe": "safe value",
            "external": marker(external_path, external_secret),
            "traverse": marker(os.path.join(S.outputs_dir(self.env, RUN_B), "..", "..", "outside.txt"),
                               data_secret),
            "cross": cross_marker,
        }
        self._save_run(outputs, run_id=RUN_B)
        self.assertEqual(self.get_value(run_id=RUN_B, port="safe", limit="20")["chunk"], "safe value")

        for port, secret in (("external", external_secret), ("traverse", data_secret),
                             ("cross", cross_secret)):
            with self.subTest(port=port):
                response, error = self._try_value(run_id=RUN_B, port=port, offset="0", limit="1000000")
                if error is not None:
                    self.assertIn(error[0], NO_EXPOSURE_ERRORS,
                                  f"{port} marker -> {error[0]}: {error[1]!r}")
                    continue
                self._check_contract(response)
                self.assertNotIn(secret[:40], response["chunk"], f"{port} leaked the secret")
                self.assertNotIn(secret, response["chunk"], f"{port} leaked the secret")

    def test_link_inside_output_dir_cannot_escape_to_a_secret(self):
        secret = "LINK-SECRET-" + "l" * 5000
        folder = tempfile.mkdtemp(prefix="flowcanvas-value-target-")
        self._scratch_dirs.append(folder)
        with open(os.path.join(folder, "secret.txt"), "w", encoding="utf-8") as fh:
            fh.write(secret)

        outputs_dir = S.outputs_dir(self.env, RUN_B)
        link = os.path.join(outputs_dir, "escape")
        created = False
        if os.name == "nt":
            done = subprocess.run(["cmd", "/c", "mklink", "/J", link, folder], capture_output=True)
            created = done.returncode == 0 and os.path.isdir(link)
        else:
            try:
                os.symlink(folder, link, target_is_directory=True)
                created = True
            except OSError:
                created = False
        if not created:
            self.skipTest("this host cannot create a symlink/junction for the escape test")
        self._links.append(link)

        marker = {"$large": {"file": "escape/secret.txt", "path": os.path.join(link, "secret.txt"),
                             "chars": len(secret), "preview": secret[:2000]}}
        self._save_run({"safe": "still here", "escape": marker}, run_id=RUN_B)
        self.assertEqual(self.get_value(run_id=RUN_B, port="safe", limit="20")["chunk"], "still here")

        response, error = self._try_value(run_id=RUN_B, port="escape", offset="0", limit="1000000")
        if error is not None:
            self.assertIn(error[0], NO_EXPOSURE_ERRORS, f"link marker -> {error[0]}: {error[1]!r}")
            return
        self._check_contract(response)
        self.assertNotIn(secret[:40], response["chunk"], "link escape leaked the secret")
        self.assertNotIn(secret, response["chunk"], "link escape leaked the secret")


    # ---------------------------------------------------------------- fixtures (boundaries)

    def _make_dir_link(self, link: str, target: str) -> bool:
        """Create a junction (Windows) / directory symlink at `link` -> `target`; False if unsupported."""
        if os.name == "nt":
            done = subprocess.run(["cmd", "/c", "mklink", "/J", link, target], capture_output=True)
            created = done.returncode == 0 and os.path.isdir(link)
        else:
            try:
                os.symlink(target, link, target_is_directory=True)
                created = True
            except OSError:
                created = False
        if created:
            self._links.append(link)
        return created

    def _large_marker(self, path: str, chars: int, preview: str = "") -> dict:
        return {"$large": {"file": os.path.basename(path), "path": path, "chars": chars,
                           "preview": preview[:2000]}}

    # ---------------------------------------------------------------- run root redirects

    def test_run_output_root_junction_to_outside_is_rejected(self):
        """A run whose output folder *itself* is a junction must be refused, not followed.

        The link is built at the run's output path before that directory exists (a fresh run id), so
        this is not a stale-directory trick. The reader must also leave the redirect in place: replacing
        a user's directory with a fresh one is destructive.
        """
        S.outputs_dir(self.env, RUN_A)                       # outputs root exists; RUN_A is a real dir
        self._save_run({"text": "ordinary run"})
        self.assertEqual(self.get_value(limit="100")["chunk"], "ordinary run")   # endpoint exists

        secret = "RUN-ROOT-SECRET-" + "s" * 6000
        target = tempfile.mkdtemp(prefix="flowcanvas-value-runaroot-")
        self._scratch_dirs.append(target)
        with open(os.path.join(target, "secret.txt"), "w", encoding="utf-8", newline="") as fh:
            fh.write(secret)

        run_root = S.outputs_dir(self.env, RUN_LINK_OUT, create=False)
        self.assertFalse(os.path.exists(run_root), f"run root already exists: {run_root}")
        if not self._make_dir_link(run_root, target):
            self.skipTest("this host cannot create a junction/symlink for the run-root test")

        self._save_run({"text": self._large_marker(os.path.join(run_root, "secret.txt"),
                                                   len(secret), secret)}, run_id=RUN_LINK_OUT)

        response, error = self._try_value(run_id=RUN_LINK_OUT, offset="0", limit="1000000")
        self.assertIsNotNone(error, "the reader followed a run output folder that is a junction")
        self.assertIn(error[0], NO_EXPOSURE_ERRORS, f"redirected run root -> {error[0]}: {error[1]!r}")
        self.assertIsNotNone(error[1])
        if response is not None:
            self.assertNotIn(secret[:40], json.dumps(response))

        # Non-destructive: the junction still exists and still resolves to the untouched target.
        self.assertTrue(os.path.isdir(run_root), "the reader removed the redirected run output folder")
        through_link = os.path.join(run_root, "secret.txt")
        self.assertTrue(os.path.isfile(through_link), "the reader replaced the redirected run output folder")
        with open(through_link, encoding="utf-8", newline="") as fh:
            self.assertEqual(fh.read(), secret, "the reader modified the redirect target")

    def test_run_output_root_junction_to_another_run_is_rejected(self):
        """A run output folder that is a junction onto *another run's* output folder is not this run's data."""
        source = "OTHER-RUN-SECRET-" + "o" * 70000
        source_marker = self._record(source, run_id=RUN_A)
        self.assertIn("$large", source_marker)
        self._save_run({"text": source_marker}, run_id=RUN_A)
        self.assertEqual(self.get_value(run_id=RUN_A, limit="100")["chunk"], source[:100])   # control

        run_root = S.outputs_dir(self.env, RUN_LINK_RUN, create=False)
        self.assertFalse(os.path.exists(run_root), f"run root already exists: {run_root}")
        if not self._make_dir_link(run_root, S.outputs_dir(self.env, RUN_A)):
            self.skipTest("this host cannot create a junction/symlink for the run-root test")

        filename = os.path.basename(source_marker["$large"]["path"])
        self._save_run({"text": self._large_marker(os.path.join(run_root, filename), len(source), source)},
                       run_id=RUN_LINK_RUN)

        response, error = self._try_value(run_id=RUN_LINK_RUN, offset="0", limit="1000000")
        self.assertIsNotNone(error, "a run root linked onto another run served that run's output")
        self.assertIn(error[0], NO_EXPOSURE_ERRORS, f"cross-run run root -> {error[0]}: {error[1]!r}")
        if response is not None:
            self.assertNotIn(source[:40], json.dumps(response))

        # The linked run's record must still exist, and the link must still point at RUN_A's folder.
        self.assertTrue(os.path.isfile(os.path.join(run_root, filename)),
                        "the reader replaced the cross-run junction with a fresh folder")

    # ---------------------------------------------------------------- size boundaries

    def test_large_file_over_16_mib_is_refused(self):
        """>16 MiB on disk is refused (413) or answered with a short, explicit error — never slurped."""
        self._save_run({"text": "control"})
        self.assertEqual(self.get_value(limit="20")["chunk"], "control")

        size = 17 * 1024 * 1024
        path = os.path.join(S.outputs_dir(self.env, RUN_A), "oversized.txt")
        with open(path, "wb") as fh:
            fh.write(b"x" * size)
        self.assertEqual(os.path.getsize(path), size)
        self._save_run({"text": "control", "big": self._large_marker(path, size)})

        response, error = self._try_value(port="big", offset="0", limit="4096")
        self.assertIsNotNone(error, f"a {size}-byte $large file was served instead of refused")
        self.assertIn(error[0], BAD_REQUEST, f">16 MiB file -> {error[0]}: {error[1]!r}")
        detail = json.dumps(error[1], ensure_ascii=False, default=str)
        self.assertGreater(len(detail), 2, "the refusal carries no message")
        self.assertLess(len(detail), 4000, "the refusal detail is not bounded")
        self.assertNotIn("x" * 200, detail, "the refusal leaked file content")

    def test_large_file_that_grew_after_it_was_recorded_is_refused(self):
        """The size must be read fresh: a file that grows past the limit after $large was recorded is refused."""
        text = "y" * (200 * 1024)
        marker = self._record(text, port="grown")
        self.assertIn("$large", marker)
        path = marker["$large"]["path"]
        self._save_run({"grown": marker})
        kind, joined, _total = self._read_all(port="grown", page=8192)     # control: readable while small
        self.assertEqual((kind, joined), ("text", text))

        target_size = 17 * 1024 * 1024
        with open(path, "ab") as fh:
            fh.write(b"z" * (target_size - os.path.getsize(path)))
        self.assertEqual(os.path.getsize(path), target_size)

        response, error = self._try_value(port="grown", offset="0", limit="4096")
        self.assertIsNotNone(error, "the reader trusted the stale $large size and served a >16 MiB file")
        self.assertIn(error[0], BAD_REQUEST, f"grown file -> {error[0]}: {error[1]!r}")

    def test_value_file_growing_during_requests_stays_bounded(self):
        """Nothing observable may exceed the 16 MiB bound while the file is being appended to."""
        text = "w" * (512 * 1024)
        marker = self._record(text, port="live")
        self.assertIn("$large", marker)
        path = marker["$large"]["path"]
        self._save_run({"live": marker})
        kind, joined, _total = self._read_all(port="live", page=65536)   # control: endpoint + paging
        self.assertEqual((kind, joined), ("text", text))

        stop = threading.Event()
        failure: list = []

        def grow():
            try:
                while not stop.is_set() and os.path.getsize(path) < 18 * 1024 * 1024:
                    with open(path, "ab") as fh:
                        fh.write(b"g" * (1024 * 1024))
            except OSError as exc:      # noqa: BLE001 - writer trouble skips, never fails, the test
                failure.append(exc)

        writer = threading.Thread(target=grow, daemon=True)
        writer.start()
        responses = 0
        try:
            deadline = time.monotonic() + 20
            while writer.is_alive() and responses < 2000 and time.monotonic() < deadline:
                response, error = self._try_value(port="live", offset="0", limit=str(10 ** 9))
                responses += 1
                if error is not None:
                    self.assertIn(error[0], NO_EXPOSURE_ERRORS + (409,),
                                  f"live file -> {error[0]}: {error[1]!r}")
                else:
                    self._check_contract(response)
                    self.assertLessEqual(len(response["chunk"]), MAX_LARGE_FILE_BYTES,
                                         f"a growing file returned {len(response['chunk'])} chars in one page")
                    self.assertEqual(response["offset"], 0)
        finally:
            stop.set()
            writer.join(timeout=10)

        if failure:
            self.skipTest(f"could not append to the value file here: {failure[0]!r}")
        self.assertGreater(responses, 0, "no request ran while the file was growing")
        self.assertGreaterEqual(os.path.getsize(path), 16 * 1024 * 1024, "the file never grew past the bound")

    # ---------------------------------------------------------------- corrupt $large json

    def test_corrupt_json_large_file_is_not_served_as_kind_json(self):
        """A .json $large file that does not parse must fail explicitly, not claim kind json."""
        self._save_run({"good": {"ok": [1, 2]}})
        good = self.get_value(port="good", limit="100")
        self.assertEqual((good["kind"], json.loads(good["chunk"])), ("json", {"ok": [1, 2]}))

        corrupt = {
            "truncated": '{"rows": [' + '"x",' * 40000,
            "garbage": "not json at all \n" * 5000,
        }
        outputs = {"good": {"ok": [1, 2]}}
        for port, raw in corrupt.items():
            self.assertGreater(len(raw), 64 * 1024)
            path = os.path.join(S.outputs_dir(self.env, RUN_A), f"{port}.json")
            with open(path, "w", encoding="utf-8", newline="") as fh:
                fh.write(raw)
            outputs[port] = self._large_marker(path, len(raw), raw)
        self._save_run(outputs, run_id=RUN_A)

        for port, raw in corrupt.items():
            with self.subTest(port=port):
                response, error = self._try_value(port=port, offset="0", limit="4096")
                if error is not None:
                    self.assertIn(error[0], (400, 409, 413, 422, 502),
                                  f"corrupt {port} -> {error[0]}: {error[1]!r}")
                    self.assertIsNotNone(error[1], "a corrupt $large json must fail with a message")
                    continue
                self._check_contract(response)
                if response["kind"] == "json":
                    kind, joined, _total = self._read_all(port=port, page=4096)
                    self.assertEqual(joined, raw)
                    try:
                        json.loads(joined)
                    except ValueError as exc:
                        self.fail(f"corrupt {port} file served as kind=json: {exc}")
                else:
                    kind, joined, _total = self._read_all(port=port, page=4096)
                    self.assertEqual(kind, "text")
                    self.assertEqual(joined, raw)

    # ---------------------------------------------------------------- Windows newline regression

    def test_large_text_with_crlf_and_lone_cr_round_trips_exactly(self):
        """CRLF and bare CR must survive record_value -> file -> value endpoint byte for byte.

        Opening the spill file in text mode without newline="" turns every "\\r\\n" into "\\r\\r\\n"
        on Windows, and reading it back in text mode turns the pair into "\\n". Both are corruptions
        the plain "\\n" tests cannot see.
        """
        text = "eins\r\nzwei\rdrei\nvier\r\n" * 9000
        self.assertGreater(len(text), 64 * 1024)
        self.assertGreater(text.count("\r\n"), 0)
        marker = self._record(text, port="crlf")
        self.assertIn("$large", marker, "the CRLF text should spill to a file")
        path = marker["$large"]["path"]
        self.assertEqual(marker["$large"]["chars"], len(text))

        with open(path, "rb") as fh:                       # bytes on purpose: no newline translation
            on_disk = fh.read()
        self.assertEqual(on_disk, text.encode("utf-8"),
                         "record_value rewrote CRLF/CR in the spill file")
        self.assertNotIn(b"\r\r\n", on_disk)

        self._save_run({"crlf": marker})
        kind, joined, total = self._read_all(port="crlf", page=4096)
        self.assertEqual(kind, "text")
        self.assertEqual(joined, text, "the value endpoint changed CRLF/CR")
        self.assertEqual(total, len(text))
        self.assertEqual(joined.count("\r"), text.count("\r"))
        self.assertEqual(joined.count("\r\n"), text.count("\r\n"))
        self.assertNotIn("\r\r\n", joined)

        # Contrast: ordinary LF text through the same path is unaffected (the test is not over-strict).
        lf_text = "Zeile ä\tüñï 🌍\n" * 9000
        lf_marker = self._record(lf_text, port="lf")
        self.assertIn("$large", lf_marker)
        self._save_run({"crlf": marker, "lf": lf_marker})
        kind, joined, total = self._read_all(port="lf", page=4096)
        self.assertEqual((kind, joined, total), ("text", lf_text, len(lf_text)))
        self.assertNotIn("\r", joined)


if __name__ == "__main__":
    unittest.main()
