"""Build with Hermes: no new Preview nodes unless the prompt asks for them; the model reads a wiring view."""
import asyncio
import json
import unittest
from types import SimpleNamespace

import helpers

PASS_THROUGH_AND_SIDE = {"name": "Mesh", "ops": [
    {"op": "add_node", "ref": "idea", "type": "input.text", "params": {"value": "a knight"}},
    {"op": "add_node", "ref": "mid", "type": "output.preview", "title": "Idea (shown)"},
    {"op": "add_node", "ref": "join", "type": "logic.merge"},
    {"op": "add_node", "ref": "side", "type": "output.preview", "title": "Merged (side)"},
    {"op": "add_node", "ref": "join2", "type": "logic.merge"},
    {"op": "add_node", "ref": "final", "type": "output.preview", "title": "Final"},
    {"op": "connect", "from": "idea.text", "to": "mid.value"},
    {"op": "connect", "from": "mid.value", "to": "join.a"},
    {"op": "connect", "from": "join.value", "to": "side.value"},
    {"op": "connect", "from": "join.value", "to": "join2.a"},
    {"op": "connect", "from": "join2.value", "to": "final.value"},
    {"op": "auto_layout"},
]}


class PreviewCleanupTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.g = self.engine.generate
        self.ctx = helpers.FakeCtx({})
        self.env = self.engine.env.Env(ctx=self.ctx, state={"tool_source": lambda: []})
        self.types = self.engine.nodes.types_by_name(self.env)
        merge = self.types.get("logic.merge")
        self.assertIsNotNone(merge)
        ins = [p["name"] for p in merge.get("inputs", [])]
        outs = [p["name"] for p in merge.get("outputs", [])]
        ops = json.loads(json.dumps(PASS_THROUGH_AND_SIDE).replace("join.a", "join." + ins[0])
                         .replace("join.value", "join." + outs[0]).replace("join2.a", "join2." + ins[0])
                         .replace("join2.value", "join2." + outs[0]))
        self.answer = ops

    def build(self, prompt, answer=None, flow_id=None):
        text = json.dumps(answer or self.answer)

        class Host:
            async def acomplete(self, messages, **kwargs):
                return SimpleNamespace(text=text)

        self.ctx.llm = Host()
        body = {"prompt": prompt}
        if flow_id:
            body["flow_id"] = flow_id
        return asyncio.run(self.g.generate(self.env, body))["flow"]

    def titles(self, flow):
        return sorted(n.get("title") for n in flow["nodes"] if n["type"] == "output.preview")

    def test_new_previews_are_removed_and_a_pass_through_is_rewired(self):
        flow = self.build("Make a knight asset flow")
        self.assertEqual(self.titles(flow), [])
        text = next(n["id"] for n in flow["nodes"] if n["type"] == "input.text")
        targets = [e["to"]["node"] for e in flow["edges"] if e["from"]["node"] == text]
        self.assertEqual(len(targets), 1)   # the pass-through was bridged straight into the first merge
        self.assertEqual(next(n for n in flow["nodes"] if n["id"] == targets[0])["type"], "logic.merge")

    def test_explicit_request_keeps_intermediate_previews(self):
        for prompt in ("Zeig mir die Zwischenergebnisse", "Show a preview after each step", "mit Vorschau"):
            self.assertEqual(len(self.titles(self.build(prompt))), 3, prompt)

    def test_previews_that_already_existed_are_never_touched(self):
        first = self.build("Zwischenschritte anzeigen")
        self.assertEqual(len(self.titles(first)), 3)
        edit = {"ops": [{"op": "set_meta", "description": "edited"}]}
        again = self.build("Rename nothing, add a description", answer=edit, flow_id=first["id"])
        self.assertEqual(len(self.titles(again)), 3)

    def test_prompt_tells_the_model_not_to_add_previews(self):
        system = self.g.build_messages("x", None, self.types)[0]["content"]
        self.assertIn("do NOT add output.preview", system)
        self.assertNotIn('"type": "output.preview", "title": "Result"', system)   # skill examples have none

    def test_wiring_view_lists_sources_constants_missing_and_unused_ports(self):
        flow = self.build("Zwischenschritte anzeigen")
        view = self.g.describe_flow(flow, self.types)
        merge = next(n for n in flow["nodes"] if n["type"] == "logic.merge" and
                     any(e["from"]["node"] == n["id"] and e["to"]["node"] in
                         {m["id"] for m in flow["nodes"] if m["type"] == "output.preview"} for e in flow["edges"]))
        self.assertIn(f'{merge["id"]} "', view)
        self.assertIn("<- ", view)
        self.assertIn("-> ", view)
        self.assertNotIn("MISSING", view)
        self.assertIn("(unused)", view)
        broken = dict(flow, nodes=flow["nodes"] + [{"id": "n_000001", "type": "logic.if", "params": {}}])
        self.assertIn("MISSING", self.g.describe_flow(broken, self.types))
        self.assertIn("settings: value=a knight", self.g.describe_flow(flow, self.types))

    def test_connection_guide_says_what_can_take_each_media_type(self):
        guide = self.g.connection_guide(self.types)
        self.assertIn("TEXT only", guide)
        text_line = next(l for l in guide.splitlines() if l.startswith("text ->"))
        self.assertIn("llm.complete" if any(p.get("type") == "text" for p in self.types["llm.complete"].get("inputs", []))
                      else "text.split.text", text_line)
        model_line = next(l for l in guide.splitlines() if l.startswith("model3d ->"))
        self.assertNotIn("llm.complete", model_line)


if __name__ == "__main__":
    unittest.main()
