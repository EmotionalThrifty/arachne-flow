"""A3: node library — built-ins, tool nodes from the registry, block list, payload."""
import unittest

import helpers

E = helpers.load_engine()
N, G, T = E.nodes, E.graph, E.types


def tool(name, toolset="web", props=None, required=(), description=""):
    return {"name": name, "toolset": toolset, "description": description,
            "parameters": {"type": "object", "properties": props or {}, "required": list(required)}}


TOOLS = [
    tool("web_search", "web", {"query": {"type": "string", "description": "Search query"},
                               "limit": {"type": "integer", "default": 5}}, required=["query"],
         description="Search the web."),
    tool("terminal", "terminal", {"command": {"type": "string"}}, required=["command"]),
    tool("kanban_create", "kanban", {"title": {"type": "string"}}),
    tool("flow_run", "arachne-flow", {"flow": {"type": "string"}}),
    tool("mcp__nanogpt__nanogpt_image_generate", "mcp-nanogpt", {
        "prompt": {"type": "string", "minLength": 1},
        "n": {"type": "number"},
        "response_format": {"type": "string", "enum": ["url", "b64_json"]},
        "imageDataUrls": {"type": "array", "items": {"type": "string"}},
        "imageDataUrl": {"type": "string"},
        "include_raw": {"type": "boolean", "default": False},
    }, required=["prompt"], description="Generate images from a text prompt."),
    tool("vision_analyze", "vision", {"image_url": {"type": "string"}, "question": {"type": "string"},
                                      "detail": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                                      "mixed": {"anyOf": [{"type": "string"}, {"type": "integer"}]}}),
    {"name": "no_schema_tool", "toolset": "misc"},
]


class Env(E.env.Env):
    pass


def env_with(ctx=None, tools=TOOLS):
    env = E.env.Env(ctx=ctx, state={})
    env.state["tool_source"] = lambda: tools
    return env


class ConfigCtx(helpers.FakeCtx):
    def __init__(self, config):
        super().__init__()
        self.config = config

    def get_config(self, key, default=None):
        return self.config.get(key, default)


class BuiltinTest(unittest.TestCase):
    def test_builtins_present_and_well_formed(self):
        names = N.builtin_type_names()
        for t in ("input.text", "input.number", "input.file", "text.template", "json.pick",
                  "llm.complete", "output.preview", "note"):
            self.assertIn(t, names)
        for spec in N.list_node_types(env_with(tools=[])):
            for key in ("type", "title", "category", "icon", "inputs", "outputs", "params"):
                self.assertIn(key, spec, spec["type"])
            for port in spec["inputs"] + spec["outputs"]:
                self.assertTrue(T.is_type(port["type"]), (spec["type"], port))

    def test_builtins_are_fresh_copies(self):
        a = N.list_node_types(env_with(tools=[]), fresh=True)
        a[0]["title"] = "mutated"
        b = N.list_node_types(env_with(tools=[]), fresh=True)
        self.assertNotEqual(b[0]["title"], "mutated")

    def test_builtin_duration_and_cost_hints(self):
        specs = {s["type"]: s for s in N.list_node_types(env_with(tools=[]), fresh=True)}
        self.assertEqual(specs["input.text"]["typical"], "instant")
        self.assertTrue(specs["llm.complete"]["typical"].startswith("seconds"))
        self.assertIn("token", specs["llm.complete"]["cost"])
        self.assertNotIn("typical", specs["note"])
        self.assertNotIn("cost", specs["json.pick"])

    def test_template_dynamic_inputs_via_graph(self):
        tb = N.types_by_name(env_with(tools=[]))
        node = {"id": "n_000001", "type": "llm.complete", "params": {"template": "{{topic}} in {{style}}"}}
        ins, outs = G.node_ports(node, tb)
        self.assertEqual([p["name"] for p in ins], ["topic", "style"])
        self.assertEqual(outs[0]["type"], "text")
        default_node = {"id": "n_000002", "type": "llm.complete", "params": {}}
        self.assertEqual([p["name"] for p in G.node_ports(default_node, tb)[0]], ["prompt"])


class ToolNodeTest(unittest.TestCase):
    def setUp(self):
        self.types = N.types_by_name(env_with())

    def test_tool_nodes_generated(self):
        spec = self.types["tool:web_search"]
        self.assertEqual(spec["kind"], "tool")
        self.assertEqual(spec["tool"], "web_search")
        self.assertEqual(spec["title"], "Web search")
        self.assertEqual(spec["category"], "Tools · web")
        self.assertEqual(spec["icon"], "globe")
        self.assertEqual([o["name"] for o in spec["outputs"]], ["result", "text", "media"])
        q = spec["inputs"][0]
        self.assertEqual((q["name"], q["type"], q["required"]), ("query", "text", True))
        self.assertEqual(spec["inputs"][1]["type"], "number")
        self.assertEqual(spec["params"][1]["default"], 5)
        self.assertEqual(spec["params"][0]["description"], "Search query")

    def test_mcp_tool_mapping(self):
        spec = self.types["tool:mcp__nanogpt__nanogpt_image_generate"]
        self.assertEqual(spec["title"], "Image generate")
        self.assertEqual(spec["category"], "MCP · nanogpt")
        self.assertEqual(spec["icon"], "plug")
        ports = {p["name"]: p for p in spec["inputs"]}
        params = {p["name"]: p for p in spec["params"]}
        self.assertEqual(ports["prompt"]["type"], "text")
        self.assertEqual(params["prompt"]["kind"], "textarea")
        self.assertTrue(ports["prompt"]["required"])
        self.assertEqual(ports["n"]["type"], "number")
        self.assertEqual(params["response_format"]["kind"], "select")
        self.assertEqual(params["response_format"]["options"], ["url", "b64_json"])
        self.assertEqual(ports["imageDataUrls"]["type"], "image")
        self.assertEqual(ports["imageDataUrl"]["type"], "image")     # media hint in the name
        self.assertEqual(ports["include_raw"]["type"], "boolean")
        self.assertEqual(params["imageDataUrl"]["label"], "Image data URL")

    def test_anyof_and_missing_schema(self):
        spec = self.types["tool:vision_analyze"]
        ports = {p["name"]: p for p in spec["inputs"]}
        self.assertEqual(ports["image_url"]["type"], "image")
        self.assertEqual(ports["question"]["type"], "text")
        self.assertEqual(ports["detail"]["type"], "text")             # anyOf [string, null]
        self.assertEqual(ports["mixed"]["type"], "json")              # anyOf [string, integer]
        bare = self.types["tool:no_schema_tool"]
        self.assertEqual(bare["inputs"], [])
        self.assertEqual(bare["category"], "Tools · misc")

    def test_default_block_list(self):
        for blocked in ("tool:terminal", "tool:kanban_create", "tool:flow_run"):
            self.assertNotIn(blocked, self.types)

    def test_configured_block_and_allow(self):
        ctx = ConfigCtx({"blocked_tools": ["web_search"], "allow_tools": ["kanban_create"]})
        types = N.types_by_name(env_with(ctx))
        self.assertNotIn("tool:web_search", types)
        self.assertIn("tool:terminal", types)          # blocked_tools replaces the default list
        self.assertIn("tool:kanban_create", types)     # explicit allow beats the prefix rule
        ctx2 = ConfigCtx({"blocked_tools": "web_search, vision_analyze"})
        types2 = N.types_by_name(env_with(ctx2))
        self.assertNotIn("tool:vision_analyze", types2)

    def test_block_and_allow_lists_are_case_insensitive_and_warn_on_unknown_names(self):
        # SE-6: mixed-case entries in blocked_tools / allow_tools must match lowercase registry names,
        # and typos / unknown tool names must log a warning instead of failing silently.
        self.assertTrue(N.is_blocked("terminal", {"Terminal"}, set()))
        self.assertTrue(N.is_blocked("Terminal", {"terminal"}, set()))
        self.assertFalse(N.is_blocked("terminal", {"terminal"}, {"Terminal"}))
        self.assertFalse(N.is_blocked("kanban_create", set(), {"Kanban_Create"}))

        ctx = ConfigCtx({"blocked_tools": ["Web_Search", "typo_blocked_tool"],
                         "allow_tools": ["Terminal", "Kanban_Create", "typo_allowed_tool"]})
        with self.assertLogs("arachne-flow.nodes", level="WARNING") as cm:
            types = N.types_by_name(env_with(ctx))
        self.assertNotIn("tool:web_search", types)
        self.assertIn("tool:terminal", types)
        self.assertIn("tool:kanban_create", types)
        joined = "\n".join(cm.output)
        self.assertIn("typo_blocked_tool", joined)
        self.assertIn("typo_allowed_tool", joined)
        self.assertNotIn("web_search", joined.lower())
        self.assertNotIn("terminal", joined.lower())

    def test_unknown_policy_names_warn_only_once_per_name(self):
        ctx = ConfigCtx({"blocked_tools": ["Web_Search", "Unknown_Once_A"],
                         "allow_tools": ["Unknown_Once_B"]})
        with self.assertLogs("arachne-flow.nodes", level="WARNING") as cm:
            N.list_node_types(env_with(ctx), fresh=True)
            N.list_node_types(env_with(ctx), fresh=True)
        self.assertEqual(len(cm.output), 1)
        self.assertIn("unknown_once_a", cm.output[0])
        self.assertIn("unknown_once_b", cm.output[0])

    def test_is_blocked_prepares_folded_sets_and_handles_case_across_config_changes(self):
        blocked = {"Terminal", "Write_File", "Patch", "Execute_Code"}
        allowed = {"Kanban_Create", "Flow_Run"}
        self.assertFalse(N.is_blocked("Web_Search", blocked, allowed))

        calls = 0
        orig_fold = N._fold_name

        def counting_fold(val):
            nonlocal calls
            calls += 1
            return orig_fold(val)

        N._fold_name = counting_fold
        try:
            checks = [
                ("TERMINAL", True),
                ("write_file", True),
                ("KANBAN_CREATE", False),
                ("KANBAN_other", True),
                ("FLOW_RUN", False),
                ("Web_Search", False),
            ]
            for name, expected in checks:
                self.assertEqual(N.is_blocked(name, blocked, allowed), expected, name)
            self.assertEqual(calls, len(checks))
        finally:
            N._fold_name = orig_fold

        ctx = ConfigCtx({"blocked_tools": ["WEB_SEARCH"], "allow_tools": ["TERMINAL"]})
        env = env_with(ctx)
        types1 = N.types_by_name(env)
        self.assertNotIn("tool:web_search", types1)
        self.assertIn("tool:terminal", types1)

        ctx.config = {"blocked_tools": ["Vision_Analyze"], "allow_tools": ["KANBAN_CREATE"]}
        N.invalidate(env)
        types2 = N.types_by_name(env)
        self.assertIn("tool:web_search", types2)
        self.assertNotIn("tool:vision_analyze", types2)
        self.assertIn("tool:kanban_create", types2)

    def test_tool_node_validates_with_constant_param(self):
        flow, _ = G.apply_ops(G.new_flow("t"), [
            {"op": "add_node", "ref": "s", "type": "tool:web_search", "params": {"query": "hermes agent"}},
            {"op": "add_node", "ref": "p", "type": "output.preview"},
            {"op": "connect", "from": "s.text", "to": "p.value"},
        ], self.types)
        self.assertFalse(G.has_errors(G.validate(flow, self.types)))
        flow["nodes"][0]["params"] = {}
        issues = G.validate(flow, self.types)
        self.assertTrue(any(i.get("port") == "query" for i in issues))

    def test_media_output_feeds_any_input(self):
        flow, _ = G.apply_ops(G.new_flow("t"), [
            {"op": "add_node", "ref": "i", "type": "tool:mcp__nanogpt__nanogpt_image_generate",
             "params": {"prompt": "robot"}},
            {"op": "add_node", "ref": "v", "type": "tool:vision_analyze", "params": {"question": "what?"}},
            {"op": "connect", "from": "i.media", "to": "v.image_url"},
        ], self.types)
        self.assertFalse(G.has_errors(G.validate(flow, self.types)))


class ListingTest(unittest.TestCase):
    def test_order_builtins_then_tools_then_mcp(self):
        cats = N.categories(N.list_node_types(env_with()))
        self.assertEqual(cats[:3], ["Triggers", "Inputs", "AI"])   # triggers start a flow, so they lead
        self.assertLess(cats.index("Tools · web"), cats.index("MCP · nanogpt"))
        self.assertEqual(cats[-1], "MCP · nanogpt")

    def test_cache_and_invalidate(self):
        calls = []

        def source():
            calls.append(1)
            return TOOLS[:1]

        env = E.env.Env(state={"tool_source": source})
        N.list_node_types(env)
        N.list_node_types(env)
        self.assertEqual(len(calls), 1)
        N.invalidate(env)
        N.list_node_types(env)
        self.assertEqual(len(calls), 2)
        N.list_node_types(env, fresh=True)
        self.assertEqual(len(calls), 3)

    def test_one_bad_schema_does_not_hide_others(self):
        bad = {"name": "weird", "toolset": "x", "parameters": {"properties": {"a": "not-a-dict"}}}
        types = N.types_by_name(env_with(tools=[bad] + TOOLS[:1]))
        self.assertIn("tool:web_search", types)
        self.assertIn("tool:weird", types)              # odd property degrades to an any/json port

    def test_payload_shape(self):
        payload = N.node_types_payload(env_with())
        self.assertEqual(set(payload), {"types", "categories", "port_types", "compat", "ext_kinds", "upload_max_bytes"})
        self.assertEqual(payload["ext_kinds"][".png"], "image")
        self.assertEqual(payload["upload_max_bytes"], 25 * 1024 * 1024)
        file_spec = next(t for t in payload["types"] if t["type"] == "input.file")
        self.assertEqual({p["name"]: p.get("browse") for p in file_spec["params"]}["path"], "file")
        self.assertIn("image", payload["compat"])
        self.assertIn("file", payload["compat"]["image"])
        self.assertIn("text", payload["port_types"])

    def test_no_registry_outside_hermes_is_empty_not_crash(self):
        env = E.env.Env(state={})
        tools = N.registry_tools(env)
        self.assertIsInstance(tools, list)

    def test_titles(self):
        self.assertEqual(N.tool_title("mcp__blender__execute_blender_code"), "Execute blender code")
        self.assertEqual(N.tool_title("mcp__nanogpt__nanogpt_3d_generate"), "3d generate")
        self.assertEqual(N.tool_title("text_to_speech"), "Text to speech")
        self.assertEqual(N.mcp_server("web_search"), None)


if __name__ == "__main__":
    unittest.main()
