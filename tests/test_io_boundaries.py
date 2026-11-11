"""SE-3/4/5 boundary tests, written RED against 3f84425 (the guards do not exist yet).

SE-3: a UNC / device / mixed-slash reference must be refused *lexically*, before the first filesystem touch.
      Every os.path.isfile / os.path.realpath / os.stat / open call made with such a spelling is recorded by a
      spy; the spy never lets the real function see it, so no test ever touches a real share.
SE-4: the real ``_http_get`` path must download through Hermes' public
      ``tools.url_safety.create_ssrf_safe_async_client`` (follow_redirects=False, timeout, trust_env=False,
      per-hop is_safe_url). The legacy synchronous factory and a raw ``httpx.Client`` are spied and must stay
      unused. A fake async safe client serves 302 -> 200 for a public test host; no socket is opened.
SE-5: a real ASGI ``Request`` feeds oversized chunks (json and multipart, with no or with a deliberately too
      small content-length); the route must answer 413 without asking for the remaining chunks, without
      reaching the multipart parser and without reaching the backend.

Nothing here executes tool code, calls a provider or opens a connection: all data is synthetic.
"""
from __future__ import annotations

import asyncio
import base64
import builtins
import contextlib
import hashlib
import os
import tempfile
import unittest
from unittest.mock import patch

import helpers

# Keep every scratch file, temp dir and log of this suite under the Hermes cache scratch (never the repo,
# never the real plugin data). tempfile reads TEMP on Windows, so set it before the first mkdtemp().
SCRATCH = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local"),
                       "hermes", "cache", "scratch", "flowcanvas-io-boundaries")

E = helpers.load_engine()
M, R, A, S, O, P = E.media, E.runner, E.api, E.store, E.options, E.presets

import httpx  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402
import starlette.requests  # noqa: E402

try:  # Hermes' public surface; only available inside the Hermes runtime (scripts/hpy)
    from tools import url_safety
except ImportError:  # plain python3: the SE-4 tests fail with a clear message instead of skipping
    url_safety = None

REAL_HTTPX_CLIENT = httpx.Client

# Only spellings that are UNC or device namespace paths: two leading separators after normalizing slashes.
HOSTILE_PATHS = (
    "\\\\attacker.invalid\\share\\evil.png",          # UNC, backslashes
    "//attacker.invalid/share/evil.png",              # UNC, forward slashes
    "\\\\attacker.invalid/share/evil.png",            # UNC, mixed separators
    "\\\\.\\PhysicalDrive0\\evil.png",                # device namespace
    "\\\\?\\C:\\Users\\Public\\evil.png",             # verbatim / extended-length device path
    "\\\\.\\pipe\\flowcanvas-evil.png",               # named pipe
)


def is_hostile_path(value) -> bool:
    """True for the UNC/device spellings above, whatever separators or normalization they went through."""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str):
        return False
    text = value.strip()
    return bool(text) and text.replace("/", "\\").startswith("\\\\")


class HostileGuard:
    """Spies every filesystem entry point a path can reach.

    A hostile spelling is recorded and answered benignly (missing file / identity realpath), so the product
    code keeps running and the test can assert on the recorded hits. Real scratch paths pass through.
    """

    PATHS = ("isfile", "isdir", "exists", "realpath", "getsize")

    def __init__(self):
        self.hits = []
        self._patches = []

    def _benign(self, name, path):
        if name in ("isfile", "isdir", "exists"):
            return False
        if name == "realpath":
            return os.fspath(path)
        raise FileNotFoundError(2, "hostile path refused by the test spy", str(path))

    def _wrap(self, name, real):
        def spy(path, *args, **kwargs):
            if is_hostile_path(path):
                self.hits.append(f"{name}({path!r})")
                return self._benign(name, path)
            return real(path, *args, **kwargs)
        return spy

    def __enter__(self):
        self._patches = [patch.object(os.path, name, self._wrap(name, getattr(os.path, name)))
                         for name in self.PATHS]
        self._patches.append(patch.object(os, "stat", self._wrap("stat", os.stat)))
        self._patches.append(patch.object(builtins, "open", self._wrap("open", builtins.open)))
        for item in self._patches:
            item.start()
        return self

    def __exit__(self, *exc_info):
        for item in reversed(self._patches):
            item.stop()
        return False


def call(fn):
    """(exception, value) of one call: the guard's own exceptions never escape as harness errors."""
    try:
        return None, fn()
    except Exception as exc:  # noqa: BLE001 - any comprehensible exception counts as a refusal
        return exc, None


def assert_no_touch(case, guard, label):
    case.assertEqual(guard.hits, [], f"SE-3: {label} reached the filesystem with a hostile path: {guard.hits}")


def assert_refused(case, label, exc, value, mode="empty"):
    """A guard may raise a comprehensible exception or answer false/empty — never accept the reference.

    mode="digest": a string answer is fine as long as it is not a content hash (a fingerprint of a hostile path).
    mode="none": only the no-touch spy assertion matters (e.g. cache_key still returns a key, just not one
    built from a stat/open of the hostile path).
    """
    if exc is not None or mode == "none":
        return
    if mode == "digest":
        case.assertNotRegex(str(value), r"^[0-9a-f]{64}$", f"SE-3: {label} hashed a hostile path")
        return
    case.assertFalse(value, f"SE-3: {label} accepted a hostile path instead of refusing it: {value!r}")


class IoBoundariesTest(unittest.TestCase):
    BODY_LIMIT = 1024

    def setUp(self):
        os.makedirs(SCRATCH, exist_ok=True)
        temp_env = patch.dict(os.environ, {key: SCRATCH for key in ("TMPDIR", "TEMP", "TMP")})
        temp_env.start()
        self.addCleanup(temp_env.stop)
        temp_dir = patch.object(tempfile, "tempdir", SCRATCH)
        temp_dir.start()
        self.addCleanup(temp_dir.stop)
        self.data = helpers.temp_data_dir()               # fresh FLOWCANVAS_DATA_DIR per test
        previous_cache = os.environ.get("FLOWCANVAS_CACHE")
        os.environ["FLOWCANVAS_CACHE"] = os.path.join(self.data, "cache")

        def restore_cache():
            if previous_cache is None:
                os.environ.pop("FLOWCANVAS_CACHE", None)
            else:
                os.environ["FLOWCANVAS_CACHE"] = previous_cache

        self.addCleanup(restore_cache)
        self.scratch = tempfile.mkdtemp(prefix="io-boundaries-")
        self.env = E.env.Env(ctx=helpers.FakeCtx(), state={})
        self.api_mod = helpers.load_module(os.path.join("dashboard", "plugin_api.py"), "fc_plugin_api_io")

    # ------------------------------------------------------------------ helpers

    def scratch_file(self, name="pixel.png", raw=b"\x89PNG\r\n\x1a\nSE-3"):
        path = os.path.join(self.scratch, name)
        with open(path, "wb") as fh:
            fh.write(raw)
        return path, raw

    def flow_with_path(self, path):
        flow = S.create_flow(self.env, name="io-boundaries")
        flow["nodes"] = [{"id": "n1", "type": "input.file", "params": {"path": path}}]
        return S.save_flow(self.env, flow)

    # ------------------------------------------------------------ SE-3: media

    def test_media_entry_points_refuse_hostile_paths_before_any_touch(self):
        """from_local / local_ref_allowed / detection / data_url / file_sha256 / to_arg / ingest."""
        entries = {
            "from_local": lambda p: M.from_local(p, copy=False),
            "local_ref_allowed": lambda p: M.local_ref_allowed(p, roots=[self.scratch]),
            "_looks_like_local_media": lambda p: M._looks_like_local_media(p),
            "data_url": lambda p: M.data_url(p),
            "file_sha256": lambda p: M.file_sha256(p),
            "to_arg(media)": lambda p: M.to_arg({"$media": {"path": p, "kind": "image"}}, "imageDataUrl"),
            "to_arg(string)": lambda p: M.to_arg(p, "image_url"),
            "ingest(local ref)": lambda p: M.ingest(p, self.scratch, "hostile"),
        }
        for path in HOSTILE_PATHS:
            for label, fn in entries.items():
                with self.subTest(entry=label, path=path):
                    with HostileGuard() as guard:
                        exc, value = call(lambda: fn(path))
                    assert_no_touch(self, guard, label)
                    assert_refused(self, label, exc, value)

    def test_runner_parameter_paths_refuse_hostile_paths(self):
        """_param_paths / _param_fingerprints / _media_fingerprint / cache_key with explicit node params."""
        entries = {
            "_param_paths(str)": lambda p: R._param_paths(p),
            "_param_paths(media)": lambda p: R._param_paths({"$media": {"path": p, "kind": "image"}}),
            "_param_paths(list)": lambda p: R._param_paths([p, {"image": p}]),
            "_param_paths(dict)": lambda p: R._param_paths({"image": p}),
            "_param_fingerprints": lambda p: R._param_fingerprints(self.env, {"image": p}),
            "_media_fingerprint": lambda p: R._media_fingerprint(self.env, {"$media": {"path": p}}),
            "cache_key(file node)": lambda p: R.cache_key(
                self.env, {"id": "n1", "type": "input.file", "params": {"path": p}}, {}),
            "cache_key(param)": lambda p: R.cache_key(
                self.env, {"id": "n1", "type": "input.text", "params": {"image": p}}, {}),
        }
        for path in HOSTILE_PATHS:
            for label, fn in entries.items():
                with self.subTest(entry=label, path=path):
                    with HostileGuard() as guard:
                        exc, value = call(lambda: fn(path))
                    assert_no_touch(self, guard, label)
                    mode = ("digest" if label == "_media_fingerprint"
                            else "none" if label.startswith("cache_key") else "empty")
                    assert_refused(self, label, exc, value, mode=mode)

    def test_api_file_routes_refuse_hostile_paths(self):
        """file_payload / _servable / _file_node_preview (File node preview reads its stored path)."""
        for path in HOSTILE_PATHS:
            with self.subTest(entry="file_payload", path=path):
                with HostileGuard() as guard:
                    exc, value = call(lambda: A.file_payload(path))
                assert_no_touch(self, guard, "file_payload")
                assert_refused(self, "file_payload", exc, value)

            with self.subTest(entry="_servable", path=path):
                with HostileGuard() as guard:
                    exc, value = call(lambda: A._servable(self.env, {"flow_id": "f_missing"}, path))
                assert_no_touch(self, guard, "_servable")
                assert_refused(self, "_servable", exc, value)

            with self.subTest(entry="_file_node_preview", path=path):
                flow = self.flow_with_path(path)
                with HostileGuard() as guard:
                    exc, value = call(lambda: A._file_node_preview(self.env, flow["id"], {"node": "n1"}))
                assert_no_touch(self, guard, "_file_node_preview")
                if exc is None:
                    self.assertFalse(value.get("exists"), f"SE-3: preview accepted {path!r}: {value!r}")

    def test_options_and_preset_arguments_refuse_hostile_paths(self):
        """options._coerce(media) and the preset arg builders (no _media_arg/_moge_arg in presets.py)."""
        entries = {
            "_coerce(media)": lambda p: O._coerce(p, "media", "image"),
            "_coerce(media_list)": lambda p: O._coerce([p], "media_list", "image"),
            "presets._inline": lambda p: P._inline(p),
            "presets._remote_or_inline": lambda p: P._remote_or_inline(p),
            "presets._inline(media)": lambda p: P._inline({"$media": {"path": p, "kind": "image"}}),
            "presets._remote_or_inline(media)": lambda p: P._remote_or_inline(
                {"$media": {"path": p, "kind": "image"}}),
        }
        for path in HOSTILE_PATHS:
            for label, fn in entries.items():
                with self.subTest(entry=label, path=path):
                    with HostileGuard() as guard:
                        exc, value = call(lambda: fn(path))
                    assert_no_touch(self, guard, label)
                    assert_refused(self, label, exc, value)

    def test_real_local_file_still_works(self):
        """The guard must not break real local files: same entry points, real scratch file, no spies."""
        path, raw = self.scratch_file()
        digest = hashlib.sha256(raw).hexdigest()

        media = M.from_local(path, copy=False)
        self.assertEqual(media["$media"]["path"], path)
        self.assertEqual(media["$media"]["kind"], "image")
        self.assertTrue(M.local_ref_allowed(path, roots=[self.scratch]))
        self.assertTrue(M._looks_like_local_media(path))
        self.assertEqual(M.file_sha256(path), digest)
        self.assertEqual(R._param_paths(path), [path])
        self.assertEqual(R._media_fingerprint(self.env, {"$media": {"path": path}}), digest)
        self.assertEqual(R._param_fingerprints(self.env, {"image": path}), {"image": [digest]})
        self.assertEqual(R._param_paths({"image": [path]}), [path])

        data_url = M.data_url(path)
        self.assertTrue(data_url.startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(data_url.split(",", 1)[1]), raw)
        self.assertTrue(M.to_arg(path, "image_url").startswith("data:image/png;base64,"))
        self.assertTrue(M.to_arg(media, "imageDataUrl").startswith("data:image/png;base64,"))

        payload = A.file_payload(path)
        self.assertEqual((payload["name"], payload["mime"], payload["size"]), ("pixel.png", "image/png", len(raw)))
        self.assertTrue(payload["data_url"].startswith("data:image/png;base64,"))
        inside = os.path.join(self.data, "outputs", "inside.png")
        os.makedirs(os.path.dirname(inside), exist_ok=True)
        with open(inside, "wb") as fh:
            fh.write(raw)
        self.assertTrue(A._servable(self.env, {"flow_id": "f_missing"}, inside))   # inside the data dir
        self.assertFalse(A._servable(self.env, {"flow_id": "f_missing"}, path))    # outside every root
        self.assertTrue(O._coerce(path, "media", "image").startswith("data:image/png;base64,"))
        self.assertTrue(P._inline(path).startswith("data:image/png;base64,"))
        self.assertTrue(P._remote_or_inline(path).startswith("data:image/png;base64,"))

        copied = M.ingest(path, os.path.join(self.data, "outputs"), "copy", roots=[self.scratch])
        self.assertNotEqual(copied["$media"]["path"], path)
        with open(copied["$media"]["path"], "rb") as fh:
            self.assertEqual(fh.read(), raw)

    # -------------------------------------------------------------- SE-4: http

    def http_patches(self, fakes):
        """Every HTTP seam: the public async factory first, the legacy sync factory only to catch the old path."""
        patches = [patch.object(httpx, "Client", fakes.raw),
                   patch.object(httpx, "AsyncClient", fakes.raw_async),
                   patch.object(url_safety, "create_ssrf_safe_async_client", fakes.async_factory),
                   patch.object(url_safety, "is_safe_url", fakes.safe)]
        if hasattr(url_safety, "create_ssrf_safe_client"):   # legacy sync factory: must stay unused
            patches.append(patch.object(url_safety, "create_ssrf_safe_client", fakes.sync_factory))
        bound = {"create_ssrf_safe_async_client": fakes.async_factory,
                 "create_ssrf_safe_client": fakes.sync_factory,
                 "is_safe_url": fakes.safe}
        for name, replacement in bound.items():
            if hasattr(M, name):                             # a fix may bind the name at import time
                patches.append(patch.object(M, name, replacement))
        return patches

    def run_http_get(self, fakes, url, dest, timeout=7, max_bytes=1024):
        with contextlib.ExitStack() as stack:
            for item in self.http_patches(fakes):
                stack.enter_context(item)
            return M._http_get(url, dest, timeout, max_bytes)

    def assert_async_factory_contract(self, fakes):
        """SE-4 oracle: only the allowlisted public async factory may build the download client."""
        self.assertEqual(fakes.raw.calls, [],
                         "SE-4: _http_get built a raw httpx.Client instead of using the SSRF-safe factory")
        self.assertEqual(fakes.raw_async.calls, [],
                         "SE-4: _http_get built a raw httpx.AsyncClient instead of using the SSRF-safe factory")
        self.assertEqual(fakes.sync_factory.calls, [],
                         "SE-4: _http_get used the synchronous tools.url_safety.create_ssrf_safe_client; "
                         "only create_ssrf_safe_async_client is allowed")
        self.assertTrue(fakes.async_factory.calls,
                        "SE-4: tools.url_safety.create_ssrf_safe_async_client was never called")
        for kwargs in fakes.async_factory.calls:
            self.assertIs(kwargs.get("follow_redirects"), False,
                          f"SE-4: async safe client must set follow_redirects=False, got {kwargs!r}")
            self.assertIs(kwargs.get("trust_env"), False,
                          f"SE-4: async safe client must set trust_env=False so proxy mounts cannot bypass "
                          f"connect-time pinning, got {kwargs!r}")
            self.assertIn("timeout", kwargs, f"SE-4: async safe client needs a timeout, got {kwargs!r}")
            self.assertIsNotNone(kwargs["timeout"], f"SE-4: empty timeout in {kwargs!r}")
        for client in fakes.async_factory.clients:
            self.assertGreaterEqual(client.async_entries, 1,
                                    "SE-4: the async safe client was never entered with 'async with'")
            self.assertEqual(client.sync_entries, 0,
                             "SE-4: the async safe client was entered with a synchronous 'with'")
        if fakes.async_factory.clients:
            for response in fakes.served:
                self.assertGreaterEqual(response.async_entries, 1,
                                        "SE-4: the response was not opened with 'async with'")
                self.assertEqual(response.sync_entries, 0,
                                 "SE-4: the response was opened with a synchronous 'with'")

    def test_http_get_uses_the_ssrf_safe_client_on_every_hop(self):
        self.assertTrue(url_safety is not None, "SE-4: run this suite with scripts/hpy (Hermes runtime)")
        fakes = HttpFakes([
            FakeResponse(302, {"location": "/b.png"}),
            FakeResponse(200, {"content-type": "image/png", "content-length": "6"}, b"\x89PNG!\n"),
        ], raw_responses=[FakeResponse(200, {"content-type": "image/png"}, b"\x89PNG!\n")])
        dest = os.path.join(self.scratch, "hop.png")

        ctype = self.run_http_get(fakes, "https://media.example.test/a.png", dest)

        self.assertEqual(ctype, "image/png")
        with open(dest, "rb") as fh:
            self.assertEqual(fh.read(), b"\x89PNG!\n")
        self.assert_async_factory_contract(fakes)
        self.assertEqual([url for _method, url, _headers in fakes.async_factory.requests],
                         ["https://media.example.test/a.png", "https://media.example.test/b.png"])
        self.assertEqual(fakes.safe.urls,
                         ["https://media.example.test/a.png", "https://media.example.test/b.png"],
                         "SE-4: is_safe_url must check every hop before it is fetched")

    def test_http_get_refuses_private_redirects_and_oversized_downloads(self):
        self.assertTrue(url_safety is not None, "SE-4: run this suite with scripts/hpy (Hermes runtime)")

        with self.subTest(case="private redirect"):
            fakes = HttpFakes([
                FakeResponse(302, {"location": "http://127.0.0.1:9/secret.png"}),
                FakeResponse(200, {"content-type": "image/png"}, b"secret"),
            ], raw_responses=[FakeResponse(200, {})], blocked=("http://127.0.0.1",))
            exc, _ = call(lambda: self.run_http_get(fakes, "https://media.example.test/a.png",
                                                    os.path.join(self.scratch, "private.png")))
            self.assertIsNotNone(exc, "SE-4: a redirect to a private address must be refused")
            self.assertIsInstance(exc, M.MediaError, f"SE-4: expected MediaError, got {exc!r}")
            self.assert_async_factory_contract(fakes)
            self.assertEqual(len(fakes.async_factory.requests), 1,
                             "SE-4: the private redirect target was fetched anyway")
            self.assertIn("http://127.0.0.1:9/secret.png", fakes.safe.urls,
                          "SE-4: the redirect target must pass is_safe_url before the next hop")

        with self.subTest(case="declared content-length over the limit"):
            limit = 10
            resp = FakeResponse(200, {"content-type": "image/png", "content-length": str(limit + 1)}, b"0123456789A")
            fakes = HttpFakes([resp], raw_responses=[
                FakeResponse(200, {"content-length": str(limit + 1)}, b"0123456789A")])
            exc, _ = call(lambda: self.run_http_get(fakes, "https://media.example.test/big.png",
                                                    os.path.join(self.scratch, "big.png"), max_bytes=limit))
            self.assertIsInstance(exc, M.MediaError, f"SE-4: oversized download not refused: {exc!r}")
            self.assert_async_factory_contract(fakes)
            self.assertEqual(resp.streamed, 0, "SE-4: body chunks were read after a declared oversize")

        with self.subTest(case="chunked body over the limit"):
            limit = 10
            resp = FakeResponse(200, {"content-type": "image/png"}, parts=[b"x" * 8, b"y" * 8, b"z" * 8])
            fakes = HttpFakes([resp], raw_responses=[FakeResponse(200, {}, b"x" * 24)])
            exc, _ = call(lambda: self.run_http_get(fakes, "https://media.example.test/chunked.png",
                                                    os.path.join(self.scratch, "chunked.png"), max_bytes=limit))
            self.assertIsInstance(exc, M.MediaError, f"SE-4: chunked oversize not refused: {exc!r}")
            self.assert_async_factory_contract(fakes)
            self.assertEqual(resp.streamed, 2, "SE-4: read chunks after the limit was crossed")

    # ------------------------------------------------------------- SE-5: body

    def post_chunks(self, chunks, content_type, content_length=None):
        feed = ChunkFeed(chunks)
        request = make_request(feed, content_type, content_length)
        backend_calls, parser_calls = [], []
        real_parser = starlette.requests.MultiPartParser

        class ParserSpy(real_parser):
            """The real parser, recorded: an oversized body must never get here."""

            def __init__(self, *args, **kwargs):
                parser_calls.append("init")
                super().__init__(*args, **kwargs)

            async def parse(self):
                parser_calls.append("parse")
                return await super().parse()

        patches = [patch.object(self.api_mod, "MAX_BODY_BYTES", self.BODY_LIMIT),
                   patch.object(self.api_mod, "backend", lambda: BackendStub(backend_calls))]
        if content_type.startswith("multipart/"):
            patches.append(patch.object(starlette.requests, "MultiPartParser", ParserSpy))
        with contextlib.ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            try:
                asyncio.run(self.api_mod.extra("uploads", request))
                status = 200
            except HTTPException as exc:
                status = exc.status_code
        return status, feed.calls, backend_calls, parser_calls

    def test_json_body_without_content_length_stops_at_the_limit(self):
        cases = (
            ("first chunk oversized", [b"{" + b" " * 4096, b"not json"], 1),
            ("second chunk oversized", [b'{"a": "', b"x" * 4096, b"not json"], 2),
        )
        for label, chunks, expected_reads in cases:
            with self.subTest(case=label):
                status, reads, backend, _parser = self.post_chunks(chunks, "application/json")
                # 413 and not 400: the invalid trailing chunk proves json.loads never saw the full body.
                self.assertEqual(status, 413, "SE-5: oversized JSON body was not refused with 413")
                self.assertEqual(reads, expected_reads,
                                 f"SE-5: read {reads} chunks although the limit was crossed in chunk "
                                 f"{expected_reads} (the rest must never be requested)")
                self.assertEqual(backend, [], "SE-5: backend was reached with an oversized body")

    def test_json_body_with_short_declared_length_stops_at_the_limit(self):
        cases = (
            ("first chunk oversized", [b"{" + b" " * 4096, b"not json"], 1),
            ("second chunk oversized", [b'{"a": "', b"x" * 4096, b"not json"], 2),
        )
        for label, chunks, expected_reads in cases:
            with self.subTest(case=label):
                status, reads, backend, _parser = self.post_chunks(chunks, "application/json", content_length=16)
                self.assertEqual(status, 413, "SE-5: a too small content-length must not disable the limit")
                self.assertEqual(reads, expected_reads,
                                 f"SE-5: read {reads} chunks although the limit was crossed in chunk "
                                 f"{expected_reads}")
                self.assertEqual(backend, [])

    def test_multipart_body_stops_at_the_limit_before_parsing(self):
        boundary = "----flowcanvasSE5"
        head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"drop.txt\"\r\n"
                f"Content-Type: text/plain\r\n\r\n").encode()
        tail = f"\r\n--{boundary}--\r\n".encode()
        content_type = f"multipart/form-data; boundary={boundary}"
        cases = (
            ("first chunk oversized", [head + b"x" * 4096, tail], 1),
            ("second chunk oversized", [head + b"x" * 128, b"y" * 4096, tail], 2),
        )
        for header_length in (None, 16):
            for label, chunks, expected_reads in cases:
                with self.subTest(case=label, declared=header_length):
                    status, reads, backend, parser = self.post_chunks(chunks, content_type,
                                                                      content_length=header_length)
                    self.assertEqual(status, 413, "SE-5: oversized multipart body was not refused with 413")
                    self.assertEqual(reads, expected_reads,
                                     f"SE-5: read {reads} chunks although the limit was crossed in chunk "
                                     f"{expected_reads}")
                    self.assertEqual(parser, [],
                                     "SE-5: the multipart parser was reached with an oversized body")
                    self.assertEqual(backend, [], "SE-5: backend was reached with an oversized body")


# --------------------------------------------------------------------- SE-4 fakes


class HttpFakes:
    """The HTTP seams of one SE-4 call.

    ``next_response`` is shared between the async and the legacy sync fake, so each scripted hop is consumed
    exactly once whichever path the product takes. That keeps the redirect/byte-cap assertions meaningful in
    the RED run too: only the factory oracle fails, never a socket or a harness error.
    """

    def __init__(self, responses, raw_responses=(), blocked=()):
        self._responses = list(responses)
        self.served = []
        self.async_factory = SafeClientFactory(self)
        self.sync_factory = SyncClientFactory(self)
        self.raw = RawClientSpy(list(raw_responses))
        self.raw_async = RawAsyncClientSpy(self)
        self.safe = SafeUrlSpy(blocked=blocked)

    def next_response(self, url):
        if not self._responses:
            raise AssertionError("SE-4: unexpected extra HTTP request")
        response = self._responses.pop(0)
        response.url = httpx.URL(str(url))
        self.served.append(response)
        return response


class FakeResponse:
    """Scripted hop: sync/async context manager with headers/url/iter_bytes/aiter_bytes like httpx."""

    def __init__(self, status=200, headers=None, body=b"", parts=None):
        self.status_code = status
        self.headers = dict(headers or {})
        self.parts = list(parts) if parts is not None else ([body] if body else [])
        self.streamed = 0
        self.url = httpx.URL("https://media.example.test/")
        self.sync_entries = 0
        self.async_entries = 0

    def __enter__(self):
        self.sync_entries += 1
        return self

    def __exit__(self, *exc_info):
        return False

    async def __aenter__(self):
        self.async_entries += 1
        return self

    async def __aexit__(self, *exc_info):
        return False

    def iter_bytes(self, chunk_size=None):
        for part in self.parts:
            self.streamed += 1
            yield part

    async def aiter_bytes(self, chunk_size=None):
        for part in self.parts:
            self.streamed += 1
            yield part


class _RecordingFactory:
    """Shared bookkeeping for a factory spy: kwargs, requested URLs and the clients it handed out."""

    def __init__(self, owner, mode):
        self.owner = owner
        self.mode = mode
        self.calls = []
        self.requests = []
        self.clients = []

    def __call__(self, *args, **kwargs):
        self.calls.append(dict(kwargs))
        client = SafeClient(self, self.mode)
        self.clients.append(client)
        return client


class SafeClientFactory(_RecordingFactory):
    """Stands in for tools.url_safety.create_ssrf_safe_async_client: records kwargs, serves the scripted hops."""

    def __init__(self, owner):
        super().__init__(owner, "async")


class SyncClientFactory(_RecordingFactory):
    """Stands in for the legacy sync create_ssrf_safe_client only so the old path fails as a clear assertion,
    never as a socket attempt or a harness error."""

    def __init__(self, owner):
        super().__init__(owner, "sync")


class RawAsyncClientSpy(_RecordingFactory):
    """Any construction here means a raw httpx.AsyncClient bypassed the SSRF-safe factory."""

    def __init__(self, owner):
        super().__init__(owner, "raw_async")


class SafeClient:
    """Async client fake; keeps the sync context methods so the pre-fix path can still run mechanically."""

    def __init__(self, factory, mode="async"):
        self.factory = factory
        self.mode = mode
        self.sync_entries = 0
        self.async_entries = 0

    def __enter__(self):
        self.sync_entries += 1
        return self

    def __exit__(self, *exc_info):
        return False

    async def __aenter__(self):
        self.async_entries += 1
        return self

    async def __aexit__(self, *exc_info):
        return False

    def stream(self, method, url, headers=None):
        self.factory.requests.append((method, str(url), dict(headers or {})))
        return self.factory.owner.next_response(url)


class SafeUrlSpy:
    def __init__(self, blocked=()):
        self.urls = []
        self.blocked = tuple(blocked)

    def __call__(self, url):
        url = str(url)
        self.urls.append(url)
        return not any(url.startswith(prefix) for prefix in self.blocked)


class RawClientSpy:
    """Any call here means _http_get bypassed the SSRF-safe factory. Serves through a MockTransport."""

    def __init__(self, responses):
        self.calls = []
        self.responses = list(responses)

    def __call__(self, *args, **kwargs):
        self.calls.append((args, dict(kwargs)))

        def handle(request):
            response = self.responses.pop(0) if self.responses else FakeResponse(500)
            return httpx.Response(response.status_code, headers=response.headers, content=b"".join(response.parts))

        return REAL_HTTPX_CLIENT(transport=httpx.MockTransport(handle), follow_redirects=False)


# --------------------------------------------------------------------- SE-5 fakes


class ChunkFeed:
    """ASGI receive() yielding a fixed chunk sequence and counting how many were asked for."""

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.calls = 0
        self.delivered = []

    async def __call__(self):
        index = self.calls
        self.calls += 1
        if index < len(self.chunks):
            chunk = self.chunks[index]
            self.delivered.append(chunk)
            return {"type": "http.request", "body": chunk, "more_body": index < len(self.chunks) - 1}
        return {"type": "http.request", "body": b"", "more_body": False}


def make_request(feed, content_type, content_length=None):
    headers = [(b"content-type", content_type.encode())]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
             "method": "POST", "scheme": "http", "path": "/api/plugins/flowcanvas/x/uploads",
             "raw_path": b"/api/plugins/flowcanvas/x/uploads", "query_string": b"", "root_path": "",
             "headers": headers, "client": ("127.0.0.1", 5555), "server": ("testserver", 80)}
    return Request(scope, feed)


class BackendStub:
    def __init__(self, log):
        self.log = log

    async def route(self, method, path, query, body):
        self.log.append((method, path))
        return {"ok": True}


if __name__ == "__main__":
    unittest.main()
