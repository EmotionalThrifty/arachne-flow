"""A7: agent tools, /flow command and declared-vs-registered tool contracts."""
import importlib.util
import json
import os
import re
import sys
import unittest

import helpers
import yaml

E = helpers.load_engine()
EXPECTED = {"flow_list", "flow_get", "flow_node_types", "flow_apply", "flow_run", "flow_status", "flow_template_save"}
TOOLS = [{"name": "echo", "toolset": "test", "parameters": {"type": "object", "properties": {
    "text": {"type": "string"}}, "required": ["text"]}}]


class AgentToolTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.events = []
        self.env = self.engine.env.Env(ctx=helpers.FakeCtx({"echo": lambda a: json.dumps({"text": "echo:" + a["text"]})}),
                                       state={"tool_source": lambda: TOOLS},
                                       emit=lambda event, payload: self.events.append((event, payload)))

    def call(self, name, args=None):
        raw = self.engine.tools.handle(name, args or {}, {}, self.env)
        result = json.loads(raw)
        self.assertFalse(result.get("error"), raw)
        return result

    def build_flow(self, name="Agent demo"):
        return self.call("flow_apply", {"name": name, "ops": [
            {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "echo", "type": "tool:echo"},
            {"op": "add_node", "ref": "out", "type": "output.preview"},
            {"op": "connect", "from": "idea.text", "to": "echo.text"},
            {"op": "connect", "from": "echo.text", "to": "out.value"},
        ]})

    def test_schemas_describe_the_seven_agent_tools(self):
        schemas = self.engine.tool_schemas.SCHEMAS
        self.assertEqual({s["name"] for s in schemas}, EXPECTED)
        for schema in schemas:
            self.assertIn("description", schema)
            self.assertEqual(schema["parameters"]["type"], "object")
        by_name = {s["name"]: s for s in schemas}
        self.assertEqual(by_name["flow_apply"]["parameters"]["required"], ["ops"])
        self.assertEqual(by_name["flow_run"]["parameters"]["required"], ["flow"])
        self.assertEqual(by_name["flow_status"]["parameters"]["required"], ["run"])

    def test_apply_list_get_and_node_types(self):
        created = self.build_flow()
        self.assertEqual(len(created["flow"]["nodes"]), 3)
        self.assertEqual(set(created["refs"]), {"idea", "echo", "out"})
        self.assertEqual(self.events[-1][0], "flow.changed")
        self.assertEqual(self.events[-1][1]["origin"], "agent")
        listed = self.call("flow_list")
        self.assertEqual([f["name"] for f in listed["flows"]], ["Agent demo"])
        got = self.call("flow_get", {"flow": "Agent dem"})
        self.assertEqual(got["flow"]["id"], created["flow"]["id"])
        self.assertIn("->", got["text"])
        echo = self.call("flow_node_types", {"query": "echo"})
        self.assertEqual([t["type"] for t in echo["types"]], ["tool:echo"])
        inputs = self.call("flow_node_types", {"category": "Inputs"})
        self.assertTrue(inputs["types"])
        self.assertTrue(all(t["category"] == "Inputs" for t in inputs["types"]))

    def test_apply_is_atomic_for_existing_and_new_flows(self):
        created = self.build_flow()
        flow_id = created["flow"]["id"]
        before = self.call("flow_get", {"flow": flow_id})["flow"]
        bad_ops = [{"op": "add_node", "type": "note"}, {"op": "add_node", "type": "no.such"}]
        error = json.loads(self.engine.tools.handle("flow_apply", {"flow": flow_id, "ops": bad_ops}, {}, self.env))
        self.assertEqual(error["index"], 1)
        after = self.call("flow_get", {"flow": flow_id})["flow"]
        self.assertEqual(after["nodes"], before["nodes"])
        self.assertEqual(after["revision"], before["revision"])
        ids_before = {f["id"] for f in self.call("flow_list")["flows"]}
        error = json.loads(self.engine.tools.handle("flow_apply", {"name": "Broken", "ops": bad_ops}, {}, self.env))
        self.assertIn("error", error)
        self.assertEqual({f["id"] for f in self.call("flow_list")["flows"]}, ids_before)

    def test_run_and_status_return_run_records(self):
        created = self.build_flow()
        idea = created["refs"]["idea"]
        run = self.call("flow_run", {"flow": "Agent demo", "inputs": {idea: "hello"}, "wait": 5})
        self.assertEqual(run["status"], "done", run)
        self.assertIn("run_id", run)
        self.assertIn("text", run)
        fetched = self.call("flow_status", {"run": run["run_id"]})
        self.assertEqual(fetched["status"], "done")
        self.assertEqual(fetched["nodes"][created["refs"]["echo"]]["outputs"]["text"], "echo:hello")
        missing = json.loads(self.engine.tools.handle("flow_status", {"run": "r_0000000000"}, {}, self.env))
        self.assertIn("error", missing)

    def test_flow_slash_command(self):
        self.build_flow()
        listed = self.engine.tools.command("list", {}, self.env)
        self.assertIn("Agent demo", listed)
        ran = self.engine.tools.command("run Agent demo", {}, self.env)
        self.assertIn("done", ran)
        run_id = next(w for w in ran.split() if w.startswith("r_")).strip(":")
        status = self.engine.tools.command("status " + run_id, {}, self.env)
        self.assertIn("done", status)
        self.assertIn("usage:", self.engine.tools.command("", {}, self.env))
        self.assertIn("usage:", self.engine.tools.command("unknown", {}, self.env))
        self.assertIn("usage:", self.engine.tools.command("run --fresh", {}, self.env))

    def test_flow_run_fresh_flag_bypasses_cache(self):
        flow_id = self.build_flow()["flow"]["id"]
        first = self.engine.tools.command("run Agent demo", {}, self.env)
        self.assertIn("done", first)
        cached = json.loads(self.engine.tools.handle("flow_run", {"flow": flow_id}, {}, self.env))
        self.assertTrue(any(s.get("status") == "cached" for s in cached["nodes"].values()), cached["text"])
        fresh = self.engine.tools.command(f"run {flow_id} --fresh", {}, self.env)
        run_id = next(w for w in fresh.split() if w.startswith("r_")).strip(":")
        run = self.engine.runner.get_run(self.env, run_id)
        self.assertFalse(any(s.get("status") == "cached" for s in run["nodes"].values()), fresh)

    def test_run_text_lists_media_paths_once(self):
        img = {"$media": {"kind": "image", "file": "a.png", "path": "C:/runs/r_1/a.png"}}
        run = {"id": "r_1", "status": "done", "ms": 5, "nodes": {
            "n1": {"status": "done", "outputs": {"media": img, "_media": [img, {"$media": {"kind": "audio", "path": "C:/runs/r_1/b.mp3"}}]}},
            "n2": {"status": "done", "outputs": {"text": "plain"}},
            "n3": {"status": "error", "error": "boom"}}}
        text = self.engine.tools._run_text(run)
        self.assertEqual([l for l in text.splitlines() if l.startswith("MEDIA:")],
                         ["MEDIA:C:/runs/r_1/a.png", "MEDIA:C:/runs/r_1/b.mp3"])
        self.assertIn("n3: error — boom", text)

    def test_flow_apply_schema_names_only_real_ops(self):
        schema = next(s for s in self.engine.tool_schemas.SCHEMAS if s["name"] == "flow_apply")
        described = schema["parameters"]["properties"]["ops"]["description"]
        for op in self.engine.graph.OPS:
            self.assertIn(op, described)
        self.assertIsNone(re.search(r"\bmove_node\b", described), "move_node is not a real op")

    def test_flow_open_emits_ui_open(self):
        flow_id = self.build_flow()["flow"]["id"]
        self.events.clear()
        said = self.engine.tools.command("open Agent demo", {}, self.env)
        self.assertIn(flow_id, said)
        self.assertEqual(self.events, [("ui.open", {"flow_id": flow_id})])
        self.events.clear()
        self.assertEqual(self.engine.tools.command("open", {}, self.env), "Opening Arachne Flow.")
        self.assertEqual(self.events, [("ui.open", {"flow_id": None})])
        self.events.clear()
        missing = self.engine.tools.command("open nope", {}, self.env)
        self.assertTrue(missing.startswith("Error:"), missing)
        self.assertEqual(self.events, [])


SKILL_TOOLS = [
    {"name": "image_generate", "toolset": "image_gen", "parameters": {"type": "object", "properties": {
        "prompt": {"type": "string"}, "aspect_ratio": {"type": "string", "enum": ["square", "landscape", "portrait"]}},
        "required": ["prompt"]}},
    {"name": "web_search", "toolset": "web", "parameters": {"type": "object", "properties": {
        "query": {"type": "string"}, "limit": {"type": "integer", "default": 5}}, "required": ["query"]}},
]


class SkillExamplesTest(unittest.TestCase):
    """D1: every ```json example in the bundled skill is a working flow_apply call."""

    def test_examples_apply_and_validate_clean(self):
        helpers.temp_data_dir()
        engine = helpers.load_engine()
        env = engine.env.Env(ctx=helpers.FakeCtx({}), state={"tool_source": lambda: SKILL_TOOLS}, emit=lambda *a: None)
        with open(os.path.join(helpers.ROOT, "skills", "arachne-flow", "SKILL.md"), encoding="utf-8") as fh:
            text = fh.read()
        blocks = [b.split("```", 1)[0] for b in text.split("```json")[1:]]
        self.assertEqual(len(blocks), 2)
        types = engine.nodes.types_by_name(env)
        for block in blocks:
            args = json.loads(block)
            result = json.loads(engine.tools.handle("flow_apply", args, {}, env))
            self.assertFalse(result.get("error"), result)
            issues = engine.graph.validate(result["flow"], types)
            self.assertEqual(issues, [], f"{args['name']}: {issues}")


class RegisterCtx(helpers.FakeCtx):
    def __init__(self):
        super().__init__()
        self.tools_seen = {}
        self.commands_seen = {}

    def register_tool(self, name, toolset, schema, handler):
        self.tools_seen[name] = {"toolset": toolset, "schema": schema, "handler": handler}

    def register_command(self, name, handler, description=None, args_hint=None):
        self.commands_seen[name] = handler

    def register_skill(self, name, path, description="", frontmatter=None):
        self.skills_seen = getattr(self, "skills_seen", {})
        self.skills_seen[name] = {"path": str(path), "description": description}


class RegistrationTest(unittest.TestCase):
    def test_manifest_matches_real_registration(self):
        with open(os.path.join(helpers.ROOT, "plugin.yaml"), encoding="utf-8") as fh:
            declared = set(yaml.safe_load(fh).get("provides_tools") or [])
        self.assertEqual(declared, EXPECTED)          # E1: the spike tool flow_ping is gone
        name = "arachne_flow_registration_test"
        spec = importlib.util.spec_from_file_location(
            name, os.path.join(helpers.ROOT, "__init__.py"), submodule_search_locations=[helpers.ROOT])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        ctx = RegisterCtx()
        previous = module.runtime.STATE.get("ctx")
        try:
            module.register(ctx)
        finally:
            module.runtime.bind(previous)
        self.assertEqual(set(ctx.tools_seen), declared)
        self.assertEqual(set(ctx.commands_seen), {"flow"})   # E1: no /arachne-flow spike command
        skill = ctx.skills_seen["arachne-flow"]
        self.assertTrue(os.path.isfile(skill["path"]), skill["path"])
        self.assertTrue(skill["description"].startswith("Use when"))
        with open(skill["path"], encoding="utf-8") as fh:
            text = fh.read()
        front = yaml.safe_load(text.split("---")[1])
        self.assertEqual(front["name"], "arachne-flow")
        for tool in EXPECTED:
            self.assertIn(tool, text, f"skill does not mention {tool}")



OWNER = "Ni" + "col"   # the developer's name, split so this file does not match its own scan
DEV_DOCS = {
    f"{stem}.md"
    for stem in ("AGENTS", "HANDOFF", "PLAN", "PROGRESS")
    if os.path.isfile(os.path.join(helpers.ROOT, f"{stem}.md"))
}   # working notes when present in the private checkout


class SpikeGoneTest(unittest.TestCase):
    """E1: no spike code or personal paths ship in the plugin package."""

    def test_version_is_1_0_0_everywhere(self):
        with open(os.path.join(helpers.ROOT, "plugin.yaml"), encoding="utf-8") as fh:
            manifest = yaml.safe_load(fh)
        self.assertEqual(str(manifest["version"]), "1.0.0")
        self.assertEqual(helpers.load_engine().VERSION, "1.0.0")

    def test_no_personal_names_in_code(self):
        hits = []
        for dirpath, dirs, files in os.walk(helpers.ROOT):
            # .hermes/ holds agent plan notes (git-ignored); dev/out holds throwaway screenshots
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", "node_modules", ".hermes", "out")]
            for name in files:
                if name in DEV_DOCS or not name.endswith((".py", ".js", ".mjs", ".yaml", ".json", ".md", ".sh")):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8", errors="replace") as fh:
                    for no, line in enumerate(fh, 1):
                        if OWNER in line:
                            hits.append(f"{os.path.relpath(path, helpers.ROOT)}:{no}")
        self.assertEqual(hits, [])

    def test_no_spike_leftovers(self):
        hits = []
        for rel in ("__init__.py", "backend.py", "plugin.yaml", os.path.join("dashboard", "plugin_api.py")):
            with open(os.path.join(helpers.ROOT, rel), encoding="utf-8") as fh:
                text = fh.read()
            for needle in ("flow_ping", "SPIKE", "C:/Users/" + OWNER, "def dispatch(", "def health("):
                if needle in text:
                    hits.append(f"{rel}: {needle}")
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
