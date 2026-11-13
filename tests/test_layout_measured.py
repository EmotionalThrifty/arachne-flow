"""Tidy must pack measured node rectangles, not guesses about collapsed cards."""
import asyncio
import copy
import math
import unittest

import helpers

E = helpers.load_engine()
L = E.layout


def node(i, x=0, y=0):
    return {"id": f"n_{i:06x}", "type": "note", "params": {"text": "a long note"}, "x": x, "y": y}


def flow():
    return {"nodes": [node(1), node(2), node(3), node(4)], "edges": [
        {"from": {"node": "n_000001", "port": "out"}, "to": {"node": "n_000003", "port": "in"}},
        {"from": {"node": "n_000002", "port": "out"}, "to": {"node": "n_000004", "port": "in"}}
    ]}


class MeasuredLayoutTest(unittest.TestCase):
    def sizes(self):
        return {"n_000001": {"width": 480, "height": 950}, "n_000002": {"width": 240, "height": 480},
                "n_000003": {"width": 240, "height": 330}, "n_000004": {"width": 320, "height": 750}}

    def assert_clear(self, f, sizes):
        for i, a in enumerate(f["nodes"]):
            for b in f["nodes"][i + 1:]:
                aa, bb = sizes[a["id"]], sizes[b["id"]]
                self.assertTrue(a["x"] + aa["width"] + 40 <= b["x"] or b["x"] + bb["width"] + 40 <= a["x"] or
                                a["y"] + aa["height"] + L.ROW_GAP <= b["y"] or b["y"] + bb["height"] + L.ROW_GAP <= a["y"], (a, b))

    def test_expanded_ports_notes_and_media_get_their_real_height_and_width(self):
        f, sizes = flow(), self.sizes()
        L.auto_layout(f, node_sizes=sizes)
        self.assert_clear(f, sizes)
        self.assertGreaterEqual(f["nodes"][2]["x"], f["nodes"][0]["x"] + 480 + 40)
        self.assertEqual(set(L.columns(f).values()), {0, 1})

    def test_tidy_is_idempotent_and_keeps_edges_and_parameters(self):
        f, sizes = flow(), self.sizes()
        before = copy.deepcopy(f)
        L.auto_layout(f, node_sizes=sizes)
        once = copy.deepcopy(f)
        L.auto_layout(f, node_sizes=sizes)
        self.assertEqual(f, once)
        self.assertEqual(f["edges"], before["edges"])
        self.assertEqual([n["params"] for n in f["nodes"]], [n["params"] for n in before["nodes"]])

    def test_partial_or_invalid_measurements_fall_back_without_nonfinite_positions(self):
        for bad in [None, [], "bad", {"n_000001": None}, {"n_000001": {"width": math.inf, "height": -1}},
                    {"n_000001": {"width": "99999", "height": True}}, {"n_000001": {"width": 1e100, "height": math.nan}}, {"n_000001": {"width": 10 ** 1000, "height": 180}}]:
            f = flow()
            L.auto_layout(f, node_sizes=bad)
            self.assertTrue(all(math.isfinite(n[k]) for n in f["nodes"] for k in ("x", "y")))
            self.assertEqual(len({(n["x"], n["y"]) for n in f["nodes"]}), len(f["nodes"]))

    def test_fallback_keeps_every_template_port_visible_like_the_canvas(self):
        template = " ".join("{{field%d}}" % i for i in range(24))
        spec = {"dynamic_inputs": "template", "inputs": [], "outputs": []}
        self.assertGreaterEqual(L.estimate_height({"type": "llm.complete", "params": {"template": template}}, spec),
                                L.CARD_HEAD + L.CARD_PAD + 24 * L.CARD_ROW)

    def test_current_measurement_is_preferred_to_a_large_unused_output_estimate(self):
        f = {"nodes": [dict(node(i), type="tool:large") for i in (1, 2)], "edges": []}
        spec = {"outputs": [{"name": f"image{i}", "type": "image"} for i in range(4)]}
        sizes = {n["id"]: {"width": 240, "height": 190} for n in f["nodes"]}
        L.auto_layout(f, {"tool:large": spec}, node_sizes=sizes)
        self.assertEqual(f["nodes"][1]["y"] - f["nodes"][0]["y"], 190 + L.ROW_GAP)

    def test_layout_route_honors_measurements_and_revision_without_storing_geometry(self):
        helpers.temp_data_dir()
        env = E.env.Env(ctx=helpers.FakeCtx(), state={"tool_source": lambda: []})
        saved = E.store.save_flow(env, dict(E.graph.new_flow("Measured"), **flow()), create=True)
        body = {"node_sizes": self.sizes(), "base_revision": saved["revision"], "origin": "ui"}
        result = asyncio.run(E.api.handle("POST", f"flows/{saved['id']}/layout", {}, body, env))["flow"]
        self.assert_clear(result, self.sizes())
        self.assertNotIn("node_sizes", result)
        self.assertEqual(result["revision"], saved["revision"] + 1)


if __name__ == "__main__":
    unittest.main()
