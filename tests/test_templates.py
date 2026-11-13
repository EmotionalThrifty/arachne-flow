"""D2: bundled templates validate against the node library and create working flows."""
import asyncio
import json
import os
import unittest

import helpers
from test_options import NEW_TOOLS
from test_presets import TOOLS

# "Leer" (blank) is the existing "New blank flow" button, not a duplicate template card.
TEMPLATE_IDS = {"prompt-to-3d", "web-research-digest", "text-to-speech", "describe-image", "youtube-summary",
                "edit-image", "idea-to-video", "animate-image", "translate-and-speak", "blog-post-writer",
                "local-list-cleanup", "json-loop-collect"}


def template_tools():
    """Fake registry with every tool a bundled template needs (test_presets + the F8 NanoGPT tools)."""
    seen, out = set(), []
    for t in TOOLS + NEW_TOOLS:
        if t["name"] not in seen:
            seen.add(t["name"])
            out.append(t)
    return out


class TemplateTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.env = self.engine.env.Env(ctx=helpers.FakeCtx({}), state={"tool_source": template_tools},
                                       emit=lambda *a: None)

    def api(self, method, path, body=None, env=None):
        return asyncio.run(self.engine.api.handle(method, path, {}, body or {}, env or self.env))

    def test_every_template_validates_clean_with_the_needed_tools(self):
        folder = os.path.join(helpers.ROOT, "templates")
        found = {name[:-5] for name in os.listdir(folder) if name.endswith(".json")}
        self.assertEqual(found, TEMPLATE_IDS)
        types = self.engine.nodes.types_by_name(self.env)
        for tid in sorted(found):
            with open(os.path.join(folder, tid + ".json"), encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertTrue(data.get("name") and data.get("description"), tid)
            self.assertEqual(self.engine.graph.validate(data, types), [], tid)

    def test_templates_create_flows_with_fresh_ids(self):
        listed = self.api("GET", "templates")["templates"]
        self.assertEqual({t["id"] for t in listed}, TEMPLATE_IDS)
        self.assertTrue(all(t["available"] and not t["missing_tools"] for t in listed), listed)
        for tid in sorted(TEMPLATE_IDS):
            template = self.engine.store.load_template(self.env, tid)
            flow = self.api("POST", "flows", {"template": tid})["flow"]
            self.assertEqual(flow["name"], template["name"])
            self.assertEqual(len(flow["nodes"]), len(template["nodes"]))
            self.assertEqual(len(flow["edges"]), len(template["edges"]))
            self.assertFalse({n["id"] for n in flow["nodes"]} & {n["id"] for n in template["nodes"]}, tid)
            issues = self.api("POST", "validate", {"flow_id": flow["id"]})["issues"]
            self.assertEqual(issues, [], tid)

    def test_missing_tools_are_named_by_the_real_tool(self):
        bare = self.engine.env.Env(ctx=helpers.FakeCtx({}), state={"tool_source": lambda: []}, emit=lambda *a: None)
        listed = {t["id"]: t for t in self.api("GET", "templates", env=bare)["templates"]}
        self.assertFalse(listed["prompt-to-3d"]["available"])
        self.assertEqual(set(listed["prompt-to-3d"]["missing_tools"]),
                         {self.engine.presets.PRESET_TOOLS[t] for t in ("preset.text_to_image", "preset.image_edit",
                                                              "preset.image_to_3d")})
        self.assertFalse(any("nanogpt" in m for m in listed["prompt-to-3d"]["missing_tools"]))
        self.assertEqual(listed["text-to-speech"]["missing_tools"], ["text_to_speech"])
        self.assertEqual(listed["describe-image"]["missing_tools"], ["vision_analyze"])
        self.assertEqual(listed["web-research-digest"]["missing_tools"], ["web_search"])
        for tid in ("local-list-cleanup", "json-loop-collect"):
            self.assertTrue(listed[tid]["available"])
            self.assertEqual(listed[tid]["missing_tools"], [])


class PromptTo3dTemplateTest(unittest.TestCase):
    """Release decision 07.11.: the flagship template uses Tripo H3.0 and feeds it the views it documents (live catalog:
    `images` = "Multiview images in front, left, back, right order", 2-4 items). The generated image is the
    front view; only the three other views are paid edits."""

    def setUp(self):
        with open(os.path.join(helpers.ROOT, "templates", "prompt-to-3d.json"), encoding="utf-8") as fh:
            self.flow = json.load(fh)
        self.nodes = {n["id"]: n for n in self.flow["nodes"]}

    def of_type(self, type_name):
        found = [n for n in self.flow["nodes"] if n["type"] == type_name]
        self.assertEqual(len(found), 1, type_name)
        return found[0]

    def test_3d_node_uses_tripo_h3(self):
        self.assertEqual(self.of_type("preset.image_to_3d")["params"].get("model"), "tripo3d/h3.0")

    def test_views_reach_the_model_in_front_left_back_right_order(self):
        three_d = self.of_type("preset.image_to_3d")
        into = [e["from"] for e in self.flow["edges"] if e["to"] == {"node": three_d["id"], "port": "image"}]
        self.assertEqual([(self.nodes[f["node"]]["type"], f["port"]) for f in into],
                         [("preset.text_to_image", "image"), ("logic.collect", "list")])
        views = [n for n in self.flow["nodes"] if n["type"] == "input.text" and n["title"] == "Other views"]
        self.assertEqual(len(views), 1)
        self.assertEqual(views[0]["params"]["value"].splitlines(), ["left side view", "back view", "right side view"])

    def test_note_names_the_model_and_the_views(self):
        text = self.of_type("note")["params"]["text"]
        self.assertIn("Tripo H3.0", text)
        self.assertIn("front, left, back, right", text)

    def test_3d_node_model_matches_live_fixture_contract(self):
        model_id = self.of_type("preset.image_to_3d")["params"].get("model")
        with open(os.path.join(helpers.ROOT, "tests", "fixtures", "nanogpt_models.json"), encoding="utf-8") as fh:
            models_3d = {m["id"]: m for m in json.load(fh)["3d"]}
        self.assertIn(model_id, models_3d)
        row = models_3d[model_id]
        self.assertEqual(row.get("name"), "Tripo H3.0")
        caps = row.get("capabilities") or {}
        self.assertTrue(caps.get("image_to_3d"))
        self.assertTrue(caps.get("multiview_to_3d"))
        images_param = ((row.get("supported_parameters") or {}).get("parameters") or {}).get("images") or {}
        self.assertIn("front, left, back, right", images_param.get("description", ""))
        self.assertEqual((images_param.get("minItems"), images_param.get("maxItems")), (2, 4))



class UserTemplateTest(unittest.TestCase):
    """G5: your own templates — save from a flow, list, rename, delete, start flows; bundled stay read-only."""

    def setUp(self):
        self.data = helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.events = []
        self.env = self.engine.env.Env(ctx=helpers.FakeCtx({}), state={"tool_source": template_tools},
                                       emit=lambda event, payload: self.events.append((event, payload)))

    def api(self, method, path, body=None):
        return asyncio.run(self.engine.api.handle(method, path, {}, body or {}, self.env))

    def status_of(self, method, path, body=None):
        from fastapi import HTTPException
        try:
            self.api(method, path, body)
        except HTTPException as exc:
            return exc.status_code, exc.detail
        return 200, None

    def make_flow(self):
        flow = self.api("POST", "flows", {"template": "prompt-to-3d"})["flow"]
        flow["nodes"].append({"id": "n_0f11e0", "type": "input.file", "title": "Ref", "x": 0, "y": 400,
                              "params": {"path": "C:/x/ref.png", "kind": "image"}})
        flow["nodes"].append({"id": "n_00a001", "type": "input.number", "title": "Seed", "x": 0, "y": 600,
                              "params": {"value": 42}})
        return self.api("PUT", f"flows/{flow['id']}", {"flow": flow})["flow"]

    def test_bundled_ids_never_use_the_user_prefix(self):
        folder = os.path.join(helpers.ROOT, "templates")
        for name in os.listdir(folder):
            self.assertFalse(name.startswith(self.engine.store.USER_TEMPLATE_PREFIX), name)

    def test_save_list_and_start_a_flow_from_your_template(self):
        flow = self.make_flow()
        saved = self.api("POST", "templates", {"flow_id": flow["id"], "name": "  Mein 3D-Ablauf  ",
                                               "description": "Idee → Bild → 3D", "clear_inputs": True})["template"]
        self.assertEqual((saved["id"], saved["name"], saved["source"]), ("u-mein-3d-ablauf", "Mein 3D-Ablauf", "user"))
        self.assertEqual(saved["node_count"], len(flow["nodes"]))
        self.assertEqual(self.events[-1], ("templates.changed", {"template_id": "u-mein-3d-ablauf", "origin": "ui",
                                                                 "created": True}))
        path = os.path.join(self.data, "templates", "u-mein-3d-ablauf.json")
        with open(path, encoding="utf-8") as fh:
            stored = json.load(fh)
        by_type = {}
        for n in stored["nodes"]:
            by_type.setdefault(n["type"], n)
        self.assertEqual(by_type["input.text"]["params"]["value"], "")          # cleared
        self.assertEqual(by_type["input.number"]["params"]["value"], 0)
        self.assertEqual(by_type["input.file"]["params"], {"path": "", "kind": "image"})   # kind kept
        self.assertEqual(stored["from_flow"], flow["id"])
        self.assertNotIn("revision", stored)
        listed = self.api("GET", "templates")["templates"]
        self.assertEqual([t["id"] for t in listed if t["source"] == "user"], ["u-mein-3d-ablauf"])
        self.assertEqual(len([t for t in listed if t["source"] == "bundled"]), len(TEMPLATE_IDS))
        made = self.api("POST", "flows", {"template": "u-mein-3d-ablauf"})["flow"]
        self.assertEqual((made["name"], made["template"]), ("Mein 3D-Ablauf", "u-mein-3d-ablauf"))
        self.assertEqual(len(made["nodes"]), len(flow["nodes"]))
        self.assertFalse({n["id"] for n in made["nodes"]} & {n["id"] for n in flow["nodes"]})
        self.assertEqual(self.api("POST", "validate", {"flow_id": made["id"]})["issues"],
                         self.api("POST", "validate", {"flow_id": flow["id"]})["issues"])
        # keeping the values; the same name gets a new id, the source flow is untouched
        again = self.api("POST", "templates", {"flow_id": flow["id"], "name": "Mein 3D-Ablauf"})["template"]
        self.assertEqual(again["id"], "u-mein-3d-ablauf-2")
        self.assertEqual(again["description"], flow["description"])            # defaults to the flow's
        kept = self.engine.store.load_template(self.env, "u-mein-3d-ablauf-2")
        self.assertIn("a small wooden toy robot", json.dumps(kept))
        self.assertEqual(self.api("GET", f"flows/{flow['id']}")["flow"]["revision"], flow["revision"])

    def test_rename_replace_delete_and_read_only_bundled(self):
        flow = self.make_flow()
        tid = self.api("POST", "templates", {"flow_id": flow["id"], "name": "Draft"})["template"]["id"]
        renamed = self.api("PUT", f"templates/{tid}", {"name": "Final", "description": "Line one\nLine two"})["template"]
        self.assertEqual((renamed["id"], renamed["name"], renamed["description"]), (tid, "Final", "Line one\nLine two"))
        self.assertEqual(self.engine.store.find_template(self.env, "final"), tid)
        replaced = self.engine.store.save_template(self.env, {"name": "x", "nodes": [], "edges": []}, name="Final",
                                                   replace=tid)
        self.assertEqual((replaced["id"], replaced["node_count"]), (tid, 0))
        gone = self.api("DELETE", f"templates/{tid}")
        self.assertEqual(gone["deleted"], tid)
        self.assertTrue(os.path.isfile(os.path.join(self.data, "templates", ".trash", gone["trash"])))
        self.assertEqual(self.events[-1][1], {"template_id": tid, "origin": "ui", "deleted": True})
        self.assertFalse([t for t in self.api("GET", "templates")["templates"] if t["source"] == "user"])
        self.assertEqual(self.status_of("DELETE", f"templates/{tid}")[0], 404)
        for method, body in (("PUT", {"name": "Hacked"}), ("DELETE", None)):
            code, detail = self.status_of(method, "templates/prompt-to-3d", body)
            self.assertEqual(code, 400)
            self.assertIn("built-in", detail)
        self.assertEqual(self.status_of("PUT", "templates/u-..%2F..%2Fx", {"name": "a"})[0], 400)
        self.assertEqual(self.status_of("POST", "templates", {"flow_id": flow["id"], "name": "   "})[0], 400)
        self.assertEqual(self.status_of("POST", "templates", {"name": "No flow"})[0], 400)
        self.assertEqual(self.status_of("POST", "templates", {"flow_id": "f_0000000000", "name": "x"})[0], 404)
        long_name = self.api("POST", "templates", {"flow_id": flow["id"], "name": "A" * 300})["template"]
        self.assertEqual(len(long_name["name"]), self.engine.store.TEMPLATE_NAME_MAX)
        self.assertLessEqual(len(long_name["id"]), 64)

    def test_agent_saves_lists_and_builds_from_templates(self):
        flow = self.make_flow()
        tools = self.engine.tools

        def call(name, args):
            result = json.loads(tools.handle(name, args, {}, self.env))
            self.assertFalse(result.get("error"), result)
            return result

        saved = call("flow_template_save", {"flow": flow["name"], "name": "Agent template", "clear_inputs": True})
        tid = saved["template"]["id"]
        self.assertEqual(tid, "u-agent-template")
        self.assertIn("Your templates", saved["text"])
        self.assertEqual(self.events[-1], ("templates.changed", {"template_id": tid, "origin": "agent", "created": True}))
        listed = call("flow_list", {})
        self.assertIn(tid, [t["id"] for t in listed["templates"]])
        self.assertIn("Agent template (u-agent-template, yours", listed["text"])
        self.assertIn("(prompt-to-3d, built-in", listed["text"])
        made = call("flow_apply", {"template": "agent template", "name": "From agent", "ops": [
            {"op": "set_meta", "description": "made from my template"}]})
        self.assertEqual((made["flow"]["name"], made["flow"]["template"]), ("From agent", tid))
        self.assertEqual(len(made["flow"]["nodes"]), len(flow["nodes"]))
        updated = call("flow_template_save", {"flow": made["flow"]["id"], "replace": tid, "name": "Agent template"})
        self.assertIn("Updated template", updated["text"])
        err = json.loads(tools.handle("flow_apply", {"flow": flow["id"], "template": tid, "ops": []}, {}, self.env))
        self.assertIn("only applies to a new flow", err["error"])
        err = json.loads(tools.handle("flow_apply", {"template": "nope", "ops": []}, {}, self.env))
        self.assertEqual(err["code"], "not_found")
        err = json.loads(tools.handle("flow_template_save", {"flow": flow["id"], "replace": "prompt-to-3d"}, {}, self.env))
        self.assertIn("built-in", err["error"])


if __name__ == "__main__":
    unittest.main()
