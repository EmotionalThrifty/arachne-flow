"""Dev check: build node types from the REAL Hermes tool registry (built-in tools only).

Usage: bash scripts/hpy dev/real_registry_types.py
"""
import collections
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
os.environ.setdefault("ARACHNE_FLOW_DATA_DIR", os.path.join(ROOT, "dev", "out", "data"))

import helpers  # noqa: E402
from tools.registry import discover_builtin_tools  # noqa: E402  (dev script, not plugin code)

discover_builtin_tools()
E = helpers.load_engine()
env = E.env.Env(state={})
types = E.nodes.list_node_types(env, fresh=True)
tool_types = [t for t in types if t.get("kind") == "tool"]
print(f"{len(types)} node types, {len(tool_types)} from tools")
print("categories:", E.nodes.categories(types))
port_kinds = collections.Counter(p["type"] for t in tool_types for p in t["inputs"])
print("tool input port types:", dict(port_kinds))
for name in ("tool:web_search", "tool:text_to_speech", "tool:vision_analyze", "tool:image_generate"):
    spec = next((t for t in tool_types if t["type"] == name), None)
    if spec:
        print(name, "->", json.dumps([(p["name"], p["type"], p.get("required", False)) for p in spec["inputs"]]))
