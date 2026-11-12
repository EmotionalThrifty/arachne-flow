"""Regression: Build with Hermes has no overall deadline (background job + Stop), only a per-call stall guard."""
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
        catalog = content.split("AVAILABLE NODE TYPES (one compact JSON object per line)\n", 1)[1].split("\n\nCONNECTION GUIDE", 1)[0]
        rows = {json.loads(line)["type"] for line in catalog.splitlines() if line.strip()}
        self.assertIn("tool:weather_lookup", rows)
        self.assertIn("input.text", rows)
        self.assertNotIn("tool:unrelated_000", rows)

    def test_slow_repair_is_not_cut_off_by_an_overall_deadline(self):
        calls = []

        async def delayed(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                return "not JSON"
            await asyncio.sleep(0.3)
            return json.dumps({"ops": [{"op": "add_node", "ref": "a", "type": "input.text"}]})

        with patch.object(self.engine.generate, "_complete", side_effect=delayed):
            result = asyncio.run(self.engine.generate.generate(self.env, {"prompt": "Make a text input"}))
        self.assertEqual(len(calls), 2)
        self.assertTrue(result["created"] and result["repaired"])
        self.assertFalse(hasattr(self.engine.generate, "GENERATION_TIMEOUT_S"))

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

    def test_defaults_allow_long_thinking_and_large_answers(self):
        g = self.engine.generate
        self.assertEqual(g.GENERATE_TASK_DEFAULTS.get("reasoning_effort"), "low")
        self.assertGreaterEqual(g.LLM_TIMEOUT_S, 600)        # a stall guard per call, not a UI deadline
        self.assertGreaterEqual(g.MAX_REPLY_TOKENS, 8192)

    def test_builder_gets_the_graph_contract_of_the_skill_but_not_its_tool_workflow(self):
        types = self.engine.nodes.types_by_name(self.env)
        messages = self.engine.generate.build_messages("Erstelle einen komplizierten Flow", None, types)
        system = messages[0]["content"]
        for section in ("## Mandatory flow audit", "## Node types (always available)", "## Ops for `flow_apply`",
                        "## Example 1", "## Triggers"):
            self.assertIn(section, system)
        self.assertNotIn("## Debugging and repair", system)
        self.assertNotIn("## Workflow", system)
        self.assertLess(len(system), 24000)
        self.assertLess(sum(len(m["content"]) for m in messages), 90000)
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
        with patch.object(self.engine.generate, "LLM_TIMEOUT_S", 0.1):   # host call stalls: per-call guard fires
            with self.assertRaises(self.engine.generate.GenerateError) as caught:
                asyncio.run(self.engine.generate.generate(self.env, {"prompt": "Build"}))
        self.assertEqual(caught.exception.status, 504)
        self.assertEqual(cancelled, [True])
        self.assertEqual(self.engine.store.list_flows(self.env), before)


class GenerateJobTest(unittest.TestCase):
    """POST generate/jobs: the request answers at once, the build runs in the background, Stop cancels it."""

    def setUp(self):
        helpers.temp_data_dir()
        self.engine = helpers.load_engine()
        self.g = self.engine.generate
        self.ctx = helpers.FakeCtx({})
        self.env = self.engine.env.Env(ctx=self.ctx, state={"tool_source": lambda: []})

    def wait(self, job_id, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            job = self.g.get_job(self.env, job_id)
            if job["status"] != "running":
                return job
            time.sleep(0.02)
        self.fail("job did not finish")

    def test_job_answers_at_once_then_saves_the_flow(self):
        phases = []

        class SlowHost:
            async def acomplete(self, messages, **kwargs):
                await asyncio.sleep(0.4)
                return SimpleNamespace(text=json.dumps({"name": "Long", "ops": [
                    {"op": "add_node", "ref": "a", "type": "input.text"}]}))

        self.ctx.llm = SlowHost()
        changed = []
        started = time.time()
        job = self.g.start_job(self.env, {"prompt": "Make a text input"}, on_done=changed.append)
        self.assertLess(time.time() - started, 0.3)
        self.assertEqual(job["status"], "running")
        phases.append(self.g.get_job(self.env, job["id"])["phase"])
        done = self.wait(job["id"])
        self.assertEqual(done["status"], "done")
        self.assertTrue(done["result"]["created"])
        self.assertEqual(done["phase"], "done")
        self.assertEqual(len(changed), 1)
        self.assertIn(phases[0], ("starting", "thinking"))
        ids = [f["id"] for f in self.engine.store.list_flows(self.env)]
        self.assertIn(done["result"]["flow"]["id"], ids)

    def test_stop_cancels_the_host_call_and_saves_nothing(self):
        cancelled = []

        class PendingHost:
            async def acomplete(self, messages, **kwargs):
                try:
                    await asyncio.sleep(30)
                except asyncio.CancelledError:
                    cancelled.append(True)
                    raise
                return SimpleNamespace(text='{"ops":[]}')

        self.ctx.llm = PendingHost()
        before = self.engine.store.list_flows(self.env)
        job = self.g.start_job(self.env, {"prompt": "Build"})
        end = time.time() + 5
        while self.g.get_job(self.env, job["id"])["phase"] != "thinking" and time.time() < end:
            time.sleep(0.02)
        stopped = self.g.cancel_job(self.env, job["id"])
        self.assertEqual(stopped["status"], "cancelled")
        time.sleep(0.1)
        self.assertEqual(cancelled, [True])
        self.assertEqual(self.engine.store.list_flows(self.env), before)

    def test_bad_input_and_stale_revision_fail_before_a_job_starts(self):
        with self.assertRaises(self.g.GenerateError):
            self.g.start_job(self.env, {"prompt": "   "})
        flow = self.engine.store.create_flow(self.env, name="Base")
        with self.assertRaises(self.engine.store.ConflictError):
            self.g.start_job(self.env, {"prompt": "Edit", "flow_id": flow["id"], "base_revision": 999})
        self.assertEqual(self.env.state.get("generate_jobs", {}), {})

    def test_invalid_answers_end_as_a_readable_job_error(self):
        class BadHost:
            async def acomplete(self, messages, **kwargs):
                return SimpleNamespace(text="no json here")

        self.ctx.llm = BadHost()
        job = self.wait(self.g.start_job(self.env, {"prompt": "Build"})["id"])
        self.assertEqual(job["status"], "error")
        self.assertEqual(job["error"]["status"], 400)
        self.assertIn("after one repair", job["error"]["message"])

    def test_long_poll_returns_on_the_next_change_not_after_the_full_wait(self):
        class SlowHost:
            async def acomplete(self, messages, **kwargs):
                await asyncio.sleep(0.3)
                return SimpleNamespace(text=json.dumps({"ops": [{"op": "add_node", "ref": "a", "type": "input.text"}]}))

        self.ctx.llm = SlowHost()
        job = self.g.start_job(self.env, {"prompt": "Build"})
        started = time.time()
        while True:
            view = self.g.get_job(self.env, job["id"], wait=5)
            if view["status"] != "running":
                break
        self.assertEqual(view["status"], "done")
        self.assertLess(time.time() - started, 3)
        self.assertEqual(self.g.get_job(self.env, job["id"], wait="junk")["status"], "done")

    def test_unknown_job_is_404(self):
        with self.assertRaises(self.g.GenerateError) as caught:
            self.g.get_job(self.env, "g_missing")
        self.assertEqual(caught.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
