"""Agent tools (flow_*) and the /flow slash command."""
from __future__ import annotations

import json
import logging

from . import graph as G
from . import nodes as N
from . import runner as R
from . import store as S

logger = logging.getLogger("flowcanvas.tools")
USAGE = "usage: /flow list | /flow run <name|id> [--fresh] | /flow open [name|id] | /flow status <run_id>"


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _error(message, code="bad_request", **extra) -> str:
    return _json({"error": str(message), "code": code, **extra})


def _required_string(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


def _seconds(value, default):
    if value in (None, ""):
        return float(default)
    try:
        return min(900.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        raise ValueError("wait must be a number of seconds") from None


def _emit_changed(env, flow, created=False):
    try:
        env.emit("flow.changed", {"flow_id": flow["id"], "revision": flow.get("revision"),
                                  "origin": "agent", "created": bool(created)})
    except Exception as exc:  # noqa: BLE001 - UI notification is best effort
        logger.debug("flowcanvas: flow.changed not delivered: %s", exc)


def _list_text(flows, templates=()):
    if not flows:
        lines = ["No flows yet. Use flow_apply to create one."]
    else:
        lines = [f"{f['name']} ({f['id']}) — {f.get('node_count', 0)} nodes, revision {f.get('revision', 0)}"
                 for f in flows]
    if templates:
        lines.append("")
        lines.append("Templates (flow_apply template=<id> starts a new flow from one):")
        for t in templates:
            tag = "yours" if t.get("source") == "user" else "built-in"
            missing = f", needs {', '.join(t['missing_tools'])}" if t.get("missing_tools") else ""
            lines.append(f"{t['name']} ({t['id']}, {tag}, {t.get('node_count', 0)} nodes{missing})")
    return "\n".join(lines)


def _templates(env):
    try:
        return S.list_templates(env, known_types=set(N.types_by_name(env)))
    except Exception as exc:  # noqa: BLE001 - the flow list must not fail because of a template file
        logger.warning("flowcanvas: templates not listed: %s", exc)
        return []


def _emit_templates_changed(env, template_id, created):
    try:
        env.emit("templates.changed", {"template_id": template_id, "origin": "agent", "created": bool(created)})
    except Exception as exc:  # noqa: BLE001 - UI notification is best effort
        logger.debug("flowcanvas: templates.changed not delivered: %s", exc)


def _flow_text(flow):
    lines = [f"{flow.get('name') or 'Untitled flow'} ({flow['id']}), revision {flow.get('revision', 0)}"]
    for node in flow.get("nodes") or []:
        params = {k: v for k, v in (node.get("params") or {}).items() if k != "picked_files"}
        suffix = " " + json.dumps(params, ensure_ascii=False, separators=(",", ":")) if params else ""
        lines.append(f"{node['id']} [{node.get('title') or node['type']}] {node['type']}{suffix}")
    for edge in flow.get("edges") or []:
        lines.append(f"{edge['from']['node']}.{edge['from']['port']} -> {edge['to']['node']}.{edge['to']['port']}")
    return "\n".join(lines)


def _media_paths(value, out):
    """Collect local paths of media values (single, lists, nested dicts) in first-seen order."""
    if isinstance(value, dict):
        if "$media" in value:
            path = (value.get("$media") or {}).get("path")
            if path and path not in out:
                out.append(path)
            return out
        for item in value.values():
            _media_paths(item, out)
    elif isinstance(value, list):
        for item in value:
            _media_paths(item, out)
    return out


def _run_text(run):
    line = f"run {run['id']}: {run.get('status')}"
    if run.get("ms") is not None:
        line += f" ({run['ms']} ms)"
    lines = [line]
    if run.get("error"):
        lines.append("error: " + str(run["error"]))
    for node_id, state in (run.get("nodes") or {}).items():
        if state.get("error"):
            lines.append(f"{node_id}: {state.get('status')} — {state['error']}")
        elif state.get("preview") is not None:
            preview = json.dumps(state["preview"], ensure_ascii=False, default=str)
            lines.append(f"{node_id}: {state.get('status')} — {preview[:300]}")
    paths = []
    for state in (run.get("nodes") or {}).values():
        _media_paths(state.get("outputs"), paths)
    # Hermes turns MEDIA:<path> lines into attachments when the agent repeats them in its reply.
    lines.extend("MEDIA:" + p for p in paths)
    return "\n".join(lines)


def _run_payload(run):
    return {**run, "run_id": run["id"], "text": _run_text(run)}


def _apply(args, env):
    ops = args.get("ops")
    if not isinstance(ops, list):
        raise ValueError("ops must be a list")
    types = N.types_by_name(env)
    results = []
    ref = args.get("flow")
    if ref not in (None, ""):
        if not isinstance(ref, str):
            raise ValueError("flow must be a string")
        if args.get("template") not in (None, ""):
            raise ValueError("template only applies to a new flow (omit flow)")
        existing = S.find_flow(env, ref)

        def mutate(flow):
            new_flow, op_results = G.apply_ops(flow, ops, types)
            results.extend(op_results)
            return new_flow

        flow = S.modify_flow(env, existing["id"], mutate, base_revision=args.get("base_revision"))
        created = False
    else:
        if args.get("base_revision") is not None:
            raise ValueError("base_revision only applies to an existing flow")
        template = args.get("template")
        if template not in (None, "") and not isinstance(template, str):
            raise ValueError("template must be a string")
        template = S.find_template(env, template) if template else None
        # Apply ops in memory; an operation failure leaves no new flow on disk.
        with S.lock(env, "flows:create"):
            flow_id = G.new_flow_id(S._taken_ids(env))
            if template:
                draft = S.flow_from_template(env, template, flow_id, name=args.get("name") or None)
            else:
                draft = G.new_flow(str(args.get("name") or "Untitled flow"), flow_id=flow_id)
            draft, op_results = G.apply_ops(draft, ops, types)
            results.extend(op_results)
            flow = S.save_flow(env, draft, create=True)
        created = True
    _emit_changed(env, flow, created=created)
    refs = {r["ref"]: r["node"] for r in results if isinstance(r, dict) and r.get("ref")}
    return {"flow": flow, "results": results, "refs": refs,
            "issues": G.validate(flow, types), "text": _flow_text(flow)}


def _run(args, env):
    flow = S.find_flow(env, _required_string(args, "flow"))
    inputs = args.get("inputs")
    if inputs is not None and not isinstance(inputs, dict):
        raise ValueError("inputs must be an object")
    run = R.run_sync(env, flow["id"], timeout_s=_seconds(args.get("wait"), 60),
                     target_node=args.get("target_node") or None, fresh=R.parse_fresh(args.get("fresh", False)),
                     inputs=inputs or None)
    return _run_payload(run)


def handle(name: str, args: dict, kwargs: dict, env) -> str:
    """Dispatch one agent tool; every success and failure is a JSON string, never an exception."""
    try:
        args = args if isinstance(args, dict) else {}
        if name == "flow_list":
            flows = S.list_flows(env)
            templates = _templates(env)
            return _json({"flows": flows, "templates": templates, "text": _list_text(flows, templates)})
        if name == "flow_template_save":
            flow = S.find_flow(env, _required_string(args, "flow"))
            for key in ("name", "description", "replace"):
                if args.get(key) is not None and not isinstance(args.get(key), str):
                    raise ValueError(f"{key} must be a string")
            replace = (args.get("replace") or "").strip() or None
            template = S.save_template(env, flow, name=args.get("name"), description=args.get("description"),
                                       clear_inputs=args.get("clear_inputs") is True, replace=replace)
            _emit_templates_changed(env, template["id"], created=not replace)
            verb = "Updated" if replace else "Saved"
            return _json({"template": template,
                          "text": f"{verb} template {template['name']} ({template['id']}) from {flow['name']} "
                                  f"({flow['id']}), {template['node_count']} nodes. It shows under 'Your "
                                  f"templates' in Arachne Flow; flow_apply template={template['id']} starts a flow."})
        if name == "flow_get":
            flow = S.find_flow(env, _required_string(args, "flow"))
            return _json({"flow": flow, "issues": G.validate(flow, N.types_by_name(env)),
                          "text": _flow_text(flow)})
        if name == "flow_node_types":
            query = str(args.get("query") or "").lower().split()
            category = str(args.get("category") or "").strip().lower()
            types = []
            for spec in N.list_node_types(env):
                haystack = " ".join(str(spec.get(k) or "") for k in ("type", "title", "category", "description")).lower()
                if query and not all(word in haystack for word in query):
                    continue
                if category and str(spec.get("category") or "").lower() != category:
                    continue
                types.append(spec)
            return _json({"types": types, "text": f"{len(types)} node types"})
        if name == "flow_apply":
            return _json(_apply(args, env))
        if name == "flow_run":
            return _json(_run(args, env))
        if name == "flow_status":
            run_id = _required_string(args, "run")
            wait = _seconds(args.get("wait"), 0)
            run = R.wait(env, run_id, wait) if wait else R.get_run(env, run_id)
            return _json(_run_payload(run))
        return _error(f"unknown flow tool: {name}", "not_found")
    except G.OpError as exc:
        return _error(str(exc), "op_error", index=exc.index)
    except S.ConflictError as exc:
        return _error(str(exc), "conflict", current_revision=exc.current_revision)
    except S.NotFoundError as exc:
        return _error(str(exc), "not_found")
    except (S.StoreError, R.RunError, ValueError) as exc:
        return _error(str(exc))
    except Exception as exc:  # noqa: BLE001 - tool handlers must not raise into the agent runtime
        logger.exception("flowcanvas: agent tool %s failed", name)
        return _error(f"{type(exc).__name__}: {exc}", "internal")


def _open(ref: str, env) -> str:
    """/flow open: ask Hermes Desktop to show Arachne Flow (and the flow, when one is named)."""
    flow = None
    if ref:
        try:
            flow = S.find_flow(env, ref)
        except S.NotFoundError as exc:
            return "Error: " + str(exc)
    try:
        env.emit("ui.open", {"flow_id": flow["id"] if flow else None})
    except Exception as exc:  # noqa: BLE001 - no Desktop listening is not an error for the command
        logger.debug("flowcanvas: ui.open not delivered: %s", exc)
        return "Could not reach Hermes Desktop. Open Arachne Flow from the sidebar."
    if flow:
        return f"Opening {flow.get('name') or flow['id']} ({flow['id']}) in Arachne Flow."
    return "Opening Arachne Flow."


def command(raw_args: str, kwargs: dict, env) -> str:
    """Human-oriented /flow list|run|open|status wrapper around the same handlers."""
    parts = (raw_args or "").strip().split(None, 1)
    if not parts:
        return USAGE
    action, rest = parts[0].lower(), parts[1].strip() if len(parts) > 1 else ""
    if action == "list" and not rest:
        name, args = "flow_list", {}
    elif action == "open":
        return _open(rest, env)
    elif action == "run" and rest:
        words = rest.split()
        fresh = "--fresh" in words
        ref = " ".join(w for w in words if w != "--fresh")
        if not ref:
            return USAGE
        name, args = "flow_run", {"flow": ref, "fresh": fresh}
    elif action == "status" and rest:
        name, args = "flow_status", {"run": rest}
    else:
        return USAGE
    result = json.loads(handle(name, args, kwargs, env))
    if result.get("error"):
        return "Error: " + str(result["error"])
    return str(result.get("text") or _json(result))
