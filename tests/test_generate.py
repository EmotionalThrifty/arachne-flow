"""G6: Build a flow with Hermes, with one bounded repair and no implicit model override."""
import asyncio
import json
import unittest

import helpers


OPS = [
    {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea", "params": {"value": "Hello"}},
    {"op": "add_node", "ref": "preview", "type": "output.preview", "title": "Preview"},
    {"op": "connect", "from": "idea.text", "to": "preview.value"},
    {"op": "auto_layout"},
]
NOTE_OPS = [
    {"op": "add_node", "ref": "note", "type": "note", "params": {"text": "Added by Hermes"}},
    {"op": "auto_layout"},
]


def answer(ops=OPS, name="Text preview"):
    value = {"ops": ops}
    if name is not None:
        value["name"] = name
    return json.dumps(value)


class FakeLLM:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def complete(self, messages, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        item = self.answers.pop(0) if self.answers else answer()
        if isinstance(item, BaseException):
            raise item
        return type("Result", (), {"text": item})()


class GenerateTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.events = []
        self.ctx = helpers.FakeCtx({})
        self.ctx.llm = FakeLLM(answer())
        self.env = self.engine.env.Env(ctx=self.ctx, state={"tool_source": lambda: []},
                                       emit=lambda event, payload: self.events.append((event, payload)))

    def api(self, method, path, body=None):
        return asyncio.run(self.engine.api.handle(method, path, {}, body or {}, self.env))

    def status_of(self, body):
        from fastapi import HTTPException
        try:
            self.api("POST", "generate", body)
        except HTTPException as exc:
            return exc.status_code, exc.detail
        return 200, None

    def test_new_flow_uses_active_model_builds_prompt_and_emits(self):
        self.ctx.llm = FakeLLM("Here is the flow:\n```json\n" + answer() + "\n```\nDone.")
        result = self.api("POST", "generate", {"prompt": "Make a text preview", "origin": "ui"})
        flow = result["flow"]
        self.assertTrue(result["created"])
        self.assertFalse(result["repaired"])
        self.assertEqual(flow["name"], "Text preview")
        self.assertEqual(flow["revision"], 1)
        self.assertEqual(len(flow["nodes"]), 2)
        self.assertEqual(len(flow["edges"]), 1)
        self.assertEqual(result["summary"], {"nodes": 2, "connections": 1})
        self.assertEqual(self.api("GET", f"flows/{flow['id']}")["flow"], flow)
        call = self.ctx.llm.calls[0]
        self.assertEqual(call["purpose"], "flowcanvas generate")
        self.assertNotIn("model", call)
        self.assertNotIn("provider", call)
        system = call["messages"][0]["content"]
        user = call["messages"][1]["content"]
        self.assertIn("flow_apply", system)
        self.assertIn("Do not run the flow", system)
        self.assertIn("Make a text preview", user)
        self.assertIn("input.text", user)
        self.assertIn("CURRENT FLOW", user)
        self.assertIn("null", user)
        self.assertEqual(self.events[-1], ("flow.changed", {"flow_id": flow["id"], "revision": 1, "origin": "ui"}))

    def test_existing_flow_sends_selected_model_current_flow_and_base_revision(self):
        flow = self.api("POST", "flows", {"name": "Existing"})["flow"]
        self.ctx.llm = FakeLLM(answer(NOTE_OPS, name=None))
        result = self.api("POST", "generate", {
            "prompt": "Add a note", "flow_id": flow["id"], "base_revision": flow["revision"],
            "model": "z-ai/glm-5.3-flash", "provider": "z-ai", "origin": "ui",
        })
        self.assertFalse(result["created"])
        self.assertEqual(result["flow"]["revision"], 2)
        self.assertEqual(result["flow"]["name"], "Existing")
        self.assertTrue(any(n["type"] == "note" for n in result["flow"]["nodes"]))
        call = self.ctx.llm.calls[0]
        self.assertEqual(call["model"], "z-ai/glm-5.3-flash")
        self.assertEqual(call["provider"], "z-ai")
        self.assertIn(flow["id"], call["messages"][1]["content"])
        self.assertEqual(result["summary"], {"nodes": 1, "connections": 0})

    def test_op_error_gets_exactly_one_repair_then_succeeds(self):
        bad = answer([{"op": "add_node", "ref": "bad", "type": "not.a.node"}], name=None)
        self.ctx.llm = FakeLLM(bad, answer())
        result = self.api("POST", "generate", {"prompt": "Make a text preview"})
        self.assertTrue(result["repaired"])
        self.assertEqual(len(self.ctx.llm.calls), 2)
        repair = self.ctx.llm.calls[1]["messages"][-1]["content"]
        self.assertIn("op 0", repair)
        self.assertIn("unknown node type", repair)
        self.assertIn("corrected complete JSON", repair)

    def test_second_bad_answer_writes_nothing_and_stops(self):
        self.ctx.llm = FakeLLM("not JSON", "still not JSON")
        code, detail = self.status_of({"prompt": "Make a text preview"})
        self.assertEqual(code, 400)
        self.assertIn("JSON", detail)
        self.assertEqual(len(self.ctx.llm.calls), 2)
        self.assertEqual(self.api("GET", "flows")["flows"], [])

    def test_validation_error_is_repaired_but_never_saved_invalid(self):
        invalid = answer([{"op": "add_node", "ref": "preview", "type": "output.preview"}], name=None)
        self.ctx.llm = FakeLLM(invalid, invalid)
        code, detail = self.status_of({"prompt": "Make an incomplete LLM flow"})
        self.assertEqual(code, 400)
        self.assertIn("required input", detail)
        self.assertEqual(len(self.ctx.llm.calls), 2)
        self.assertEqual(self.api("GET", "flows")["flows"], [])

    def test_stale_base_revision_returns_409_and_keeps_the_newer_flow(self):
        flow = self.api("POST", "flows", {"name": "Original"})["flow"]
        newer = self.api("PUT", f"flows/{flow['id']}", {
            "flow": {**flow, "name": "Newer"}, "base_revision": 1,
        })["flow"]
        self.ctx.llm = FakeLLM(answer(NOTE_OPS, name=None))
        code, detail = self.status_of({"prompt": "Add a note", "flow_id": flow["id"], "base_revision": 1})
        self.assertEqual(code, 409)
        self.assertEqual(detail["current_revision"], 2)
        current = self.api("GET", f"flows/{flow['id']}")["flow"]
        self.assertEqual(current, newer)
        self.assertFalse(any(n["type"] == "note" for n in current["nodes"]))

    def test_existing_validation_errors_do_not_block_unrelated_valid_changes(self):
        flow = self.api("POST", "flows", {"name": "Draft"})["flow"]
        broken = self.api("POST", f"flows/{flow['id']}/ops", {
            "ops": [{"op": "add_node", "ref": "preview", "type": "output.preview"}],
            "base_revision": 1,
        })["flow"]
        self.assertTrue(self.api("POST", "validate", {"flow_id": flow["id"]})["issues"])
        self.ctx.llm = FakeLLM(answer(NOTE_OPS, name=None))
        result = self.api("POST", "generate", {
            "prompt": "Add a note, leave the unfinished preview alone", "flow_id": flow["id"], "base_revision": 2,
        })
        self.assertEqual(result["flow"]["revision"], 3)
        self.assertFalse(result["repaired"])
        self.assertEqual(len(self.ctx.llm.calls), 1)
        self.assertTrue(any(n["type"] == "note" for n in result["flow"]["nodes"]))
        self.assertIn("KNOWN EXISTING ISSUES", self.ctx.llm.calls[0]["messages"][1]["content"])
        self.assertEqual(len(self.api("POST", "validate", {"flow_id": flow["id"]})["issues"]),
                         len(self.api("POST", "validate", {"flow": broken})["issues"]))

    def test_empty_ops_get_one_repair_instead_of_saving_a_noop_revision(self):
        flow = self.api("POST", "flows", {"name": "Existing"})["flow"]
        self.ctx.llm = FakeLLM(answer([], name=None), answer(NOTE_OPS, name=None))
        result = self.api("POST", "generate", {
            "prompt": "Add a note", "flow_id": flow["id"], "base_revision": 1,
        })
        self.assertTrue(result["repaired"])
        self.assertEqual(len(self.ctx.llm.calls), 2)
        self.assertEqual(result["flow"]["revision"], 2)
        self.assertEqual(len(result["flow"]["nodes"]), 1)
        self.assertIn("no operations", self.ctx.llm.calls[1]["messages"][-1]["content"])

    def test_permission_error_names_both_override_settings(self):
        self.ctx.llm = FakeLLM(PermissionError("override denied"))
        code, detail = self.status_of({"prompt": "Build", "model": "z/model", "provider": "z"})
        self.assertEqual(code, 403)
        self.assertIn("plugins.entries.flowcanvas.llm.allow_model_override", detail)
        self.assertIn("plugins.entries.flowcanvas.llm.allow_provider_override", detail)

    def test_blank_prompt_is_400_without_an_llm_call(self):
        code, detail = self.status_of({"prompt": "  "})
        self.assertEqual(code, 400)
        self.assertIn("prompt", detail)
        self.assertEqual(self.ctx.llm.calls, [])

    def test_generate_keeps_provider_reasoning_defaults_and_supports_older_hosts(self):
        self.ctx.llm = FakeLLM(answer())
        self.api("POST", "generate", {"prompt": "Make a text preview"})
        self.assertEqual(len(self.ctx.llm.calls), 1)
        call = self.ctx.llm.calls[0]
        self.assertEqual(call.get("task"), "flowcanvas_generate")
        self.assertNotIn("reasoning_effort", call)
        self.assertEqual(call.get("timeout"), self.engine.generate.LLM_TIMEOUT_S)
        self.assertEqual(call.get("max_tokens"), self.engine.generate.MAX_REPLY_TOKENS)

        # Fallback 1: a provider/stub whose complete(messages) accepts no optional kwargs
        calls = []

        class MinimalLLM:
            def complete(self, messages):
                calls.append(messages)
                return type("Result", (), {"text": answer()})()

        self.ctx.llm = MinimalLLM()
        res = self.api("POST", "generate", {"prompt": "Make a text preview"})
        self.assertTrue(res["created"])
        self.assertEqual(len(calls), 1)

        # Fallback 2: host rejects auxiliary task routing with PermissionError, falls back to default call
        task_calls = []

        class TaskRejectingLLM:
            def complete(self, messages, *, purpose=None, task=None, model=None, provider=None):
                task_calls.append({"purpose": purpose, "task": task})
                if task is not None:
                    raise PermissionError("Plugin 'flowcanvas' cannot route through auxiliary task 'flowcanvas_generate'")
                return type("Result", (), {"text": answer()})()

        self.ctx.llm = TaskRejectingLLM()
        res2 = self.api("POST", "generate", {"prompt": "Make a text preview"})
        self.assertTrue(res2["created"])
        self.assertEqual(len(task_calls), 2)
        self.assertEqual(task_calls[0]["task"], "flowcanvas_generate")
        self.assertIsNone(task_calls[1]["task"])

    def test_full_catalog_is_sent_compactly_and_call_count_is_bounded(self):
        tools = [
            {
                "name": "image_generate",
                "toolset": "image_gen",
                "description": "Generate an image from a prompt.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": {"type": "string", "description": "Detailed visual prompt for the image generator."},
                        "aspect_ratio": {"type": "string", "enum": ["square", "landscape", "portrait"]},
                    },
                    "required": ["prompt"],
                },
            },
            {
                "name": "web_search",
                "toolset": "web",
                "description": "Search the web.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Query string to search for."},
                        "limit": {"type": "integer", "default": 5},
                    },
                    "required": ["query"],
                },
            },
        ]
        self.env.state["tool_source"] = lambda: tools
        expected_types = self.engine.nodes.types_by_name(self.env)
        self.assertIn("preset.text_to_image", expected_types)
        self.assertIn("preset.web_search", expected_types)
        self.assertIn("tool:image_generate", expected_types)
        self.assertIn("tool:web_search", expected_types)

        self.ctx.llm = FakeLLM(answer())
        result = self.api("POST", "generate", {"prompt": "Search and make an image"})
        self.assertFalse(result["repaired"])
        self.assertEqual(len(self.ctx.llm.calls), 1)

        user_msg = self.ctx.llm.calls[0]["messages"][1]["content"]
        cat_block = user_msg.split("AVAILABLE NODE TYPES (one compact JSON object per line)\n", 1)[1].split(
            "\n\nCURRENT FLOW", 1)[0]
        rows = {json.loads(line)["type"]: json.loads(line) for line in cat_block.splitlines() if line.strip()}
        self.assertEqual(set(rows.keys()), set(expected_types.keys()))
        for name, row in rows.items():
            self.assertIn("description", row)
            self.assertIn("inputs", row)
            self.assertIn("outputs", row)
            self.assertIn("params", row)
        # Compactness: no `"required":false`, no `"default":null`, no duplicate port/param description on tool nodes
        self.assertNotIn('"required":false', cat_block)
        self.assertNotIn('"default":null', cat_block)
        img_tool = rows["tool:image_generate"]
        self.assertEqual(img_tool["inputs"][0]["description"], "Detailed visual prompt for the image generator.")
        self.assertNotIn("description", img_tool["params"][0])

    def test_failed_repair_reports_both_initial_and_repair_errors(self):
        bad_op = answer([{"op": "add_node", "ref": "bad", "type": "not.a.node"}], name=None)
        self.ctx.llm = FakeLLM(bad_op, "not valid json at all")
        code, detail = self.status_of({"prompt": "Make a text preview"})
        self.assertEqual(code, 400)
        self.assertEqual(len(self.ctx.llm.calls), 2)
        self.assertIn("after one repair", detail)
        self.assertIn("JSON", detail)
        self.assertIn("unknown node type", detail)


class SingleLlmCallTest(unittest.TestCase):
    """Review E-14: one sync bridge for LLM calls, shared by the node executor and flow generation."""

    def test_generate_uses_the_executors_llm_call(self):
        E = helpers.load_engine()
        self.assertIs(E.generate._llm_call, E.executors._llm_call)


if __name__ == "__main__":
    unittest.main()
