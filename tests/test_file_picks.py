"""Catalog review: model-supplied paths never reach a local file the user did not pick in the canvas.

A File node reads a path only when the user picked it for that node (an HMAC the agent cannot mint) or it lies in
Arachne Flow's uploads folder; a text naming a file is inlined only for picked files or media in Hermes'/Arachne
Flow's folders; credential stores and ``.env*`` files are refused always. Each refusal happens before any tool call.
"""
import asyncio
import json
import os
import tempfile
import unittest
from unittest import mock

import helpers

E = helpers.load_engine()
M, S, G, N, R, P, T, A = E.media, E.store, E.graph, E.nodes, E.runner, E.picks, E.tools, E.api

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000")
TOOLS = [{"name": "look", "toolset": "vision", "parameters": {"type": "object", "properties": {
    "imageDataUrl": {"type": "string"}, "question": {"type": "string"}}}},
         {"name": "read_doc", "toolset": "docs", "parameters": {"type": "object", "properties": {
    "document_url": {"type": "string"}}}}]


def write(folder, name, data=b"secret"):
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, name)
    with open(path, "wb") as fh:
        fh.write(data)
    return path


class FilePickTest(unittest.TestCase):
    def setUp(self):
        self.data = helpers.temp_data_dir()
        self.scratch = tempfile.mkdtemp(prefix="arachne-flow-picks-")
        # A synthetic Hermes home (profile layout) with its credential stores; never the real one.
        self.root = os.path.join(self.scratch, "hermes")
        self.home = os.path.join(self.root, "profiles", "work")
        os.makedirs(self.home)
        patcher = mock.patch.object(M, "_hermes_home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        env_patch = mock.patch.dict(os.environ, {"ARACHNE_FLOW_MEDIA_ROOTS": ""})
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.auth = write(self.home, "auth.json", b'{"token": "sk-secret"}')
        self.root_auth = write(self.root, "auth.json", b'{"token": "sk-root"}')
        self.project = os.path.join(self.scratch, "project")
        self.dotenv = write(self.project, ".env", b"API_KEY=sk-secret")
        self.photo = write(self.project, "photo.png", PNG)
        self.ctx = helpers.FakeCtx({"look": lambda a: json.dumps({"answer": "ok"}),
                                    "read_doc": lambda a: json.dumps({"text": "ok"})})
        self.env = E.env.Env(ctx=self.ctx, state={"tool_source": lambda: TOOLS})

    def call(self, name, args):
        return json.loads(T.handle(name, args, {}, self.env))

    def file_flow(self, path=""):
        """File -> look(image_url), built by the agent through flow_apply."""
        out = self.call("flow_apply", {"name": "Look", "ops": [
            {"op": "add_node", "ref": "f", "type": "input.file", "title": "File", "params": {"path": path}},
            {"op": "add_node", "ref": "l", "type": "tool:look", "params": {"question": "what is it?"}},
            {"op": "connect", "from": "f.file", "to": "l.imageDataUrl"}]})
        self.assertFalse(out.get("error"), out)
        return out["flow"], out["refs"]

    def text_flow(self, text):
        out = self.call("flow_apply", {"name": "Text", "ops": [
            {"op": "add_node", "ref": "t", "type": "input.text", "title": "Text", "params": {"value": text}},
            # a text-typed *_url argument: a text naming a local file used to be inlined as a data URL
            {"op": "add_node", "ref": "l", "type": "tool:read_doc"},
            {"op": "connect", "from": "t.text", "to": "l.document_url"}]})
        self.assertFalse(out.get("error"), out)
        return out["flow"], out["refs"]

    def assert_refused_before_tools(self, run, node, pattern):
        self.assertEqual(run.get("status"), "error", run)
        self.assertRegex(run["nodes"][node]["error"], pattern)
        self.assertEqual(self.ctx.calls, [], "no tool may run")

    # ------------------------------------------------------------------ the reviewer's two cases
    def test_flow_run_input_naming_hermes_auth_json_fails_before_any_tool_call(self):
        flow, refs = self.file_flow()
        for path in (self.auth, self.root_auth):
            with self.subTest(path=path):
                run = self.call("flow_run", {"flow": flow["id"], "inputs": {"File": path}})
                self.assert_refused_before_tools(run, refs["f"], "credential store")

    def test_text_input_naming_a_dotenv_fails_before_any_tool_call(self):
        flow, refs = self.text_flow(self.dotenv)
        run = self.call("flow_run", {"flow": flow["id"]})
        self.assert_refused_before_tools(run, refs["l"], r"\.env")
        # also when passed as a flow_run input, and for .env.* names
        other = write(self.project, ".env.production", b"X=1")
        run = self.call("flow_run", {"flow": flow["id"], "inputs": {"Text": other}})
        self.assert_refused_before_tools(run, refs["l"], r"\.env")

    # ------------------------------------------------------------------ agent-set paths
    def test_agent_set_file_path_outside_uploads_is_refused(self):
        flow, refs = self.file_flow(self.photo)
        run = self.call("flow_run", {"flow": flow["id"]})
        self.assert_refused_before_tools(run, refs["f"], "not picked")
        run = self.call("flow_run", {"flow": flow["id"], "inputs": {"File": self.photo}})
        self.assert_refused_before_tools(run, refs["f"], "not picked")

    def test_agent_set_path_inside_uploads_is_accepted(self):
        upload = write(S.uploads_dir(self.env), "abc123.png", PNG)
        flow, refs = self.file_flow()
        run = self.call("flow_run", {"flow": flow["id"], "inputs": {"File": upload}})
        self.assertEqual(run["status"], "done", run)
        self.assertTrue(self.ctx.calls[-1][1]["imageDataUrl"].startswith("data:image/png;base64,"))

    def test_text_naming_a_file_outside_hermes_folders_is_not_inlined(self):
        flow, refs = self.text_flow(self.photo)
        run = self.call("flow_run", {"flow": flow["id"]})
        self.assert_refused_before_tools(run, refs["l"], "picked with Browse")

    def test_agent_set_string_param_naming_a_file_is_not_inlined(self):
        for path in (self.dotenv, self.photo):
            with self.subTest(path=path):
                out = self.call("flow_apply", {"name": "Direct", "ops": [
                    {"op": "add_node", "ref": "l", "type": "tool:look", "params": {"question": "q", "imageDataUrl": path}}]})
                run = self.call("flow_run", {"flow": out["flow"]["id"]})
                self.assert_refused_before_tools(run, out["refs"]["l"], r"\.env|picked with Browse")

    def test_forged_media_value_in_params_is_not_inlined(self):
        out = self.call("flow_apply", {"name": "Forged", "ops": [
            {"op": "add_node", "ref": "l", "type": "tool:look",
             "params": {"question": "q", "imageDataUrl": {"$media": {"kind": "image", "path": self.photo}}}}]})
        run = self.call("flow_run", {"flow": out["flow"]["id"]})
        self.assertEqual(run["status"], "error", run)
        self.assertEqual(self.ctx.calls, [])

    # ------------------------------------------------------------------ user picks
    def test_a_canvas_pick_is_accepted_and_reaches_downstream_tools(self):
        flow, refs = self.file_flow(self.photo)
        flow = helpers.pick_file(E, self.env, flow, refs["f"], self.photo)
        run = R.run_sync(self.env, flow["id"], timeout_s=10)
        self.assertEqual(run["status"], "done", run)
        self.assertTrue(self.ctx.calls[-1][1]["imageDataUrl"].startswith("data:image/png;base64,"))

    def test_agent_edits_and_run_inputs_drop_the_pick(self):
        flow, refs = self.file_flow(self.photo)
        flow = helpers.pick_file(E, self.env, flow, refs["f"], self.photo)
        node = next(n for n in flow["nodes"] if n["id"] == refs["f"])
        self.assertIn(P.PARAM, node["params"])
        # flow_run inputs: even the same path loses the pick
        run = self.call("flow_run", {"flow": flow["id"], "inputs": {"File": self.photo}})
        self.assert_refused_before_tools(run, refs["f"], "not picked")
        # an agent edit of the node (here: only its title) drops the pick on disk
        edited = self.call("flow_apply", {"flow": flow["id"], "ops": [
            {"op": "update_node", "node": refs["f"], "title": "Renamed"}]})["flow"]
        node = next(n for n in edited["nodes"] if n["id"] == refs["f"])
        self.assertNotIn(P.PARAM, node["params"])
        # an edit of another node keeps it
        flow = helpers.pick_file(E, self.env, edited, refs["f"], self.photo)
        kept = self.call("flow_apply", {"flow": flow["id"], "ops": [
            {"op": "update_node", "node": refs["l"], "params": {"question": "other"}}]})["flow"]
        self.assertIn(P.PARAM, next(n for n in kept["nodes"] if n["id"] == refs["f"])["params"])

    def test_agent_cannot_add_or_move_a_pick(self):
        flow, refs = self.file_flow(self.photo)
        flow = helpers.pick_file(E, self.env, flow, refs["f"], self.photo)
        token = next(n for n in flow["nodes"] if n["id"] == refs["f"])["params"][P.PARAM][self.photo]
        out = self.call("flow_apply", {"flow": flow["id"], "ops": [
            {"op": "add_node", "ref": "g", "type": "input.file",
             "params": {"path": self.photo, P.PARAM: {self.photo: token}}}]})
        added = next(n for n in out["flow"]["nodes"] if n["id"] == out["refs"]["g"])
        self.assertNotIn(P.PARAM, added["params"])
        # a token bound to another node, flow or path never matches
        self.assertTrue(P.matches(self.env, flow["id"], refs["f"], self.photo, token))
        self.assertFalse(P.matches(self.env, flow["id"], out["refs"]["g"], self.photo, token))
        self.assertFalse(P.matches(self.env, "f_other", refs["f"], self.photo, token))
        other = write(self.project, "other.png", PNG)
        self.assertFalse(P.matches(self.env, flow["id"], refs["f"], other, token))

    def test_duplicate_and_template_do_not_carry_picks(self):
        flow, refs = self.file_flow(self.photo)
        flow = helpers.pick_file(E, self.env, flow, refs["f"], self.photo)
        copy = S.duplicate_flow(self.env, flow["id"])
        self.assertEqual(P.flow_picks(self.env, copy["id"], copy), frozenset())
        template = S.template_from_flow(flow)
        self.assertNotIn(P.PARAM, next(n for n in template["nodes"] if n["id"] == refs["f"])["params"])

    def test_pick_route_mints_only_for_readable_files(self):
        flow, refs = self.file_flow()
        res = asyncio.run(A.handle("POST", f"flows/{flow['id']}/file-pick",
                                   {}, {"node_id": refs["f"], "path": self.photo}, self.env))
        self.assertTrue(P.matches(self.env, flow["id"], refs["f"], self.photo, res["token"]))
        for path in (self.auth, self.root_auth, self.dotenv, os.path.join(self.project, "missing.png")):
            with self.subTest(path=path), self.assertRaises(A.HTTPException) as cm:
                asyncio.run(A.handle("POST", f"flows/{flow['id']}/file-pick",
                                     {}, {"node_id": refs["f"], "path": path}, self.env))
            self.assertEqual(cm.exception.status_code, 400)

    def test_picked_secrets_are_still_refused(self):
        for path in (self.auth, self.dotenv):
            with self.subTest(path=path), M.approved([path]):
                with self.assertRaises(M.MediaError):
                    M.to_arg(path, "imageDataUrl")
                with self.assertRaises(M.MediaError):
                    M.data_url(path)
        self.assertIsNotNone(M.secret_reason(os.path.join(self.home, "mcp-tokens", "srv.json")))
        self.assertIsNotNone(M.secret_reason(os.path.join(S.data_dir(None), "messaging-secret")))
        self.assertIsNone(M.secret_reason(self.photo))

    def test_agent_tools_do_not_show_picks(self):
        flow, refs = self.file_flow(self.photo)
        flow = helpers.pick_file(E, self.env, flow, refs["f"], self.photo)
        text = self.call("flow_get", {"flow": flow["id"]})["text"]
        self.assertNotIn(P.PARAM, text)


if __name__ == "__main__":
    unittest.main()
