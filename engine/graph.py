"""Flow model: creation, ports, validation, topology and atomic edit ops.

`types_by_name` everywhere is {type_name: node-type spec (§3.4)}. Pure functions, no I/O.
"""
from __future__ import annotations

import copy
import re
import secrets
from datetime import datetime, timezone

from . import layout
from . import types as ptypes

SCHEMA = "flowcanvas/1"
NODE_ID_RE = re.compile(r"^n_[0-9a-f]{6}$")
EDGE_ID_RE = re.compile(r"^e_[0-9a-f]{6}$")
FLOW_ID_RE = re.compile(r"^f_[0-9a-f]{10}$")
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
NOTE_TYPE = "note"


class OpError(ValueError):
    """An op in an apply_ops batch failed; nothing was applied."""

    def __init__(self, index: int, message: str):
        super().__init__(f"op {index}: {message}")
        self.index = index
        self.message = message


class CycleError(ValueError):
    def __init__(self, nodes):
        super().__init__("flow contains a cycle: " + " -> ".join(nodes))
        self.nodes = list(nodes)


# ----------------------------------------------------------------- ids and creation

def messaging_params(node: dict, copy_target: bool = False) -> dict:
    """Never arms: only a dedicated opt-in action may. Anything else disarms."""
    params = copy.deepcopy(node.get("params") or {})
    if node.get("type") != "output.send_message":
        return params
    target = params.get("target")
    target = target.strip() if isinstance(target, str) else ""
    token = params.get("optin_token")
    keep = (not copy_target and params.get("send_enabled") is True and bool(target)
            and params.get("authorized_target") == target
            and isinstance(token, str) and len(token) == 64)
    if not keep:
        params["send_enabled"] = False
        params.pop("authorized_target", None)
        params.pop("optin_token", None)
        params.pop("allow_attachments", None)
    return params


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id(prefix: str, nbytes: int, taken) -> str:
    while True:
        candidate = prefix + secrets.token_hex(nbytes)
        if candidate not in taken:
            return candidate


def new_flow_id(taken=()) -> str:
    return _new_id("f_", 5, set(taken))


def new_node_id(flow: dict) -> str:
    return _new_id("n_", 3, {n.get("id") for n in flow.get("nodes", [])})


def new_edge_id(flow: dict) -> str:
    return _new_id("e_", 3, {e.get("id") for e in flow.get("edges", [])})


def new_flow(name: str = "Untitled flow", description: str = "", flow_id: str = None) -> dict:
    ts = now_iso()
    return {
        "schema": SCHEMA, "id": flow_id or new_flow_id(), "name": name or "Untitled flow",
        "description": description or "", "revision": 0, "created_at": ts, "updated_at": ts,
        "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [], "edges": [],
    }


def refresh_ids(flow: dict) -> dict:
    """Copy of `flow` with fresh node and edge ids (templates, duplicates); edges are rewired."""
    out = copy.deepcopy(flow)
    mapping = {}
    taken: set = set()
    for n in out.get("nodes", []):
        nid = _new_id("n_", 3, taken)
        taken.add(nid)
        mapping[n.get("id")] = nid
        n["id"] = nid
    for n in out.get("nodes", []):
        n["params"] = messaging_params(n, copy_target=True)
    etaken: set = set()
    for e in out.get("edges", []):
        e["id"] = _new_id("e_", 3, etaken)
        etaken.add(e["id"])
        e["from"]["node"] = mapping.get(e["from"]["node"], e["from"]["node"])
        e["to"]["node"] = mapping.get(e["to"]["node"], e["to"]["node"])
    return out


# ----------------------------------------------------------------- lookups and ports

def node_by_id(flow: dict, node_id: str):
    for n in flow.get("nodes", []):
        if n.get("id") == node_id:
            return n
    return None


def template_placeholders(text) -> list:
    """Unique {{placeholder}} names in order of first appearance."""
    seen, out = set(), []
    for m in PLACEHOLDER_RE.finditer(text if isinstance(text, str) else ""):
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append(m.group(1))
    return out


MAX_CASES = 20  # Switch: at most this many case outputs (G10)


def switch_cases(source) -> list:
    """Switch cases from its `cases` setting: one per non-empty line (or list item), trimmed, at most MAX_CASES.
    Output ports are positional (case1, case2, ...), so editing a line keeps its wires; removing one shifts them."""
    if isinstance(source, (list, tuple)):
        items = [ptypes.to_text(v) for v in source]
    else:
        items = str(source or "").splitlines()
    return [c.strip() for c in items if c.strip()][:MAX_CASES]


def _param_value(node: dict, spec: dict, name: str):
    value = (node.get("params") or {}).get(name)
    if value is None:
        value = next((p.get("default") for p in spec.get("params", []) if p.get("name") == name), None)
    return value


def node_ports(node: dict, types_by_name: dict):
    """(inputs, outputs) port lists for a node, including template-driven dynamic inputs.

    Returns (None, None) for unknown types.
    """
    spec = (types_by_name or {}).get(node.get("type"))
    if spec is None:
        return None, None
    inputs = [dict(p) for p in spec.get("inputs", [])]
    outputs = [dict(p) for p in spec.get("outputs", [])]
    dyn = spec.get("dynamic_inputs")
    if dyn:
        params = node.get("params") or {}
        source = params.get(dyn)
        if source is None:
            for p in spec.get("params", []):
                if p.get("name") == dyn:
                    source = p.get("default")
        names = {p["name"] for p in inputs}
        for name in template_placeholders(source):
            if name not in names:
                names.add(name)
                inputs.append({"name": name, "type": spec.get("dynamic_input_type", "text"), "required": False, "label": name, "dynamic": True})
    dyn_out = spec.get("dynamic_outputs")
    if dyn_out:  # Switch: one output per case line, before the fixed outputs (default)
        cases = [{"name": f"case{i}", "type": "any", "label": c, "dynamic": True}
                 for i, c in enumerate(switch_cases(_param_value(node, spec, dyn_out)), 1)]
        outputs = cases + outputs
    return inputs, outputs


def _port(ports, name):
    for p in ports or []:
        if p.get("name") == name:
            return p
    return None


# ----------------------------------------------------------------- topology

def _adjacency(flow: dict, only=None):
    ids = [n["id"] for n in flow.get("nodes", []) if only is None or n["id"] in only]
    known = set(ids)
    children = {i: [] for i in ids}
    parents = {i: [] for i in ids}
    for e in flow.get("edges", []):
        a, b = e["from"]["node"], e["to"]["node"]
        if a in known and b in known:
            children[a].append(b)
            parents[b].append(a)
    return ids, children, parents


def find_cycle(flow: dict):
    """A list of node ids forming a cycle (first == last), or None."""
    ids, children, _ = _adjacency(flow)
    color = {i: 0 for i in ids}            # 0 new, 1 on stack, 2 done
    for root in ids:
        if color[root]:
            continue
        stack = [(root, iter(children[root]))]
        path = [root]
        color[root] = 1
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                color[node] = 2
                stack.pop()
                path.pop()
            elif color[nxt] == 1:
                return path[path.index(nxt):] + [nxt]
            elif color[nxt] == 0:
                color[nxt] = 1
                stack.append((nxt, iter(children[nxt])))
                path.append(nxt)
    return None


def topo_order(flow: dict, node_ids=None) -> list:
    """Dependency order (Kahn), ties broken by order in the file. Raises CycleError."""
    only = set(node_ids) if node_ids is not None else None
    ids, children, parents = _adjacency(flow, only)
    indeg = {i: len(parents[i]) for i in ids}
    rank = {i: k for k, i in enumerate(ids)}
    ready = sorted((i for i in ids if indeg[i] == 0), key=rank.get)
    out = []
    while ready:
        a = ready.pop(0)
        out.append(a)
        for b in children[a]:
            indeg[b] -= 1
            if indeg[b] == 0:
                ready.append(b)
                ready.sort(key=rank.get)
    if len(out) != len(ids):
        sub = {"nodes": [n for n in flow["nodes"] if n["id"] in set(ids) - set(out)], "edges": flow.get("edges", [])}
        raise CycleError(find_cycle(sub) or sorted(set(ids) - set(out)))
    return out


def _reach(start: str, nexts: dict) -> set:
    seen, todo = set(), list(nexts.get(start, []))
    while todo:
        n = todo.pop()
        if n not in seen:
            seen.add(n)
            todo.extend(nexts.get(n, []))
    seen.discard(start)
    return seen


def ancestors(flow: dict, node_id: str) -> set:
    _, _, parents = _adjacency(flow)
    return _reach(node_id, parents)


def descendants(flow: dict, node_id: str) -> set:
    _, children, _ = _adjacency(flow)
    return _reach(node_id, children)


# ----------------------------------------------------------------- loops (G11)

FOREACH, COLLECT = "logic.foreach", "logic.collect"


def loops(flow: dict, types_by_name: dict = None) -> tuple:
    """({for_each_id: {"body": set, "collects": set}}, issues). The body of a For each is every node after it
    that is not after one of its Collects: it runs once per item. Collects run once and get the item results.
    Nodes after a Collect may not read per-item values; For each inside a loop is not supported."""
    nodes = [n for n in flow.get("nodes", []) if isinstance(n, dict) and isinstance(n.get("id"), str)]
    ids = {n["id"] for n in nodes}
    kind = {n["id"]: n.get("type") for n in nodes}
    edges = [e for e in flow.get("edges", []) if isinstance(e, dict) and isinstance(e.get("from"), dict)
             and isinstance(e.get("to"), dict) and e["from"].get("node") in ids and e["to"].get("node") in ids]
    sub = {"nodes": nodes, "edges": edges}
    if find_cycle(sub):
        return {}, []                         # validate reports the cycle; loop shapes are meaningless then
    _, children, parents = _adjacency(sub)
    out, issues, owner = {}, [], {}
    for fid in [n["id"] for n in nodes if kind[n["id"]] == FOREACH]:
        after_f = _reach(fid, children)
        found = {n for n in after_f if kind[n] == COLLECT}
        # a Collect behind another Collect gets no per-item values: not part of this loop (reported below)
        nested = set().union(*(_reach(c, children) for c in found)) if found else set()
        collects = found - nested
        later = set().union(*(_reach(c, children) for c in collects)) if collects else set()
        body = after_f - collects - later
        out[fid] = {"body": body, "collects": collects}
        for n in body:
            owner.setdefault(n, []).append(fid)
        for n in sorted(later):
            bad = [p for p in parents[n] if p == fid or p in body]
            if bad:
                issues.append(_issue("error", "uses a per-item value from inside a For each; take it from the "
                                              "Collect instead", node=n))
    for n, fids in sorted(owner.items()):
        if kind[n] == FOREACH:
            issues.append(_issue("error", "For each inside another For each is not supported yet", node=n))
        elif len(fids) > 1:
            issues.append(_issue("error", "mixes the items of two For each loops", node=n))
    looped = {c for loop in out.values() for c in loop["collects"]}
    after_collect = set().union(*(_reach(c, children) for c in looped)) if looped else set()
    for n in sorted(i for i in ids if kind[i] == COLLECT and i not in looped):
        message = ("Collect is downstream of another Collect; its values are already collected, not per-item"
                   if n in after_collect else "Collect needs a For each before it")
        issues.append(_issue("error", message, node=n))
    for c in sorted(looped):
        fids = [f for f, loop in out.items() if c in loop["collects"]]
        if len(fids) > 1:
            issues.append(_issue("error", "Collect closes two For each loops at once", node=c))
    return out, issues


# ----------------------------------------------------------------- validation

def _issue(level, message, node=None, port=None):
    out = {"level": level, "message": message}
    if node is not None:
        out["node"] = node
    if port is not None:
        out["port"] = port
    return out


def validate(flow: dict, types_by_name: dict) -> list:
    """Problems with the flow as [{level: error|warning, node?, port?, message}]. Empty = runnable."""
    issues: list = []
    if not isinstance(flow, dict):
        return [_issue("error", "flow must be an object")]
    if flow.get("schema") not in (None, SCHEMA):
        issues.append(_issue("error", f"unsupported schema {flow.get('schema')!r}"))
    nodes = flow.get("nodes")
    edges = flow.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return issues + [_issue("error", "flow needs 'nodes' and 'edges' lists")]

    ports = {}
    seen_ids: set = set()
    for n in nodes:
        if not isinstance(n, dict) or not isinstance(n.get("id"), str):
            issues.append(_issue("error", "node without an id"))
            continue
        nid = n["id"]
        if nid in seen_ids:
            issues.append(_issue("error", f"duplicate node id {nid}", node=nid))
            continue
        seen_ids.add(nid)
        if not NODE_ID_RE.match(nid):
            issues.append(_issue("warning", f"node id {nid!r} does not match n_xxxxxx", node=nid))
        if n.get("params") is not None and not isinstance(n.get("params"), dict):
            issues.append(_issue("error", "params must be an object", node=nid))
        ins, outs = node_ports(n, types_by_name)
        if ins is None:
            issues.append(_issue("error", f"unknown node type {n.get('type')!r}", node=nid))
            continue
        ports[nid] = (ins, outs)

    fed: dict = {}
    good_edges = []
    edge_ids: set = set()
    for e in edges:
        try:
            src, sport = e["from"]["node"], e["from"]["port"]
            dst, dport = e["to"]["node"], e["to"]["port"]
        except (KeyError, TypeError):
            issues.append(_issue("error", f"malformed edge {e.get('id') if isinstance(e, dict) else e!r}"))
            continue
        eid = e.get("id")
        if eid in edge_ids:
            issues.append(_issue("error", f"duplicate edge id {eid}", node=dst, port=dport))
        edge_ids.add(eid)
        if src not in seen_ids or dst not in seen_ids:
            missing = src if src not in seen_ids else dst
            issues.append(_issue("error", f"edge {eid} references missing node {missing}"))
            continue
        if src == dst:
            issues.append(_issue("error", "a node cannot feed itself", node=dst, port=dport))
            continue
        good_edges.append(e)
        if src not in ports or dst not in ports:
            continue                                  # unknown type already reported
        op = _port(ports[src][1], sport)
        ip = _port(ports[dst][0], dport)
        if op is None:
            issues.append(_issue("error", f"node has no output {sport!r}", node=src, port=sport))
            continue
        if ip is None:
            issues.append(_issue("error", f"node has no input {dport!r}", node=dst, port=dport))
            continue
        if (dst, dport) in fed and not ip.get("multiple"):
            issues.append(_issue("error", f"input {dport!r} has more than one connection", node=dst, port=dport))
        fed[(dst, dport)] = e
        if not ptypes.compatible(op.get("type", "any"), ip.get("type", "any")):
            issues.append(_issue("error", f"cannot connect {op.get('type')} output {sport!r} to "
                                          f"{ip.get('type')} input {dport!r}", node=dst, port=dport))

    cyc = find_cycle({"nodes": [n for n in nodes if isinstance(n, dict) and n.get("id") in seen_ids],
                      "edges": good_edges})
    if cyc:
        issues.append(_issue("error", "cycle: " + " -> ".join(cyc), node=cyc[0]))
    else:
        issues.extend(loops({"nodes": [n for n in nodes if isinstance(n, dict) and n.get("id") in seen_ids],
                             "edges": good_edges}, types_by_name)[1])

    for n in nodes:
        if not isinstance(n, dict) or n.get("id") not in ports or n.get("type") == NOTE_TYPE:
            continue
        params = n.get("params") or {}
        if n.get("type") == "output.send_message":
            message = params.get("message")
            if ((n["id"], "message") not in fed and (n["id"], "attachment") not in fed
                    and (not isinstance(message, str) or not message.strip())):
                issues.append(_issue("error", "connect a message or attachment before running", node=n["id"]))
        for p in ports[n["id"]][0]:
            if not p.get("required") or (n["id"], p["name"]) in fed:
                continue
            if params.get(p["name"]) not in (None, ""):
                continue                              # a constant in params satisfies the input
            issues.append(_issue("error", f"required input {p.get('label') or p['name']!r} is not connected",
                                 node=n["id"], port=p["name"]))
    return issues


def has_errors(issues) -> bool:
    return any(i.get("level") == "error" for i in issues)


# ----------------------------------------------------------------- ops (atomic)

OPS = ("add_node", "update_node", "remove_node", "connect", "disconnect", "set_meta", "auto_layout")


def _resolve_node(flow: dict, refs: dict, ref) -> str:
    if not isinstance(ref, str) or not ref:
        raise ValueError(f"node reference must be a non-empty string, got {ref!r}")
    if ref in refs:
        return refs[ref]
    if node_by_id(flow, ref) is not None:
        return ref
    matches = [n["id"] for n in flow.get("nodes", []) if str(n.get("title") or "").lower() == ref.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(f"node title {ref!r} is ambiguous; use the node id")
    raise ValueError(f"unknown node {ref!r}")


def _resolve_port(flow: dict, refs: dict, spec):
    """'ref.port' or {node, port} -> (node_id, port)."""
    if isinstance(spec, dict):
        node, port = spec.get("node"), spec.get("port")
    elif isinstance(spec, str) and "." in spec:
        node, port = spec.rsplit(".", 1)
    else:
        raise ValueError(f"port reference must look like 'node.port', got {spec!r}")
    if not port:
        raise ValueError(f"missing port name in {spec!r}")
    return _resolve_node(flow, refs, node), port


def _num(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{what} must be a number")
    return value


def _op_add_node(flow, op, refs, types_by_name):
    ntype = op.get("type")
    if not isinstance(ntype, str) or not ntype:
        raise ValueError("add_node needs a 'type'")
    if types_by_name is not None and ntype not in types_by_name:
        raise ValueError(f"unknown node type {ntype!r}")
    params = op.get("params") or {}
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    ref = op.get("ref")
    if ref is not None and (not isinstance(ref, str) or not ref or "." in ref):
        raise ValueError("ref must be a non-empty string without dots")
    if ref in refs:
        raise ValueError(f"ref {ref!r} used twice")
    x0, y0 = layout.next_position(flow)
    node = {"id": new_node_id(flow), "type": ntype}
    title = op.get("title")
    if title:
        node["title"] = str(title)
    node["x"] = _num(op["x"], "x") if op.get("x") is not None else x0
    node["y"] = _num(op["y"], "y") if op.get("y") is not None else y0
    node["params"] = copy.deepcopy(params)
    if "record_inputs" in op:
        if not isinstance(op["record_inputs"], bool):
            raise ValueError("record_inputs must be a boolean")
        node["record_inputs"] = op["record_inputs"]
    flow["nodes"].append(node)
    if ref:
        refs[ref] = node["id"]
    return {"op": "add_node", "node": node["id"], **({"ref": ref} if ref else {})}


def _op_update_node(flow, op, refs, types_by_name):
    node = node_by_id(flow, _resolve_node(flow, refs, op.get("node")))
    if "record_inputs" in op:
        if not isinstance(op["record_inputs"], bool):
            raise ValueError("record_inputs must be a boolean")
        node["record_inputs"] = op["record_inputs"]
    if "title" in op:
        if op["title"]:
            node["title"] = str(op["title"])
        else:
            node.pop("title", None)
    for axis in ("x", "y"):
        if op.get(axis) is not None:
            node[axis] = _num(op[axis], axis)
    if op.get("params") is not None:
        if not isinstance(op["params"], dict):
            raise ValueError("params must be an object")
        params = node.setdefault("params", {})
        for k, v in op["params"].items():
            if v is None:
                params.pop(k, None)
            else:
                params[k] = copy.deepcopy(v)
        _drop_dangling_dynamic_edges(flow, node, types_by_name)
    return {"op": "update_node", "node": node["id"]}


def _drop_dangling_dynamic_edges(flow, node, types_by_name):
    """Drop edges to or from dynamic ports removed by a parameter edit."""
    if types_by_name is None:
        return
    ins, outs = node_ports(node, types_by_name)
    if ins is None or outs is None:
        return
    input_names = {p["name"] for p in ins}
    output_names = {p["name"] for p in outs}
    flow["edges"] = [
        e for e in flow["edges"]
        if not (e["to"]["node"] == node["id"] and e["to"]["port"] not in input_names)
        and not (e["from"]["node"] == node["id"] and e["from"]["port"] not in output_names)
    ]


def _op_remove_node(flow, op, refs, types_by_name):
    nid = _resolve_node(flow, refs, op.get("node"))
    before = len(flow["edges"])
    flow["nodes"] = [n for n in flow["nodes"] if n["id"] != nid]
    flow["edges"] = [e for e in flow["edges"] if nid not in (e["from"]["node"], e["to"]["node"])]
    for k in [k for k, v in refs.items() if v == nid]:
        del refs[k]
    return {"op": "remove_node", "node": nid, "removed_edges": before - len(flow["edges"])}


def _op_connect(flow, op, refs, types_by_name):
    src, sport = _resolve_port(flow, refs, op.get("from"))
    dst, dport = _resolve_port(flow, refs, op.get("to"))
    if src == dst:
        raise ValueError("a node cannot feed itself")
    if types_by_name is not None:
        _, outs = node_ports(node_by_id(flow, src), types_by_name)
        ins, _ = node_ports(node_by_id(flow, dst), types_by_name)
        if outs is None or ins is None:
            raise ValueError("cannot connect a node of unknown type")
        op_ = _port(outs, sport)
        ip = _port(ins, dport)
        if op_ is None:
            raise ValueError(f"{src} has no output {sport!r} (has: {', '.join(p['name'] for p in outs) or '-'})")
        if ip is None:
            raise ValueError(f"{dst} has no input {dport!r} (has: {', '.join(p['name'] for p in ins) or '-'})")
        if not ptypes.compatible(op_.get("type", "any"), ip.get("type", "any")):
            raise ValueError(f"cannot connect {op_.get('type')} output {sport!r} to {ip.get('type')} input {dport!r}")
    else:
        ip = {}
    if src in descendants(flow, dst):
        raise ValueError(f"connecting {src}.{sport} -> {dst}.{dport} would create a cycle")
    into = [e for e in flow["edges"] if e["to"]["node"] == dst and e["to"]["port"] == dport]
    identical = next((e for e in into if e["from"]["node"] == src and e["from"]["port"] == sport), None)
    if identical:
        return {"op": "connect", "edge": identical["id"], "unchanged": True}
    # G8: only a port explicitly marked multiple collects wires; all other inputs keep replace semantics.
    replaced = [] if ip.get("multiple") else [e["id"] for e in into]
    flow["edges"] = [e for e in flow["edges"] if e["id"] not in replaced]
    edge = {"id": new_edge_id(flow), "from": {"node": src, "port": sport}, "to": {"node": dst, "port": dport}}
    flow["edges"].append(edge)
    out = {"op": "connect", "edge": edge["id"]}
    if replaced:
        out["replaced"] = replaced[0]
    return out


def _op_disconnect(flow, op, refs, types_by_name):
    if op.get("edge"):
        gone = [e["id"] for e in flow["edges"] if e["id"] == op["edge"]]
        if not gone:
            raise ValueError(f"unknown edge {op['edge']!r}")
    else:
        dst, dport = _resolve_port(flow, refs, op.get("to"))
        gone = [e["id"] for e in flow["edges"] if e["to"]["node"] == dst and e["to"]["port"] == dport]
        if not gone:
            raise ValueError(f"nothing is connected to {dst}.{dport}")
    flow["edges"] = [e for e in flow["edges"] if e["id"] not in gone]
    return {"op": "disconnect", "edges": gone}


def _op_set_meta(flow, op, refs, types_by_name):
    if "name" in op:
        name = str(op["name"] or "").strip()
        if not name:
            raise ValueError("name must not be empty")
        flow["name"] = name[:200]
    if "description" in op:
        flow["description"] = str(op["description"] or "")
    return {"op": "set_meta"}


def _op_auto_layout(flow, op, refs, types_by_name):
    layout.auto_layout(flow, types_by_name)
    return {"op": "auto_layout"}


_HANDLERS = {
    "add_node": _op_add_node, "update_node": _op_update_node, "remove_node": _op_remove_node,
    "connect": _op_connect, "disconnect": _op_disconnect, "set_meta": _op_set_meta,
    "auto_layout": _op_auto_layout,
}


def apply_ops(flow: dict, ops, types_by_name: dict = None):
    """Apply edit ops atomically to a COPY of `flow`. Returns (new_flow, results).

    Raises OpError(index, message) on the first failing op; `flow` is never modified.
    Revision / updated_at are the store's business and stay untouched here.
    """
    if not isinstance(ops, list):
        raise OpError(-1, "ops must be a list")
    out = copy.deepcopy(flow)
    out.setdefault("nodes", [])
    out.setdefault("edges", [])
    refs: dict = {}
    results = []
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            raise OpError(i, "op must be an object")
        kind = op.get("op")
        handler = _HANDLERS.get(kind)
        if handler is None:
            raise OpError(i, f"unknown op {kind!r} (known: {', '.join(OPS)})")
        try:
            results.append(handler(out, op, refs, types_by_name))
        except OpError:
            raise
        except (ValueError, TypeError, KeyError) as exc:
            raise OpError(i, f"{kind}: {exc}") from None
    # Ops come from the agent (flow_apply), Build with Hermes or the ops route, never from a canvas pick:
    # every node they add or change loses its picked files (catalog review), so its paths need a new pick.
    from . import picks
    before = {n.get("id"): n for n in flow.get("nodes") or [] if isinstance(n, dict)}
    for node in out["nodes"]:
        if isinstance(node, dict) and before.get(node.get("id")) != node:
            picks.drop(node)
    return out, results
