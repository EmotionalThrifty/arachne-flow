"""Explicit messaging through Hermes' official, user-enabled MCP bridge.

No private host imports and no platform credentials. The two tools below must be
registered through ``ctx.dispatch_tool``; the dedicated node is otherwise absent.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets

CHANNEL_TOOL = "mcp__messaging__channels_list"
SEND_TOOL = "mcp__messaging__messages_send"
NODE_TYPE = "output.send_message"


def _secret(env) -> bytes:
    """Publish a complete install key once; never replace an unreadable/corrupt key."""
    import tempfile
    from . import store
    folder = store.data_dir(env)
    path = os.path.join(folder, "messaging-secret")

    def read_key():
        with open(path, "rb") as fh:
            value = fh.read(33)
        if len(value) != 32:
            raise ValueError("invalid messaging key; sending is disabled")
        return value

    try:
        return read_key()
    except FileNotFoundError:
        pass
    # A unique, fully flushed file is linked into place without overwriting a winner.
    # A competing reader can never observe an empty or half-written key.
    fd, staged = tempfile.mkstemp(prefix=".messaging-key-", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            value = secrets.token_bytes(32)
            fh.write(value)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.link(staged, path)
        except FileExistsError:
            return read_key()
        return value
    finally:
        os.unlink(staged)


def optin_token(env, flow_id: str, node_id: str, target: str, allow_attachments: bool = False) -> str:
    """Only the opt-in route mints this, for one immutable flow/node/target triple."""
    import secrets
    parts = (flow_id, node_id, target)
    if not all(isinstance(part, str) and part.strip() for part in parts):
        raise ValueError("flow, node and recipient are required for messaging opt-in")
    nonce = secrets.token_hex(16)
    version = "send-message-v3-files" if allow_attachments is True else "send-message-v2"
    payload = version + "\x1f" + "\x1f".join(part.strip() for part in parts) + "\x1f" + nonce
    mac = hmac.new(_secret(env), payload.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    return nonce + mac


def token_matches(env, flow_id: str, node_id: str, params: dict) -> bool:
    """A readable token alone is not enough: storage also requires unchanged prior consent."""
    if not isinstance(params, dict) or params.get("send_enabled") is not True:
        return False
    token, target = params.get("optin_token"), params.get("target")
    if not isinstance(token, str) or len(token) != 64 or not isinstance(target, str) or not target.strip():
        return False
    if any(c not in "0123456789abcdefABCDEF" for c in token):
        return False
    if params.get("authorized_target") != target.strip():
        return False
    if not all(isinstance(value, str) and value.strip() for value in (flow_id, node_id)):
        return False
    scope = params.get("allow_attachments")
    if scope is not None and type(scope) is not bool:
        return False
    version = "send-message-v3-files" if scope is True else "send-message-v2"
    nonce, mac_part = token[:32], token[32:]
    payload = version + "\x1f" + flow_id.strip() + "\x1f" + node_id.strip() + "\x1f" + target.strip() + "\x1f" + nonce
    try:
        expected_mac = hmac.new(_secret(env), payload.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    except (OSError, TypeError, ValueError):
        return False
    return hmac.compare_digest(mac_part.lower(), expected_mac.lower())


def response_values(result, max_depth: int = 6):
    """Yield a bounded MCP receipt and its recognized JSON/text payload envelopes.

    This intentionally does not recursively walk arbitrary provider data. Plain non-JSON
    text remains a valid receipt; explicit error objects at every recognized level are not.
    """
    pending = [(result, 0)]
    for _ in range(32):
        if not pending:
            return
        value, depth = pending.pop(0)
        yield value
        if depth >= max_depth:
            continue
        nested = []
        if isinstance(value, dict):
            nested = [value.get(key) for key in ("result", "structuredContent") if key in value]
            content = value.get("content")
            if isinstance(content, list):
                nested.extend(part.get("text") for part in content[:16]
                              if isinstance(part, dict) and part.get("type") == "text")
        elif isinstance(value, list):
            nested = [part.get("text") for part in value[:16]
                      if isinstance(part, dict) and part.get("type") == "text"]
        elif isinstance(value, str) and len(value) <= 100_000:
            text = value.strip()
            if text[:1] in "[{":
                try:
                    nested = [json.loads(text)]
                except ValueError:
                    pass
        pending.extend((item, depth + 1) for item in nested if item is not value and item is not None)


def validate_receipt(result, attachment: bool = False) -> bool:
    """Require explicit success and inspect every bounded, recognized MCP envelope.

    Success in one sibling never overrides a failure, skipped send, approval or
    ambiguous result in another. Unknown provider metadata is not traversed.
    """
    pending = [(result, 0)]
    visited = 0
    confirmed = False
    # A provider may acknowledge a queued request as success. A supplied status
    # must describe a terminal success, not merely acceptance or an unknown state.
    confirmed_statuses = {"success", "succeeded", "sent", "delivered", "done",
                          "complete", "completed", "ok"}

    def enqueue(value, depth):
        if depth > 8 or visited + len(pending) >= 128:
            raise ValueError("receipt envelope limit exceeded; delivery status is unconfirmed")
        pending.append((value, depth))

    def detail(value, fallback):
        return value.strip()[:1500] if isinstance(value, str) and value.strip() else fallback

    while pending:
        value, depth = pending.pop()
        visited += 1
        if isinstance(value, str):
            if len(value) > 100_000:
                raise ValueError("receipt text limit exceeded; delivery status is unconfirmed")
            text = value.strip()
            if text.startswith("BLOCKED:"):
                raise ValueError("Hermes blocked this tool call: " + text[:1500])
            if text and text[0] in "[{":
                try:
                    parsed = json.loads(text)
                except (ValueError, RecursionError):
                    raise ValueError("malformed receipt JSON; delivery status is unconfirmed") from None
                enqueue(parsed, depth + 1)
            continue
        if isinstance(value, list):
            if len(value) > 128 - visited - len(pending):
                raise ValueError("receipt envelope limit exceeded; delivery status is unconfirmed")
            for item in value:
                enqueue(item, depth + 1)
            continue
        if not isinstance(value, dict):
            raise ValueError("invalid receipt; delivery status is unconfirmed")
        if "success" in value:
            if type(value["success"]) is not bool:
                raise ValueError("invalid receipt: success must be boolean")
            if value["success"] is False:
                raise ValueError(detail(value.get("error") or value.get("message"), "host reported failure"))
            confirmed = True
        if value.get("error") or value.get("isError"):
            raise ValueError(detail(value.get("error") or value.get("message"), "host reported an error"))
        if value.get("approved") is False or value.get("approval_pending"):
            raise ValueError("This step needs approval; Arachne Flow cannot answer approval prompts")
        status = value.get("status")
        if status is not None:
            if not isinstance(status, str):
                raise ValueError("invalid receipt status; delivery status is unconfirmed")
            status = status.strip().casefold()
            if status in {"approval_required", "pending_approval"}:
                raise ValueError("This step needs approval; Arachne Flow cannot answer approval prompts")
            if status not in confirmed_statuses:
                raise ValueError(detail(value.get("message"), "unconfirmed host status=" + status))
        if attachment:
            if value.get("media_dropped") or value.get("warnings") or value.get("partial_success"):
                raise ValueError("attachment delivery incomplete or unconfirmed")
            if "media_delivered" in value and value["media_delivered"] is not True:
                raise ValueError("attachment delivery unconfirmed")
        if value.get("skipped"):
            raise ValueError("delivery was skipped")
        if any(value.get(k) for k in ("delivery_unconfirmed", "unconfirmed", "ambiguous")):
            raise ValueError("delivery status is unconfirmed or ambiguous")
        for key in ("message", "description", "reason"):
            text = value.get(key)
            if isinstance(text, str) and text.lstrip().startswith("BLOCKED:"):
                raise ValueError("Hermes blocked this tool call: " + text.strip()[:1500])
        for key in ("result", "structuredContent", "content"):
            if key in value:
                enqueue(value[key], depth + 1)
        if value.get("type") == "text":
            if not isinstance(value.get("text"), str):
                raise ValueError("invalid MCP text receipt")
            enqueue(value["text"], depth + 1)
    if not confirmed:
        raise ValueError("provider response missing success confirmation; delivery status is unconfirmed")
    return True



# Conservative subset common to the installed Hermes MEDIA parser and Arachne's
# output types. Unsupported suffixes fail rather than leaking a literal path.
ATTACHMENT_EXTENSIONS = frozenset({
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg',
    '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.ogg',
    '.opus', '.m4a', '.flac', '.pdf', '.txt', '.md', '.csv', '.zip',
})
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024


def attachment_path(env, value, run_id: str) -> str:
    """One engine-owned local artifact only; never accept a user-supplied path string."""
    from . import media, store, types
    if not types.is_media(value):
        raise ValueError("attachment must be a connected file or media value")
    raw = value['$media'].get('path')
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or not os.path.isabs(raw):
        raise ValueError("attachment has no valid local file path")
    if media.blocked_local_path(raw) or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        raise ValueError("attachment path contains unsafe characters")
    # MEDIA tags are quoted. Reject quote/backtick characters so the tag can
    # neither escape its quoted path nor inject a second transport directive.
    if any(c in raw for c in ('"', "'", '`')):
        raise ValueError("attachment path contains unsafe quoting characters")
    try:
        path = os.path.realpath(raw)
        root = os.path.realpath(store.outputs_dir(env, run_id, create=False))
        target, base = os.path.normcase(path), os.path.normcase(root)
        if os.path.commonpath((target, base)) != base or target == base:
            raise ValueError("attachment must be a file produced in the current run")
        if os.path.splitext(path)[1].lower() not in ATTACHMENT_EXTENSIONS:
            raise ValueError("unsupported attachment file type")
        if not os.path.isfile(path):
            raise ValueError("attachment file is missing")
        size = os.path.getsize(path)
        if size <= 0 or size > MAX_ATTACHMENT_BYTES:
            raise ValueError("attachment must be nonempty and at most 100 MiB")
        return path
    except (OSError, TypeError):
        raise ValueError("attachment file cannot be read") from None


def registered(tools) -> bool:
    names = {t.get("name") for t in tools or [] if isinstance(t, dict)}
    return CHANNEL_TOOL in names and SEND_TOOL in names


def spec() -> dict:
    return {
        "type": NODE_TYPE, "title": "Send message", "category": "Output", "icon": "send",
        "description": "Send text or an explicitly enabled file to one fixed recipient through Hermes' official messaging bridge. Every execution may send a real message; timeouts and cancellations have unconfirmed delivery status.",
        "inputs": [{"name": "message", "type": "text", "required": False, "label": "Message"},
                   {"name": "attachment", "type": "file", "required": False, "label": "Attachment"}],
        "outputs": [{"name": "result", "type": "json", "label": "Provider response"},
                    {"name": "text", "type": "text", "label": "Delivery summary"}],
        "params": [
            {"name": "target", "kind": "text", "label": "Recipient", "required": True,
             "options_source": "messaging_channels",
             "description": "A fixed target from the Hermes messaging bridge. If the list is empty, type one from `hermes send --list` (e.g. signal:<recipient>). Change it to require a new opt-in."},
            {"name": "message", "kind": "textarea", "label": "Message", "required": False,
             "description": "Optional plain text caption. Connect files to the Attachment port; text cannot contain MEDIA markers."},
            {"name": "send_enabled", "kind": "boolean", "label": "Enable sending to this exact recipient", "default": False, "required": True, "hidden": True,
             "description": "Explicit persistent opt-in. Off by default; reset by a target edit, duplicate, template or target mismatch."},
            {"name": "authorized_target", "kind": "hidden", "default": "", "hidden": True},
            {"name": "allow_attachments", "kind": "hidden", "default": False, "hidden": True},
            {"name": "timeout_s", "kind": "number", "label": "Timeout (s)", "default": 45, "advanced": True,
             "min": 5, "max": 120, "description": "A timeout cannot prove non-delivery. Never re-run automatically."},
        ],
        "cacheable": False, "cache_default": False, "record_inputs_default": False,
        "typical": "usually seconds; timeout/cancel leaves delivery unconfirmed",
        "cost": "May send real messages; no provider cost estimated",
    }


def channel_options(result) -> list:
    """Strictly map the official bridge's directory, including its MCP JSON envelope."""
    channels = next((value.get("channels") for value in response_values(result)
                     if isinstance(value, dict) and isinstance(value.get("channels"), list)), None)
    if channels is None:
        return []
    options, seen = [], set()
    for row in channels[:1000]:
        if not isinstance(row, dict):
            continue
        target = row.get("target")
        if not isinstance(target, str) or not target.strip() or len(target) > 1000 or any(ord(c) < 32 for c in target):
            continue
        target = target.strip()
        if target in seen:
            continue
        seen.add(target)
        platform = str(row.get("platform") or target.partition(":")[0] or "Messaging").strip()[:60]
        name = str(row.get("name") or target).strip()[:200]
        kind = str(row.get("chat_type") or "").replace("_", " ").strip().title()
        options.append({"value": target, "label": " · ".join(x for x in (name, platform.title(), kind) if x), "group": platform.title()})
    return options
