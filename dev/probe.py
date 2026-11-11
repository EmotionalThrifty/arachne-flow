"""Headless DOM probe for the dev harness: console errors, node overlaps, edge count per scenario.

  bash scripts/hpy dev/probe.py [scenario ...]     (default: all scenarios)

Exit code 1 when a scenario logs errors or shows overlapping nodes. Dev tooling only.
"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import dev_server  # noqa: E402
from screenshot import chrome, free_port  # noqa: E402

SCENARIOS = ("empty", "template", "running", "done", "inspector", "quick", "quick_add",
             "partial", "fresh", "stop", "shortcut", "inspector_error", "tool_swap", "edit_keys",
             "agent_sync", "agent_sync_dirty", "agent_undo", "ask", "ask_none", "shell", "model_picker",
             "tool_options", "llm_info",
             "lightbox", "lightbox_inspector", "palette", "files", "popout", "popout_fail", "popin", "templates", "generate", "model_settings", "media_inputs", "timings", "logic", "loop", "schedule")


def overlaps(nodes: list) -> list:
    out = []
    for i, a in enumerate(nodes):
        for b in nodes[i + 1:]:
            if a["x"] < b["x"] + b["w"] - 2 and b["x"] < a["x"] + a["w"] - 2 and \
               a["y"] < b["y"] + b["h"] - 2 and b["y"] < a["y"] + a["h"] - 2:
                out.append(f"{a['title']} × {b['title']}")
    return out


def probe(scenario: str, port: int, width=1600, height=1000) -> dict:
    seeded = dev_server.reset({"model_picker": "inspector_llm", "shell": "template", "tool_options": "inspector_3d",
                               "llm_info": "inspector_llm",
                               "lightbox": "done", "lightbox_inspector": "inspector",
                               "palette": "template", "files": "template", "popout": "template",
                               "popout_fail": "template", "popin": "template",
                               "templates": "template", "generate": "empty", "schedule": "template",
                               "agent_undo": "template"}.get(scenario, scenario))
    query = {"events": "0", "diag_ms": "4500"}
    if seeded.get("flow_id"):
        query["flow"] = seeded["flow_id"]
    if seeded.get("select"):
        query["select"] = seeded["select"]
    if scenario in ("quick", "quick_add"):
        query.update(quick="add" if scenario == "quick_add" else "1", recent="llm.complete,input.text")
    if scenario in ("partial", "fresh", "stop", "shortcut"):
        query["run_action"] = scenario
    if scenario == "shell":
        query["shell"] = "desktop"
    if scenario in ("model_picker", "tool_options"):
        query.update(inspector="1", model_picker="1", shell="desktop")
    if scenario in ("inspector", "inspector_error", "tool_swap"):
        query["inspector"] = "1"
    if scenario == "edit_keys":
        query.update(edit_keys="1", diag_ms="6500")
    if scenario in ("lightbox", "lightbox_inspector"):
        query.update(lightbox="inspector" if scenario.endswith("inspector") else "card", diag_ms="6000", shell="desktop")
        if scenario.endswith("inspector"):
            query["inspector"] = "1"
    if scenario == "palette":
        query.update(palette="check", shell="desktop", diag_ms="6500")
    if scenario in ("popout", "popout_fail"):
        query.update(popout="fail" if scenario.endswith("fail") else "ok", diag_ms="5000")
    if scenario == "popin":
        query.update(popin="1", diag_ms="5500", shell="desktop")
    if scenario == "templates":
        query.update(templates="check", shell="desktop", diag_ms="9000")
    if scenario == "generate":
        query.update(generate="check", shell="desktop", diag_ms="12000")
    if scenario == "llm_info":
        query.update(llm_info="check", inspector="1", diag_ms="6500")
    if scenario == "model_settings":
        query.update(model_settings="check", inspector="1", shell="desktop", diag_ms="9500")
    if scenario == "files":
        picked = dev_server._fake_file("picked.png", dev_server._png((60, 180, 90), (320, 200)))
        query.update(files="check", shell="desktop", diag_ms="9500", pick=picked)
    if scenario == "media_inputs":
        picked = dev_server._fake_file("picked-detail.png", dev_server._png((180, 90, 180), (320, 200)))
        query.update(media_inputs="check", inspector="1", shell="desktop", diag_ms="10000", pick=picked)
    if scenario == "timings":
        query.update(timings="check", inspector="1", shell="desktop", diag_ms="9000")
    if scenario == "logic":
        query.update(logic="check", inspector="1", shell="desktop", diag_ms="7000")
    if scenario == "loop":
        query.update(loop="check", inspector="1", shell="desktop", diag_ms="6500")
    if scenario == "schedule":
        query.update(schedule="check", diag_ms="5500")
    if scenario in ("agent_sync", "agent_sync_dirty"):
        query.update(agent_sync="dirty" if scenario.endswith("dirty") else "clean", diag_ms="5500")
    if scenario == "agent_undo":
        query.update(agent_undo="1", diag_ms="8000")
    if scenario in ("ask", "ask_none"):
        query["ask"] = "1"
        if scenario == "ask_none":
            query["composer"] = "none"
    if scenario == "tool_swap":
        query["select_node"] = seeded.get("select") or ""
    if scenario == "tool_swap":
        query["tool_swap"] = "tool:slow_tool"
    url = f"http://127.0.0.1:{port}/?{urlencode(query)}"
    profile = tempfile.mkdtemp(prefix="fc-probe-")
    cmd = [chrome(), "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
           f"--user-data-dir={profile}", f"--window-size={width},{height}",
           f"--virtual-time-budget={max(7000, int(query.get('diag_ms', 4500)) + 500)}",
           "--dump-dom", url]
    try:
        dom = subprocess.run(cmd, capture_output=True, timeout=90).stdout.decode("utf-8", "replace")
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    m = re.search(r'<pre id="__diag"[^>]*>(.*?)</pre>', dom, re.S)
    if not m:
        return {"scenario": scenario, "errors": ["no diagnostics in DOM (page did not boot?)"], "nodes": []}
    data = json.loads(html.unescape(m.group(1)))
    data["scenario"] = scenario
    data["pick"] = query.get("pick", "")
    data["flow"] = query.get("flow", "")
    data["overlaps"] = overlaps(data.get("nodes") or [])
    return data


# (label, nodes, edges, selected) after each C7 step on the 7-node / 5-edge template flow; None = not checked
EDIT_EXPECT = [
    ("start", 7, 5, None), ("ctrl+a", 7, 5, 7), ("escape", 7, 5, 0), ("node menu", 7, 5, 1), ("copy", 7, 5, 1),
    ("ctrl+v", 8, 5, 1), ("ctrl+d", 9, 5, 1), ("delete", 8, 5, 0), ("undo delete", 9, 5, None),
    ("undo duplicate", 8, 5, None), ("undo paste", 7, 5, 0), ("redo paste", 8, 5, None),
    ("undo paste again", 7, 5, 0), ("cut idea", 6, 4, 0), ("paste here", 7, 4, 1), ("edge menu", 7, 4, 0),
    ("remove connection", 7, 3, 0), ("end", 7, 3, None),
]


def check_edit_steps(steps: list) -> list:
    problems = []
    by_label = {s.get("label"): s for s in steps}
    for label, nodes, edges, selected in EDIT_EXPECT:
        got = by_label.get(label)
        if got is None:
            problems.append(f"edit step missing: {label}")
            continue
        if got.get("error"):
            problems.append(f"{label}: {got['error']}")
        want = {"nodes": nodes, "edges": edges, "selected": selected}
        for k, v in want.items():
            if v is not None and got.get(k) != v:
                problems.append(f"{label}: {k}={got.get(k)} (want {v})")
    menu = (by_label.get("node menu") or {}).get("menu") or []
    for item in ("Run up to here", "Duplicate", "Copy", "Cut", "Delete"):
        if item not in menu:
            problems.append(f"node menu lacks {item!r}: {menu}")
    paste = by_label.get("paste here") or {}
    if "Paste here" not in (paste.get("menu") or []):
        problems.append(f"canvas menu lacks 'Paste here': {paste.get('menu')}")
    click, pasted = paste.get("click"), paste.get("pasted")
    if not click or not pasted or abs(click["x"] - pasted["x"]) > 12 or abs(click["y"] - pasted["y"]) > 12:
        problems.append(f"pasted node not at the click point: click={click} pasted={pasted}")
    for label in ("node menu", "edge menu"):
        if (by_label.get(label) or {}).get("inside") is not True:
            problems.append(f"{label} is not fully inside the canvas")
    edge_menu = (by_label.get("edge menu") or {}).get("menu")
    if edge_menu != ["Remove connection"]:
        problems.append(f"edge menu: {edge_menu}")
    if (by_label.get("edge menu") or {}).get("edgeSelected") != 1:
        problems.append("right-clicked edge is not highlighted")
    return problems


def check_lightbox(steps: list) -> list:
    """G1: done flow = image (Image node) + GLB (3D model node; Result passes the same file on -> listed once)."""
    by = {st.get("label"): st for st in steps}
    problems = []
    opened, nxt, dele, back, closed = (by.get(k) or {} for k in ("open", "next", "delete", "back", "closed"))
    if not opened.get("open"):
        return [f"lightbox did not open: {steps}"]
    if opened.get("count") != "1 / 2" or opened.get("title") != "Image" or not opened.get("imgWidth"):
        problems.append(f"lightbox open: count={opened.get('count')} title={opened.get('title')} img={opened.get('imgWidth')}")
    if opened.get("x") != 0 or opened.get("y") != 0 or opened.get("w") != opened.get("vw") or opened.get("h") != opened.get("vh"):
        problems.append(f"lightbox scrim does not cover the window: {opened}")
    panel = opened.get("panel") or {}
    vw, vh = opened.get("vw") or 0, opened.get("vh") or 0
    if abs((panel.get("w") or 0) - 0.85 * vw) > 2 or abs((panel.get("h") or 0) - 0.85 * vh) > 2 \
            or abs((panel.get("x") or 0) - 0.075 * vw) > 2:
        problems.append(f"preview window is not 85 % of the window and centred: {panel} in {vw}x{vh}")
    if not opened.get("focused"):
        problems.append("lightbox has no keyboard focus")
    for b in ("Copy image", "Copy path", "Show in folder"):
        if b not in (opened.get("buttons") or []):
            problems.append(f"lightbox button missing: {b} in {opened.get('buttons')}")
    if opened.get("thumbs") != 2:
        problems.append(f"lightbox filmstrip: {opened.get('thumbs')} (want 2)")
    if nxt.get("count") != "2 / 2" or nxt.get("title") != "3D model":
        problems.append(f"ArrowRight: {nxt}")
    if nxt.get("model3d") != "ready" or "triangles" not in (nxt.get("model3dText") or ""):
        problems.append(f"3D viewer: state={nxt.get('model3d')} text={nxt.get('model3dText')!r}")
    if dele.get("nodes") != 7 or not dele.get("open"):
        problems.append(f"Delete leaked to the canvas: nodes={dele.get('nodes')} open={dele.get('open')}")
    reveals = (by.get("reveal") or {}).get("reveals") or []
    if len(reveals) != 1 or not reveals[0].endswith(".glb"):
        problems.append(f"Show in folder: {reveals}")
    if back.get("count") != "1 / 2":
        problems.append(f"ArrowLeft: {back.get('count')}")
    if closed.get("open") or not closed.get("rootFocused"):
        problems.append(f"Esc: {closed}")
    return problems


def check_palette(p: dict) -> list:
    """G2 on the dev registry: 3D presets (paired model list -> default-model price), fold-all, tooltips, search."""
    if not p:
        return ["palette probe did not run"]
    problems = []
    lay = p.get("layout") or {}
    search, fold, pal = lay.get("search") or {}, lay.get("fold") or {}, lay.get("palette") or {}
    if not fold or fold["x"] < search.get("x", 0) + search.get("w", 0) - 1 or fold["x"] + fold["w"] > pal.get("x", 0) + pal.get("w", 0) \
            or abs((fold["y"] + fold["h"] / 2) - (search.get("y", 0) + search.get("h", 0) / 2)) > 3:
        problems.append(f"fold button is not right of the search box: search={search} fold={fold} palette={pal}")
    secs = lay.get("sections") or []
    if [s.get("id") for s in secs] != ["ready", "basic", "tools", "mcp"]:
        problems.append(f"palette sections: {[s.get('id') for s in secs]}")
    if any(not (s.get("icon") or "").count("codicon-") or s.get("bg") in (None, "rgba(0, 0, 0, 0)") for s in secs) \
            or len({s.get("color") for s in secs}) < len(secs):
        problems.append(f"section heads need an icon, a tint and distinct colours: {secs}")
    total = p.get("total")
    exp, col = p.get("expanded") or {}, p.get("collapsed") or {}
    if exp.get("mode") != "collapse" or exp.get("items") != total:
        problems.append(f"expand all: {exp} (want {total} items)")
    if col.get("mode") != "expand" or col.get("items") != 0 or "true" in (col.get("heads") or []):
        problems.append(f"collapse all: {col}")
    tip = p.get("tip") or {}
    if not tip:
        problems.append("hovering a palette entry showed no tooltip")
    else:
        if tip.get("rows") != ["in", "out", "typical", "cost"] or "~$0.27 per model" not in tip.get("text", "") \
                or "minutes" not in tip.get("text", "") or tip.get("dots") != 2:
            problems.append(f"tooltip content: rows={tip.get('rows')} dots={tip.get('dots')} text={tip.get('text')!r}")
        b = tip.get("bubble") or {}
        if b.get("x", 0) < (tip.get("entry") or {}).get("x", 0) + (tip.get("entry") or {}).get("w", 0) \
                or b.get("x", 0) + b.get("w", 0) > tip.get("vw", 0) or b.get("y", 0) + b.get("h", 0) > tip.get("vh", 0):
            problems.append(f"tooltip not right of the entry / off screen: {b} entry={tip.get('entry')}")
        if tip.get("title"):
            problems.append(f"palette entry has a native title besides the rich tooltip: {tip.get('title')!r}")
        look = tip.get("look") or {}
        arrow, bub = look.get("arrow") or {}, tip.get("bubble") or {}
        arrow_clipped = look.get("overflow") == "hidden" and (not arrow or arrow.get("x", 0) + arrow.get("w", 0) <= bub.get("x", 0))
        if look.get("bg") != look.get("elevated") or look.get("radius") != "10px" or look.get("padding") != "0px" \
                or not arrow_clipped or not look.get("icon") or look.get("head") in (None, look.get("bg")) \
                or look.get("titleColor") == look.get("bg"):
            problems.append(f"tooltip is not in the Arachne Flow look (elevated card, tinted head, arrow clipped): {look} bubble={bub}")
    if p.get("tipGone") is not True:
        problems.append("tooltip stays after the pointer leaves")
    port = p.get("port") or {}
    if sorted(port.get("items") or []) != ["preset.image_to_3d", "preset.text_to_3d"] or not port.get("active") \
            or port.get("foldDisabled") is not True:
        problems.append(f"search by port type 'model3d': {port}")
    if not {"preset.image_to_3d", "preset.text_to_3d"} <= set((p.get("desc") or {}).get("items") or []):
        problems.append(f"search by description 'polls': {p.get('desc')}")
    if "image" not in ((p.get("image") or {}).get("active") or "").lower():
        problems.append(f"Enter target for 'image' is not a title match: {p.get('image')}")
    cleared = p.get("cleared") or {}
    if cleared.get("items") != total or cleared.get("foldDisabled") is not False:
        problems.append(f"after clearing the search: {cleared} (want {total} items, fold enabled)")
    return problems


def check_model_settings(m: dict, list_calls: list) -> list:
    """G7: model-driven choices with prices, bounded n, cost at node + inspector, one list call per list tool."""
    if not m or not m.get("start"):
        return ["model settings probe did not run"]
    problems = []
    st = m["start"]
    want_sizes = ["tool default", "1k · $0.02", "1.5k · $0.03", "2k · $0.04", "3k · $0.08", "4k · $0.12"]
    if st.get("sizeChoices") != "model" or st.get("sizeOptions") != want_sizes or st.get("sizeValue") != "4k":
        problems.append(f"size select: {st.get('sizeChoices')} {st.get('sizeOptions')} value={st.get('sizeValue')}")
    if st.get("nRange") != "1–4 · whole numbers" or "Outside the allowed range" not in (st.get("nBad") or ""):
        problems.append(f"n field: range={st.get('nRange')!r} bad={st.get('nBad')!r}")
    if st.get("resolution") is not None or st.get("aspect") != "model":  # undescribed -> folded under More settings
        problems.append(f"p-h3-image lists aspect ratios, no resolution: {st.get('resolution')} {st.get('aspect')}")
    if st.get("cost") != "≈ $0.72" or (st.get("chips") or {}).get("NanoGPT image") != "≈ $0.72" \
            or (st.get("chips") or {}).get("Video") != "≈ $0.24" or (st.get("chips") or {}).get("Idea"):
        problems.append(f"start cost: inspector={st.get('cost')} chips={st.get('chips')}")
    if (m.get("afterN") or {}).get("cost") != "≈ $0.24" or (m.get("afterN") or {}).get("nBad"):
        problems.append(f"after n=2: {m.get('afterN')}")
    after = m.get("afterSize") or {}
    if after.get("cost") != "≈ $0.04" or (after.get("chips") or {}).get("NanoGPT image") != "≈ $0.04":
        problems.append(f"after size=1k: {after}")
    v = m.get("video") or {}
    if (v.get("durationOptions") or [])[:3] != ["default (6)", "6 seconds", "8 seconds"] or v.get("cost") != "≈ $0.24":
        problems.append(f"video duration/cost: {v}")
    if (v.get("after") or {}).get("cost") != "≈ $0.40" or ((v.get("after") or {}).get("chips") or {}).get("Video") != "≈ $0.40":
        problems.append(f"video after duration=10: {v.get('after')}")
    pills = m.get("pills") or []
    if len(pills) != 3 or len({(p["font"], p["color"]) for p in pills}) != 1:
        problems.append(f"cost pills differ or are missing: {pills}")
    for p in pills:  # pixel check: inside the header, right of the title, not clipped
        pb, nb, hb = p["pill"], p["name"], p["head"]
        if p["clipped"] or pb["l"] < nb["r"] - 0.5 or pb["t"] < hb["t"] or pb["b"] > hb["b"] or pb["r"] > hb["r"]:
            problems.append(f"cost pill misplaced on {p['title']}: {p}")
    if sorted(set(list_calls)) != sorted(list_calls) or len(list_calls) > 2:
        problems.append(f"model lists called more than once each: {list_calls}")
    if (v.get("extras") or []) != ["generateAudio"]:  # LTX lists one setting beyond the preset's own
        problems.append(f"video model settings: {v.get('extras')}")
    mesh = m.get("meshy") or {}
    want = ["animation_action_id", "enable_animation", "enable_pbr", "enable_rigging", "geometry_resolution", "pose_mode",
            "rigging_height_meters", "should_remesh", "should_texture", "symmetry_mode", "target_polycount",
            "texture_image", "texture_prompt", "topology"]
    if mesh.get("count") != "14" or mesh.get("fields") != want or "Meshy 7.1 Multi-Image to 3D" not in (mesh.get("head") or ""):
        problems.append(f"Meshy model settings: count={mesh.get('count')} head={mesh.get('head')!r} fields={mesh.get('fields')}")
    if mesh.get("geometry") != ["default (standard)", "Standard", "2K (+$0.24)"] or mesh.get("pbr") != "default (off)" \
            or mesh.get("polyRange") != "100–300000 · steps of 1000" or mesh.get("textInputs") != 1:
        problems.append(f"Meshy controls: {mesh}")
    if mesh.get("overflow") is None or mesh.get("overflow") or mesh.get("headCut"):
        problems.append(f"Meshy settings overflow the inspector: {mesh.get('overflow')} headCut={mesh.get('headCut')}")
    if mesh.get("cost") != "≈ $1.44" or (mesh.get("after") or {}).get("geometry") != "2k":
        problems.append(f"Meshy cost/selection: cost={mesh.get('cost')} after={mesh.get('after')}")
    if (st.get("chips") or {}).get("3D") != "≈ $1.44":
        problems.append(f"3D node cost pill: {st.get('chips')}")
    return problems


def check_generate(g: dict) -> list:
    """G6: grouped configured models, current default, one repair, undo and preserved failure input."""
    if not g:
        return ["generate probe did not run"]
    problems = []
    if "Current · deepseek/deepseek-v4.1-flash-1017:thinking" not in (g.get("current") or ""):
        problems.append(f"current model is not the default label: {g.get('current')!r}")
    if g.get("groups") != ["custom", "anthropic"] or g.get("models") != 6:
        problems.append(f"provider groups/models: groups={g.get('groups')} models={g.get('models')}")
    created = g.get("created") or {}
    request = created.get("request") or {}
    if created.get("title") != "Generated text preview" or created.get("nodes") != 2 or created.get("edges") != 1 \
            or "repaired once" not in (created.get("notice") or ""):
        problems.append(f"repaired new flow: {created}")
    if "model" in request or "provider" in request or "flow_id" in request:
        problems.append(f"default generation unexpectedly overrides model/provider/flow: {request}")
    updated = g.get("updated") or {}
    picked = updated.get("request") or {}
    if updated.get("nodes") != 3 or "Note" not in (updated.get("titles") or []) \
            or picked.get("model") != "z-ai/glm-5.3-flash" or picked.get("provider") != "custom" \
            or picked.get("base_revision") != 1:
        problems.append(f"existing flow / selected model: {updated}")
    if (g.get("undo") or {}).get("nodes") != 2:
        problems.append(f"generated edit is not undoable: {g.get('undo')}")
    failure = g.get("failure") or {}
    if not failure.get("open") or failure.get("prompt") != "fail" or "after one repair" not in (failure.get("error") or "") \
            or failure.get("busy"):
        problems.append(f"failure did not preserve the draft / finish busy state: {failure}")
    blank = g.get("blank") or {}
    if not blank.get("ready") or not blank.get("hitTest") or blank.get("prompt") != "Draft on the blank canvas" \
            or blank.get("pointerPrevented") or blank.get("quickSearch") or blank.get("contextMenu"):
        problems.append(f"blank-canvas composer swallows canvas gestures / cannot edit: {blank}")
    calls = (g.get("serverCalls") or {}).get("calls") or []
    if len(calls) != 5 or any(c.get("purpose") != "flowcanvas generate" for c in calls) \
            or "model" in calls[0] or "provider" in calls[0] \
            or calls[2].get("model") != "z-ai/glm-5.3-flash" or calls[2].get("provider") != "custom":
        problems.append(f"fake LLM calls (new repair, selected existing, two failures): {calls}")
    return problems


def check_templates(t: dict) -> list:
    """G5: Save as template… → Your templates → edit → new flow from it (inputs cleared) → delete."""
    if not t:
        return ["templates probe did not run"]
    problems = []
    d = t.get("dialog") or {}
    if not t.get("saveItem") or not d.get("open") or not d.get("menuClosed") or d.get("name") != "Prompt to 3D" \
            or not d.get("focused") or not d.get("clearEnabled") or "Idea" not in (d.get("clearLabel") or "") \
            or not d.get("nodesAfterDelete"):
        problems.append(f"save dialog: {t.get('saveItem')} {d}")
    s = t.get("saved") or {}
    if not s.get("closed") or "My 3D pipeline" not in (s.get("notice") or ""):
        problems.append(f"after saving: {s}")
    m = t.get("menuAfterSave") or {}
    if m.get("labels") != ["Your flows", "Your templates", "Built-in templates"] or \
            [o.get("text") for o in m.get("own") or []] != ["My 3D pipeline"] or t.get("id") != "u-my-3d-pipeline":
        problems.append(f"menu after save: {m}")
    e = t.get("edit") or {}
    if not e.get("open") or e.get("name") != "My 3D pipeline" or e.get("desc") != "Idea to image to 3D, my settings." \
            or not e.get("noClear"):
        problems.append(f"edit dialog: {e}")
    if [o.get("text") for o in (t.get("menuAfterEdit") or {}).get("own") or []] != ["My 3D pipeline v2"]:
        problems.append(f"menu after edit: {t.get('menuAfterEdit')}")
    c = t.get("created") or {}
    if c.get("title") != "My 3D pipeline v2" or c.get("nodes") != 7 or "a small wooden toy robot" in (c.get("ideaText") or ""):
        problems.append(f"flow from your template (inputs cleared): {c}")
    if t.get("armed") != "Click the trash again to delete" or (t.get("menuAfterDelete") or {}).get("own") \
            or "Your templates" in ((t.get("menuAfterDelete") or {}).get("labels") or []):
        problems.append(f"delete: armed={t.get('armed')!r} after={t.get('menuAfterDelete')}")
    folder = os.path.join(dev_server.DATA, "templates")
    left = sorted(n for n in os.listdir(folder) if n.endswith(".json")) if os.path.isdir(folder) else []
    trashed = os.listdir(os.path.join(folder, ".trash")) if os.path.isdir(os.path.join(folder, ".trash")) else []
    if left or len(trashed) != 1:
        problems.append(f"templates folder: left={left} trash={trashed}")
    return problems


def check_files(f: dict, query_pick: str = "") -> list:
    """G3: drop png+txt+exe -> two File nodes with previews (exe refused), Browse… via ctx.os, Add another file."""
    if not f:
        return ["files probe did not run"]
    problems = []
    if (f.get("over") or {}) != {"cls": True, "hint": True}:
        problems.append(f"dragging files over the canvas shows no drop highlight/hint: {f.get('over')}")
    d = f.get("dropped") or {}
    red, txt = d.get("red") or {}, d.get("txt") or {}
    if d.get("nodes") != 9 or red.get("kind") != "image" or not red.get("img") or txt.get("kind") != "file" \
            or "notes.txt" not in (txt.get("text") or ""):
        problems.append(f"dropped files did not become File nodes with previews: {d}")
    if "tool.exe" not in (d.get("notice") or "") or d.get("overAfter") or d.get("busyAfter") or d.get("selected") != 2:
        problems.append(f"after the drop: notice/highlight/selection wrong: {d}")
    up = os.path.join(dev_server.DATA, "uploads")
    stored = sorted(os.path.relpath(os.path.join(d, n), up).replace("\\", "/").split("/", 1)[1]
                    for d, _, names in os.walk(up) for n in names) if os.path.isdir(up) else []
    if stored != ["drop-red.png", "notes.txt"]:
        problems.append(f"uploads folder holds {stored}, want ['drop-red.png', 'notes.txt'] in hash folders")
    ins = f.get("inspector") or {}
    if not ins.get("browse") or not ins.get("addFile"):
        problems.append(f"File node inspector lacks Browse… / Add another file: {ins}")
    b = f.get("browsed") or {}
    picks = b.get("picks") or []
    if not query_pick or b.get("value") != query_pick:
        problems.append(f"Browse… did not set the path: {b.get('value')!r} (want {query_pick!r})")
    if not picks or picks[0].get("filters", [None])[0] != "Media and documents" or picks[0].get("filters", [None])[-1] != "All files":
        problems.append(f"pickOpenPath filters: {picks}")
    a = f.get("added") or {}
    if a.get("nodes") != 10 or (a.get("picked") or {}).get("kind") != "image" or not (a.get("picked") or {}).get("img") \
            or not a.get("redChanged") or a.get("pickedBelowRed") is not True:
        problems.append(f"Browse…/Add another file result: {a}")
    return problems


def wait_for_finished_run(flow_id: str, timeout: float = 12) -> dict:
    """Real-time join for fake jobs; Chrome virtual time must not outrun their real sleep (G8)."""
    env = dev_server._env()
    engine = dev_server._engine()
    deadline = time.monotonic() + timeout
    latest = {}
    while time.monotonic() < deadline:
        runs = engine.store.list_runs(env, flow_id, limit=1)
        if runs:
            latest = engine.store.load_run(env, runs[0]["id"])
            if latest.get("status") in ("done", "error", "cancelled"):
                return latest
        time.sleep(0.2)
    return latest


def check_media_inputs(m: dict, query_pick: str, calls: list, run_record: dict) -> list:
    """G8: two wires + one Browse… file reach the 3D tool as one images array."""
    if not m:
        return ["media-input probe did not run"]
    problems = []
    initial = m.get("initial") or {}
    if initial.get("count") != "0" or not initial.get("browse") or "Front" not in (initial.get("wired") or "") \
            or "Side" not in (initial.get("wired") or ""):
        problems.append(f"initial media list/two wires: {initial}")
    browsed = m.get("afterBrowse") or {}
    if browsed.get("count") != "1" or browsed.get("value") != query_pick:
        problems.append(f"Browse… did not append the picked image: {browsed}")
    picks = browsed.get("picks") or []
    if not picks or picks[0].get("filters", [None])[0] != "Images":
        problems.append(f"media Browse… is not image-filtered: {picks}")
    run = m.get("run") or {}
    if run.get("error"):
        problems.append(f"multi-image run showed a node error: {run}")
    target = run_record.get("target_node")
    target_state = (run_record.get("nodes") or {}).get(target) or {}
    if run_record.get("status") != "done" or target_state.get("status") != "done" or not target_state.get("outputs"):
        problems.append(f"multi-image run did not finish with an output: {dev_server._engine().store.summarize_run(run_record) if run_record else run_record}")
    images = calls[-1].get("images") if calls else None
    if not isinstance(images, list) or len(images) != 3 or not all(str(v).startswith("data:image/") for v in images):
        problems.append(f"fake 3D tool did not receive 3 inline images: {calls[-1] if calls else None}")
    if m.get("afterRemove") != "0":
        problems.append(f"removing the direct image failed: {m.get('afterRemove')}")
    return problems


def check_popout(scenario: str, p: dict, flow_id: str) -> list:
    """G4: the header button calls openWindow once and leaves a fresh hand-off; the new window takes it."""
    if not p:
        return ["popout probe did not run"]
    problems = []
    if p.get("nodes") != 7:
        problems.append(f"{scenario}: flow not shown ({p.get('nodes')} nodes)")
    if scenario == "popin":
        if p.get("button"):
            problems.append("popin: 'Open in new window' shows without the Desktop bridge")
        if p.get("handoffBefore") is not None or (p.get("navigated") or [None])[0] != "/flowcanvas" \
                or p.get("flowName") != "Prompt to 3D":
            problems.append(f"popin: hand-off not taken once / wrong flow: {p}")
        f, a = p.get("focus") or {}, p.get("after") or {}
        root = f.get("root") or {}
        if f.get("flag") != "1" or root != {"x": 0, "y": 0, "w": f.get("vw"), "h": f.get("vh")} or f.get("session") != "1":
            problems.append(f"popin: page does not cover the whole window as an Arachne Flow window: {f}")
        if f.get("padRight") != "150px" or f.get("drag") != "drag" or f.get("runDrag") != "no-drag" \
                or (f.get("runRight") or 0) > (f.get("vw") or 0) - 138 or not f.get("unfocus"):
            problems.append(f"popin: header not a drag area clear of the window buttons: {f}")
        if a.get("flag") is not None or a.get("session") is not None or (a.get("root") or {}).get("y", 0) < 6:
            problems.append(f"popin: 'Show Hermes' did not return to the normal page: {a}")
        return problems
    if not p.get("button") or p.get("calls") != [None]:
        problems.append(f"{scenario}: button/openWindow call: button={p.get('button')} calls={p.get('calls')}")
    notice = p.get("notice") or ""
    if scenario == "popout":
        h = p.get("handoff") or {}
        if not isinstance(h, dict) or h.get("flowId") != flow_id or not (0 <= (p.get("fresh") or -1) < 5000):
            problems.append(f"popout: hand-off {h!r} (want flowId={flow_id}, fresh)")
        if "new window" not in notice:
            problems.append(f"popout: notice {notice!r}")
    else:
        if p.get("handoff") not in (None, "missing"):
            problems.append(f"popout_fail: hand-off not cleared: {p.get('handoff')!r}")
        if "no window today" not in notice:
            problems.append(f"popout_fail: notice {notice!r}")
    return problems


def check_loop(g: dict) -> list:
    """G11: the body ran per item (bob filtered by If), Collect kept item order, badges/icons/tips say so."""
    if not g:
        return ["loop probe did not run"]
    problems = []
    b = g.get("badges") or {}
    if not b.get("Greeting", "").startswith("3× · ") or not b.get("Not Bob", "").startswith("3× · "):
        problems.append(f"loop body badges should count items: {b}")
    if g.get("loopIcons") != ["Greeting", "Not Bob"]:
        problems.append(f"loop icons on {g.get('loopIcons')} (want Greeting, Not Bob)")
    res = g.get("result") or ""
    if "Hi anna" not in res or "Hi cleo" not in res or "bob" in res or res.find("anna") > res.find("cleo"):
        problems.append(f"collected list: {res!r}")
    gt = g.get("greetTip") or []
    if not gt or gt[0] != "3 items: 2 done · 1 skipped" or not any(line.endswith("in total") for line in gt):
        problems.append(f"body status tip: {gt}")
    if "Ran 3 items" not in (g.get("eachTip") or []):
        problems.append(f"For each tip: {g.get('eachTip')}")
    if not (g.get("loopTip") or [""])[0].startswith("Repeats for every item of “Each name”"):
        problems.append(f"loop icon tip: {g.get('loopTip')}")
    insp = g.get("inspector") or ""
    if "Hi anna" not in insp or "skipped: Not Bob took “False”, not “True”" not in insp or "null" in insp \
            or g.get("iterRows") != ["value", "skipped", "value"]:
        problems.append(f"inspector per-item rows: rows={g.get('iterRows')} text={insp[-300:]!r}")
    if not g.get("palette"):
        problems.append("palette lacks For each / Collect")
    return problems


def check_logic(g: dict) -> list:
    """G10: If took False, its True branch is skipped (not failed), Merge passes the live value, Switch case2."""
    if not g:
        return ["logic probe did not run"]
    problems = []
    want = {"Answer": "done", "Is yes?": "done", "Yes text": "skipped", "No text": "done", "Either": "done",
            "Reply": "done", "Colour": "done", "Which colour": "done", "Red": "skipped", "Green": "done", "Other": "skipped"}
    if g.get("status") != want:
        problems.append(f"node statuses: {g.get('status')}")
    if "Sorry: no" not in (g.get("reply") or ""):
        problems.append(f"merge did not pass the False branch on: reply={g.get('reply')!r}")
    if g.get("ifPorts") != {"true": "untaken", "false": "taken"}:
        problems.append(f"If ports: {g.get('ifPorts')}")
    if g.get("switchPorts") != {"case1": "untaken", "case2": "taken", "default": "untaken"} \
            or g.get("switchLabels") != ["red", "green", "Default"]:
        problems.append(f"Switch ports: {g.get('switchPorts')} labels={g.get('switchLabels')}")
    # dead: if.true->yes, yes->merge, sw.case1->red, sw.default->other
    if g.get("deadEdges") != 4 or g.get("edges") != 10:
        problems.append(f"faded wires: {g.get('deadEdges')} of {g.get('edges')} (want 4 of 10)")
    if (g.get("skipTip") or [None])[0] != "Not on the branch this run took." \
            or "Is yes? took “False”, not “True”" not in (g.get("skipTip") or []):
        problems.append(f"skipped-branch tip: {g.get('skipTip')}")
    if "Took the “False” output" not in (g.get("ifTip") or []):
        problems.append(f"If status tip: {g.get('ifTip')}")
    if "Not taken in this run: the steps after it were skipped" not in (g.get("untakenTip") or []):
        problems.append(f"untaken port tip: {g.get('untakenTip')}")
    if any(bad for _msg, bad in g.get("logMsgs") or []) or g.get("runChip") != "done":
        problems.append(f"run log marks skipped branches as errors: chip={g.get('runChip')} msgs={g.get('logMsgs')}")
    if g.get("afterAdd") != ["case1", "case2", "case3", "default"] or g.get("afterRemove") != ["case1", "default"] \
            or g.get("edgesAfterRemove") != 9:
        problems.append(f"Switch case edit: add={g.get('afterAdd')} remove={g.get('afterRemove')} edges={g.get('edgesAfterRemove')}")
    if not g.get("paletteHasLogic"):
        problems.append("palette lacks If/Switch/Merge")
    return problems


def check_timings(t: dict) -> list:
    """G9: live clock ticks, measured average (11/12/13 s seeds), rich tips everywhere, no native titles beside them."""
    if not t:
        return ["timings probe did not run"]
    problems = []
    clock = re.compile(r"^(\d+ s|\d+:\d\d)$")
    c1, c2 = t.get("clock1") or "", t.get("clock2") or ""
    if not clock.match(c1) or not clock.match(c2) or c1 == c2:
        problems.append(f"live clock on the running node did not tick: {c1!r} -> {c2!r}")
    if "/ ~12 s" not in (t.get("badgeText") or ""):
        problems.append(f"running badge lacks the measured average: {t.get('badgeText')!r}")
    st = t.get("status") or {}
    lines = st.get("lines") or []
    if st.get("title") != "Running" or not lines or not lines[0].startswith("Running for ") \
            or "Usually ~12 s (your last 3 runs)" not in lines:
        problems.append(f"running status tip: {st}")
    er = t.get("error") or {}
    if er.get("title") != "Error" or not any("always fails" in line for line in er.get("lines") or []) \
            or "inspector" not in (er.get("foot") or ""):
        problems.append(f"error tip: {er}")
    port = t.get("port") or {}
    if port.get("title") != "Text" or port.get("kind") or port.get("lines") != ["Optional", "1 wire connected"]:
        problems.append(f"input port tip: {port}")
    if (t.get("portOut") or {}).get("lines") != ["Drag from here to an input to connect"]:
        problems.append(f"output port tip: {t.get('portOut')}")
    for key in ("statusTitle", "errorTitle", "portTitle"):
        if t.get(key) is not None:
            problems.append(f"{key}: native title next to the rich tip: {t.get(key)!r}")
    hd = t.get("header") or {}
    want = {"flows", "palette", "inspector", "undo", "redo", "tidy", "generate", "ask", "stop", "run"}
    if not want <= set(hd.get("ids") or []) or hd.get("unwrapped") or hd.get("titled"):
        problems.append(f"header buttons without rich tips: {hd}")
    if hd.get("disabledPointer") != "none":
        problems.append(f"disabled header button swallows the tooltip hover: pointer-events={hd.get('disabledPointer')}")
    if (t.get("stopTip") or {}).get("title") != "Stop":
        problems.append(f"stop tip: {t.get('stopTip')}")
    undo = t.get("undoTip") or {}
    if not t.get("undoDisabled") or undo.get("title") != "Undo" or undo.get("keys") != ["Ctrl", "Z"]:
        problems.append(f"disabled undo tip: disabled={t.get('undoDisabled')} tip={undo}")
    if not clock.match((t.get("runClock") or "").replace(" · ", "").strip()):
        problems.append(f"run chip clock: {t.get('runClock')!r}")
    run = t.get("run") or {}
    if run.get("title") != "Running" or not (run.get("lines") or [""])[0].startswith("Running for ") \
            or "1 of 3 steps finished" not in (run.get("lines") or []):
        problems.append(f"run chip tip: {run}")
    timing = t.get("timing") or []
    if len(timing) < 2 or not timing[0].startswith("Running for ") or "Your last 3 runs: ~12 s (11 s – 13 s)" not in timing:
        problems.append(f"inspector timing: {timing}")
    if "your last 3 runs: ~12 s" not in (t.get("palette") or ""):
        problems.append(f"palette Takes row lacks the measured runs: {t.get('palette')!r}")
    return problems


def main() -> int:
    wanted = sys.argv[1:] or list(SCENARIOS)
    port = free_port()
    dev_server.serve(port, block=False)
    bad = False
    for s in wanted:
        d = probe(s, port)
        problems = (d.get("errors") or []) + [f"overlap: {o}" for o in d.get("overlaps") or []]
        if s in ("shell", "model_picker"):
            if d.get("pageOverflow") not in (0, None) or d.get("logVisible") is not True:
                problems.append(f"page scrolls in the Desktop shell: overflow={d.get('pageOverflow')} "
                                f"logVisible={d.get('logVisible')}")
        if s == "model_picker":
            mp = d.get("modelPicker") or {}
            heads = [h.lower() for h in mp.get("groups") or []]
            if not heads or not heads[0].startswith("nanogpt") or not any(h.startswith("anthropic") for h in heads):
                problems.append(f"model picker groups: {mp.get('groups')}")
            if any(h.startswith(("mixture", "nous")) for h in heads):
                problems.append(f"model picker shows MoA/unavailable providers: {mp.get('groups')}")
            if mp.get("items") != 7:  # Hermes default + 4 NanoGPT + 2 Anthropic in the dev stub
                problems.append(f"model picker items: {mp.get('items')} (want 7)")
            fields = (d.get("inspector") or {}).get("fields") or []
            if "Provider" in fields:
                problems.append("hidden provider param is shown in the inspector")
        if s == "tool_options":
            mp = d.get("modelPicker") or {}
            want = ["Tool default", 'Meshy 7.1 Multi-Image to 3D', "Tripo P1", "Hunyuan 3D v3.1 Rapid"]  # groups A-Z; rig: mesh only
            if mp.get("error") or mp.get("labels") != want:
                problems.append(f"tool model picker: labels={mp.get('labels')} error={mp.get('error')}")
        if s == "quick":
            quick = d.get("quick")
            if not quick:
                problems.append("double-click did not open quick search")
            else:
                if not quick.get("focused"):
                    problems.append("quick search input is not focused")
                if quick.get("recent") != ["llm.complete", "input.text"]:
                    problems.append(f"quick search recents: {quick.get('recent')}")
                canvas = d.get("canvas")
                footer = quick.get("footer")
                if canvas and footer and footer["y"] + footer["h"] > canvas["y"] + canvas["h"] + 1:
                    problems.append(f"quick search footer clipped: footer={footer}, canvas={canvas}")
            if d.get("paletteRecent") != ["llm.complete", "input.text"]:
                problems.append(f"palette recents: {d.get('paletteRecent')}")
        if s == "quick_add":
            if d.get("quick"):
                problems.append("quick search stayed open after Enter")
            if len(d.get("nodes") or []) != 8 or not any(n.get("title") == "Text" for n in d.get("nodes") or []):
                problems.append("Enter did not add the selected Text node")
            if d.get("paletteRecent") != ["input.text", "llm.complete"]:
                problems.append(f"recents after add: {d.get('paletteRecent')}")
        if s == "running" and d.get("runFetches", 0) < 2:
            problems.append(f"polling fallback did not refresh the active run: {d.get('runFetches')}")
        if s == "timings":
            problems += check_timings(d.get("timings"))
        if s == "logic":
            problems += check_logic(d.get("logic"))
        if s == "loop":
            problems += check_loop(d.get("loop"))
        if s == "schedule":
            sc = d.get("schedule") or {}
            if not sc.get("menuItem") or not sc.get("dialog"):
                problems.append(f"no Schedule with Hermes entry/dialog: {sc}")
            if not sc.get("emptyError") or not sc.get("emptyDisabled"):
                problems.append(f"empty schedule was not refused: {sc}")
            draft = sc.get("draft") or ""
            if "every weekday at 8am" not in draft or "fresh=true" not in draft or "flow_run(flow=" not in draft or "flow_id" in draft:
                problems.append(f"cron draft: {draft!r}")
            if not sc.get("closed") or "composer" not in (sc.get("notice") or ""):
                problems.append(f"after submit: closed={sc.get('closed')} notice={sc.get('notice')!r}")
        if s == "done":
            if "Done" not in (d.get("runChip") or ""):
                problems.append(f"last run was not loaded on open: {d.get('runChip')}")
            if len(d.get("logRows") or []) != 6:
                problems.append(f"run log rows: {len(d.get('logRows') or [])}")
            if d.get("images", 0) < 1:
                problems.append("finished image thumbnail is missing")
        if s == "partial":
            target = next((n["id"] for n in d.get("nodes") or [] if n.get("title") == "Idea"), None)
            requests = d.get("runRequests") or []
            if not requests or requests[0].get("target_node") != target:
                problems.append(f"partial run target: {requests}")
            if not d.get("runChip") or len(d.get("logRows") or []) != 1:
                problems.append(f"partial run log: {d.get('runChip')}, rows={d.get('logRows')}")
        if s == "fresh":
            requests = d.get("runRequests") or []
            if not requests or requests[0].get("fresh") is not True:
                problems.append(f"Fresh did not bypass cache: {requests}")
        if s == "shortcut":
            requests = d.get("runRequests") or []
            if len(requests) != 1 or requests[0].get("fresh") is not False:
                problems.append(f"Ctrl+Enter run request: {requests}")
        if s == "stop":
            if len(d.get("cancelRequests") or []) != 1:
                problems.append(f"Stop did not cancel: {d.get('cancelRequests')}")
            if "Stopped" not in (d.get("runChip") or ""):
                problems.append(f"cancelled state missing: {d.get('runChip')}")
        insp = d.get("inspector") or {}
        fits = [(insp.get("tool") or "", insp.get("toolFit") or {})]
        if s == "model_settings":  # the long MCP name is in the inspector before the probe selects the preset
            fits.append(("tool:mcp__nanogpt__nanogpt_image_generate",
                         ((d.get("modelSettings") or {}).get("start") or {}).get("toolFit") or {}))
            if fits[-1][1].get("text") != "Image generate":
                problems.append(f"model_settings tool label: {fits[-1][1]}")
        for tool_type, fit in fits:
            if fit and fit.get("textW", 0) > fit.get("room", 0):  # Vision finding G7: raw MCP names clipped the select
                problems.append(f"tool picker label clipped: {fit}")
            if fit and tool_type.startswith("tool:") and tool_type[5:] not in fit.get("hover", ""):
                problems.append(f"tool picker tooltip lacks the raw tool name: {fit}")
        if s in ("inspector", "inspector_error", "tool_swap"):
            if not insp:
                problems.append("inspector did not open for the selected node")
            elif insp.get("scrollW", 0) > insp.get("clientW", 0) + 1:
                problems.append(f"inspector scrolls horizontally: {insp.get('scrollW')} > {insp.get('clientW')}")
            if insp and not insp.get("deleteBtn"):
                problems.append("inspector has no 'Delete node' button")
            if insp and insp.get("scrollH", 0) > insp.get("clientH", 0) + 1 and insp.get("overflowY") not in ("auto", "scroll"):
                problems.append(f"inspector content clipped: {insp.get('scrollH')} > {insp.get('clientH')}, overflow {insp.get('overflowY')}")
        if s == "inspector" and insp:
            if insp.get("tool") != "tool:image_generate" or insp.get("toolOptions", 0) < 5:
                problems.append(f"tool picker: {insp.get('tool')} ({insp.get('toolOptions')} options)")
            if insp.get("images", 0) < 1 or not insp.get("chips"):
                problems.append(f"inspector media: images={insp.get('images')} chips={insp.get('chips')}")
            for heading in ("Settings", "Run", "Last result"):
                if heading not in (insp.get("sections") or []):
                    problems.append(f"inspector section missing: {heading} in {insp.get('sections')}")
        if s == "inspector_error" and insp:
            if "always fails" not in (insp.get("error") or "") or not insp.get("errorCopy"):
                problems.append(f"inspector error: {insp.get('error')!r}, copy={insp.get('errorCopy')}")
            if insp.get("title") != "Broken step":
                problems.append(f"inspector title: {insp.get('title')!r}")
        if s == "tool_swap" and insp:
            before = d.get("toolBefore") or {}
            if before.get("tool") != "tool:vision_analyze":
                problems.append(f"swap start: {before}")
            if insp.get("tool") != "tool:slow_tool":
                problems.append(f"tool after swap: {insp.get('tool')}")
            if d.get("edges") != before.get("edges", 0) - 1:
                problems.append(f"incompatible wire not dropped: {before.get('edges')} -> {d.get('edges')}")
            if "Seconds" not in (insp.get("fields") or []) or "Question" in (insp.get("fields") or []):
                problems.append(f"fields after swap: {insp.get('fields')}")
        sync = d.get("sync") or {}
        if s in ("agent_sync", "agent_sync_dirty") and not d.get("agentListeners"):
            problems.append("page has no flow.changed listener")
        if s == "agent_sync":
            if d.get("agentEdit") != 200 or sync.get("nodes") != 8 or "From Hermes" not in (sync.get("titles") or []):
                problems.append(f"clean page did not reload the agent edit: status={d.get('agentEdit')} sync={sync}")
            if "Hermes updated this flow" not in (sync.get("notice") or ""):
                problems.append(f"agent edit notice: {sync.get('notice')!r}")
            if sync.get("banner"):
                problems.append(f"unexpected conflict banner: {sync.get('banner')!r}")
        if s == "agent_undo":
            undo = d.get("undo") or {}
            if d.get("agentEdit") != 200:
                problems.append(f"agent edit failed: {d.get('agentEdit')}")
            if undo.get("before") != 7 or undo.get("afterSync") != 8 or "From Hermes" not in (undo.get("titles") or []):
                problems.append(f"agent edit did not land on the saved local edit: {undo}")
            if "undo history cleared" not in (undo.get("notice") or ""):
                problems.append(f"no cleared-history notice: {undo.get('notice')!r}")
            if undo.get("afterUndo") != 8 or "From Hermes" not in (undo.get("titlesAfterUndo") or []):
                problems.append(f"Ctrl+Z reverted Hermes' change (U-15): {undo}")
        if s == "agent_sync_dirty":
            if d.get("agentEdit") != 200:
                problems.append(f"agent edit failed: {d.get('agentEdit')}")
            if not sync.get("banner"):
                problems.append(f"unsaved local edit + agent edit showed no conflict banner: {sync}")
            if sync.get("nodes") != 6 or "From Hermes" in (sync.get("titles") or []):
                problems.append(f"local unsaved edit was overwritten (want 6 local nodes): {sync}")
        ask = d.get("ask") or {}
        if s == "ask":
            if ask.get("calls") != ["dev-session"] or "(id f_" not in (ask.get("draft") or ""):
                problems.append(f"Discuss in chat draft: {ask}")
            if "waiting in your chat composer" not in (ask.get("notice") or ""):
                problems.append(f"Discuss in chat notice: {ask.get('notice')!r}")
        if s == "ask_none":
            if ask.get("calls") != ["dev-session", None] or ask.get("draft"):
                problems.append(f"no-composer fallback order: {ask}")
            if "(id f_" not in (ask.get("clipboard") or "") or "copied" not in (ask.get("notice") or ""):
                problems.append(f"no-composer clipboard fallback: {ask}")
        if s in ("lightbox", "lightbox_inspector"):
            problems += check_lightbox(d.get("lightbox") or [])
        if s == "palette":
            problems += check_palette(d.get("palette") or {})
        if s in ("popout", "popout_fail", "popin"):
            problems += check_popout(s, d.get("popout") or {}, d.get("flow") or "")
        if s == "templates":
            problems += check_templates(d.get("templates") or {})
        if s == "generate":
            problems += check_generate(d.get("generate") or {})
        if s == "model_settings":
            problems += check_model_settings(d.get("modelSettings") or {}, list(dev_server.LIST_CALLS))
        if s == "llm_info":
            li = d.get("llmInfo") or {}
            rows = " | ".join(li.get("rows") or [])
            if not li.get("model"):
                problems.append("LLM node shows no model info block")
            for want in ("ProviderNanoGPT", "Price$0.1 in / $0.6 out per Mtok", "Context window1.05M tokens",
                         "Max output393.2k tokens", "Reasoningnone · low · high · max"):
                if want not in rows:
                    problems.append(f"LLM info row missing: {want} in {li.get('rows')}")
            if li.get("pill") != "out $0.60/M" or li.get("maxHint") != "1–393216 · whole numbers":
                problems.append(f"LLM pill/max_tokens: pill={li.get('pill')} hint={li.get('maxHint')}")
            if li.get("pickerPrice") != "in $0.10 / out $0.30":
                problems.append(f"picker price: {li.get('pickerPrice')}")
        if s == "files":
            problems += check_files(d.get("files") or {}, d.get("pick") or "")
        if s == "media_inputs":
            run_record = wait_for_finished_run(d.get("flow") or "")
            problems += check_media_inputs(d.get("mediaInputs") or {}, d.get("pick") or "", list(dev_server.MEDIA_CALLS), run_record)
        if s == "edit_keys":
            edit_problems = check_edit_steps(d.get("editSteps") or [])
            problems += edit_problems
            for step in (d.get("editSteps") or []) if edit_problems else []:
                print("   step", {k: step.get(k) for k in ("label", "nodes", "edges", "selected", "edgeSelected")})
        bad = bad or bool(problems)
        print(f"[{s}] nodes={len(d.get('nodes') or [])} edges={d.get('edges')} images={d.get('images')} "
              f"badges={d.get('badges')} root={d.get('root')}")
        if insp:
            print(f"   inspector: scroll {insp.get('scrollH')}/{insp.get('clientH')} px ({insp.get('overflowY')}), "
                  f"delete={insp.get('deleteBtn')}, sections={insp.get('sections')}")
        for p in problems:
            print(f"   ! {p}")
    pending = dev_server.drain_runs()
    if pending:
        bad = True
        print(f"   ! runs did not stop: {pending}")
    print("PROBE: FAIL" if bad else "PROBE: PASS")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
