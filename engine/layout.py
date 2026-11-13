"""Automatic layout: columns by longest path from the sources."""
from __future__ import annotations

import math
import re

START_X = 80
START_Y = 80
COL_W = 300
ROW_H = 170
ROW_GAP = 40
COL_GAP = 60
NODE_W = 240
# Mirrors the node card in desktop/plugin.js (header, port rows, collapsed inputs, summary).
CARD_HEAD = 48
CARD_FOOT = 26   # Clean card footer: cost and usual time (most tool and ready-made nodes show one)
CARD_ROW = 22
CARD_PAD = 10
CARD_COLLAPSE_AFTER = 6
CARD_VISIBLE_OPTIONAL = 4


def estimate_height(node: dict, spec) -> int:
    """Rough rendered height of a node card; never below ROW_H - ROW_GAP."""
    floor = ROW_H - ROW_GAP
    if node.get("type") == "note":
        return max(floor, CARD_HEAD + 160 + 24)  # note text can fill a 160px box
    if not isinstance(spec, dict):
        return floor
    inputs = list(spec.get("inputs") or [])
    dyn = spec.get("dynamic_inputs")
    if dyn:
        src = (node.get("params") or {}).get(dyn)
        if src is None:
            src = next((p.get("default") for p in spec.get("params") or [] if p.get("name") == dyn), "")
        names = {p.get("name") for p in inputs}
        for m in re.finditer(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", str(src or "")):
            if m.group(1) not in names:
                names.add(m.group(1))
                inputs.append({"name": m.group(1), "dynamic": True})
    shown = len(inputs)
    extra = 0
    if shown > CARD_COLLAPSE_AFTER:
        required = sum(1 for p in inputs if p.get("required") or p.get("dynamic"))
        shown = min(shown, required + CARD_VISIBLE_OPTIONAL)
        extra = 20 if shown < len(inputs) else 0              # "+ N more inputs"
    outputs = len(spec.get("outputs") or [])
    if spec.get("dynamic_outputs"):
        from .graph import switch_cases  # lazy: graph imports layout
        src = (node.get("params") or {}).get(spec["dynamic_outputs"])
        if src is None:
            src = next((p.get("default") for p in spec.get("params") or [] if p.get("name") == spec["dynamic_outputs"]), "")
        outputs += len(switch_cases(src))
    rows = max(shown, outputs)
    params = [k for k, v in (node.get("params") or {}).items() if k not in ("cache", "timeout_s") and v not in (None, "")]
    summary = min(3, len(params)) * 15 + (8 if params else 0)
    outputs = spec.get('outputs') or []
    shown = min(4, len(outputs))
    media_count = min(4, sum(1 for p in outputs if p.get('type') in ('image','video','model3d','audio')))
    data_count = min(4 - media_count, max(0, shown - media_count))
    # Match the real output cards: header, ports, 140px media rows and text rows.
    # Up to four outputs are shown, so a one-output estimate would overlap siblings.
    preview = 0 if not outputs else (34 + media_count * 140 + data_count * 72 + (28 if len(outputs) > 4 else 0))
    foot = CARD_FOOT if spec.get("kind") in ("tool", "preset") or spec.get("typical") else 0
    return max(floor, CARD_HEAD + CARD_PAD + rows * CARD_ROW + extra + summary + preview + foot)


def columns(flow: dict) -> dict:
    """node_id -> column index = length of the longest edge path ending in that node.

    Edges that would close a cycle are ignored (a cyclic flow is invalid anyway; layout must not hang).
    """
    ids = [n["id"] for n in flow.get("nodes", [])]
    known = set(ids)
    children: dict = {i: [] for i in ids}
    indeg: dict = {i: 0 for i in ids}
    for e in flow.get("edges", []):
        a, b = e["from"]["node"], e["to"]["node"]
        if a in known and b in known and a != b:
            children[a].append(b)
            indeg[b] += 1
    col: dict = {i: 0 for i in ids}
    queue = [i for i in ids if indeg[i] == 0]
    while queue:                       # Kahn; nodes stuck in a cycle keep what their parents gave them
        a = queue.pop(0)
        for b in children[a]:
            col[b] = max(col[b], col[a] + 1)
            indeg[b] -= 1
            if indeg[b] == 0:
                queue.append(b)
    return col


def _dimension(value, fallback):
    """Measurements are untrusted UI hints, never persisted node settings."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value <= 100000 and math.isfinite(value):
        return math.ceil(value)
    return fallback


def auto_layout(flow: dict, types_by_name: dict = None, node_sizes: dict = None) -> dict:
    """Pack all nodes left-to-right by wiring using measured world-pixel card bounds when supplied.

    Expanded inputs, notes and media can be taller than their schemas predict. Current measurements win
    over estimates, avoiding both overlaps and room reserved for unused previews. Column widths grow too.
    Invalid hints fall back to estimates; none are saved. Order follows parents, previous y, then file order.
    """
    nodes = flow.get("nodes", [])
    if not nodes:
        return flow
    types_by_name = types_by_name or {}
    node_sizes = node_sizes if isinstance(node_sizes, dict) else {}
    sizes = {}
    for n in nodes:
        hint = node_sizes.get(n["id"])
        hint = hint if isinstance(hint, dict) else {}
        sizes[n["id"]] = (
            max(NODE_W, _dimension(hint.get("width"), NODE_W)),
            max(ROW_H - ROW_GAP, _dimension(hint.get("height"), estimate_height(n, types_by_name.get(n.get("type")))))
        )
    col = columns(flow)
    order = {n["id"]: i for i, n in enumerate(nodes)}
    by_id = {n["id"]: n for n in nodes}
    parents: dict = {n["id"]: [] for n in nodes}
    for e in flow.get("edges", []):
        a, b = e["from"]["node"], e["to"]["node"]
        if a in by_id and b in by_id:
            parents[b].append(a)
    row: dict = {}
    x = START_X
    for c in range(max(col.values()) + 1):
        members = [n for n in nodes if col[n["id"]] == c]

        def key(n):
            ps = [row[p] for p in parents[n["id"]] if p in row]
            bary = sum(ps) / len(ps) if ps else float("inf")
            return (bary, float(n.get("y") or 0), order[n["id"]])

        members.sort(key=key)
        y = START_Y
        for r, n in enumerate(members):
            row[n["id"]] = r
            n["x"] = x
            n["y"] = y
            y += max(ROW_H, sizes[n["id"]][1] + ROW_GAP)
        x += max(COL_W, max((sizes[n["id"]][0] for n in members), default=NODE_W) + COL_GAP)
    return flow


def next_position(flow: dict) -> tuple:
    """A free spot for a node added without coordinates: right of the right-most node."""
    nodes = flow.get("nodes", [])
    if not nodes:
        return START_X, START_Y
    right = max(float(n.get("x") or 0) for n in nodes)
    top = min(float(n.get("y") or 0) for n in nodes)
    return int(right + COL_W), int(top)
