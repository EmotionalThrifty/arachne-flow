"""A5: runner — order, parallelism, failure propagation, cache, cancel, target node, events."""
import json
import os
import shutil
import threading
import time
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N = E.runner, E.store, E.graph, E.nodes

TOOLS = [
    {"name": "echo", "toolset": "test", "read_only": True,  # a pure fake: cached by default (review E-8)
     "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "slow", "toolset": "test", "parameters": {"type": "object", "properties": {
        "text": {"type": "string"}, "seconds": {"type": "number"}}}},
    {"name": "fail", "toolset": "test", "parameters": {"type": "object", "properties": {
        "text": {"type": "string"}}}},
    {"name": "big", "toolset": "test", "parameters": {"type": "object", "properties": {}}},
]


class Recorder:
    def __init__(self):
        self.events = []
        self.lock = threading.Lock()

    def __call__(self, event, payload):
        with self.lock:
            self.events.append((event, dict(payload)))

    def of(self, event):
        with self.lock:
            return [p for e, p in self.events if e == event]


class Ctx(helpers.FakeCtx):
    def __init__(self, config=None):
        self.active = 0
        self.peak = 0
        self.counter = threading.Lock()
        super().__init__({
            "echo": lambda a: json.dumps({"text": "echo:" + a["text"]}),
            "slow": self._slow,
            "fail": lambda a: json.dumps({"success": False, "error": "boom"}),
            "big": lambda a: json.dumps({"text": "x" * 70000}),
        })
        self.config = config or {}

    def _slow(self, a):
        with self.counter:
            self.active += 1
            self.peak = max(self.peak, self.active)
        time.sleep(float(a.get("seconds", 0.3)))
        with self.counter:
            self.active -= 1
        return json.dumps({"text": "slow:" + a.get("text", "")})

    def get_config(self, key, default=None):
        return self.config.get(key, default)


def make_env(config=None):
    helpers.temp_data_dir()
    rec = Recorder()
    env = E.env.Env(ctx=Ctx(config), state={"tool_source": lambda: TOOLS}, emit=rec)
    return env, rec


def build(env, ops, name="t"):
    types = N.types_by_name(env)
    flow, refs = G.apply_ops(G.new_flow(name), ops, types)
    return S.save_flow(env, flow, create=True), refs


def ref(flow, title):
    return next(n["id"] for n in flow["nodes"] if n.get("title") == title)


class RunnerTest(unittest.TestCase):
    def test_linear_run_and_record(self):
        env, rec = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "a", "type": "input.text", "title": "Idea", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "b", "type": "tool:echo", "title": "Echo"},
            {"op": "add_node", "ref": "c", "type": "text.template", "title": "Tpl", "params": {"template": "<{{x}}>"}},
            {"op": "add_node", "ref": "n", "type": "note", "title": "Note"},
            {"op": "connect", "from": "a.text", "to": "b.text"},
            {"op": "connect", "from": "b.text", "to": "c.x"},
        ])
        run = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(run["status"], "done", run)
        self.assertEqual(run["order"], [ref(flow, "Idea"), ref(flow, "Echo"), ref(flow, "Tpl")])
        self.assertNotIn(ref(flow, "Note"), run["nodes"])
        self.assertEqual(run["nodes"][ref(flow, "Tpl")]["outputs"]["text"], "<echo:hi>")
        stored = S.load_run(env, run["id"])
        self.assertEqual(stored["status"], "done")
        self.assertEqual(rec.of("run.started")[0]["run_id"], run["id"])
        self.assertEqual(rec.of("run.finished")[-1]["status"], "done")
        statuses = [p["status"] for p in rec.of("node.status") if p["node_id"] == ref(flow, "Echo")]
        self.assertEqual(statuses, ["running", "done"])
        self.assertIn("preview", [p for p in rec.of("node.status") if p["status"] == "done"][-1])

    def test_parallel_limit(self):
        env, _ = make_env({"max_parallel": 2})
        ops = [{"op": "add_node", "ref": f"s{i}", "type": "tool:slow", "title": f"S{i}",
                "params": {"text": str(i), "seconds": 0.3}} for i in range(4)]
        flow, _ = build(env, ops)
        t0 = time.monotonic()
        run = R.run_sync(env, flow["id"], timeout_s=10)
        elapsed = time.monotonic() - t0
        self.assertEqual(run["status"], "done")
        self.assertEqual(env.ctx.peak, 2)
        self.assertLess(elapsed, 1.1)          # 4 x 0.3 s with 2 lanes ~ 0.6 s, sequential would be 1.2 s

    def test_failure_skips_descendants_but_not_siblings(self):
        env, _ = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "f", "type": "tool:fail", "title": "Fail"},
            {"op": "add_node", "ref": "d", "type": "tool:echo", "title": "Down"},
            {"op": "add_node", "ref": "o", "type": "tool:echo", "title": "Other", "params": {"text": "ok"}},
            {"op": "connect", "from": "f.text", "to": "d.text"},
        ])
        run = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(run["status"], "error")
        self.assertEqual(run["nodes"][ref(flow, "Fail")]["status"], "error")
        self.assertEqual(run["nodes"][ref(flow, "Fail")]["error"], "boom")
        self.assertEqual(run["nodes"][ref(flow, "Down")]["status"], "skipped")
        self.assertEqual(run["nodes"][ref(flow, "Other")]["status"], "done")
        self.assertIn("Fail", run["error"])

    def test_cache_and_fresh(self):
        env, _ = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "a", "type": "input.text", "title": "A", "params": {"value": "v"}},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "E"},
            {"op": "connect", "from": "a.text", "to": "e.text"},
        ])
        first = R.run_sync(env, flow["id"], timeout_s=10)
        calls = len(env.ctx.calls)
        second = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(second["nodes"][ref(flow, "E")]["status"], "cached")
        self.assertEqual(len(env.ctx.calls), calls)
        self.assertEqual(second["nodes"][ref(flow, "E")]["outputs"]["text"], "echo:v")
        third = R.run_sync(env, flow["id"], timeout_s=10, fresh=True)
        self.assertEqual(third["nodes"][ref(flow, "E")]["status"], "done")
        self.assertEqual(len(env.ctx.calls), calls + 1)
        # changing an upstream value is a cache miss
        S.modify_flow(env, flow["id"], lambda f: G.node_by_id(f, ref(flow, "A"))["params"].update(value="w"))
        fourth = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(fourth["nodes"][ref(flow, "E")]["status"], "done")
        self.assertEqual(fourth["nodes"][ref(flow, "E")]["outputs"]["text"], "echo:w")
        self.assertEqual(first["status"], "done")

    def test_cache_off_per_node(self):
        env, _ = make_env()
        flow, _ = build(env, [{"op": "add_node", "type": "tool:echo", "title": "E",
                               "params": {"text": "x", "cache": False}}])
        R.run_sync(env, flow["id"], timeout_s=10)
        run = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(run["nodes"][ref(flow, "E")]["status"], "done")
        self.assertEqual(len(env.ctx.calls), 2)

    def test_target_node_runs_only_ancestors(self):
        env, _ = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "a", "type": "input.text", "title": "A", "params": {"value": "v"}},
            {"op": "add_node", "ref": "b", "type": "tool:echo", "title": "B"},
            {"op": "add_node", "ref": "c", "type": "tool:echo", "title": "C"},
            {"op": "connect", "from": "a.text", "to": "b.text"},
            {"op": "connect", "from": "b.text", "to": "c.text"},
        ])
        run = R.run_sync(env, flow["id"], timeout_s=10, target_node=ref(flow, "B"))
        self.assertEqual(set(run["nodes"]), {ref(flow, "A"), ref(flow, "B")})
        self.assertEqual(run["target_node"], ref(flow, "B"))
        with self.assertRaises(R.RunError):
            R.start_run(env, flow["id"], target_node="n_ffffff")

    def test_cancel(self):
        env, rec = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "s", "type": "tool:slow", "title": "S", "params": {"seconds": 2}},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "E"},
            {"op": "connect", "from": "s.text", "to": "e.text"},
        ])
        handle = R.start_run(env, flow["id"])
        s_id = ref(flow, "S")
        self.assertTrue(helpers.wait_until(lambda: handle.snapshot()["nodes"][s_id]["status"] == "running"))
        self.assertTrue(R.cancel_run(env, handle.run["id"]))
        self.assertTrue(handle.done.wait(3))
        run = R.get_run(env, handle.run["id"])
        self.assertEqual(run["status"], "cancelled")
        self.assertEqual(run["nodes"][ref(flow, "S")]["status"], "cancelled")
        self.assertEqual(run["nodes"][ref(flow, "E")]["status"], "skipped")
        self.assertFalse(R.cancel_run(env, handle.run["id"]))       # no longer active
        self.assertEqual(rec.of("run.finished")[-1]["status"], "cancelled")

    def test_invalid_flow(self):
        env, rec = make_env()
        flow, _ = build(env, [{"op": "add_node", "type": "tool:echo", "title": "E"}])   # required text missing
        run = R.run_sync(env, flow["id"], timeout_s=5)
        self.assertEqual(run["status"], "invalid")
        self.assertTrue(run["issues"])
        self.assertEqual(S.load_run(env, run["id"])["status"], "invalid")
        self.assertEqual(rec.of("run.finished")[-1]["status"], "invalid")

    def test_inputs_override_by_title(self):
        env, _ = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "a", "type": "input.text", "title": "Topic", "params": {"value": "old"}},
            {"op": "add_node", "ref": "e", "type": "tool:echo", "title": "E"},
            {"op": "connect", "from": "a.text", "to": "e.text"},
        ])
        run = R.run_sync(env, flow["id"], timeout_s=10, inputs={"topic": "new"})
        self.assertEqual(run["nodes"][ref(flow, "E")]["outputs"]["text"], "echo:new")
        self.assertEqual(S.get_flow(env, flow["id"])["nodes"][0]["params"]["value"], "old")   # not persisted
        with self.assertRaisesRegex(R.RunError, "Topic"):
            R.start_run(env, flow["id"], inputs={"nope": 1})

    def test_large_value_moves_to_file(self):
        env, _ = make_env()
        flow, _ = build(env, [
            {"op": "add_node", "ref": "b", "type": "tool:big", "title": "Big"},
            {"op": "add_node", "ref": "t", "type": "text.template", "title": "Len", "params": {"template": "{{x}}"}},
            {"op": "connect", "from": "b.text", "to": "t.x"},
        ])
        run = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(run["status"], "done")
        big = run["nodes"][ref(flow, "Big")]["outputs"]["text"]
        self.assertIn("$large", big)
        self.assertTrue(os.path.isfile(big["$large"]["path"]))
        tpl = run["nodes"][ref(flow, "Len")]["outputs"]["text"]
        self.assertEqual(tpl["$large"]["chars"], 70000)            # downstream got the full value

    def test_interrupted_runs_marked_on_startup(self):
        env, _ = make_env()
        flow, _ = build(env, [{"op": "add_node", "type": "input.text", "title": "A"}])
        stale = {"id": S.new_run_id(), "flow_id": flow["id"], "status": "running", "started_at": G.now_iso(),
                 "nodes": {"n_000001": {"status": "running"}}}
        S.save_run(env, stale)
        R.ensure_startup(env)
        again = S.load_run(env, stale["id"])
        self.assertEqual(again["status"], "error")
        self.assertEqual(again["error"], "interrupted")



class RunContextTest(unittest.TestCase):
    """Review E-5: tools must see the caller's ContextVars (Hermes session, cron deny mode, platform)."""

    def test_tools_see_the_callers_context_vars(self):
        import contextvars
        var = contextvars.ContextVar("fc_test_session", default=None)
        seen = []

        class SessionCtx(helpers.FakeCtx):
            def dispatch_tool(self, name, args, **kwargs):
                seen.append(var.get())
                return json.dumps({"text": "ok"})

        helpers.temp_data_dir()
        env = E.env.Env(ctx=SessionCtx(), state={"tool_source": lambda: TOOLS})
        flow, _ = build(env, [{"op": "add_node", "ref": "a", "type": "tool:echo", "title": "Echo",
                               "params": {"text": "x"}}])
        token = var.set("cron-session-42")
        try:
            run = R.run_sync(env, flow["id"], timeout_s=10)
        finally:
            var.reset(token)
        self.assertEqual(run["status"], "done", run)
        self.assertEqual(seen, ["cron-session-42"])



class TimeoutTeardownTest(unittest.TestCase):
    """Review E-6: a timed-out tool thread must not hold the run open until it finally returns."""

    def test_run_finishes_soon_after_a_node_timeout(self):
        release = threading.Event()
        self.addCleanup(release.set)

        class HangCtx(Ctx):
            def dispatch_tool(self, name, args, **kwargs):
                release.wait(20)      # a tool that ignores the node timeout
                return json.dumps({"text": "late"})

        helpers.temp_data_dir()
        env = E.env.Env(ctx=HangCtx({"node_timeout_s": 1}), state={"tool_source": lambda: TOOLS})
        flow, _ = build(env, [{"op": "add_node", "ref": "a", "type": "tool:echo", "title": "Hang",
                               "params": {"text": "x"}}])
        t0 = time.monotonic()
        handle = R.start_run(env, flow["id"])
        finished = handle.done.wait(5)
        took = time.monotonic() - t0
        self.assertTrue(finished, "handle.done waited for the hung tool thread")
        self.assertLess(took, 3.0)
        run = handle.snapshot()
        self.assertEqual(run["status"], "error", run)
        self.assertIn("timed out", run["nodes"][ref(flow, "Hang")]["error"])
        self.assertNotIn(run["id"], R._active(env))



class RunOwnerTest(unittest.TestCase):
    """Review E-7: a run records its owner and a heartbeat; another process's startup leaves it running."""

    def test_second_process_does_not_interrupt_a_live_run(self):
        helpers.temp_data_dir()
        release = threading.Event()
        self.addCleanup(release.set)

        class SlowCtx(Ctx):
            def dispatch_tool(self, name, args, **kwargs):
                release.wait(10)
                return json.dumps({"text": "ok"})

        env_a = E.env.Env(ctx=SlowCtx(), state={"tool_source": lambda: TOOLS})
        flow, _ = build(env_a, [{"op": "add_node", "ref": "a", "type": "tool:echo", "title": "S",
                                 "params": {"text": "x"}}])
        handle = R.start_run(env_a, flow["id"])

        def is_running_on_disk():
            try:
                return S.load_run(env_a, handle.run["id"]).get("status") == "running"
            except S.NotFoundError:
                return False                               # first save not written yet

        self.assertTrue(helpers.wait_until(is_running_on_disk))
        on_disk = S.load_run(env_a, handle.run["id"])
        self.assertEqual(on_disk["owner"]["pid"], os.getpid())
        self.assertTrue(on_disk["owner"]["boot"])
        self.assertGreater(on_disk["heartbeat"], time.time() - 30)
        env_b = E.env.Env(ctx=Ctx(), state={"tool_source": lambda: TOOLS})   # e.g. gateway or `hermes chat`
        R.ensure_startup(env_b)
        self.assertEqual(S.load_run(env_a, handle.run["id"])["status"], "running")
        release.set()
        self.assertTrue(handle.done.wait(10))
        self.assertEqual(S.load_run(env_a, handle.run["id"])["status"], "done")

    def test_heartbeat_keeps_ticking_during_a_long_node(self):
        helpers.temp_data_dir()
        release = threading.Event()
        self.addCleanup(release.set)

        class SlowCtx(Ctx):
            def dispatch_tool(self, name, args, **kwargs):
                release.wait(10)
                return json.dumps({"text": "ok"})

        self.addCleanup(setattr, R, "HEARTBEAT_S", R.HEARTBEAT_S)
        R.HEARTBEAT_S = 0.1
        env = E.env.Env(ctx=SlowCtx(), state={"tool_source": lambda: TOOLS})
        flow, _ = build(env, [{"op": "add_node", "ref": "a", "type": "tool:echo", "title": "S", "params": {"text": "x"}}])
        handle = R.start_run(env, flow["id"])

        def read_hb():
            try:
                return S.load_run(env, handle.run["id"]).get("heartbeat")
            except S.NotFoundError:
                return None

        first = helpers.wait_until(read_hb)
        self.assertIsNotNone(first)
        second = helpers.wait_until(lambda: (hb := read_hb()) and hb > first and hb)
        release.set()
        handle.done.wait(10)
        self.assertIsNotNone(second)
        self.assertGreater(second, first)


# -- review E-11: the key must cover what the node really runs with, not just the node's own params
E11_TOOL = "mcp__fake__fake_image_generate"
E11_LIST = "mcp__fake__fake_list_image_models"


def e11_tools(model="m-one", required=("prompt",)):
    """A read-only MCP-ish tool with a model setting (the peer list tool gives it a fallback default)."""
    return [
        {"name": E11_TOOL, "toolset": "test", "read_only": True,
         "parameters": {"type": "object", "properties": {
             "prompt": {"type": "string"}, "model": {"type": "string", "default": model},
             "image": {"type": "string"}}, "required": list(required)}},
        {"name": E11_LIST, "toolset": "test", "read_only": True,
         "parameters": {"type": "object", "properties": {}}},
    ]


class CacheKeyTest(unittest.TestCase):
    """A hit may only be reused while the node runs with the same effective inputs (review E-11)."""

    def spec(self, **kwargs):
        tools = e11_tools(**kwargs)
        peers = {t["name"] for t in tools}
        return N.tool_node_type(tools[0], peers)

    def test_changed_default_model_changes_the_key(self):
        env, _ = make_env()
        node = {"type": f"tool:{E11_TOOL}", "params": {"prompt": "a cat"}}
        one = R.cache_key(env, node, {}, self.spec(model="m-one"))
        two = R.cache_key(env, node, {}, self.spec(model="m-two"))
        self.assertEqual(next(p for p in self.spec(model="m-one")["params"] if p["name"] == "model")["options_source"],
                         E11_LIST)  # the tool's default really is what blank model falls back to
        self.assertNotEqual(one, two)
        # a model the node picks itself is what runs, so the spec default stops mattering
        picked = {"type": f"tool:{E11_TOOL}", "params": {"prompt": "a cat", "model": "m-three"}}
        self.assertEqual(R.cache_key(env, picked, {}, self.spec(model="m-one")),
                         R.cache_key(env, picked, {}, self.spec(model="m-two")))

    def test_changed_tool_schema_changes_the_key(self):
        env, _ = make_env()
        node = {"type": f"tool:{E11_TOOL}", "params": {"prompt": "a cat"}}
        before = R.cache_key(env, node, {}, self.spec())
        after = R.cache_key(env, node, {}, self.spec(required=("prompt", "image")))  # the tool now needs an image
        self.assertNotEqual(before, after)

    def test_changed_media_file_changes_the_key(self):
        helpers.temp_data_dir()
        env, _ = make_env()
        path = os.path.join(helpers.temp_data_dir(), "pic.png")
        with open(path, "wb") as fh:
            fh.write(b"one")
        node = {"type": f"tool:{E11_TOOL}", "params": {"prompt": "a cat", "image": path}}
        spec = self.spec()
        before = R.cache_key(env, node, {}, spec)
        with open(path, "wb") as fh:
            fh.write(b"a different picture")
        after = R.cache_key(env, node, {}, spec)
        self.assertNotEqual(before, after)
        self.assertEqual(after, R.cache_key(env, {**node}, {}, spec))  # same path, same content: same key

    def test_unchanged_node_and_spec_keep_the_key(self):
        env, _ = make_env()
        node = {"type": f"tool:{E11_TOOL}", "params": {"prompt": "a cat", "model": ""}}
        first = R.cache_key(env, node, {}, self.spec())
        self.assertEqual(first, R.cache_key(env, node, {}, self.spec()))
        other_env, _ = make_env()  # no process-local state in the hash
        self.assertEqual(first, R.cache_key(other_env, node, {}, self.spec()))

    def test_a_changed_default_model_re_runs_a_cached_node(self):
        helpers.temp_data_dir()
        tools = e11_tools()
        ctx = helpers.FakeCtx({E11_TOOL: lambda a: json.dumps({"text": "pic:" + a.get("model", "")})})
        env = E.env.Env(ctx=ctx, state={"tool_source": lambda: tools})
        flow, _ = build(env, [{"op": "add_node", "type": f"tool:{E11_TOOL}", "title": "Pic",
                               "params": {"prompt": "a cat"}}])
        nid = flow["nodes"][0]["id"]
        R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(R.run_sync(env, flow["id"], timeout_s=10)["nodes"][nid]["status"], "cached")
        tools[:] = e11_tools(model="m-two")   # the preset's default model moved on
        N.invalidate(env)
        run = R.run_sync(env, flow["id"], timeout_s=10)
        self.assertEqual(run["nodes"][nid]["status"], "done")
        self.assertEqual(run["nodes"][nid]["outputs"]["text"], "pic:m-two")


class HousekeepingTest(unittest.TestCase):
    """Review E-12: bounded process state and a startup sweep of trash/uploads."""

    def setUp(self):
        self.env, self.rec = make_env()
        self.dir = S.data_dir(self.env)
        self.addCleanup(shutil.rmtree, self.dir, True)

    def media(self, name, body=b"one"):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as fh:
            fh.write(body)
        return {"$media": {"kind": "image", "path": path, "file": name}}

    def test_old_trash_is_swept_once_at_startup(self):
        flow = S.create_flow(self.env, name="gone")
        name = S.delete_flow(self.env, flow["id"])
        trash = os.path.join(S.trash_dir(self.env), name)
        when = time.time() - 40 * 24 * 3600
        os.utime(trash, (when, when))
        R.ensure_startup(self.env)
        self.assertFalse(os.path.exists(trash))

        again = S.create_flow(self.env, name="gone too")
        name = S.delete_flow(self.env, again["id"])
        later = os.path.join(S.trash_dir(self.env), name)
        os.utime(later, (when, when))
        R.ensure_startup(self.env)          # same process: no second sweep
        self.assertTrue(os.path.exists(later))

    def test_hash_memo_stops_growing_and_drops_the_oldest_entry(self):
        real = R.HASH_MEMO_MAX
        R.HASH_MEMO_MAX = 3
        self.addCleanup(setattr, R, "HASH_MEMO_MAX", real)
        first = self.media("a.png")
        R._media_fingerprint(self.env, first)
        for name in ("b.png", "c.png", "d.png"):
            R._media_fingerprint(self.env, self.media(name, name.encode()))
        memo = self.env.state["hash_memo"]
        self.assertEqual(len(memo), 3)
        self.assertNotIn((first["$media"]["path"], os.stat(first["$media"]["path"]).st_mtime_ns,
                          os.path.getsize(first["$media"]["path"])), memo)
        self.assertEqual(R._media_fingerprint(self.env, first), E.media.file_sha256(first["$media"]["path"]))
        self.assertEqual(len(memo), 3)      # a re-hash is remembered, still capped

    def test_cache_prune_runs_on_a_throttle_not_on_every_put(self):
        real = R.CACHE_PRUNE_MIN_PUTS, R.CACHE_PRUNE_MIN_S
        R.CACHE_PRUNE_MIN_PUTS, R.CACHE_PRUNE_MIN_S = 3, 3600.0
        self.addCleanup(lambda: setattr(R, "CACHE_PRUNE_MIN_PUTS", real[0]))
        self.addCleanup(lambda: setattr(R, "CACHE_PRUNE_MIN_S", real[1]))
        calls = []
        real_prune = R._prune_cache
        R._prune_cache = lambda env, own: calls.append(own)
        self.addCleanup(setattr, R, "_prune_cache", real_prune)
        ok = {"ok": True}
        for i in range(5):
            R.cache_put(self.env, f"k{i}", {"type": "tool:echo"}, ok, flow_id="f_000001")
        self.assertEqual(len(calls), 1, calls)   # five puts, one sweep: on the third

    def test_cache_prune_also_fires_when_the_interval_has_passed(self):
        real = R.CACHE_PRUNE_MIN_PUTS, R.CACHE_PRUNE_MIN_S
        R.CACHE_PRUNE_MIN_PUTS, R.CACHE_PRUNE_MIN_S = 1000, 60.0
        self.addCleanup(lambda: setattr(R, "CACHE_PRUNE_MIN_PUTS", real[0]))
        self.addCleanup(lambda: setattr(R, "CACHE_PRUNE_MIN_S", real[1]))
        calls = []
        real_prune = R._prune_cache
        R._prune_cache = lambda env, own: calls.append(own)
        self.addCleanup(setattr, R, "_prune_cache", real_prune)
        ok = {"ok": True}
        R.cache_put(self.env, "k0", {"type": "tool:echo"}, ok, flow_id="f_000001")
        R.cache_put(self.env, "k1", {"type": "tool:echo"}, ok, flow_id="f_000001")
        self.assertEqual(len(calls), 0)          # far from the put count, and no minute has passed
        self.env.state["cache_prune"]["at"] -= 120.0
        R.cache_put(self.env, "k2", {"type": "tool:echo"}, ok, flow_id="f_000001")
        self.assertEqual(len(calls), 1)

    def test_a_put_does_not_list_every_cache_folder(self):
        real = R._cache_entries
        listed = []
        R._cache_entries = lambda folder: listed.append(folder) or real(folder)
        self.addCleanup(setattr, R, "_cache_entries", real)
        ok = {"ok": True}
        for i in range(5):
            R.cache_put(self.env, f"k{i}", {"type": "tool:echo"}, ok, flow_id="f_000001")
            R.cache_put(self.env, f"j{i}", {"type": "tool:echo"}, ok, flow_id="f_000002")
        self.assertEqual(len(listed), 2, listed)   # one scan filling the counts (root + this flow), then none

    def test_the_cache_key_hash_does_not_run_on_the_run_loop(self):
        """Hashing a 200 MB upload takes seconds; the run's own loop thread must not be stuck meanwhile."""
        threads = []
        real = R.cache_key

        def spy(*args, **kwargs):
            threads.append(threading.get_ident())
            return real(*args, **kwargs)

        R.cache_key = spy
        self.addCleanup(setattr, R, "cache_key", real)
        flow, _ = build(self.env, [{"op": "add_node", "type": "tool:echo", "title": "E",
                                    "params": {"text": "x"}}])
        handle = R.start_run(self.env, flow["id"])
        self.assertTrue(handle.done.wait(20))
        self.assertEqual(handle.run["nodes"][ref(flow, "E")]["status"], "done")
        self.assertTrue(threads)
        self.assertNotIn(handle.thread.ident, threads)   # it ran in the run's worker pool
