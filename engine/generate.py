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

from . import executors as E
from . import graph as G
from . import nodes as N
from . import store as S
from .executors import _llm_call   # review E-14: one sync bridge for both the LLM node and generation

SKILL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "skills", "arachne-flow", "SKILL.md")
MAX_PROMPT_CHARS = 12000
LLM_TIMEOUT_S = 30
# Interactive UI work: at most two bounded proposals, including the single repair.
GENERATION_TIMEOUT_S = 65
MAX_CATALOG_CHARS = 24000
MAX_REPLY_TOKENS = 3072
MAX_REPAIRS = 1
GENERATE_TASK = "arachne_flow_generate"
GENERATE_TASK_VERSION = 3
GENERATE_TASK_DEFAULTS = {"timeout": LLM_TIMEOUT_S, "reasoning_effort": "low"}


class GenerateError(ValueError):
    """A safe, user-displayable generation failure."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class CandidateError(ValueError):
    """A model answer that can be sent back for its single repair round."""


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
            "The selected model did not finish the flow proposal within the interactive deadline. "
            "No changes were saved; your prompt is preserved. Try a smaller request or another model.", 504) from None
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


def _candidate(base: dict | None, proposed: dict, types: dict, fallback_name: str, base_errors=None):
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


async def generate(env, body: dict) -> dict:
    # A single budget spans both proposals. Timed-out workers never reach the save below.
    try:
        return await asyncio.wait_for(_generate(env, body), timeout=GENERATION_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise GenerateError("Hermes could not finish within the generation deadline. Your prompt is preserved; try a smaller request or another model.", 504) from None


async def _generate(env, body: dict) -> dict:
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

    types = N.types_by_name(env)
    base_issues = G.validate(before, types) if before is not None else []
    base_errors = [i for i in base_issues if i.get("level") == "error"]
    messages = build_messages(prompt, before, types, known_issues=base_errors)
    raw = await _complete(env, messages, model=model, provider=provider)
    fallback_name = prompt.splitlines()[0][:80] or "Generated flow"
    candidate = None
    repaired = False
    first_error = None
    for attempt in range(MAX_REPAIRS + 1):
        try:
            proposed = parse_answer(raw)
            candidate, _results = _candidate(before, proposed, types, fallback_name, base_errors=base_errors)
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
            raw = await _complete(env, messages, model=model, provider=provider)

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
