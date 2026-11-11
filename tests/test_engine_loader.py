import asyncio
import os
import time
import unittest

import helpers


class EngineLoaderTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.backend = helpers.load_backend()

    def test_ping_route(self):
        res = asyncio.run(self.backend.route("GET", "ping", {}, {}))
        self.assertTrue(res["ok"])
        self.assertIn("engine", res)

    def test_unknown_route_is_404(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as cm:
            asyncio.run(self.backend.route("GET", "nope", {}, {}))
        self.assertEqual(cm.exception.status_code, 404)

    def dev(self, value):
        previous = os.environ.get("FLOWCANVAS_DEV")
        if value is None:
            os.environ.pop("FLOWCANVAS_DEV", None)
        else:
            os.environ["FLOWCANVAS_DEV"] = value
        self.addCleanup(lambda: os.environ.__setitem__("FLOWCANVAS_DEV", previous) if previous is not None
                        else os.environ.pop("FLOWCANVAS_DEV", None))

    def touched(self, *rel):
        path = os.path.join(helpers.ROOT, *rel)
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
        self.addCleanup(os.utime, path, ns=(st.st_atime_ns, st.st_mtime_ns))

    def test_engine_reloads_after_edit_in_dev_mode(self):
        self.dev("1")
        first = self.backend.engine()
        self.assertIs(self.backend.engine(), first)          # cached while unchanged
        self.touched("engine", "version.py")
        self.assertIsNot(self.backend.engine(), first)       # touched file -> fresh package

    def test_engine_loads_once_outside_dev_mode(self):
        """Review E-9: a production install (hermes plugins update = git pull) must not swap modules live."""
        self.dev(None)
        first = self.backend.engine()
        self.touched("engine", "version.py")
        self.assertIs(self.backend.engine(), first)

    def test_no_reload_while_a_run_is_active(self):
        self.dev("1")
        first = self.backend.engine()
        rt = self.backend._runtime()
        active = rt.STATE.setdefault("engine_state", {}).setdefault("active_runs", {})
        active["r_test_active"] = object()
        self.addCleanup(active.pop, "r_test_active", None)
        self.touched("engine", "version.py")
        self.assertIs(self.backend.engine(), first)          # a running flow keeps one engine version
        active.pop("r_test_active")
        self.assertIsNot(self.backend.engine(), first)       # reloads once the run is over


class BackendLoaderTest(unittest.TestCase):
    """Review E-9/E-14: one backend loader (runtime.load_backend), dev-only reload."""

    def setUp(self):
        helpers.temp_data_dir()
        self.rt = helpers.load_module("runtime.py", "fc_rt_loader_test").find_or_load()
        EngineLoaderTest.dev(self, None)

    def test_backend_loads_once_outside_dev_mode(self):
        first = self.rt.load_backend()
        EngineLoaderTest.touched(self, "backend.py")
        self.assertIs(self.rt.load_backend(), first)

    def test_backend_reloads_in_dev_mode(self):
        os.environ["FLOWCANVAS_DEV"] = "1"
        first = self.rt.load_backend()
        EngineLoaderTest.touched(self, "backend.py")
        self.assertIsNot(self.rt.load_backend(), first)

    def test_plugin_api_uses_the_runtime_loader(self):
        api = helpers.load_module(os.path.join("dashboard", "plugin_api.py"), "fc_plugin_api_loader")
        self.assertIs(api.backend(), self.rt.load_backend())
        self.assertFalse(hasattr(api, "_CACHE"), "plugin_api.py keeps its own backend copy")


if __name__ == "__main__":
    unittest.main()
