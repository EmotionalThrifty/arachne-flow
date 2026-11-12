"""A1: port types, graph model, ops and layout."""
import unittest

import helpers

E = helpers.load_engine()
T, G, L = E.types, E.graph, E.layout

# A small fake node library in §3.4 shape.
TYPES = {
    "input.text": {"type": "input.text", "inputs": [], "outputs": [{"name": "text", "type": "text"}],
                   "params": [{"name": "value", "kind": "textarea", "default": ""}]},
    "input.number": {"type": "input.number", "inputs": [], "outputs": [{"name": "value", "type": "number"}]},
    "llm.complete": {"type": "llm.complete",
                     "inputs": [{"name": "prompt", "type": "text", "required": True, "label": "Prompt"}],
                     "outputs": [{"name": "text", "type": "text"}],
                     "params": [{"name": "template", "kind": "textarea", "default": "{{prompt}}"}],
                     "dynamic_inputs": "template"},
    "img": {"type": "img", "inputs": [{"name": "prompt", "type": "text", "required": True}],
            "outputs": [{"name": "image", "type": "image"}]},
    "save": {"type": "save", "inputs": [{"name": "file", "type": "file", "required": True}], "outputs": []},
    "num.sink": {"type": "num.sink", "inputs": [{"name": "n", "type": "number"}], "outputs": []},
    "any.pass": {"type": "any.pass", "inputs": [{"name": "in", "type": "any"}],
                 "outputs": [{"name": "out", "type": "any"}]},
    "logic.switch": {"type": "logic.switch", "inputs": [{"name": "value", "type": "any", "required": True}],
                     "outputs": [{"name": "default", "type": "any"}],
                     "params": [{"name": "cases", "kind": "textarea", "default": ""}],
                     "dynamic_outputs": "cases"},
    "output.preview": {"type": "output.preview", "inputs": [{"name": "value", "type": "any", "required": True}],
                       "outputs": [{"name": "value", "type": "any"}]},
    "note": {"type": "note", "inputs": [], "outputs": [], "params": [{"name": "text", "kind": "textarea"}]},
}


def build(ops, flow=None):
    flow, results = G.apply_ops(flow or G.new_flow("t"), ops, TYPES)
    return flow, results


def chain():
    return build([
        {"op": "add_node", "ref": "a", "type": "input.text", "params": {"value": "hi"}},
        {"op": "add_node", "ref": "b", "type": "llm.complete"},
        {"op": "add_node", "ref": "c", "type": "img"},
        {"op": "connect", "from": "a.text", "to": "b.prompt"},
        {"op": "connect", "from": "b.text", "to": "c.prompt"},
    ])


class TypesTest(unittest.TestCase):
    def test_same_type_and_any(self):
        for t in T.TYPE_NAMES:
            self.assertTrue(T.compatible(t, t))
            self.assertTrue(T.compatible(t, "any"))
            self.assertTrue(T.compatible("any", t))

    def test_conversions_and_refusals(self):
        self.assertTrue(T.compatible("number", "text"))
        self.assertTrue(T.compatible("json", "text"))
        self.assertTrue(T.compatible("image", "file"))
        self.assertTrue(T.compatible("model3d", "file"))
        self.assertFalse(T.compatible("text", "number"))
        self.assertFalse(T.compatible("image", "text"))
        self.assertFalse(T.compatible("file", "image"))
        self.assertFalse(T.compatible("text", "bogus"))

    def test_compat_table_matches_function(self):
        table = T.compat_table()
        self.assertEqual(set(table), set(T.TYPE_NAMES))
        self.assertIn("text", table["number"])
        self.assertNotIn("number", table["text"])
        self.assertEqual(set(T.port_types()), set(T.TYPE_NAMES))

    def test_convert_values(self):
        self.assertEqual(T.convert(3, "text"), "3")
        self.assertEqual(T.convert(2.5, "text"), "2.5")
        self.assertEqual(T.convert(True, "text"), "true")
        self.assertEqual(T.convert({"a": 1}, "text"), '{\n  "a": 1\n}')
        self.assertEqual(T.convert("42", "number"), 42)
        self.assertEqual(T.convert("4.5", "number"), 4.5)
        self.assertEqual(T.convert('{"x": 1}', "json"), {"x": 1})
        self.assertIs(T.convert("yes", "boolean"), True)
        with self.assertRaises(T.ConversionError):
            T.convert("abc", "number")
        media = {"$media": {"kind": "image", "file": "n_1-0.png", "path": "C:/x/n_1-0.png"}}
        self.assertIs(T.convert(media, "file"), media)
        self.assertEqual(T.value_type(media), "image")
        with self.assertRaises(T.ConversionError):
            T.convert(media, "audio")


class GraphModelTest(unittest.TestCase):
    def test_flows_saved_before_the_rename_still_validate(self):
        legacy = dict(G.new_flow("Old"), schema="flowcanvas/1")
        self.assertFalse([i for i in G.validate(legacy, {}) if "schema" in i["message"]])
        other = dict(G.new_flow("Other"), schema="someone-else/1")
        self.assertTrue([i for i in G.validate(other, {}) if "schema" in i["message"]])

    def test_new_flow_shape_and_ids(self):
        f = G.new_flow("Prompt to 3D")
        self.assertEqual(f["schema"], "arachne-flow/1")
        self.assertRegex(f["id"], r"^f_[0-9a-f]{10}$")
        self.assertEqual(f["nodes"], [])
        self.assertEqual(f["viewport"], {"x": 0, "y": 0, "zoom": 1})
        flow, _ = chain()
        for n in flow["nodes"]:
            self.assertRegex(n["id"], r"^n_[0-9a-f]{6}$")
        for e in flow["edges"]:
            self.assertRegex(e["id"], r"^e_[0-9a-f]{6}$")

    def test_ref_resolution_by_ref_id_and_title(self):
        flow, res = build([
            {"op": "add_node", "ref": "src", "type": "input.text", "title": "Idee"},
            {"op": "add_node", "ref": "llm", "type": "llm.complete"},
            {"op": "connect", "from": "src.text", "to": "llm.prompt"},
        ])
        src_id = res[0]["node"]
        self.assertEqual(res[0]["ref"], "src")
        self.assertEqual(flow["edges"][0]["from"], {"node": src_id, "port": "text"})
        llm_id = res[1]["node"]
        # second batch: refs are gone, ids and (unique) titles still resolve
        flow2, _ = build([{"op": "disconnect", "to": f"{llm_id}.prompt"},
                          {"op": "connect", "from": "idee.text", "to": {"node": llm_id, "port": "prompt"}}], flow)
        self.assertEqual(len(flow2["edges"]), 1)
        self.assertEqual(flow2["edges"][0]["from"]["node"], src_id)

    def test_unknown_ref_fails(self):
        with self.assertRaises(G.OpError) as cm:
            build([{"op": "connect", "from": "ghost.text", "to": "x.prompt"}])
        self.assertEqual(cm.exception.index, 0)
        self.assertIn("ghost", cm.exception.message)

    def test_connect_replaces_existing_input_edge(self):
        flow, res = build([
            {"op": "add_node", "ref": "a", "type": "input.text"},
            {"op": "add_node", "ref": "b", "type": "input.text"},
            {"op": "add_node", "ref": "l", "type": "llm.complete"},
            {"op": "connect", "from": "a.text", "to": "l.prompt"},
            {"op": "connect", "from": "b.text", "to": "l.prompt"},
        ])
        self.assertEqual(len(flow["edges"]), 1)
        self.assertEqual(flow["edges"][0]["from"]["node"], res[1]["node"])
        self.assertEqual(res[4]["replaced"], res[3]["edge"])

    def test_connect_refuses_cycle(self):
        flow, res = chain()
        b, c = res[1]["node"], res[2]["node"]
        flow, r = build([{"op": "add_node", "ref": "p", "type": "any.pass"},
                         {"op": "connect", "from": f"{c}.image", "to": "p.in"}], flow)
        p = r[0]["node"]
        with self.assertRaises(G.OpError) as cm:
            build([{"op": "connect", "from": f"{p}.out", "to": f"{b}.prompt"}], flow)
        self.assertIn("cycle", cm.exception.message)

    def test_connect_refuses_self_loop(self):
        with self.assertRaises(G.OpError):
            build([{"op": "add_node", "ref": "p", "type": "any.pass"},
                   {"op": "connect", "from": "p.out", "to": "p.in"}])

    def test_connect_incompatible_ports(self):
        with self.assertRaises(G.OpError) as cm:
            build([{"op": "add_node", "ref": "t", "type": "input.text"},
                   {"op": "add_node", "ref": "n", "type": "num.sink"},
                   {"op": "connect", "from": "t.text", "to": "n.n"}])
        self.assertEqual(cm.exception.index, 2)
        self.assertIn("cannot connect", cm.exception.message)

    def test_connect_compatible_conversions(self):
        flow, _ = build([{"op": "add_node", "ref": "n", "type": "input.number"},
                         {"op": "add_node", "ref": "l", "type": "llm.complete"},
                         {"op": "connect", "from": "n.value", "to": "l.prompt"},
                         {"op": "add_node", "ref": "i", "type": "img"},
                         {"op": "add_node", "ref": "s", "type": "save"},
                         {"op": "connect", "from": "i.image", "to": "s.file"}])
        self.assertEqual(len(flow["edges"]), 2)

    def test_unknown_port_lists_available(self):
        with self.assertRaises(G.OpError) as cm:
            build([{"op": "add_node", "ref": "t", "type": "input.text"},
                   {"op": "add_node", "ref": "l", "type": "llm.complete"},
                   {"op": "connect", "from": "t.txt", "to": "l.prompt"}])
        self.assertIn("text", cm.exception.message)

    def test_remove_node_cascades_edges(self):
        flow, res = chain()
        flow2, r = build([{"op": "remove_node", "node": res[1]["node"]}], flow)
        self.assertEqual(len(flow2["nodes"]), 2)
        self.assertEqual(flow2["edges"], [])
        self.assertEqual(r[0]["removed_edges"], 2)

    def test_atomic_abort_leaves_flow_untouched(self):
        flow, _ = chain()
        snapshot = G.copy.deepcopy(flow)
        with self.assertRaises(G.OpError) as cm:
            G.apply_ops(flow, [{"op": "add_node", "type": "input.text"},
                               {"op": "set_meta", "name": "renamed"},
                               {"op": "explode"}], TYPES)
        self.assertEqual(cm.exception.index, 2)
        self.assertEqual(flow, snapshot)

    def test_unknown_type_refused_when_library_given(self):
        with self.assertRaises(G.OpError):
            build([{"op": "add_node", "type": "does.not.exist"}])
        flow, _ = G.apply_ops(G.new_flow(), [{"op": "add_node", "type": "does.not.exist"}])  # no library
        self.assertEqual(len(flow["nodes"]), 1)

    def test_update_node_merges_params_and_drops_dangling_dynamic_edges(self):
        flow, res = build([
            {"op": "add_node", "ref": "t", "type": "input.text"},
            {"op": "add_node", "ref": "l", "type": "llm.complete",
             "params": {"template": "{{prompt}} in style {{style}}", "system": "s"}},
            {"op": "connect", "from": "t.text", "to": "l.style"},
        ])
        lid = res[1]["node"]
        self.assertEqual(len(flow["edges"]), 1)
        flow2, _ = build([{"op": "update_node", "node": lid, "title": "Better",
                           "params": {"template": "{{prompt}}", "system": None}, "x": 5}], flow)
        node = G.node_by_id(flow2, lid)
        self.assertEqual(node["title"], "Better")
        self.assertEqual(node["x"], 5)
        self.assertEqual(node["params"], {"template": "{{prompt}}"})
        self.assertEqual(flow2["edges"], [])

    def test_reducing_switch_cases_removes_the_orphaned_output_edge(self):
        # R2-03: an agent edit that drops case3 must also drop its edge; otherwise the flow is invalid.
        flow, res = build([
            {"op": "add_node", "ref": "src", "type": "input.text"},
            {"op": "add_node", "ref": "sw", "type": "logic.switch", "params": {"cases": "a\nb\nc"}},
            {"op": "add_node", "ref": "pv", "type": "output.preview"},
            {"op": "add_node", "ref": "sink", "type": "any.pass"},
            {"op": "connect", "from": "src.text", "to": "sw.value"},
            {"op": "connect", "from": "sw.case1", "to": "pv.value"},
            {"op": "connect", "from": "sw.case3", "to": "sink.in"},
        ])
        sw = res[1]["node"]
        self.assertEqual(len(flow["edges"]), 3)
        flow2, _ = build([{"op": "update_node", "node": sw, "params": {"cases": "a"}}], flow)
        self.assertEqual([e for e in flow2["edges"] if e["from"]["node"] == sw and e["from"]["port"] == "case3"],
                         [], "the edge from the removed 'case3' output must be dropped")
        self.assertEqual(len(flow2["edges"]), 2)
        self.assertEqual(G.validate(flow2, TYPES), [])
        self.assertEqual(set(G.topo_order(flow2)), {r["node"] for r in res[:4]})

    def test_set_meta_and_disconnect(self):
        flow, res = chain()
        flow2, r = build([{"op": "set_meta", "name": "  New  ", "description": "d"},
                          {"op": "disconnect", "to": f"{res[2]['node']}.prompt"}], flow)
        self.assertEqual(flow2["name"], "New")
        self.assertEqual(flow2["description"], "d")
        self.assertEqual(len(flow2["edges"]), 1)
        with self.assertRaises(G.OpError):
            build([{"op": "disconnect", "to": f"{res[2]['node']}.prompt"}], flow2)
        with self.assertRaises(G.OpError):
            build([{"op": "set_meta", "name": ""}], flow2)

    def test_duplicate_ref_and_bad_op_shapes(self):
        with self.assertRaises(G.OpError):
            build([{"op": "add_node", "ref": "a", "type": "note"}, {"op": "add_node", "ref": "a", "type": "note"}])
        with self.assertRaises(G.OpError):
            build(["nope"])
        with self.assertRaises(G.OpError):
            G.apply_ops(G.new_flow(), {"op": "add_node"})

    def test_refresh_ids_rewires_edges(self):
        flow, _ = chain()
        fresh = G.refresh_ids(flow)
        self.assertFalse({n["id"] for n in flow["nodes"]} & {n["id"] for n in fresh["nodes"]})
        self.assertEqual(G.validate(fresh, TYPES), [])
        self.assertEqual(len(fresh["edges"]), 2)


class TopologyTest(unittest.TestCase):
    def test_topo_order_respects_edges(self):
        flow, res = chain()
        order = G.topo_order(flow)
        ids = [r["node"] for r in res[:3]]
        self.assertEqual(order, ids)
        flow["nodes"].reverse()                    # file order must not beat dependencies
        self.assertEqual(G.topo_order(flow), ids)

    def test_topo_order_subset_and_cycle_error(self):
        flow, res = chain()
        a, b, c = (r["node"] for r in res[:3])
        self.assertEqual(G.topo_order(flow, [c, a]), [a, c])
        flow["edges"].append({"id": "e_ffffff", "from": {"node": c, "port": "image"}, "to": {"node": a, "port": "x"}})
        with self.assertRaises(G.CycleError) as cm:
            G.topo_order(flow)
        self.assertEqual(cm.exception.nodes[0], cm.exception.nodes[-1])

    def test_ancestors_and_descendants(self):
        flow, res = build([
            {"op": "add_node", "ref": "a", "type": "input.text"},
            {"op": "add_node", "ref": "b", "type": "llm.complete"},
            {"op": "add_node", "ref": "c", "type": "img"},
            {"op": "add_node", "ref": "d", "type": "input.text"},
            {"op": "connect", "from": "a.text", "to": "b.prompt"},
            {"op": "connect", "from": "b.text", "to": "c.prompt"},
        ])
        a, b, c, d = (r["node"] for r in res[:4])
        self.assertEqual(G.ancestors(flow, c), {a, b})
        self.assertEqual(G.ancestors(flow, a), set())
        self.assertEqual(G.descendants(flow, a), {b, c})
        self.assertEqual(G.descendants(flow, d), set())


class ValidateTest(unittest.TestCase):
    def test_valid_chain_has_no_issues(self):
        flow, _ = chain()
        self.assertEqual(G.validate(flow, TYPES), [])

    def test_missing_required_input(self):
        flow, res = build([{"op": "add_node", "ref": "l", "type": "llm.complete"}])
        issues = G.validate(flow, TYPES)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["level"], "error")
        self.assertEqual(issues[0]["node"], res[0]["node"])
        self.assertEqual(issues[0]["port"], "prompt")
        flow2, _ = build([{"op": "update_node", "node": res[0]["node"], "params": {"prompt": "constant"}}], flow)
        self.assertEqual(G.validate(flow2, TYPES), [])        # a constant param satisfies it

    def test_unknown_type_and_dangling_edge(self):
        flow, res = chain()
        flow["nodes"].append({"id": "n_abcdef", "type": "mystery", "x": 0, "y": 0, "params": {}})
        flow["edges"].append({"id": "e_abcdef", "from": {"node": "n_000000", "port": "text"},
                              "to": {"node": res[1]["node"], "port": "prompt"}})
        msgs = [i["message"] for i in G.validate(flow, TYPES)]
        self.assertTrue(any("unknown node type" in m for m in msgs))
        self.assertTrue(any("missing node" in m for m in msgs))

    def test_incompatible_edge_and_double_input(self):
        flow, res = chain()
        a, b = res[0]["node"], res[1]["node"]
        flow["nodes"].append({"id": "n_0000aa", "type": "num.sink", "params": {}})
        flow["edges"].append({"id": "e_0000aa", "from": {"node": a, "port": "text"}, "to": {"node": "n_0000aa", "port": "n"}})
        flow["edges"].append({"id": "e_0000bb", "from": {"node": a, "port": "text"}, "to": {"node": b, "port": "prompt"}})
        msgs = [i["message"] for i in G.validate(flow, TYPES)]
        self.assertTrue(any("cannot connect" in m for m in msgs))
        self.assertTrue(any("more than one connection" in m for m in msgs))

    def test_cycle_detected(self):
        flow, res = build([{"op": "add_node", "ref": "p", "type": "any.pass"},
                           {"op": "add_node", "ref": "q", "type": "any.pass"},
                           {"op": "connect", "from": "p.out", "to": "q.in"}])
        p, q = res[0]["node"], res[1]["node"]
        flow["edges"].append({"id": "e_cccccc", "from": {"node": q, "port": "out"}, "to": {"node": p, "port": "in"}})
        issues = G.validate(flow, TYPES)
        self.assertTrue(any(i["message"].startswith("cycle") for i in issues))
        self.assertTrue(G.has_errors(issues))

    def test_note_and_dynamic_inputs(self):
        flow, res = build([{"op": "add_node", "ref": "n", "type": "note", "params": {"text": "hello"}},
                           {"op": "add_node", "ref": "l", "type": "llm.complete",
                            "params": {"template": "{{ topic }} and {{prompt}} {{topic}}"}}])
        ins, _ = G.node_ports(G.node_by_id(flow, res[1]["node"]), TYPES)
        self.assertEqual([p["name"] for p in ins], ["prompt", "topic"])
        self.assertEqual(ins[1]["type"], "text")
        # only the required 'prompt' complains; the note is ignored, dynamic inputs are optional
        self.assertEqual([i["port"] for i in G.validate(flow, TYPES)], ["prompt"])

    def test_malformed_flow(self):
        self.assertTrue(G.has_errors(G.validate({"nodes": "x"}, TYPES)))
        self.assertTrue(G.has_errors(G.validate("x", TYPES)))
        dup = {"nodes": [{"id": "n_111111", "type": "note"}, {"id": "n_111111", "type": "note"}], "edges": []}
        self.assertTrue(any("duplicate" in i["message"] for i in G.validate(dup, TYPES)))


class LayoutTest(unittest.TestCase):
    def test_columns_by_longest_path(self):
        flow, res = build([
            {"op": "add_node", "ref": "a", "type": "input.text"},
            {"op": "add_node", "ref": "b", "type": "llm.complete"},
            {"op": "add_node", "ref": "c", "type": "llm.complete", "params": {"template": "{{prompt}}{{x}}"}},
            {"op": "connect", "from": "a.text", "to": "b.prompt"},
            {"op": "connect", "from": "b.text", "to": "c.prompt"},
            {"op": "connect", "from": "a.text", "to": "c.x"},      # short path a->c must not win
            {"op": "auto_layout"},
        ])
        a, b, c = (G.node_by_id(flow, r["node"]) for r in res[:3])
        self.assertEqual((a["x"], a["y"]), (80, 80))
        self.assertEqual(b["x"], 380)
        self.assertEqual(c["x"], 680)

    def test_layout_has_no_overlap(self):
        ops = [{"op": "add_node", "ref": "src", "type": "input.text", "x": 0, "y": 0}]
        for i in range(12):
            ops.append({"op": "add_node", "ref": f"l{i}", "type": "llm.complete", "x": 0, "y": 0})
            ops.append({"op": "connect", "from": "src.text", "to": f"l{i}.prompt"})
        for i in range(5):
            ops.append({"op": "add_node", "type": "note", "x": 0, "y": 0})
        ops.append({"op": "auto_layout"})
        flow, _ = build(ops)
        spots = [(n["x"], n["y"]) for n in flow["nodes"]]
        self.assertEqual(len(spots), len(set(spots)))
        for i, (x1, y1) in enumerate(spots):
            for x2, y2 in spots[i + 1:]:
                self.assertTrue(abs(x1 - x2) >= 300 or abs(y1 - y2) >= 170)

    def test_layout_gives_tall_nodes_room(self):
        # Tool nodes with many ports are taller than ROW_H; with types known, rows must not overlap.
        tall = {"type": "tool:big", "kind": "tool", "inputs": [{"name": f"p{i}", "type": "text"} for i in range(6)],
                "outputs": [{"name": "result", "type": "json"}], "params": []}
        types = dict(TYPES, **{"tool:big": tall})
        flow = G.new_flow()
        flow["nodes"] = [{"id": f"n_{i:06x}", "type": "tool:big", "x": 0, "y": 0, "params": {"p0": "x"}} for i in range(3)]
        L.auto_layout(flow, types)
        ys = sorted(n["y"] for n in flow["nodes"])
        est = L.estimate_height(flow["nodes"][0], tall)
        self.assertGreater(est, L.ROW_H)
        for a, b in zip(ys, ys[1:]):
            self.assertGreaterEqual(b - a, est + L.ROW_GAP)

    def test_layout_reserves_four_output_cards_in_one_column(self):
        # One card's four outputs make the canvas card about 270 px tall, not the old 60 px estimate.
        # The two sibling cards must not overlap when every tool result has thumbnails.
        big = dict(TYPES['img'], outputs=[{'name': 'image', 'type': 'image'}] * 4)
        types = dict(TYPES, img=big)
        flow = G.new_flow()
        flow['nodes'] = [{'id': f'n_{i:06x}', 'type': 'img', 'x': 0, 'y': 0, 'params': {}} for i in range(2)]
        L.auto_layout(flow, types)
        a, b = flow['nodes']
        self.assertGreaterEqual(b['y'] - a['y'], 270 + L.ROW_GAP)
        self.assertEqual(L.estimate_height(a, big), b['y'] - a['y'] - L.ROW_GAP)
        media_tool = {'type':'tool:mcp__nanogpt__nanogpt_3d_generate', 'inputs':[{'name':'prompt'}], 'outputs':[{'name':'result'},{'name':'text'},{'name':'media'}], 'params':[]}
        vision_tool = {'type':'tool:vision_analyze', 'inputs':[{'name':'image_url'},{'name':'question'}], 'outputs':[{'name':'result'},{'name':'text'},{'name':'media'}], 'params':[{'name':'question','default':'Is it a robot?'}]}
        types.update({'tool:mcp__nanogpt__nanogpt_3d_generate':media_tool,'tool:vision_analyze':vision_tool})
        flow['nodes']=[{'id':'n_000001','type':'tool:vision_analyze','x':0,'y':0,'params':{'question':'Is this a robot toy?'}},
                       {'id':'n_000002','type':'tool:mcp__nanogpt__nanogpt_3d_generate','x':0,'y':0,'params':{}}]
        L.auto_layout(flow,types)
        a,b=flow['nodes']
        self.assertGreaterEqual(b['y']-a['y'],L.estimate_height(a,vision_tool)+L.ROW_GAP)
        self.assertGreaterEqual(L.estimate_height(a,vision_tool),380)

    def test_layout_survives_cycle_and_empty(self):
        self.assertEqual(L.auto_layout(G.new_flow())["nodes"], [])
        flow, res = build([{"op": "add_node", "ref": "p", "type": "any.pass"},
                           {"op": "add_node", "ref": "q", "type": "any.pass"},
                           {"op": "connect", "from": "p.out", "to": "q.in"}])
        flow["edges"].append({"id": "e_cccccc", "from": {"node": res[1]["node"], "port": "out"},
                              "to": {"node": res[0]["node"], "port": "in"}})
        L.auto_layout(flow)                                   # must terminate
        self.assertEqual(len({(n["x"], n["y"]) for n in flow["nodes"]}), 2)

    def test_new_nodes_get_free_positions(self):
        flow, res = build([{"op": "add_node", "type": "note"}, {"op": "add_node", "type": "note"}])
        n1, n2 = flow["nodes"]
        self.assertEqual((n1["x"], n1["y"]), (80, 80))
        self.assertEqual(n2["x"], 380)


if __name__ == "__main__":
    unittest.main()
