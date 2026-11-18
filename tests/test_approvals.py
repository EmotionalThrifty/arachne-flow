"""Review E-4: a tool call that needs approval (or was blocked) is a node error, never a cached success.

The payloads are Hermes' own shapes (hermes-agent `tools/approval.py` `_pending_result` :592/:599,
`tools/terminal_tool.py` `_run_approval_guards` :1123/:1137, `tools/registry.tool_error`, file write guards).
"""
import json
import unittest

import helpers

E = helpers.load_engine()
R, S, G, N, X = E.runner, E.store, E.graph, E.nodes, E.executors

ACTION_GATE = {"approved": False, "pattern_key": "protected_write", "status": "approval_required",
               "command": "write config.yaml", "description": "protected file",
               "message": "⚠️ This action is potentially dangerous (protected file). Asking the user for approval."}
COMMAND_GATE = {"approved": False, "pattern_key": "rm_rf", "status": "pending_approval", "approval_pending": True,
                "command": "rm -rf build", "description": "recursive delete",
                "message": "⚠️ recursive delete. Asking the user for approval.\n\nSTOP: do NOT re-run ..."}
TERMINAL_PENDING = {"output": "", "exit_code": -1, "error": "", "status": "pending_approval", "approval_pending": True,
                    "command": "rm -rf build", "description": "recursive delete", "pattern_key": "rm_rf",
                    "smart_denied": False, "allow_permanent": True}
TERMINAL_BLOCKED = {"output": "", "exit_code": -1, "status": "blocked",
                    "error": "BLOCKED: User denied this command. Do NOT retry."}
FILE_BLOCKED = {"error": "BLOCKED: write to SSH config file(s) (~/.ssh/config) was denied."}
PLAIN_BLOCKED = "BLOCKED: Command timed out without user response."
# hermes-agent tools/mcp_tool_handlers.py :292/:306 and tools/mcp_tool_costs.py Charge.refusal, wrapped by tool_error
TRUST_DENIED = {"error": "The user did not approve running write-capable MCP tool 'mcp__nanogpt__img' on untrusted "
                         "server 'nanogpt'. The command was NOT run. Do not retry without explicit user direction."}
TRUST_NO_CHAT = {"error": "MCP tool 'mcp__nanogpt__img' on untrusted server 'nanogpt' was blocked: the approval "
                          "system was unavailable (fail-closed)."}
SPEND_LIMIT = {"error": "MCP tool 'mcp__nanogpt__img' on server 'nanogpt' was NOT run: this chat has used about $1.20 "
                        "on 'nanogpt' and its spend limit is $1.00. This call (about $0.04) needed an explicit approval "
                        "and did not get one. Do not retry; tell the user the spend limit was reached."}

SHAPES = {"action_gate": ACTION_GATE, "command_gate": COMMAND_GATE, "terminal_pending": TERMINAL_PENDING,
          "terminal_blocked": TERMINAL_BLOCKED, "file_blocked": FILE_BLOCKED, "plain_blocked": PLAIN_BLOCKED,
          "trust_denied": TRUST_DENIED, "trust_no_chat": TRUST_NO_CHAT, "spend_limit": SPEND_LIMIT}
TOOLS = [{"name": name, "toolset": "test", "parameters": {"type": "object", "properties": {"text": {"type": "string"}}}}
         for name in SHAPES]


def reply(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


class ApprovalTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.ctx = helpers.FakeCtx({name: (lambda args, v=value: reply(v)) for name, value in SHAPES.items()})
        self.env = E.env.Env(ctx=self.ctx, state={"tool_source": lambda: TOOLS})

    def run_twice(self, name):
        flow, _ = G.apply_ops(G.new_flow("t"), [
            {"op": "add_node", "ref": "a", "type": f"tool:{name}", "title": "A", "params": {"text": "x"}}],
            N.types_by_name(self.env))
        flow = S.save_flow(self.env, flow, create=True)
        nid = flow["nodes"][0]["id"]
        first = R.run_sync(self.env, flow["id"], timeout_s=10)["nodes"][nid]
        second = R.run_sync(self.env, flow["id"], timeout_s=10)["nodes"][nid]
        return first, second

    def test_every_approval_shape_fails_the_node_and_is_never_cached(self):
        for name in SHAPES:
            with self.subTest(name):
                calls = len(self.ctx.calls)
                first, second = self.run_twice(name)
                self.assertEqual(first["status"], "error", first)
                self.assertEqual(second["status"], "error", second)
                self.assertEqual(len(self.ctx.calls) - calls, 2, "the second run must call the tool again")

    def test_pending_approval_names_the_action_and_the_way_out(self):
        first, _ = self.run_twice("command_gate")
        self.assertIn("needs approval", first["error"])
        self.assertIn("recursive delete", first["error"])
        self.assertIn("chat", first["error"])

    def test_blocked_keeps_hermes_reason(self):
        first, _ = self.run_twice("terminal_blocked")
        self.assertIn("User denied this command", first["error"])
        self.assertIn("blocked", first["error"].lower())

    def test_mcp_trust_gate_names_the_server_and_the_way_out(self):
        for name in ("trust_denied", "trust_no_chat"):
            with self.subTest(name):
                first, _ = self.run_twice(name)
                self.assertIn("'nanogpt'", first["error"])
                self.assertNotIn("mcp__nanogpt__img' (trust", first["error"])
                self.assertIn("Always allow", first["error"])
                self.assertIn("Nothing ran", first["error"])

    def test_mcp_spend_limit_is_explained(self):
        first, _ = self.run_twice("spend_limit")
        self.assertIn("spend limit", first["error"])
        self.assertIn("'nanogpt'", first["error"])

    def test_ordinary_results_with_status_fields_still_succeed(self):
        for value in ({"status": "ok", "message": "done"}, {"approved": True, "message": None},
                      {"output": "hi", "exit_code": 0, "error": None}, "All good."):
            with self.subTest(value):
                self.assertIsNone(X.approval_error(X.parse_tool_result(reply(value))))


if __name__ == "__main__":
    unittest.main()
