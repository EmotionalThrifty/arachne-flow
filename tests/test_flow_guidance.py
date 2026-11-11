"""Reliability contract for agent-built, edited and debugged flows."""
import json
import unittest

import helpers


class FlowValidationGuidanceTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.env = self.engine.env.Env(
            ctx=helpers.FakeCtx({}), state={"tool_source": lambda: []}, emit=lambda *a: None)

    def call(self, name, args):
        raw = self.engine.tools.handle(name, args, {}, self.env)
        result = json.loads(raw)
        self.assertFalse(result.get("error"), raw)
        return result

    def test_apply_and_get_return_validation_issues_without_running(self):
        created = self.call("flow_apply", {
            "name": "Incomplete draft",
            "ops": [{"op": "add_node", "ref": "show", "type": "output.preview"}],
        })
        issues = created["issues"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["level"], "error")
        self.assertIn("required input", issues[0]["message"])

        fetched = self.call("flow_get", {"flow": created["flow"]["id"]})
        self.assertEqual(fetched["issues"], issues)


class GenerationGuidanceTest(unittest.TestCase):
    def test_compact_catalog_preserves_execution_and_model_contract(self):
        spec = {
            "type": "preset.image_to_3d",
            "title": "Image to 3D",
            "category": "Presets",
            "description": "Turn images into a model.",
            "open_params": True,
            "cache_default": True,
            "dynamic_inputs": "template",
            "typical": "Usually 1–10 minutes",
            "cost": "Paid per model",
            "inputs": [{
                "name": "image", "type": "image", "required": True,
                "multiple": True, "max": 4, "description": "Views of one object.",
            }],
            "outputs": [{"name": "model", "type": "model3d"}],
            "params": [
                {
                    "name": "model", "kind": "text", "label": "Model",
                    "default": "vendor/default", "description": "Generation model.",
                    "options_source": "mcp__vendor__list_3d_models",
                    "options_accepts": "image", "fallback": True,
                },
                {
                    "name": "duration", "kind": "number", "default": 6,
                    "from_model": "model", "min": 1, "max": 8,
                    "integer": True, "numeric": True,
                },
                {
                    "name": "references", "kind": "media_list", "required": True,
                    "min_items": 1, "max_items": 4,
                },
            ],
        }
        engine = helpers.load_engine()
        row = json.loads(engine.generate.compact_catalog({spec["type"]: spec}))

        self.assertTrue(row["open_params"])
        self.assertTrue(row["cache_default"])
        self.assertEqual(row["typical"], "Usually 1–10 minutes")
        self.assertEqual(row["cost"], "Paid per model")
        self.assertEqual(row["dynamic_inputs"], "one text input per {{name}} in template")
        self.assertEqual(row["inputs"][0]["multiple"], True)
        self.assertEqual(row["inputs"][0]["max"], 4)
        self.assertEqual(row["inputs"][0]["description"], "Views of one object.")
        model, duration, references = row["params"]
        self.assertEqual(model["options_source"], "mcp__vendor__list_3d_models")
        self.assertEqual(model["options_accepts"], "image")
        self.assertTrue(model["fallback"])
        self.assertEqual(model["description"], "Generation model.")
        self.assertEqual(duration["from_model"], "model")
        self.assertTrue(duration["numeric"])
        self.assertEqual(references["required"], True)
        self.assertEqual((references["min_items"], references["max_items"]), (1, 4))

    def test_builder_prompt_contains_the_mandatory_flow_audit(self):
        engine = helpers.load_engine()
        messages = engine.generate.build_messages("Build a reliable flow", None, {})
        system = messages[0]["content"]
        self.assertIn("## Mandatory flow audit", system)
        self.assertIn("every node", system)
        self.assertIn("every parameter", system)
        self.assertIn("options_source", system)
        self.assertIn("model compatibility", system)


if __name__ == "__main__":
    unittest.main()
