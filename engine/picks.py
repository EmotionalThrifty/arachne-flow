"""Files the user picked in the canvas (catalog review: model-supplied paths).

A local file outside Arachne Flow's uploads folder reaches a tool only when the user chose it in the Desktop canvas:
Browse… in a File node or a media field. The pick route stores an HMAC in the node's ``picked_files`` param, bound to
the flow, the node and the file's real path. The key is the install's consent key (``messaging.py``), so an agent
cannot mint one; every agent edit of a node (``graph.apply_ops``: flow_apply, Build with Hermes, the ops route) and
every ``flow_run`` input override drops the node's picks, and a copied or duplicated flow invalidates them (other
flow id). Drops need no pick: they are copied into the uploads folder first.
"""
from __future__ import annotations

import hashlib
import hmac
import os

from . import media as M

PARAM = "picked_files"            # {"<path as stored in the node>": "<64 hex>"}
_VERSION = "file-pick-v1"
MAX_PICKS_PER_NODE = 64


def _mac(env, flow_id: str, node_id: str, real: str) -> str:
    from . import messaging as MSG
    payload = "\x1f".join((_VERSION, flow_id, node_id, real))
    return hmac.new(MSG._secret(env), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _ids_ok(flow_id, node_id) -> bool:
    return all(isinstance(v, str) and v.strip() for v in (flow_id, node_id))


def mint(env, flow_id: str, node_id: str, path: str, folder: bool = False) -> str:
    """Only the Desktop pick route calls this, right after the user chose ``path`` in a native file dialog
    (``folder``: a folder dialog, for Folder watch triggers)."""
    if not _ids_ok(flow_id, node_id):
        raise ValueError("flow and node are required for a file pick")
    if not isinstance(path, str) or not path.strip():
        raise ValueError("path is required")
    path = path.strip()
    M.require_local_path(path)
    M.require_readable(path)
    if folder:
        if not os.path.isdir(os.path.expanduser(path)):
            raise ValueError(f"folder not found: {path}")
    elif not os.path.isfile(os.path.expanduser(path)):
        raise ValueError(f"file not found: {path}")
    return _mac(env, flow_id.strip(), node_id.strip(), M.real_path(path))


def matches(env, flow_id: str, node_id: str, path: str, token) -> bool:
    if not _ids_ok(flow_id, node_id) or not isinstance(path, str) or not path.strip():
        return False
    if not isinstance(token, str) or len(token) != 64 or any(c not in "0123456789abcdef" for c in token.lower()):
        return False
    try:
        if M.secret_reason(path.strip()):
            return False
        expected = _mac(env, flow_id.strip(), node_id.strip(), M.real_path(path.strip()))
    except (OSError, TypeError, ValueError, M.MediaError):
        return False
    return hmac.compare_digest(token.lower(), expected)


def node_picks(env, flow_id: str, node: dict) -> frozenset:
    """Real paths of the files the user picked for this node (valid tokens only)."""
    params = (node or {}).get("params") or {}
    picks = params.get(PARAM)
    if not isinstance(picks, dict) or not _ids_ok(flow_id, (node or {}).get("id")):
        return frozenset()
    out = set()
    for path, token in list(picks.items())[:MAX_PICKS_PER_NODE]:
        if matches(env, flow_id, node["id"], path, token):
            out.add(M.real_path(path.strip()))
    return frozenset(out)


def flow_picks(env, flow_id: str, flow: dict) -> frozenset:
    """Every picked file of the flow: a downstream node may send the file a File node passed it."""
    out = set()
    for node in (flow or {}).get("nodes") or []:
        if isinstance(node, dict):
            out |= node_picks(env, flow_id, node)
    return frozenset(out)


def drop(node: dict) -> None:
    """Forget the node's picks (in place): it was edited by something other than the user's canvas."""
    params = node.get("params") if isinstance(node, dict) else None
    if isinstance(params, dict):
        params.pop(PARAM, None)
