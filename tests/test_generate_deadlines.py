"""Regression: generator budgets include host fallback, without provider-specific reasoning flags."""
import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import helpers


class GenerateDeadlineTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.ctx = helpers.FakeCtx({})
        self.env = self.engine.env.Env(ctx=self.ctx, state={"tool_source": lambda: []})

    def test_host_fallback_result_is_not_discarded_at_the_provider_deadline(self):
        calls = []

        class HostLLM:
            def complete(self, messages, *, purpose=None, task=None, model=None, provider=None,
                         timeout=None, max_tokens=None):
                calls.append({"timeout": timeout, "max_tokens": max_tokens})
                # One provider deadline then a successful host fallback, both inside the request budget.
                time.sleep(0.06)
                return SimpleNamespace(text='{"ops":[]}')

        self.ctx.llm = HostLLM()
        with patch.object(self.engine.generate, "LLM_TIMEOUT_S", 0.04):
            result = asyncio.run(self.engine.generate._complete(self.env, [{"role": "user", "content": "test"}]))
        self.assertEqual(result, '{"ops":[]}')
        self.assertEqual(calls[0]["timeout"], 0.04)
        self.assertGreater(calls[0]["max_tokens"], 0)

    def test_task_defaults_do_not_force_reasoning_off_for_reasoning_only_models(self):
        registered = []
        self.ctx.register_auxiliary_task = lambda *args, **kw: registered.append(kw)
        self.engine.generate._ensure_generate_task(self.env)
        self.assertEqual(len(registered), 1)
        defaults = registered[0]["defaults"]
        self.assertNotEqual(defaults.get("reasoning_effort"), "none")
        self.assertNotEqual((defaults.get("extra_body") or {}).get("reasoning", {}).get("enabled"), False)

    def test_large_catalog_does_not_send_unrelated_tool_schemas(self):
        types = self.engine.nodes.types_by_name(self.env)
        for i in range(180):
            types[f"tool:unrelated_{i:03d}"] = {
                "title": f"Unrelated {i}", "description": "Unrelated archival maintenance " * 8,
                "inputs": [{"name": "query", "type": "text"}], "outputs": [{"name": "result", "type": "text"}],
                "params": [{"name": "query", "kind": "text", "description": "Archive setting " * 400}],
            }
        types["tool:weather_lookup"] = {
            "title": "Weather lookup", "description": "Weather forecast", "inputs": [], "outputs": [],
            "params": [{"name": "city", "kind": "text", "required": True}],
        }
        messages = self.engine.generate.build_messages("Use weather_lookup for the forecast", None, types)
        content = messages[1]["content"]
        self.assertLess(len(content), 100000)
        catalog = content.split("AVAILABLE NODE TYPES (one compact JSON object per line)\n", 1)[1].split("\n\nCURRENT FLOW", 1)[0]
        rows = {json.loads(line)["type"] for line in catalog.splitlines() if line.strip()}
        self.assertIn("tool:weather_lookup", rows)
        self.assertIn("input.text", rows)
        self.assertNotIn("tool:unrelated_000", rows)

    def test_request_deadline_spans_repair_and_never_saves_a_late_result(self):
        calls = []

        async def delayed(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                return "not JSON"
            await asyncio.sleep(1)
            return json.dumps({"ops": [{"op": "add_node", "ref": "a", "type": "input.text"}]})

        before = self.engine.store.list_flows(self.env)
        with patch.object(self.engine.generate, "_complete", side_effect=delayed), \
                patch.object(self.engine.generate, "GENERATION_TIMEOUT_S", 0.2):
            with self.assertRaises(self.engine.generate.GenerateError) as caught:
                asyncio.run(self.engine.generate.generate(self.env, {"prompt": "Make a text input"}))
        self.assertEqual(caught.exception.status, 504)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.engine.store.list_flows(self.env), before)

    def test_large_catalog_keeps_schemas_already_used_in_the_flow(self):
        types = self.engine.nodes.types_by_name(self.env)
        for i in range(180):
            types[f"tool:archive_{i:03d}"] = {
                "title": "Archive", "description": "Unrelated", "inputs": [], "outputs": [],
                "params": [{"name": "query", "kind": "text", "description": "Description " * 80}],
            }
        flow = {"nodes": [{"type": "tool:archive_179"}]}
        catalog, _ = self.engine.generate.generation_catalog("Add a text input", flow, types)
        rows = {json.loads(line)["type"] for line in catalog.splitlines()}
        self.assertIn("tool:archive_179", rows)
        self.assertIn("input.text", rows)
        self.assertLessEqual(len(catalog), self.engine.generate.MAX_CATALOG_CHARS)

    def test_old_registered_task_is_refreshed_once_after_hot_reload(self):
        self.env.state["generate_task_registered"] = True
        registered = []
        self.ctx.register_auxiliary_task = lambda *args, **kw: registered.append(kw)
        self.engine.generate._ensure_generate_task(self.env)
        self.engine.generate._ensure_generate_task(self.env)
        self.assertEqual(len(registered), 1)
        self.assertEqual(registered[0]["defaults"]["reasoning_effort"], "low")

    def test_generation_prefers_the_cancellable_public_async_host_api(self):
        calls = []

        class AsyncHost:
            async def acomplete(self, messages, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(text='{"ops":[]}')

            def complete(self, **kwargs):
                raise AssertionError("UI generation must not launch uncancellable sync retries")

        self.ctx.llm = AsyncHost()
        value = asyncio.run(self.engine.generate._complete(self.env, [{"role": "user", "content": "Build"}]))
        self.assertEqual(value, '{"ops":[]}')
        self.assertEqual(len(calls), 1)

    def test_ui_defaults_are_low_effort_and_interactive_not_multi_minute(self):
        g = self.engine.generate
        self.assertEqual(g.GENERATE_TASK_DEFAULTS.get("reasoning_effort"), "low")
        self.assertLessEqual(g.LLM_TIMEOUT_S, 30)
        self.assertLessEqual(g.GENERATION_TIMEOUT_S, 75)

    def test_builder_instructions_do_not_ship_the_whole_agent_audit(self):
        types = self.engine.nodes.types_by_name(self.env)
        messages = self.engine.generate.build_messages("Erstelle einen komplizierten Flow", None, types)
        self.assertLess(len(messages[0]["content"]), 4500)
        self.assertLess(sum(len(m["content"]) for m in messages), 24000)
        self.assertIn("auto_layout", messages[0]["content"])
        self.assertIn("connect", messages[0]["content"])

    def test_async_timeout_cancels_the_host_call_and_cannot_save_later(self):
        cancelled = []

        class PendingHost:
            async def acomplete(self, messages, **kwargs):
                try:
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    cancelled.append(True)
                    raise
                return SimpleNamespace(text='{"ops":[]}')

        self.ctx.llm = PendingHost()
        before = self.engine.store.list_flows(self.env)
        with patch.object(self.engine.generate, "GENERATION_TIMEOUT_S", 0.2):
            with self.assertRaises(self.engine.generate.GenerateError) as caught:
                asyncio.run(self.engine.generate.generate(self.env, {"prompt": "Build"}))
        self.assertEqual(caught.exception.status, 504)
        self.assertEqual(cancelled, [True])
        self.assertEqual(self.engine.store.list_flows(self.env), before)


if __name__ == "__main__":
    unittest.main()
