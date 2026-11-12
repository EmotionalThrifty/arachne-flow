"""Execute one node. The runner resolves and converts inputs; executors turn
(node, spec, inputs) into an outputs dict ``{port_name: value}`` or raise NodeError.

Blocking host calls (tools, LLM, downloads) run in worker threads with a timeout. A timed-out
thread cannot be killed; its late result is simply discarded.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from . import data_nodes as D
from . import graph as G
from . import media as M
from . import types as ptypes

logger = logging.getLogger("arachne-flow.executors")

DEFAULT_TIMEOUT_S = 120.0
_TEXT_KEYS = ("text", "content", "result", "output", "answer", "message", "summary", "markdown", "response")
_ERROR_ENVELOPE_KEYS = {"error", "error_type", "success", "details", "detail", "hint", "status", "tool", "code"}
_PATH_TOKEN = re.compile(r"\[(-?\d+)\]|\.?([^.\[\]]+)")


class NodeError(Exception):
    """A node failed; the message is shown to the user as is."""


@dataclass
class NodeContext:
    run_id: str
    node_id: str
    out_dir: str                              # outputs/<run_id>
    flow_id: Optional[str] = None             # required for recipient-scoped messaging consent
    approved: frozenset = frozenset()         # real paths the user picked in this flow's canvas (picks.py)
    timeout_s: float = DEFAULT_TIMEOUT_S
    allow_download: bool = True
    # Required on purpose: a silent no-op default hid every job status line (E-1).
    log: Callable[[str], None] = field(kw_only=True)


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


async def call_blocking(fn: Callable, *args, timeout: float, what: str, **kwargs):
    try:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args, **kwargs), timeout=timeout)
    except asyncio.TimeoutError:
        raise NodeError(f"{what} timed out after {int(timeout)} s") from None


def node_timeout(node: dict, nctx: NodeContext) -> float:
    raw = (node.get("params") or {}).get("timeout_s")
    try:
        value = float(raw)
        if value > 0:
            return min(value, 3600.0)
    except (TypeError, ValueError):
        pass
    return nctx.timeout_s


# ----------------------------------------------------------------- templates and paths

def render_template(template: str, inputs: dict) -> str:
    def sub(m):
        return ptypes.to_text(inputs.get(m.group(1)))
    return G.PLACEHOLDER_RE.sub(sub, template or "")


def pick(data, path: str):
    """Value at ``a.b[0].c`` (``a.b.0.c`` works too); JSON text is parsed first. Raises KeyError."""
    if isinstance(data, str):
        try:
            data = ptypes.loads_untrusted(data)
        except ValueError:
            pass
    current = data
    path = (path or "").strip()
    if not path:
        return current
    for m in _PATH_TOKEN.finditer(path):
        index, name = m.group(1), m.group(2)
        if isinstance(current, str) and current.strip()[:1] in "[{":
            try:
                current = ptypes.loads_untrusted(current)
            except ValueError:
                pass
        if index is not None:
            if not isinstance(current, list):
                raise KeyError(f"[{index}]")
            current = current[int(index)]
        elif isinstance(current, dict) and name in current:
            current = current[name]
        elif isinstance(current, list) and name.lstrip("-").isdigit():
            current = current[int(name)]
        else:
            raise KeyError(name)
    return current


# ----------------------------------------------------------------- tool results

def parse_tool_result(raw) -> Any:
    """str (JSON or plain) or the registry's multimodal dict -> python value."""
    if isinstance(raw, dict):
        return ptypes.defang(raw)          # review E-2: a tool cannot hand back engine media values
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    if isinstance(raw, str):
        text = raw.strip()
        if text[:1] in "{[":
            try:
                return ptypes.loads_untrusted(text)
            except ValueError:
                return raw
        return raw
    return raw


_APPROVAL_STATES = {"approval_required", "pending_approval"}
_APPROVAL_HINT = ("Arachne Flow cannot answer approval prompts: run this step from the chat, "
                  "or allow it in Hermes' approval settings.")


def _blocked_text(value) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.lstrip().startswith("BLOCKED:") else None


def approval_error(result) -> Optional[str]:
    """The node error when Hermes held the call for approval or blocked it (review E-4), else None.

    Shapes: ``tools/approval.py`` (``approved: false`` + ``status`` approval_required/pending_approval),
    ``tools/terminal_tool.py`` (``status`` pending_approval/blocked inside the output envelope) and plain
    ``BLOCKED: …`` text. Such a result is never a success: the tool did not run."""
    if isinstance(result, str):
        text = _blocked_text(result)
        return f"Hermes blocked this tool call: {text[:1500]}" if text else None
    if not isinstance(result, dict) or result.get("_multimodal"):
        return None
    status = result.get("status")
    if result.get("approval_pending") is True or status in _APPROVAL_STATES or (
            result.get("approved") is False and ("status" in result or "message" in result)):
        what = result.get("description") or result.get("command") or "this tool call"
        return f"This step needs approval ({str(what)[:300]}). {_APPROVAL_HINT}"
    reason = _blocked_text(result.get("error")) or _blocked_text(result.get("message"))
    if status == "blocked" or reason:
        reason = reason or str(result.get("error") or result.get("message") or "no reason given")
        return f"Hermes blocked this tool call: {reason[:1500]}"
    return None


def tool_error(result) -> Optional[str]:
    """The error message when a tool result is a failure envelope, else None."""
    held = approval_error(result)
    if held:
        return held
    if not isinstance(result, dict) or result.get("_multimodal"):
        return None
    if result.get("success") is False:
        return str(result.get("error") or result.get("message") or "tool reported failure")
    error = result.get("error")
    if error and set(result) <= _ERROR_ENVELOPE_KEYS:
        return str(error) if not isinstance(error, dict) else json.dumps(error)[:500]
    if result.get("isError") is True:
        return best_text(result) or "tool reported an error"
    return None


def best_text(result) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        if result.get("_multimodal"):
            parts = [p.get("text", "") for p in result.get("content", []) if isinstance(p, dict) and p.get("type") == "text"]
            return "\n".join(p for p in parts if p)
        for key in _TEXT_KEYS:
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value
        content = result.get("content")
        if isinstance(content, list):
            parts = [c.get("text") for c in content if isinstance(c, dict) and isinstance(c.get("text"), str)]
            if parts:
                return "\n".join(parts)
    return ptypes.to_text(result)


def multimodal_refs(result) -> list:
    """data: URLs for image parts of a multimodal tool result."""
    refs = []
    if isinstance(result, dict) and result.get("_multimodal"):
        for part in result.get("content", []):
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image" and part.get("data"):
                refs.append(f"data:{part.get('mimeType') or part.get('mime_type') or 'image/png'};base64,{part['data']}")
            elif part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url") if isinstance(part.get("image_url"), dict) else part.get("image_url")
                if isinstance(url, str):
                    refs.append(url)
    return refs


def collect_media(result, nctx: NodeContext) -> list:
    stem = nctx.node_id
    found = []
    for i, ref in enumerate(multimodal_refs(result)):
        try:
            found.append(M.ingest(ref, nctx.out_dir, f"{stem}-mm{i}", allow_download=nctx.allow_download))
        except Exception as exc:  # noqa: BLE001
            logger.info("arachne-flow: multimodal part skipped: %s", exc)
            nctx.log(f"media skipped: {exc}")
    if not found:
        found = M.extract_media(result, nctx.out_dir, stem, allow_download=nctx.allow_download, log=nctx.log)
    return found


# ----------------------------------------------------------------- tool nodes

def build_tool_args(spec: dict, node: dict, inputs: dict) -> dict:
    """Arguments for a tool node: connected inputs win over inspector params; blanks are omitted."""
    params = node.get("params") or {}
    kinds = {p["name"]: p.get("kind") for p in spec.get("params", [])}
    # Blank model settings fall back to the spec's default (presets ship one), so older nodes keep working.
    fallback = {p["name"]: p.get("default") for p in spec.get("params", [])
                if (p.get("options_source") or p.get("fallback")) and not _blank(p.get("default"))}
    ports = {p["name"]: p for p in spec.get("inputs", [])}
    args = {}
    for name in [p["name"] for p in spec.get("params", [])] or list(ports):
        from_input = name in inputs and inputs[name] is not None
        if from_input:
            value = inputs[name]
            if ports.get(name, {}).get("multiple") and kinds.get(name) == "media_list":
                direct = params.get(name)
                if isinstance(direct, str):
                    try:
                        direct = json.loads(direct)
                    except ValueError:
                        direct = [direct]
                    direct = direct if isinstance(direct, list) else [direct]
                if isinstance(direct, list) and direct:
                    value = list(direct) + (list(value) if isinstance(value, list) else [value])
        else:
            value = params.get(name)
            if _blank(value):
                value = fallback.get(name)
            if _blank(value):
                continue
            if kinds.get(name) == "json" and isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    raise NodeError(f"parameter {name!r} is not valid JSON") from None
            elif kinds.get(name) == "multiselect" and isinstance(value, str):  # G7: '["a","b"]' or a single choice
                try:
                    value = json.loads(value)
                except ValueError:
                    value = [value]
                value = value if isinstance(value, list) else [value]
            elif kinds.get(name) == "number" and isinstance(value, str):
                try:
                    value = ptypes.convert(value, "number")
                except ptypes.ConversionError as exc:
                    raise NodeError(f"parameter {name!r}: {exc}") from None
        expects_list = ports.get(name, {}).get("multiple") or kinds.get(name) in ("json", "multiselect", "media_list")
        if from_input and isinstance(value, list) and not expects_list:
            # A multi-image upstream may feed a single-image model: use its first image (G8).
            value = value[0] if value else None
        if kinds.get(name) == "media_list" and not isinstance(value, list):
            value = [value]
        if ptypes.is_media(value) or kinds.get(name) in ("media", "media_list"):
            try:
                value = M.to_arg(value, name)
            except (M.MediaError, OSError) as exc:
                raise NodeError(f"{name}: {exc}") from None
        elif ports.get(name, {}).get("type") == "text" and not isinstance(value, str):
            value = ptypes.to_text(value)
        args[name] = value
    missing = [p["name"] for p in spec.get("inputs", []) if p.get("required") and _blank(args.get(p["name"]))]
    if missing:
        raise NodeError("missing required input: " + ", ".join(missing))
    return args


async def call_tool(env, tool: str, args: dict, timeout: float):
    ctx = getattr(env, "ctx", None)
    if ctx is None or not hasattr(ctx, "dispatch_tool"):
        raise NodeError("Hermes tool access is not available in this process")
    raw = await call_blocking(ctx.dispatch_tool, tool, args, timeout=timeout, what=f"tool {tool}")
    result = parse_tool_result(raw)
    error = tool_error(result)
    if error:
        raise NodeError(error[:2000])
    return result


async def run_tool_node(env, node, spec, inputs, nctx: NodeContext) -> dict:
    from . import options as O  # late import: options imports this module

    args = build_tool_args(spec, node, inputs)
    args.update(await O.model_extras(env, spec, node))  # the chosen model's own settings (G7b)
    result = await call_tool(env, spec["tool"], args, node_timeout(node, nctx))
    media = await asyncio.to_thread(collect_media, result, nctx)
    outputs = {"result": result, "text": best_text(result), "media": media[0] if media else None}
    if len(media) > 1:
        outputs["_media"] = media
    return outputs


# ----------------------------------------------------------------- built-ins

async def _input_text(env, node, spec, inputs, nctx):
    return {"text": ptypes.to_text((node.get("params") or {}).get("value", ""))}


async def _input_number(env, node, spec, inputs, nctx):
    raw = (node.get("params") or {}).get("value", 0)
    try:
        return {"number": ptypes.convert(0 if _blank(raw) else raw, "number")}
    except ptypes.ConversionError as exc:
        raise NodeError(str(exc)) from None


async def _input_file(env, node, spec, inputs, nctx):
    params = node.get("params") or {}
    path = str(params.get("path") or "").strip().strip('"')
    if not path:
        raise NodeError("choose a file path")
    kind = params.get("kind") or "auto"
    try:
        M.require_local_path(path)
        M.require_readable(path)
        _require_picked(env, node, path, nctx)
        value = M.from_local(path, copy=False, kind=None if kind == "auto" else kind)
    except M.MediaError as exc:
        raise NodeError(str(exc)) from None
    return {"file": value}


def _require_picked(env, node, path, nctx) -> None:
    """Catalog review: a File node reads a path only when the user picked it for this node in the canvas or it
    lies in Arachne Flow's uploads folder (canvas drops). A path set by the agent (flow_apply, flow_run inputs)
    or a template is refused before any tool runs."""
    from . import picks as P
    from . import store as S
    real = M.real_path(path)
    uploads = M.real_path(S.uploads_dir(env)).rstrip("\\/")
    if real.startswith(uploads + os.sep):
        return
    if real in P.node_picks(env, getattr(nctx, "flow_id", None), node):
        return
    raise NodeError(f"{path} was not picked in the canvas. Choose it with Browse… or drop it onto the canvas "
                    "(paths set by the agent are accepted only inside Arachne Flow's uploads folder)")


async def _text_template(env, node, spec, inputs, nctx):
    return {"text": render_template((node.get("params") or {}).get("template", ""), inputs)}


async def _json_pick(env, node, spec, inputs, nctx):
    path = (node.get("params") or {}).get("path", "")
    try:
        return {"value": pick(inputs.get("data"), path)}
    except (KeyError, IndexError, TypeError) as exc:
        raise NodeError(f"path {path!r} not found (at {exc})") from None


def _llm_call(llm, messages, kwargs):
    """The one sync bridge to PluginLlm.complete: called in a worker thread (call_blocking) by both the LLM
    node and flow generation (review E-14)."""
    return llm.complete(messages=messages, **kwargs)


async def _llm_complete(env, node, spec, inputs, nctx):
    params = node.get("params") or {}
    llm = getattr(getattr(env, "ctx", None), "llm", None)
    if llm is None or not hasattr(llm, "complete"):
        raise NodeError("Hermes LLM access is not available in this process")
    prompt = render_template(params.get("template", "{{prompt}}"), inputs)
    if not prompt.strip():
        raise NodeError("the prompt is empty")
    messages = []
    if not _blank(params.get("system")):
        messages.append({"role": "system", "content": str(params["system"])})
    messages.append({"role": "user", "content": prompt})
    kwargs = {"purpose": "arachne-flow node"}
    for key in ("provider", "model"):
        if not _blank(params.get(key)):
            kwargs[key] = str(params[key]).strip()
    for key, kind in (("temperature", float), ("max_tokens", int)):
        if not _blank(params.get(key)):
            try:
                kwargs[key] = kind(params[key])
            except (TypeError, ValueError):
                raise NodeError(f"{key} must be a number") from None
    timeout = node_timeout(node, nctx)
    kwargs["timeout"] = timeout
    try:
        result = await call_blocking(_llm_call, llm, messages, kwargs, timeout=timeout + 5, what="LLM call")
    except NodeError:
        raise
    except TypeError:
        kwargs.pop("purpose", None)
        result = await call_blocking(_llm_call, llm, messages, kwargs, timeout=timeout + 5, what="LLM call")
    except PermissionError as exc:  # PluginLlmTrustError: model choice not allowed in config.yaml
        raise NodeError(
            "Hermes does not allow Arachne Flow to pick a model. Set plugins.entries.arachne-flow.llm."
            "allow_model_override and allow_provider_override to true in config.yaml, or set Model back to "
            f"'Hermes default'. ({exc})") from None
    except Exception as exc:  # noqa: BLE001 - provider errors become node errors
        hint = ""
        if "model" not in kwargs and re.search(r"credential|token|api key|auth", str(exc), re.I):
            hint = (" Hermes' active model is not reachable from the Desktop backend; pick a model in this "
                    "node's Model list instead.")
        raise NodeError(f"LLM call failed: {exc}{hint}") from None
    text = getattr(result, "text", result)
    return {"text": text if isinstance(text, str) else ptypes.to_text(text)}


# ----------------------------------------------------------------- control flow (G10)
# If/Switch return only the taken output plus BRANCH = its port name; the runner skips everything that hangs off
# the other outputs. Merge gets the first live wire's value from the runner (runner._Execution.merge_value).
BRANCH = "_branch"
IF_OPS = ("contains", "not contains", "equals", "not equals", "regex", ">", ">=", "<", "<=", "empty", "not empty")
SWITCH_OPS = ("equals", "contains", "starts with", "regex")
_REGEX_TEXT_LIMIT = 16_384
_REGEX_PATTERN_LIMIT = 512
_REGEX_TIMEOUT_S = 0.5  # includes isolated interpreter startup; subprocess.run kills and reaps on timeout


def _as_text(value) -> str:
    return value if isinstance(value, str) else ptypes.to_text(value)


def _is_empty(value) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


def _as_number(value, what: str) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = _as_text(value).strip()
    try:
        return float(text)
    except ValueError:
        raise NodeError(f"{what} is not a number: {text[:60]!r} (decimals use a dot, e.g. 0.5)") from None


def _regex(pattern: str, text: str, case_sensitive: bool) -> bool:
    # Even tiny input can backtrack indefinitely. A thread timeout cannot stop stdlib re holding the GIL.
    if len(pattern) > _REGEX_PATTERN_LIMIT or len(text) > _REGEX_TEXT_LIMIT:
        raise NodeError(f"regular expression input is too large (pattern max {_REGEX_PATTERN_LIMIT}, "
                        f"text max {_REGEX_TEXT_LIMIT} characters)")
    payload = json.dumps({"pattern": pattern, "text": text, "case_sensitive": case_sensitive}, ensure_ascii=True)
    worker = os.path.join(os.path.dirname(__file__), "regex_worker.py")
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-S", worker], input=payload.encode("ascii"), capture_output=True,
            timeout=_REGEX_TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode:
            raise NodeError("regular expression worker failed; expression was not evaluated")
        reply = json.loads(result.stdout)
        if reply.get("error"):
            raise NodeError(f"invalid regular expression {pattern!r}: {reply['error']}")
        if not isinstance(reply.get("matched"), bool):
            raise NodeError("regular expression worker returned an invalid result")
        return reply["matched"]
    except subprocess.TimeoutExpired:
        raise NodeError("regular expression timed out; simplify the pattern or use contains/equals") from None
    except (OSError, ValueError, AttributeError) as exc:
        raise NodeError(f"regular expression could not be evaluated: {exc}") from None


def check_condition(op: str, value, compare, case_sensitive: bool = False) -> bool:
    """The If test. Text ops trim nothing but equals; numbers need both sides numeric."""
    if op in ("empty", "not empty"):
        return _is_empty(value) == (op == "empty")
    if op in (">", ">=", "<", "<="):
        a, b = _as_number(value, "value"), _as_number(compare, "compare to")
        return {">": a > b, ">=": a >= b, "<": a < b, "<=": a <= b}[op]
    text, other = _as_text(value), _as_text("" if compare is None else compare)
    if op == "regex":
        return _regex(other, text, case_sensitive)
    if not case_sensitive:
        text, other = text.casefold(), other.casefold()
    if op in ("contains", "not contains"):
        return (other in text) == (op == "contains")
    if op in ("equals", "not equals"):
        return (text.strip() == other.strip()) == (op == "equals")
    raise NodeError(f"unknown condition {op!r}; use one of: {', '.join(IF_OPS)}")


def _truthy_param(value) -> bool:
    return value is True or str(value).strip().lower() in ("true", "1", "yes", "on")


async def _logic_if(env, node, spec, inputs, nctx):
    params = node.get("params") or {}
    compare = inputs["compare"] if inputs.get("compare") is not None else params.get("compare", "")
    op = str(params.get("op") or "contains")
    args = (op, inputs.get("value"), compare, _truthy_param(params.get("case_sensitive")))
    matched = await asyncio.to_thread(check_condition, *args) if op == "regex" else check_condition(*args)
    taken = "true" if matched else "false"
    return {taken: inputs.get("value"), BRANCH: taken}


def switch_match(op: str, value, case: str, case_sensitive: bool) -> bool:
    text = _as_text(value)
    if op == "regex":
        return _regex(case, text, case_sensitive)
    if not case_sensitive:
        text, case = text.casefold(), case.casefold()
    if op == "equals":
        return text.strip() == case.strip()
    if op == "contains":
        return case in text
    if op == "starts with":
        return text.lstrip().startswith(case)
    raise NodeError(f"unknown match {op!r}; use one of: {', '.join(SWITCH_OPS)}")


async def _logic_switch(env, node, spec, inputs, nctx):
    params = node.get("params") or {}
    op, sensitive = str(params.get("op") or "equals"), _truthy_param(params.get("case_sensitive"))
    taken = "default"
    for i, case in enumerate(G.switch_cases(params.get("cases")), 1):
        args = (op, inputs.get("value"), case, sensitive)
        matched = await asyncio.to_thread(switch_match, *args) if op == "regex" else switch_match(*args)
        if matched:
            taken = f"case{i}"
            break
    return {taken: inputs.get("value"), BRANCH: taken}


async def _logic_merge(env, node, spec, inputs, nctx):
    return {"value": inputs.get("value")}


def list_items(value) -> list:
    """For each input -> items: lists stay, a JSON list in text is parsed, other text is split into non-empty
    trimmed lines, nothing is no items, anything else is one item."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                parsed = ptypes.loads_untrusted(text)
                if isinstance(parsed, list):
                    return parsed
            except ValueError:
                pass
        return [line.strip() for line in value.splitlines() if line.strip()]
    return [value]


async def _logic_foreach(env, node, spec, inputs, nctx):
    # the runner runs the loop body per item (runner._Execution.run_loop); this only lists the items
    return {"item": list_items(inputs.get("list"))}


async def _logic_collect(env, node, spec, inputs, nctx):
    return {"list": list(inputs.get("value") or [])}


async def _output_preview(env, node, spec, inputs, nctx):
    return {"value": inputs.get("value")}


async def _output_send_message(env, node, spec, inputs, nctx):
    """One intentional send, one host call; never cached, retried or target-rewired."""
    import asyncio
    import hmac
    import threading
    import time
    from . import messaging as MSG
    from . import nodes as N
    from . import store

    params = node.get("params") or {}
    target = params.get("target")
    if not isinstance(target, str) or not target.strip() or len(target) > 1000 or any(ord(c) < 32 for c in target):
        raise NodeError("choose a valid fixed recipient in the node settings")
    target = target.strip()
    if inputs.get("target") is not None:
        raise NodeError("the recipient must be fixed in the node settings; remove the target wire and re-enable it")
    if params.get("send_enabled") is not True:
        raise NodeError("Enable sending to this exact recipient in the inspector before running the flow")
    if params.get("authorized_target") != target:
        raise NodeError("the recipient changed since it was enabled; review it and enable sending again")
    flow_id = getattr(nctx, "flow_id", None)
    node_id = node.get("id")
    if not MSG.token_matches(env, flow_id, node_id, params):
        raise NodeError("sending is not authorized for this recipient. Enable it in the inspector (a copied or "
                        "edited flow needs a fresh opt-in)")
    names = {t.get("name") for t in N.registry_tools(env)}
    if MSG.SEND_TOOL not in names or MSG.CHANNEL_TOOL not in names:
        raise NodeError("Hermes' official messaging bridge is not available. Enable its channels_list and messages_send tools")
    message = inputs.get("message") if inputs.get("message") is not None else params.get("message")
    attachment = inputs.get("attachment")
    if message is None:
        message = ""
    if not isinstance(message, str):
        raise NodeError("the message must be plain text")
    if len(message) > 100_000 or "media:" in message.casefold() or any(
            tag in message.casefold() for tag in ("[[as_document]]", "[[audio_as_voice]]")):
        raise NodeError("message text cannot contain MEDIA: or attachment control markers")
    if attachment is None and not message.strip():
        raise NodeError("the message must be non-empty plain text or include an attachment")
    if attachment is not None:
        if params.get("allow_attachments") is not True:
            raise NodeError("attachment sending is not enabled for this recipient")
        try:
            MSG.attachment_path(env, attachment, nctx.run_id)
        except ValueError as exc:
            raise NodeError(str(exc)) from None

    ctx = getattr(env, "ctx", None)
    if ctx is None or not hasattr(ctx, "dispatch_tool"):
        raise NodeError("Hermes tool access is not available in this process")

    timeout = node_timeout(node, nctx)
    deadline = time.monotonic() + timeout
    abandoned = threading.Event()

    def _send_worker():
        if abandoned.is_set() or time.monotonic() >= deadline:
            return None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out before lock")
        try:
            with store.flow_lock(env, flow_id, timeout_s=max(remaining, 1e-6)):
                if abandoned.is_set() or time.monotonic() >= deadline:
                    return None
                try:
                    flow = store.get_flow(env, flow_id)
                except Exception:
                    raise NodeError("sending is not authorized: corrupt flow storage") from None
                if not isinstance(flow, dict):
                    raise NodeError("sending is not authorized: flow consent missing")
                nodes = flow.get("nodes")
                if not isinstance(nodes, list):
                    raise NodeError("sending is not authorized: flow corrupt")
                stored_node = next((n for n in nodes if isinstance(n, dict) and n.get("id") == node_id), None)
                if not stored_node or stored_node.get("type") != MSG.NODE_TYPE:
                    raise NodeError("sending is not authorized: node or consent missing")
                stored_params = stored_node.get("params")
                if not isinstance(stored_params, dict):
                    raise NodeError("sending is not authorized: missing node consent")
                if not MSG.token_matches(env, flow_id, node_id, stored_params):
                    raise NodeError("sending is not authorized: stored consent revoked or invalid")
                stored_target = stored_params.get("target")
                if not isinstance(stored_target, str) or stored_target.strip() != target:
                    raise NodeError("sending is not authorized: stored recipient does not match")
                stored_token = stored_params.get("optin_token")
                snapshot_token = params.get("optin_token")
                if (not isinstance(stored_token, str) or not isinstance(snapshot_token, str) or
                        not hmac.compare_digest(stored_token, snapshot_token)):
                    raise NodeError("sending is not authorized: stored consent token mismatch")
                if abandoned.is_set() or time.monotonic() >= deadline:
                    return None
                outgoing = message
                if attachment is not None:
                    if stored_params.get("allow_attachments") is not True:
                        raise NodeError("attachment sending is not authorized")
                    try:
                        # Revalidate inside the locked dispatch boundary after waiting.
                        path = MSG.attachment_path(env, attachment, nctx.run_id)
                    except ValueError as exc:
                        raise NodeError(str(exc)) from None
                    outgoing = (message.rstrip() + "\n" if message.strip() else "") + 'MEDIA:"' + path + '"'
                if abandoned.is_set() or time.monotonic() >= deadline:
                    return None
                try:
                    return ctx.dispatch_tool(MSG.SEND_TOOL, {"target": target, "message": outgoing})
                except Exception:
                    raise NodeError(
                        "delivery status is unconfirmed after host error. Do not re-run automatically; check the recipient before retrying."
                    ) from None
        except TimeoutError:
            raise NodeError(
                "delivery status is unconfirmed after the timeout. Do not re-run automatically; check the recipient before retrying."
            ) from None

    nctx.log("sending to the explicitly enabled recipient; no automatic retry")
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(_send_worker), timeout=timeout)
    except asyncio.TimeoutError:
        abandoned.set()
        raise NodeError(
            "delivery status is unconfirmed after the timeout. Do not re-run automatically; check the recipient before retrying."
        ) from None
    except asyncio.CancelledError:
        abandoned.set()
        nctx.log("delivery status is unconfirmed after cancellation; do not retry")
        raise
    finally:
        abandoned.set()

    if raw is None:
        raise NodeError(
            "delivery status is unconfirmed after the timeout. Do not re-run automatically; check the recipient before retrying."
        )
    try:
        result = parse_tool_result(raw)
        MSG.validate_receipt(result, attachment=attachment is not None)
    except (ValueError, RecursionError) as exc:
        detail = str(exc)[:1500] if isinstance(exc, ValueError) else "invalid provider response"
        raise NodeError(detail + ". Delivery status is unconfirmed. Do not re-run automatically; "
                        "check the recipient before retrying.") from None
    nctx.log("the host reported success; this is not a recipient read receipt")
    return {"result": result, "text": "Delivery reported by Hermes (provider response only):\n" + best_text(result)[:6000], "media": None}


async def _note(env, node, spec, inputs, nctx):
    return {}


BUILTIN = {
    "input.text": _input_text,
    "input.number": _input_number,
    "input.file": _input_file,
    "text.template": _text_template,
    "json.pick": _json_pick,
    "llm.complete": _llm_complete,
    "logic.if": _logic_if,
    "logic.switch": _logic_switch,
    "logic.merge": _logic_merge,
    "logic.foreach": _logic_foreach,
    "logic.collect": _logic_collect,
    "output.preview": _output_preview,
    "output.send_message": _output_send_message,
    "note": _note,
}

BUILTIN.update({name: D.execute for name in D.TYPES})


async def _trigger(env, node, spec, inputs, nctx):
    from . import triggers as T
    return await T.execute(env, node, spec, inputs, nctx)


BUILTIN.update({name: _trigger for name in ("trigger.schedule", "trigger.rss", "trigger.webhook")})


async def execute(env, node: dict, spec: dict, inputs: dict, nctx: NodeContext) -> dict:
    """Run one node. Raises NodeError for user-facing failures."""
    if spec is None:
        raise NodeError(f"unknown node type {node.get('type')!r} (tool missing or blocked?)")
    token = M.set_approved(getattr(nctx, "approved", None) or (), roots=(getattr(nctx, "out_dir", None),))
    try:
        handler = BUILTIN.get(node.get("type"))
        if handler is not None:
            return await handler(env, node, spec, inputs, nctx)
        if spec.get("kind") == "tool":
            return await run_tool_node(env, node, spec, inputs, nctx)
        if spec.get("kind") == "preset":
            from . import presets
            return await presets.execute(env, node, spec, inputs, nctx)
        raise NodeError(f"no executor for node type {node.get('type')!r}")
    finally:
        M.reset_approved(token)


def out_dir_for(env, run_id: str) -> str:
    from . import store
    return store.outputs_dir(env, run_id)


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path
