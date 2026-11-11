"""A6: REST API via engine.api.handle (+ a smoke test through the real FastAPI router)."""
import asyncio
import base64
import io
import json
import os
import tempfile
import time
import unittest

import helpers

E = helpers.load_engine()
A, R, S = E.api, E.runner, E.store

from fastapi import HTTPException  # noqa: E402

TOOLS = [{"name": "echo", "toolset": "test", "parameters": {"type": "object", "properties": {
    "text": {"type": "string"}}, "required": ["text"]}},
    {"name": "pic", "toolset": "test", "parameters": {"type": "object", "properties": {}}}]


def png_bytes(size=(64, 48)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, "PNG")
    return buf.getvalue()


class Ctx(helpers.FakeCtx):
    def __init__(self):
        super().__init__({
            "echo": lambda a: json.dumps({"text": "echo:" + a["text"]}),
            "pic": lambda a: json.dumps({"image": "data:image/png;base64," + base64.b64encode(png_bytes()).decode()}),
        })


class ApiTest(unittest.TestCase):
    def setUp(self):
        helpers.temp_data_dir()
        self.events = []
        self.env = E.env.Env(ctx=Ctx(), state={"tool_source": lambda: TOOLS},
                             emit=lambda e, p: self.events.append((e, p)))

    def call(self, method, path, body=None, query=None):
        return asyncio.run(A.handle(method, path, query or {}, body or {}, self.env))

    def status_of(self, method, path, body=None, query=None):
        try:
            self.call(method, path, body, query)
        except HTTPException as exc:
            return exc.status_code, exc.detail
        return 200, None

    def test_ping_and_unknown(self):
        self.assertTrue(self.call("GET", "ping")["ok"])
        self.assertEqual(self.status_of("GET", "nope")[0], 404)
        self.assertEqual(self.status_of("DELETE", "flows")[0], 405)

    def test_flow_crud_and_events(self):
        flow = self.call("POST", "flows", {"name": "My flow"})["flow"]
        self.assertEqual(flow["name"], "My flow")
        self.assertEqual(self.events[-1][0], "flow.changed")
        listed = self.call("GET", "flows")["flows"]
        self.assertEqual([f["id"] for f in listed], [flow["id"]])
        got = self.call("GET", f"flows/{flow['id']}")["flow"]
        got["name"] = "Renamed"
        saved = self.call("PUT", f"flows/{flow['id']}", {"flow": got, "base_revision": got["revision"]})["flow"]
        self.assertEqual(saved["revision"], got["revision"] + 1)
        code, detail = self.status_of("PUT", f"flows/{flow['id']}", {"flow": got, "base_revision": got["revision"]})
        self.assertEqual(code, 409)
        self.assertEqual(detail["code"], "conflict")
        self.assertEqual(detail["current_revision"], saved["revision"])
        dup = self.call("POST", f"flows/{flow['id']}/duplicate")["flow"]
        self.assertNotEqual(dup["id"], flow["id"])
        self.assertTrue(self.call("DELETE", f"flows/{flow['id']}")["ok"])
        self.assertEqual(self.status_of("GET", f"flows/{flow['id']}")[0], 404)
        self.assertEqual(len(self.call("GET", "trash")["trash"]), 1)
        restored = self.call("POST", f"flows/{flow['id']}/restore")["flow"]
        self.assertEqual(restored["id"], flow["id"])
        self.assertEqual(self.status_of("GET", "flows/not-an-id")[0], 400)

    def test_ops_and_validate(self):
        flow = self.call("POST", "flows", {"name": "ops"})["flow"]
        res = self.call("POST", f"flows/{flow['id']}/ops", {"ops": [
            {"op": "add_node", "ref": "a", "type": "input.text", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "e", "type": "tool:echo"},
            {"op": "connect", "from": "a.text", "to": "e.text"},
        ], "origin": "agent"})
        self.assertEqual(len(res["flow"]["nodes"]), 2)
        self.assertEqual(set(res["refs"]), {"a", "e"})
        self.assertEqual(self.events[-1][1]["origin"], "agent")
        code, detail = self.status_of("POST", f"flows/{flow['id']}/ops", {"ops": [
            {"op": "add_node", "type": "input.text"}, {"op": "add_node", "type": "no.such"}]})
        self.assertEqual(code, 400)
        self.assertEqual(detail["index"], 1)
        self.assertEqual(len(self.call("GET", f"flows/{flow['id']}")["flow"]["nodes"]), 2)   # atomic
        issues = self.call("POST", "validate", {"flow_id": flow["id"]})["issues"]
        self.assertEqual([i for i in issues if i["level"] == "error"], [])
        laid = self.call("POST", f"flows/{flow['id']}/layout")["flow"]
        xs = sorted(n["x"] for n in laid["nodes"])
        self.assertLess(xs[0], xs[1])

    def test_node_types_and_templates(self):
        payload = self.call("GET", "node-types")
        self.assertIn("tool:echo", [t["type"] for t in payload["types"]])
        self.assertIn("compat", payload)
        self.assertIsInstance(self.call("GET", "templates")["templates"], list)

    def wait_run(self, run_id, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = self.call("GET", f"runs/{run_id}")["run"]
            if run["status"] not in ("queued", "running"):
                return run
            time.sleep(0.05)
        self.fail("run did not finish")

    def test_runs_and_media(self):
        flow = self.call("POST", "flows", {"name": "run"})["flow"]
        res = self.call("POST", f"flows/{flow['id']}/ops", {"ops": [
            {"op": "add_node", "ref": "a", "type": "input.text", "params": {"value": "hi"}},
            {"op": "add_node", "ref": "e", "type": "tool:echo"},
            {"op": "add_node", "ref": "p", "type": "tool:pic"},
            {"op": "connect", "from": "a.text", "to": "e.text"},
        ]})
        started = self.call("POST", "runs", {"flow_id": flow["id"]})
        run = self.wait_run(started["run_id"])
        self.assertEqual(run["status"], "done", run)
        self.assertEqual(run["nodes"][res["refs"]["e"]]["outputs"]["text"], "echo:hi")
        listed = self.call("GET", "runs", query={"flow_id": flow["id"]})
        self.assertEqual(listed["runs"][0]["id"], run["id"])
        media = self.call("GET", f"runs/{run['id']}/media", query={"node": res["refs"]["p"], "thumb": "16"})
        self.assertEqual(media["kind"], "image")
        self.assertTrue(media["data_url"].startswith(("data:image/jpeg;base64,", "data:image/png;base64,")))
        self.assertTrue(media.get("thumb"))
        name = media["name"]
        raw = self.call("GET", f"files/{run['id']}/{name}")
        self.assertTrue(raw["data_url"].startswith("data:image/png"))
        self.assertEqual(self.status_of("GET", f"files/{run['id']}/..")[0], 400)
        self.assertEqual(self.status_of("GET", f"files/../{name}")[0], 400)
        self.assertEqual(self.status_of("GET", f"runs/{run['id']}/media", query={"node": "n_zzzzzz"})[0], 404)
        self.assertFalse(self.call("POST", f"runs/{run['id']}/cancel")["ok"])

    def test_media_lightbox_size(self):
        big = base64.b64encode(png_bytes((3000, 400))).decode()
        self.env.ctx.tools["big"] = lambda a: json.dumps({"image": "data:image/png;base64," + big})
        tools = TOOLS + [{"name": "big", "toolset": "test", "parameters": {"type": "object", "properties": {}}}]
        self.env.state["tool_source"] = lambda: tools
        flow = self.call("POST", "flows", {"name": "big"})["flow"]
        res = self.call("POST", f"flows/{flow['id']}/ops", {"ops": [{"op": "add_node", "ref": "b", "type": "tool:big"}]})
        run = self.wait_run(self.call("POST", "runs", {"flow_id": flow["id"]})["run_id"])
        self.assertEqual(run["status"], "done", run)
        from PIL import Image
        for asked, want in (("2048", 2048), ("9999", 2048), ("320", 320)):
            media = self.call("GET", f"runs/{run['id']}/media", query={"node": res["refs"]["b"], "thumb": asked})
            raw = base64.b64decode(media["data_url"].split(",", 1)[1])
            with Image.open(io.BytesIO(raw)) as img:
                self.assertEqual(img.size[0], want, asked)

    def upload(self, name, raw, mime="image/png"):
        return self.call("POST", "uploads", {"name": name, "data_url": f"data:{mime};base64," + base64.b64encode(raw).decode()})

    def test_uploads_store_by_hash_and_check_type_size_and_name(self):
        raw = png_bytes()
        first = self.upload("My cat.png", raw)
        self.assertEqual((first["name"], first["kind"], first["size"], first["deduped"]), ("My cat.png", "image", len(raw), False))
        folder = os.path.realpath(S.uploads_dir(self.env))
        rel = os.path.relpath(os.path.realpath(first["path"]), folder).replace("\\", "/")
        self.assertRegex(rel, r"^[0-9a-f]{12}/My cat\.png$")   # hash folder keeps the readable name
        with open(first["path"], "rb") as fh:
            self.assertEqual(fh.read(), raw)
        again = self.upload("My cat.png", raw)
        self.assertEqual((again["path"], again["deduped"]), (first["path"], True))
        renamed = self.upload("other.PNG", raw)   # same content, other name: same hash folder, second file
        self.assertEqual(os.path.dirname(renamed["path"]), os.path.dirname(first["path"]))
        self.assertFalse(renamed["deduped"])
        sneaky = self.upload("..\\..\\evil/../../x.png", png_bytes((8, 8)))   # only the base name survives
        self.assertEqual(sneaky["name"], "x.png")
        self.assertEqual(os.path.dirname(os.path.dirname(os.path.realpath(sneaky["path"]))), folder)
        odd = self.upload('CON.png', png_bytes((9, 9)))
        self.assertEqual(odd["name"], "_CON.png")
        self.assertEqual(self.upload('a<b>:c?.png', png_bytes((10, 10)))["name"], "a_b__c_.png")
        self.assertEqual(len(os.listdir(folder)), 4)
        code, detail = self.status_of("POST", "uploads", {"name": "run.exe", "data_url": "data:application/octet-stream;base64,AAAA"})
        self.assertEqual((code, detail["code"]), (400, "bad_type"))
        code, detail = self.status_of("POST", "uploads", {"name": ".png", "data_url": "data:image/png;base64,AAAA"})
        self.assertEqual((code, detail["code"]), (400, "bad_type"))   # nothing left of the name
        code, detail = self.status_of("POST", "uploads", {"name": "a.png", "data_url": "not a data url"})
        self.assertEqual((code, detail["code"]), (400, "bad_data"))
        code, detail = self.status_of("POST", "uploads", {"name": "a.png", "data_url": "data:image/png;base64,@@@@"})
        self.assertEqual((code, detail["code"]), (400, "bad_data"))
        old = E.media.MAX_UPLOAD_BYTES
        E.media.MAX_UPLOAD_BYTES = 100
        try:
            code, detail = self.status_of("POST", "uploads", {"name": "big.png", "data_url": "data:image/png;base64,"
                                                              + base64.b64encode(b"x" * 200).decode()})
        finally:
            E.media.MAX_UPLOAD_BYTES = old
        self.assertEqual((code, detail["code"], detail["max_bytes"]), (413, "too_large", 100))
        old = E.media.MAX_UPLOAD_BYTES
        E.media.MAX_UPLOAD_BYTES = 100
        try:
            code, detail = self.status_of("POST", "uploads", {"name": "big.png", "data": b"x" * 200})
        finally:
            E.media.MAX_UPLOAD_BYTES = old
        self.assertEqual((code, detail["code"], detail["max_bytes"]), (413, "too_large", 100))

    def test_uploads_accept_raw_bytes_like_the_multipart_route(self):
        # Review U-10: the same upload from raw bytes (what plugin_api.py builds) is the same stored file.
        raw = png_bytes((11, 11))
        by_url = self.upload("bytes.png", raw)
        by_bytes = self.call("POST", "uploads", {"name": "bytes.png", "data": raw})
        self.assertEqual((by_bytes["path"], by_bytes["deduped"], by_bytes["size"]), (by_url["path"], True, len(raw)))
        code, detail = self.status_of("POST", "uploads", {"name": "run.exe", "data": b"x"})
        self.assertEqual((code, detail["code"]), (400, "bad_type"))
        code, detail = self.status_of("POST", "uploads", {"name": "bytes.png", "data": "not bytes"})
        self.assertEqual((code, detail["code"]), (400, "bad_data"))

    def test_file_node_preview_uses_the_saved_path_only(self):
        pic = self.upload("pic.png", png_bytes((900, 300)))["path"]
        flow = self.call("POST", "flows", {"name": "files"})["flow"]
        res = self.call("POST", f"flows/{flow['id']}/ops", {"ops": [
            {"op": "add_node", "ref": "f", "type": "input.file", "params": {"path": f'"{pic}"'}},
            {"op": "add_node", "ref": "doc", "type": "input.file", "params": {"path": __file__}},
            {"op": "add_node", "ref": "gone", "type": "input.file", "params": {"path": pic + ".missing.png"}},
            {"op": "add_node", "ref": "t", "type": "input.text"},
        ]})
        ref = res["refs"]
        url = f"flows/{flow['id']}/file"
        got = self.call("GET", url, query={"node": ref["f"], "thumb": "9999", "path": "C:/Windows/win.ini"})
        self.assertEqual((got["exists"], got["kind"], got["path"], got["path_param"]), (True, "image", pic, f'"{pic}"'))
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(got["data_url"].split(",", 1)[1]))) as img:
            self.assertEqual(img.size[0], 512)   # clamped to FILE_NODE_THUMB_PX
        doc = self.call("GET", url, query={"node": ref["doc"], "thumb": "256"})
        self.assertEqual((doc["exists"], doc["kind"], doc["data_url"]), (True, "file", None))   # never the raw file
        self.assertFalse(self.call("GET", url, query={"node": ref["gone"], "thumb": "64"})["exists"])
        self.assertEqual(self.status_of("GET", url, query={"node": ref["t"]})[0], 400)
        self.assertEqual(self.status_of("GET", url, query={"node": "n_zzzzzz"})[0], 404)
        self.assertEqual(self.status_of("POST", url)[0], 404)

    def test_run_errors(self):
        self.assertEqual(self.status_of("POST", "runs", {})[0], 400)
        self.assertEqual(self.status_of("POST", "runs", {"flow_id": "f_0000000000"})[0], 404)
        flow = self.call("POST", "flows", {"name": "bad"})["flow"]
        self.call("POST", f"flows/{flow['id']}/ops", {"ops": [{"op": "add_node", "type": "tool:echo"}]})
        res = self.call("POST", "runs", {"flow_id": flow["id"]})
        self.assertEqual(res["status"], "invalid")
        self.assertTrue(res["issues"])
        self.assertEqual(self.status_of("POST", "runs", {"flow_id": flow["id"], "inputs": {"x": 1}})[0], 400)


class ModelPreviewTest(unittest.TestCase):
    """3D preview (07.11.): .glb files are inlined up to a larger limit than other files, so the viewer gets them."""

    def test_glb_over_the_general_limit_is_inlined(self):
        E = helpers.load_engine()
        tmp = tempfile.mkdtemp(prefix="fc-glb-")
        size = E.api.MAX_INLINE_BYTES + 1024
        glb, other = os.path.join(tmp, "m.glb"), os.path.join(tmp, "m.bin")
        for path in (glb, other):
            with open(path, "wb") as fh:
                fh.write(b"glTF" + b"\0" * (size - 4))
        self.assertTrue(E.api.file_payload(glb)["data_url"].startswith("data:model/gltf-binary;base64,"))
        self.assertIsNone(E.api.file_payload(other)["data_url"])
        self.assertGreaterEqual(E.api.MAX_MODEL_INLINE_BYTES, 32 * 1024 * 1024)


class RouterSmokeTest(unittest.TestCase):
    """The real dashboard/plugin_api.py router under FastAPI's TestClient."""

    def test_router(self):
        helpers.temp_data_dir()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        api_mod = helpers.load_module(os.path.join("dashboard", "plugin_api.py"), "fc_plugin_api_smoke")
        app = FastAPI()
        app.include_router(api_mod.router, prefix="/api/plugins/flowcanvas")
        client = TestClient(app)
        self.assertEqual(client.get("/api/plugins/flowcanvas/x/ping").json()["ok"], True)
        created = client.post("/api/plugins/flowcanvas/x/flows", json={"name": "Smoke"})
        self.assertEqual(created.status_code, 200, created.text)
        flow_id = created.json()["flow"]["id"]
        self.assertEqual(client.get(f"/api/plugins/flowcanvas/x/flows/{flow_id}").json()["flow"]["name"], "Smoke")
        missing = client.get("/api/plugins/flowcanvas/x/flows/f_0000000000")
        self.assertEqual(missing.status_code, 404)
        # E1: the spike routes are gone; every endpoint goes through /x/<path>
        self.assertEqual(client.get("/api/plugins/flowcanvas/health").status_code, 404)
        self.assertEqual(client.post("/api/plugins/flowcanvas/dispatch", json={"tool": "read_file"}).status_code, 404)
        self.assertEqual({getattr(r, "path", "") for r in api_mod.router.routes}, {"/x/{path:path}"})

    def test_multipart_upload_is_the_same_upload(self):
        # Review U-10: the plugin SDK sends one file as multipart/form-data (field "file"), so a drop no longer
        # travels base64-inflated inside JSON. Same storage rules, same answer, and the JSON body still works.
        data_dir = helpers.temp_data_dir()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        api_mod = helpers.load_module(os.path.join("dashboard", "plugin_api.py"), "fc_plugin_api_multipart")
        app = FastAPI()
        app.include_router(api_mod.router, prefix="/api/plugins/flowcanvas")
        client = TestClient(app)
        raw = png_bytes((40, 30))
        res = client.post("/api/plugins/flowcanvas/x/uploads", files={"file": ("drop.png", raw, "image/png")})
        self.assertEqual(res.status_code, 200, res.text)
        got = res.json()
        self.assertEqual((got["name"], got["kind"], got["size"], got["deduped"]), ("drop.png", "image", len(raw), False))
        self.assertTrue(os.path.isfile(got["path"]))
        with open(got["path"], "rb") as fh:
            self.assertEqual(fh.read(), raw)
        uploads = os.path.realpath(os.path.join(data_dir, "uploads"))
        self.assertEqual(os.path.dirname(os.path.dirname(os.path.realpath(got["path"]))), uploads)  # <uploads>/<hash>/<name>
        # the JSON data_url body still reaches the same file: one record, deduped
        again = client.post("/api/plugins/flowcanvas/x/uploads",
                            json={"name": "drop.png", "data_url": "data:image/png;base64," + base64.b64encode(raw).decode()})
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual((again.json()["path"], again.json()["deduped"]), (got["path"], True))
        # the route's own refusals surface unchanged
        bad = client.post("/api/plugins/flowcanvas/x/uploads", files={"file": ("run.exe", b"\x00\x01", "application/octet-stream")})
        self.assertEqual(bad.status_code, 400, bad.text)
        self.assertEqual(bad.json()["detail"]["code"], "bad_type")
        nameless = client.post("/api/plugins/flowcanvas/x/uploads", data={"name": "drop.png"})
        self.assertEqual(nameless.status_code, 400, nameless.text)
        broken = client.post("/api/plugins/flowcanvas/x/uploads", content=b"--nope\r\n",
                             headers={"content-type": "multipart/form-data; boundary=nope"})
        self.assertEqual(broken.status_code, 400, broken.text)
        elsewhere = client.post("/api/plugins/flowcanvas/x/flows", files={"file": ("x.png", b"\x89PNG", "image/png")})
        self.assertEqual(elsewhere.status_code, 400, elsewhere.text)   # multipart is the upload route's transport only

    def test_body_is_checked_before_parsing(self):
        # Review E-13: broken JSON was silently {} (misleading 400 later); size was only checked after parsing.
        helpers.temp_data_dir()
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        api_mod = helpers.load_module(os.path.join("dashboard", "plugin_api.py"), "fc_plugin_api_body")
        app = FastAPI()
        app.include_router(api_mod.router, prefix="/p")
        client = TestClient(app)
        bad = client.post("/p/x/flows", content=b"{not json", headers={"content-type": "application/json"})
        self.assertEqual(bad.status_code, 400)
        self.assertIn("invalid JSON", bad.text)
        big = client.post("/p/x/flows", content=b" " * (api_mod.MAX_BODY_BYTES + 1),
                          headers={"content-type": "application/json"})
        self.assertEqual(big.status_code, 413)
        self.assertGreater(api_mod.MAX_BODY_BYTES, 25 * 1024 * 1024 * 4 // 3)   # a 25 MB upload as base64 fits
        empty = client.post("/p/x/flows", content=b"")                        # empty body still means {}
        self.assertEqual(empty.status_code, 200, empty.text)


if __name__ == "__main__":
    unittest.main()
