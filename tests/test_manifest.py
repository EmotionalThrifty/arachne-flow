"""D3: plugin.yaml config_schema matches what the engine actually reads."""
import os
import unittest

import yaml

import helpers


class ConfigSchemaTest(unittest.TestCase):
    def setUp(self):
        self.engine = helpers.load_engine()
        with open(os.path.join(helpers.ROOT, "plugin.yaml"), encoding="utf-8") as fh:
            self.schema = yaml.safe_load(fh)["config_schema"]

    def test_keys_and_types(self):
        self.assertEqual(set(self.schema), {"blocked_tools", "allow_tools", "max_parallel", "max_items", "node_timeout_s",
                                            "webhook_port"})
        types = {k: v["type"] for k, v in self.schema.items()}
        self.assertEqual(types, {"blocked_tools": "list", "allow_tools": "list", "max_parallel": "int",
                                 "max_items": "int", "node_timeout_s": "int", "webhook_port": "int"})
        for key, spec in self.schema.items():
            self.assertTrue(spec.get("label") and spec.get("description"), key)

    def test_defaults_match_engine(self):
        # The settings form shows the default and saves it back verbatim once edited, so it must be the
        # real built-in list; an empty default would silently unblock shell/browser/delegation tools.
        self.assertEqual(self.schema["blocked_tools"]["default"], list(self.engine.nodes.DEFAULT_BLOCKED))
        self.assertEqual(self.schema["allow_tools"]["default"], [])
        self.assertEqual(self.schema["max_parallel"]["default"], self.engine.runner.DEFAULT_MAX_PARALLEL)
        self.assertEqual(self.schema["node_timeout_s"]["default"], self.engine.runner.DEFAULT_NODE_TIMEOUT_S)
        self.assertEqual(self.schema["webhook_port"]["default"], self.engine.triggers.DEFAULT_WEBHOOK_PORT)
        self.assertEqual(self.schema["max_items"]["default"], self.engine.runner.DEFAULT_MAX_ITEMS)

    def test_known_code_exec_mcp_tools_are_blocked_by_default(self):
        # Review E-10: the README says code execution is blocked; MCP tools are blocked by name only, so the
        # known code/eval tools of the bundled MCP servers must be on the default list (yaml and engine).
        code_exec = ("mcp__blender__execute_blender_code", "mcp__godot_ai__editor_manage",
                     "mcp__godot_ai__script_create", "mcp__godot_ai__script_patch")
        for name in code_exec:
            self.assertIn(name, self.engine.nodes.DEFAULT_BLOCKED, name)
            self.assertIn(name, self.schema["blocked_tools"]["default"], name)
            self.assertTrue(self.engine.nodes.is_blocked(name, set(self.engine.nodes.DEFAULT_BLOCKED), set()), name)

    def test_file_write_tools_are_blocked_by_default(self):
        # R2-02: write_file/patch can write anywhere the user can, so unattended flows must not get them.
        nodes = self.engine.nodes
        for name in ("write_file", "patch"):
            self.assertIn(name, nodes.DEFAULT_BLOCKED, name)
            self.assertIn(name, self.schema["blocked_tools"]["default"], name)
            self.assertTrue(nodes.is_blocked(name, set(nodes.DEFAULT_BLOCKED), set()), name)

    def test_hand_written_flow_with_a_file_write_tool_is_invalid(self):
        # R2-02: the default policy removes the node type, so a hand-written flow cannot silently run it.
        tools = [
            {"name": "write_file", "toolset": "files",
             "parameters": {"type": "object", "properties": {"path": {"type": "string"},
                                                             "content": {"type": "string"}},
                            "required": ["path", "content"]}},
            {"name": "patch", "toolset": "files",
             "parameters": {"type": "object", "properties": {"path": {"type": "string"},
                                                             "old_string": {"type": "string"},
                                                             "new_string": {"type": "string"}}}},
        ]
        env = self.engine.env.Env(ctx=helpers.FakeCtx(), state={"tool_source": lambda: tools})
        types = self.engine.nodes.types_by_name(env)
        for name in ("write_file", "patch"):
            self.assertNotIn(f"tool:{name}", types, name)
        flow = {"schema": "arachne-flow/1", "id": "f_0000000001", "name": "hand written",
                "nodes": [{"id": "n_000001", "type": "tool:write_file", "x": 0, "y": 0,
                           "params": {"path": "C:/Windows/Startup/evil.cmd", "content": "x"}}],
                "edges": []}
        issues = self.engine.graph.validate(flow, types)
        self.assertTrue(any(i.get("level") == "error" and "unknown node type" in i.get("message", "")
                            for i in issues), issues)

    def test_readme_discloses_local_files_threads_cron_and_mcp_blocking(self):
        with open(os.path.join(helpers.ROOT, "README.md"), encoding="utf-8") as fh:
            text = fh.read()
        section = text.split("## Security and disclosure", 1)[1].split("\n## ", 1)[0]
        for needle in ("Local files", "background thread", "cron", "blocked by name", "ARACHNE_FLOW_MEDIA_ROOTS",
                       "execute_blender_code"):
            self.assertIn(needle, section, needle)
        self.assertNotIn("Flow Canvas", " ".join(text.split()))

    def test_readme_documents_install_providers_templates_and_dev_harness(self):
        with open(os.path.join(helpers.ROOT, "README.md"), encoding="utf-8") as fh:
            text = fh.read()
        install = text.split("## Install", 1)[1].split("\n## ", 1)[0]
        # catalog entry `arachne-flow` (PR #157777); GitHub install stays documented for unreviewed commits
        self.assertIn("hermes plugins install arachne-flow --enable", install)
        self.assertIn("hermes plugins install EmotionalThrifty/arachne-flow --enable", install)
        self.assertIn("plugin ID is `arachne-flow`", install)
        self.assertIn("Coming from `flowcanvas`?", install)      # old id: how to move existing data
        self.assertIn("provider-independent", install)
        self.assertNotIn("nanogpt", text.lower())                # no provider is required or special-cased
        dev = text.split("## Development", 1)[1].split("\n## ", 1)[0]
        self.assertIn("never loaded by Hermes at plugin runtime", dev)
        with open(os.path.join(helpers.ROOT, "dev", "dev_server.py"), encoding="utf-8") as fh:
            dev_server_doc = fh.read(800)
        self.assertNotIn("never shipped", dev_server_doc)
        self.assertIn("never loaded by Hermes at plugin runtime", dev_server_doc)

    def test_described_policy_holds(self):
        nodes = self.engine.nodes
        # "an empty list unblocks everything except the fixed prefixes"
        self.assertFalse(nodes.is_blocked("terminal", set(), set()))
        for name in ("kanban_create", "flow_run", "yb_send", "feishu_doc", "send_message"):
            self.assertTrue(nodes.is_blocked(name, set(), set()), name)
        # "allow_tools wins over the blocked list and the fixed prefixes"
        self.assertFalse(nodes.is_blocked("terminal", {"terminal"}, {"terminal"}))
        self.assertFalse(nodes.is_blocked("kanban_show", set(), {"kanban_show"}))

    def test_catalog_draft_matches_manifests_and_version(self):
        draft_path = os.path.join(helpers.ROOT, "docs", "catalog-entry.draft.yaml")
        if not os.path.isfile(draft_path):
            self.skipTest("catalog draft is excluded from public export")
        with open(draft_path, encoding="utf-8") as fh:
            draft = yaml.safe_load(fh)
        with open(os.path.join(helpers.ROOT, "plugin.yaml"), encoding="utf-8") as fh:
            plugin_manifest = yaml.safe_load(fh)
        with open(os.path.join(helpers.ROOT, "dashboard", "manifest.json"), encoding="utf-8") as fh:
            import json
            dash_manifest = json.load(fh)
        self.assertEqual(draft["name"], plugin_manifest["name"])
        self.assertEqual(draft["name"], dash_manifest["name"])
        self.assertEqual(draft["title"], plugin_manifest["label"])
        self.assertEqual(draft["title"], dash_manifest["label"])
        self.assertEqual(str(draft["version"]), str(plugin_manifest["version"]))
        self.assertEqual(str(draft["version"]), self.engine.VERSION)
        self.assertEqual(draft["requires_hermes"], plugin_manifest["requires_hermes"])
        self.assertEqual(draft["category"], "desktop")
        caps = draft.get("capabilities") or {}
        self.assertEqual(caps.get("provides_tools"), plugin_manifest["provides_tools"])
        self.assertEqual(caps.get("provides_hooks"), plugin_manifest["provides_hooks"])
        self.assertEqual(caps.get("provides_middleware"), [])
        self.assertEqual(caps.get("requires_env"), [])


if __name__ == "__main__":
    unittest.main()
