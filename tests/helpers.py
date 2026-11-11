"""Shared test helpers: load plugin files by path exactly like Hermes does, fake host objects."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_module(rel_path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel_path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_backend():
    """backend.py the way plugin_api.py loads it (shares runtime + engine reload state)."""
    return load_module("backend.py", "flowcanvas_backend_test")


class FakeCtx:
    """Minimal PluginContext: tools are python callables returning JSON strings."""

    def __init__(self, tools=None):
        self.tools = dict(tools or {})
        self.calls = []

    def dispatch_tool(self, name, args, **kwargs):
        self.calls.append((name, args))
        if name not in self.tools:
            return json.dumps({"error": f"Unknown tool: {name}"})
        return self.tools[name](args)


def temp_data_dir():
    """A throwaway FLOWCANVAS_DATA_DIR; tests must never write into the real plugin-data."""
    path = tempfile.mkdtemp(prefix="flowcanvas-test-")
    os.environ["FLOWCANVAS_DATA_DIR"] = path
    return path


def load_engine():
    """The engine package as backend.py loads it (relative imports work, hot-reload cache shared)."""
    return load_backend().engine()


def wait_until(predicate, timeout: float = 5.0, interval: float = 0.01):
    """Poll predicate() until it returns a truthy value or timeout expires."""
    deadline = time.monotonic() + timeout
    while True:
        val = predicate()
        if val or time.monotonic() >= deadline:
            return val
        time.sleep(interval)
