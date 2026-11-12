"""G6: turn a prompt into validated flow_apply ops, with exactly one repair attempt.

The model proposes edits only. It never executes a flow or calls a tool. Every answer is applied to
an in-memory copy and validated before store.py is allowed to write anything.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import threading
import time
import uuid

from . import executors as E
from . import graph as G
from . import nodes as N
from . import store as S
from .executors import _llm_call   # review E-14: one sync bridge for both the LLM node and generation

SKILL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "skills", "arachne-flow", "SKILL.md")
MAX_PROMPT_CHARS = 12000
# No deadline for the whole build: it may take as long as the model needs (thinking models, large flows). This
# only guards ONE model call that never answers; the host API has no streaming, so it is a per-call stall limit.
LLM_TIMEOUT_S = 900
MAX_CATALOG_CHARS = 24000
# Reasoning tokens count against this on some providers; a large flow's ops JSON needs room too.
MAX_REPLY_TOKENS = 16384
MAX_REPAIRS = 1
GENERATE_TASK = "arachne_flow_generate"
GENERATE_TASK_VERSION = 4
# Background builds (POST generate/jobs): finished jobs stay readable for a while, then are dropped.
JOB_KEEP_S = 15 * 60
MAX_JOBS = 32
GENERATE_TASK_DEFAULTS = {"timeout": LLM_TIMEOUT_S, "reasoning_effort": "low"}


class GenerateError(ValueError):
    """A safe, user-displayable generation failure."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class CandidateError(ValueError):
    """A model answer that can be sent back for its single repair round."""


def _minutes(seconds: float) -> str:
    minutes = max(1, round(seconds / 60))
    return f"{minutes} minute" + ("" if minutes == 1 else "s")


def _ensure_generate_task(env) -> None:
    """Use low effort for interactive graph edits; never disable reasoning-only models."""
    state = getattr(env, "state", None)
    if isinstance(state, dict) and state.get("generate_task_registered") == GENERATE_TASK_VERSION:
        return
    reg = getattr(getattr(env, "ctx", None), "register_auxiliary_task", None)
    if callable(reg):
        try:
            reg(
                GENERATE_TASK,
                display_name="Arachne Flow: Build with Hermes",
                description="Generate or edit a flow graph quickly, with low reasoning effort and bounded output.",
                defaults=dict(GENERATE_TASK_DEFAULTS),
            )
            if isinstance(state, dict):
                state["generate_task_registered"] = GENERATE_TASK_VERSION
        except Exception:  # noqa: BLE001 - fallback in _complete handles unregistered task
            pass


def _supported_kwargs(llm, kwargs: dict) -> dict:
    """Keep only kwargs accepted by ``llm.complete`` (all of them if it takes ``**kwargs``)."""
    try:
        params = inspect.signature(getattr(llm, "acomplete", None) or llm.complete).parameters
    except (TypeError, ValueError):
        return dict(kwargs)
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(kwargs)
    return {k: v for k, v in kwargs.items() if k in params}


async def _complete(env, messages, model=None, provider=None):
    llm = getattr(getattr(env, "ctx", None), "llm", None)
    if llm is None or not (callable(getattr(llm, "acomplete", None)) or callable(getattr(llm, "complete", None))):
        raise GenerateError("Hermes LLM access is not available in this process.", 503)
    _ensure_generate_task(env)
    raw_kwargs = {
        "purpose": "arachne-flow generate",
        "task": GENERATE_TASK,
        "timeout": LLM_TIMEOUT_S,
        "max_tokens": MAX_REPLY_TOKENS,
    }
    if model:
        raw_kwargs["model"] = model
    if provider:
        raw_kwargs["provider"] = provider
    kwargs = _supported_kwargs(llm, raw_kwargs)

    async def invoke():
        async_complete = getattr(llm, "acomplete", None)
        if callable(async_complete):
            # Cancelling the public async API closes the in-flight transport and stops host retries.
            return await asyncio.wait_for(async_complete(messages=messages, **kwargs), timeout=LLM_TIMEOUT_S + 2)
        return await E.call_blocking(_llm_call, llm, messages, kwargs,
                                     timeout=LLM_TIMEOUT_S + 2, what="flow generation")

    try:
        try:
            result = await invoke()
        except TypeError:
            for opt in ("reasoning_effort", "task", "purpose"):
                kwargs.pop(opt, None)
            result = await invoke()
        except PermissionError as exc:
            if "auxiliary task" in str(exc).lower() and "task" in kwargs:
                kwargs.pop("task", None)
                kwargs.pop("reasoning_effort", None)
                result = await invoke()
            else:
                raise
    except asyncio.TimeoutError:
        raise GenerateError(
            f"The selected model sent no answer for {_minutes(LLM_TIMEOUT_S)}. No changes were saved; "
            "your prompt is preserved. Try again or pick another model.", 504) from None
    except PermissionError:
        raise GenerateError(
            "Hermes refused the selected model/provider. Allow model and provider overrides under "
            "plugins.entries.arachne-flow.llm.allow_model_override and "
            "plugins.entries.arachne-flow.llm.allow_provider_override in config.yaml, or leave the "
            "model at Hermes' current model.", 403) from None
    except GenerateError:
        raise
    except Exception as exc:  # noqa: BLE001 - host/provider errors belong in the composer
        raise GenerateError(f"Hermes could not generate the flow: {type(exc).__name__}: {exc}", 502) from None
    text = getattr(result, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise GenerateError("Hermes returned an empty response.", 502)
    return text


def _skill_rules() -> str:
    """The graph-building parts of the bundled skill; deliberately omit its run/tool workflow."""
    try:
        with open(SKILL_PATH, encoding="utf-8") as fh:
            text = fh.read()
        start = text.index("## Ops for `flow_apply`")
        end = text.index("## Example 1", start)
        audit = (
            "## Mandatory flow audit\n"
            "Check every node and every parameter for correct data shape, required inputs, limits and defaults. "
            "Respect model compatibility and options_source metadata; do not invent model settings. "
            "Preserve working nodes and models. Use logic.merge to join exclusive branches, and collect loop "
            "results before leaving the loop. Include a useful final output. Never execute or expose secrets.\n\n"
        )
        return audit + text[start:end].strip()
    except (OSError, ValueError):
        # Packaged installs should always contain the skill. Keep generation usable if a downstream
        # package omitted it, while the ops below still fully constrain the model.
        return "Use only the supplied node catalog and the documented flow_apply operations."


def _port(port: dict) -> dict:
    out = {"name": port.get("name"), "type": port.get("type", "any")}
    if port.get("required"):
        out["required"] = True
    for key in ("description", "multiple", "min", "max", "min_items", "max_items"):
        if key in port and port[key] not in (None, "", False):
            out[key] = port[key]
    return out


def _param(param: dict, port_descs: dict | None = None) -> dict:
    # Keep the execution and model-selection contract, not just the field names.
    out = {"name": param.get("name"), "kind": param.get("kind", "text")}
    for key in ("description", "required", "default", "options", "options_source",
                "options_accepts", "from_model", "fallback", "numeric", "min", "max", "integer",
                "min_items", "max_items"):
        if key not in param:
            continue
        val = param[key]
        if val is None or val == "" or (key in ("required", "fallback", "numeric", "integer") and not val):
            continue
        if key == "description" and port_descs and port_descs.get(param.get("name")) == val:
            continue
        out[key] = val
    if param.get("dynamic"):
        out["dynamic"] = True
    return out


def compact_catalog(types: dict, lean: bool = False) -> str:
    """One compact JSON object per available type; no giant formatted schema dump."""
    rows = []
    for name in sorted(types):
        spec = types[name]
        inputs = [_port(p) for p in spec.get("inputs", [])]
        port_descs = {p.get("name"): p.get("description") for p in inputs if p.get("description")}
        rows.append(json.dumps({
            "type": name,
            "title": spec.get("title") or name,
            "category": spec.get("category") or "",
            "description": (spec.get("description") or "")[:180],
            "inputs": inputs,
            "outputs": [_port(p) for p in spec.get("outputs", [])],
            "params": [_param(p, port_descs) for p in spec.get("params", [])],
            **{key: spec[key] for key in ("open_params", "cache_default", "typical", "cost")
               if key in spec},
            **({"dynamic_inputs": "one text input per {{name}} in " + spec["dynamic_inputs"]}
               if spec.get("dynamic_inputs") else {}),
            **({"dynamic_outputs": f"case1..caseN, one per non-empty line of {spec['dynamic_outputs']}, "
                                   f"then the fixed outputs"} if spec.get("dynamic_outputs") else {}),
        }, ensure_ascii=False, separators=(",", ":")))
    if lean:
        reduced = []
        for line in rows:
            row = json.loads(line)
            row.pop("category", None)
            row["description"] = row["description"][:120]
            raw_tool = row["type"].startswith("tool:")
            for field in ("inputs", "outputs", "params"):
                for item in row[field]:
                    if "description" in item:
                        if raw_tool:
                            item["description"] = item["description"][:120]
                        else:
                            item.pop("description")
                    default = item.get("default")
                    if isinstance(default, (str, list, dict)) and len(json.dumps(default)) > 180:
                        item.pop("default")  # the executor still applies the full schema's default
            reduced.append(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
        rows = reduced
    return "\n".join(rows)


def generation_catalog(prompt: str, flow: dict | None, types: dict) -> tuple[str, str]:
    """Keep small catalogs intact; focus large MCP catalogs on the request and existing graph.

    Validation still uses the complete registry. No tools are invoked to select schemas.
    """
    rows = {name: compact_catalog({name: spec}, lean=True) for name, spec in types.items()}
    if sum(len(row) + 1 for row in rows.values()) <= MAX_CATALOG_CHARS:
        return "\n".join(rows[name] for name in sorted(rows)), ""
    used = {node.get("type") for node in (flow or {}).get("nodes", [])}
    required = sorted(name for name in types if not name.startswith("tool:") or name in used)
    chosen = list(required)
    size = sum(len(rows[name]) + 1 for name in chosen)
    if size > MAX_CATALOG_CHARS:
        raise GenerateError("The schemas in this flow exceed the generation budget. Use a smaller flow or edit its nodes manually.", 413)
    words = set(re.findall(r"[^\W_]{3,}", prompt.casefold())) - {
        "the", "and", "with", "from", "for", "use", "make", "flow", "then", "this", "that",
        "und", "mit", "der", "die", "das", "ein", "eine", "einen", "erstelle", "einem",
    }
    text = prompt.casefold()
    def relevance(name):
        spec = types[name]
        haystack = " ".join((name, spec.get("title") or "", spec.get("description") or "")).casefold()
        return (100 if name.removeprefix("tool:").casefold() in text else 0) + sum(w in haystack for w in words)
    candidates = sorted((name for name in types if name not in chosen), key=lambda name: (-relevance(name), name))
    for name in candidates:
        if relevance(name) and size + len(rows[name]) + 1 <= MAX_CATALOG_CHARS:
            chosen.append(name)
            size += len(rows[name]) + 1
    omitted = [name for name in sorted(types) if name not in chosen]
    index = "\n".join(omitted)
    if len(index) > 12000:
        index = index[:12000].rsplit("\n", 1)[0] + "\n(additional tool names omitted)"
    return "\n".join(rows[name] for name in sorted(chosen)), (
        "\n\nOTHER AVAILABLE TOOL NAMES (schemas omitted to bound request size; do not guess their ports)\n" + index
    )


def build_messages(prompt: str, flow: dict | None, types: dict, known_issues=None) -> list:
    catalog, catalog_index = generation_catalog(prompt, flow, types)
    system = (
        "You build or edit Arachne Flow graphs. Do not run the flow and do not call any tools. "
        "Return only one JSON object: {\"name\": optional string, \"ops\": [flow_apply operations]}. "
        "Use only node types and ports from the supplied catalog. Give every new add_node a unique "
        "ref, and use ref.port for its later connections. For an existing flow, preserve nodes and "
        "edges unless the request requires changing them. Set dynamic templates/placeholders before "
        "connecting them. Finish with auto_layout unless the user explicitly requested exact positions. "
        "The optional name is for a new flow only; use set_meta to rename an existing flow. "
        "Return compact JSON without indentation, prose or notes. Every operation MUST have an 'op' key. "
        "An add_node uses flat type/title/params fields, NEVER a nested node object. "
        "Example: {\"ops\":[{\"op\":\"add_node\",\"ref\":\"a\",\"type\":\"input.text\",\"params\":{\"value\":\"Hello\"}},"
        "{\"op\":\"add_node\",\"ref\":\"b\",\"type\":\"output.preview\"},"
        "{\"op\":\"connect\",\"from\":\"a.text\",\"to\":\"b.value\"},{\"op\":\"auto_layout\"}]}. "
        "Every node already shows its own result on the canvas. Add output.preview only at the END of a "
        "branch (a final result), never in the middle: do not route data through a Preview into later nodes and "
        "do not hang a Preview off a step whose output continues elsewhere, unless the user explicitly asks "
        "for intermediate previews. "
        "For a vague request, build a useful "
        "6-8 node example with at most 24 operations, not an exhaustive showcase. "
        "Satisfy required inputs with a connection or a same-named constant in params. "
        "Keep existing provider/model settings; leave new LLM models at defaults unless requested. "
        "Join exclusive If/Switch branches with logic.merge before a shared step. "
        "Set Switch cases before wiring caseN. Foreach.item and index stay inside its Collect boundary; "
        "after Collect use its list output. Do not nest loops.\n\n"
        "FLOW CANVAS SKILL RULES\n" + _skill_rules()
    )
    known = [i for i in (known_issues or []) if i.get("level") == "error"]
    known_text = ("\n\nKNOWN EXISTING ISSUES (already present; leave them alone unless the user asks for a fix)\n" +
                  json.dumps(known, ensure_ascii=False, separators=(",", ":"))) if known else ""
    user = (
        "AVAILABLE NODE TYPES (one compact JSON object per line)\n" + catalog +
        "\n\nCURRENT FLOW (null means create a new flow)\n" +
        json.dumps(flow, ensure_ascii=False, separators=(",", ":")) + known_text + catalog_index +
        "\n\nUSER REQUEST\n" + prompt
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _answer_object(value) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("ops"), list):
        raise ValueError("missing ops list")
    if "name" in value and not isinstance(value["name"], str):
        raise ValueError("name must be a string")
    return {"name": value.get("name"), "ops": value["ops"]}


def parse_answer(raw: str) -> dict:
    """Strict result shape, tolerant of fences and prose before/after the JSON object."""
    decoder = json.JSONDecoder()
    starts = [match.start() for match in re.finditer(r"\{", raw)]
    for start in starts:
        try:
            value, _end = decoder.raw_decode(raw[start:])
            return _answer_object(value)
        except (ValueError, TypeError, json.JSONDecodeError):
            continue
    raise CandidateError("The model did not return valid JSON with an 'ops' list.")


PREVIEW = "output.preview"
# Words that ask for previews between steps ("Zwischenergebnisse", "after each step", ...). Without one, newly added
# intermediate previews are removed: every node already shows its own output, so they only add clutter.
_INTERMEDIATE_ASK = re.compile(
    r"zwischen|intermediate|in[- ]between|mitten|each step|every step|after each|jede[nmrs]? (schritt|stufe|node)|"
    r"nach jede[mnr]|step[- ]by[- ]step|debug", re.IGNORECASE)


def wants_intermediate_previews(prompt: str) -> bool:
    return bool(_INTERMEDIATE_ASK.search(prompt or ""))


def drop_intermediate_previews(base, candidate: dict, types: dict, results=None, prompt: str = ""):
    """Remove Preview nodes this build added mid-flow (unless the prompt asks for them).

    Mid-flow means: the Preview's own output feeds further nodes (a pass-through; those nodes are rewired to the
    Preview's source), or its source also feeds a non-output node (a side branch). Previews at the end of a branch,
    and every Preview the flow had before, stay. Returns (flow, results)."""
    if wants_intermediate_previews(prompt):
        return candidate, results
    old = {n.get("id") for n in (base or {}).get("nodes", [])}
    nodes = {n["id"]: n for n in candidate.get("nodes", [])}
    added = [nid for nid, n in nodes.items() if n.get("type") == PREVIEW and nid not in old]
    if not added:
        return candidate, results
    ops = []
    flow = candidate
    for nid in added:
        edges = flow.get("edges", [])
        incoming = [e for e in edges if e["to"]["node"] == nid]
        outgoing = [e for e in edges if e["from"]["node"] == nid]
        source = incoming[0]["from"] if len(incoming) == 1 else None
        if outgoing:
            if source is None:
                continue
            rewire = [{"op": "connect", "from": f"{source['node']}.{source['port']}",
                       "to": f"{e['to']['node']}.{e['to']['port']}"} for e in outgoing]
        else:
            if source is None:
                continue
            siblings = [e for e in edges if e["from"]["node"] == source["node"] and e["to"]["node"] != nid]
            if not any(not str(nodes.get(e["to"]["node"], {}).get("type", "")).startswith("output.") for e in siblings):
                continue   # end of a branch: a real final result
            rewire = []
        step = [{"op": "remove_node", "node": nid}] + rewire
        try:
            flow, _ = G.apply_ops(flow, step, types)
        except (G.OpError, ValueError, TypeError, KeyError):
            continue   # keep the model's graph rather than break it
        ops.extend(step)
    if not ops:
        return candidate, results
    try:
        flow, _ = G.apply_ops(flow, [{"op": "auto_layout"}], types)
    except (G.OpError, ValueError, TypeError, KeyError):
        pass
    return flow, results


def _candidate(base: dict | None, proposed: dict, types: dict, fallback_name: str, base_errors=None, prompt: str = ""):
    if not proposed["ops"]:
        raise CandidateError("the answer contains no operations")
    flow = G.new_flow((proposed.get("name") or fallback_name).strip()[:80] or "Generated flow") \
        if base is None else base
    try:
        candidate, results = G.apply_ops(flow, proposed["ops"], types)
    except G.OpError as exc:
        raise CandidateError(f"op {exc.index}: {exc.message}") from None
    except (ValueError, TypeError, KeyError) as exc:
        raise CandidateError(str(exc)) from None
    candidate, results = drop_intermediate_previews(base, candidate, types, results, prompt)
    issues = G.validate(candidate, types)
    known = {(i.get("node"), i.get("port"), i.get("message")) for i in (base_errors or [])}
    new_errors = [i for i in issues if i.get("level") == "error" and
                  (i.get("node"), i.get("port"), i.get("message")) not in known]
    if new_errors:
        detail = "; ".join(
            f"{i.get('node') + '/' if i.get('node') else ''}{i.get('port') + ': ' if i.get('port') else ''}"
            f"{i.get('message')}" for i in new_errors)
        raise CandidateError("validation: " + detail)
    return candidate, results


def _changes(before: dict | None, after: dict) -> dict:
    old_nodes = {n.get("id") for n in (before or {}).get("nodes", [])}
    old_edges = {e.get("id") for e in (before or {}).get("edges", [])}
    return {
        "nodes": sum(n.get("id") not in old_nodes for n in after.get("nodes", [])),
        "connections": sum(e.get("id") not in old_edges for e in after.get("edges", [])),
    }


def _optional_text(body: dict, key: str):
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise GenerateError(f"{key} must be a string")
    return value.strip() or None


async def generate(env, body: dict, progress=None) -> dict:
    """Prompt -> validated, saved flow. No overall deadline; cancelling the task before the save leaves the store
    untouched (the save is the last step and has no await inside)."""
    return await _generate(env, _prepare(env, body), progress)


def _prepare(env, body: dict) -> dict:
    """Checks that can fail at once (bad input, stale revision), before a background job is started."""
    if not isinstance(body, dict):
        raise GenerateError("A JSON object is required.")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise GenerateError("A non-empty prompt is required.")
    prompt = prompt.strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise GenerateError(f"The prompt is too long (maximum {MAX_PROMPT_CHARS} characters).")
    flow_id = _optional_text(body, "flow_id")
    model = _optional_text(body, "model")
    provider = _optional_text(body, "provider")
    before = S.get_flow(env, flow_id) if flow_id else None
    base_revision = body.get("base_revision")
    if before is not None and base_revision is not None:
        try:
            stale = int(base_revision) != int(before.get("revision", 0))
        except (TypeError, ValueError):
            raise GenerateError("base_revision must be an integer") from None
        if stale:
            raise S.ConflictError(flow_id, int(before.get("revision", 0)), base_revision)
    return {"prompt": prompt, "flow_id": flow_id, "model": model, "provider": provider,
            "before": before, "base_revision": base_revision}


async def _generate(env, job: dict, progress=None) -> dict:
    def phase(name: str) -> None:
        if callable(progress):
            progress(name)

    prompt, model, provider = job["prompt"], job["model"], job["provider"]
    before, base_revision = job["before"], job["base_revision"]
    types = N.types_by_name(env)
    base_issues = G.validate(before, types) if before is not None else []
    base_errors = [i for i in base_issues if i.get("level") == "error"]
    messages = build_messages(prompt, before, types, known_issues=base_errors)
    phase("thinking")
    raw = await _complete(env, messages, model=model, provider=provider)
    fallback_name = prompt.splitlines()[0][:80] or "Generated flow"
    candidate = None
    repaired = False
    first_error = None
    for attempt in range(MAX_REPAIRS + 1):
        try:
            proposed = parse_answer(raw)
            candidate, _results = _candidate(before, proposed, types, fallback_name, base_errors=base_errors,
                                             prompt=prompt)
            break
        except CandidateError as exc:
            err_text = str(exc)
            if attempt >= MAX_REPAIRS:
                suffix = f" (initial attempt failed: {first_error})" if first_error and first_error != err_text else ""
                raise GenerateError(
                    f"Hermes could not build a valid flow after one repair: {err_text}{suffix}"
                ) from None
            first_error = err_text
            repaired = True
            repair = (
                "Your previous answer failed Arachne Flow validation: " + err_text +
                ". Return a corrected complete JSON object with the same {name?, ops} shape. "
                "Fix all operations rather than explaining the error. Do not run the flow."
            )
            messages = messages + [{"role": "assistant", "content": raw}, {"role": "user", "content": repair}]
            phase("repairing")
            raw = await _complete(env, messages, model=model, provider=provider)

    phase("saving")
    if before is None:
        # create_flow's create=True write, delayed until the graph is valid; no intermediate blank file.
        with S.lock(env, "flows:create"):
            taken = S._taken_ids(env)
            if candidate["id"] in taken:
                candidate["id"] = G.new_flow_id(taken)
            saved = S.save_flow(env, candidate, create=True)
    else:
        revision = before.get("revision", 0) if base_revision is None else base_revision
        saved = S.save_flow(env, candidate, base_revision=revision)
    return {"flow": saved, "created": before is None, "repaired": repaired,
            "summary": _changes(before, saved)}


# ---------------------------------------------------------------- background builds
# The UI starts a job and polls it, so no HTTP request (Desktop bridge, gateway, plugin host) has to stay open for
# the whole build. Jobs run on one private event loop thread per process; its handle lives in env.state, which
# survives an engine hot reload.

def _job_loop(env):
    state = env.state
    with _JOBS_LOCK:
        loop = state.get("generate_loop")
        if loop is not None and loop.is_running():
            return loop
        loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run():
            asyncio.set_event_loop(loop)
            loop.call_soon(ready.set)
            loop.run_forever()

        threading.Thread(target=run, name="arachne-flow-generate", daemon=True).start()
        ready.wait(5)
        state["generate_loop"] = loop
        return loop


_JOBS_LOCK = threading.RLock()


def _jobs(env) -> dict:
    return env.state.setdefault("generate_jobs", {})


def _prune(jobs: dict, now: float) -> None:
    done = [j for j in jobs.values() if j["status"] != "running"]
    for job in done:
        if now - job["finished_at"] > JOB_KEEP_S:
            jobs.pop(job["id"], None)
    if len(jobs) > MAX_JOBS:
        for job in sorted((j for j in jobs.values() if j["status"] != "running"), key=lambda j: j["finished_at"]):
            if len(jobs) <= MAX_JOBS:
                break
            jobs.pop(job["id"], None)


def _error_view(exc) -> dict:
    if isinstance(exc, S.ConflictError):
        return {"message": str(exc), "status": 409, "code": "conflict", "current_revision": exc.current_revision}
    if isinstance(exc, GenerateError):
        return {"message": str(exc), "status": exc.status}
    return {"message": f"Hermes could not generate the flow: {type(exc).__name__}: {exc}", "status": 502}


def job_view(job: dict) -> dict:
    end = job["finished_at"] if job["status"] != "running" else time.time()
    view = {"id": job["id"], "status": job["status"], "phase": job["phase"],
            "elapsed_s": round(max(0.0, end - job["started_at"]), 1), "flow_id": job["flow_id"]}
    if job.get("result") is not None:
        view["result"] = job["result"]
    if job.get("error") is not None:
        view["error"] = job["error"]
    return view


def start_job(env, body: dict, on_done=None) -> dict:
    """Validate now, build in the background. Returns the job view (status ``running``)."""
    prepared = _prepare(env, body)
    loop = _job_loop(env)
    now = time.time()
    job = {"id": "g_" + uuid.uuid4().hex[:12], "status": "running", "phase": "starting", "started_at": now,
           "finished_at": now, "flow_id": prepared["flow_id"], "result": None, "error": None, "future": None}

    def progress(name: str) -> None:
        job["phase"] = name

    async def run():
        try:
            result = await _generate(env, prepared, progress)
        except asyncio.CancelledError:
            job.update(status="cancelled", phase="cancelled", finished_at=time.time())
            raise
        except Exception as exc:  # noqa: BLE001 - every failure becomes a readable job error
            job.update(status="error", phase="failed", error=_error_view(exc), finished_at=time.time())
            return
        job.update(status="done", phase="done", result=result, finished_at=time.time())
        if callable(on_done):
            try:
                on_done(result)
            except Exception:  # noqa: BLE001 - the flow is saved; a lost change event must not fail the job
                pass

    with _JOBS_LOCK:
        jobs = _jobs(env)
        _prune(jobs, now)
        jobs[job["id"]] = job
    job["future"] = asyncio.run_coroutine_threadsafe(run(), loop)
    return job_view(job)


MAX_JOB_WAIT_S = 5


def get_job(env, job_id: str, wait: float = 0) -> dict:
    """The job's state. With ``wait`` (seconds, capped) it long-polls: it returns as soon as the job's phase or
    status changes, so the UI needs few requests and still sees the end at once. Blocking: call off the loop."""
    with _JOBS_LOCK:
        job = _jobs(env).get(job_id)
    if job is None:
        raise GenerateError("This build is unknown or expired.", 404)
    try:
        wait = min(max(float(wait or 0), 0.0), MAX_JOB_WAIT_S)
    except (TypeError, ValueError):
        wait = 0.0
    seen, end = (job["status"], job["phase"]), time.time() + wait
    while job["status"] == "running" and (job["status"], job["phase"]) == seen and time.time() < end:
        time.sleep(0.05)
    return job_view(job)


def cancel_job(env, job_id: str) -> dict:
    """Stop a running build. Nothing is saved unless the save already happened (then the job reports done)."""
    with _JOBS_LOCK:
        job = _jobs(env).get(job_id)
    if job is None:
        raise GenerateError("This build is unknown or expired.", 404)
    future = job.get("future")
    if job["status"] == "running" and future is not None:
        future.cancel()
        deadline = time.time() + 5
        while job["status"] == "running" and time.time() < deadline:
            time.sleep(0.02)
        if job["status"] == "running":   # cancelled before the coroutine ever started
            job.update(status="cancelled", phase="cancelled", finished_at=time.time())
    return job_view(job)
