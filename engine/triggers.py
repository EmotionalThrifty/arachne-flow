"""Trigger nodes: start a flow on a schedule, for each new RSS/Atom item, when a webhook is called, for each new
file in a watched folder, or after another flow finished.

A trigger is a source node in the flow (``trigger.schedule``, ``trigger.rss``, ``trigger.webhook``,
``trigger.folder``, ``trigger.flow``). Nothing fires
until the node is switched on (param ``active``). Firing is done by ONE long-lived Hermes process per data folder
(the gateway or the Desktop backend; whichever holds ``locks/triggers.lock``), so two processes never run the same
trigger twice. No agent turn and no LLM call happen for a trigger itself: it starts the flow directly, so a
schedule costs only what its nodes cost.

When a trigger fires, its node outputs the event (time, feed item, webhook body); every OTHER trigger node of that
flow is idle, so its branch is skipped like an untaken If branch. Run by hand (Run button, flow_run), a trigger
produces a sample: the current time, the newest feed item, or the last webhook received.
"""
from __future__ import annotations

import fnmatch
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta

from . import executors as X
from . import store as S

logger = logging.getLogger("arachne-flow.triggers")

SCHEDULE, RSS, WEBHOOK = "trigger.schedule", "trigger.rss", "trigger.webhook"
FOLDER, AFTER_FLOW = "trigger.folder", "trigger.flow"
TYPES = (SCHEDULE, RSS, WEBHOOK, FOLDER, AFTER_FLOW)
EVENT, IDLE = "$event", "$idle"           # injected into the effective (never saved) flow of a triggered run
IDLE_BRANCH = "idle"                      # no output port has this name: every output of an idle trigger is dead

TICK_S = 15.0                             # how often due triggers are checked
LEADER_RETRY_S = 30.0
STARTUP_DELAY_S = 10.0                    # short-lived processes (CLI, validators) exit before they ever compete
LATE_GRACE_S = 30 * 60                    # a calendar slot missed by up to this much still runs once
MIN_INTERVAL_S = 60
RSS_MIN_MINUTES, RSS_DEFAULT_MINUTES = 5, 15
RSS_MAX_BYTES = 2 * 1024 * 1024
RSS_TIMEOUT_S = 20
RSS_SEEN_KEEP = 500
WEBHOOK_MAX_BYTES = 1024 * 1024
WEBHOOK_QUEUE = 20
DEFAULT_WEBHOOK_PORT = 8649
FOLDER_MAX_ENTRIES = 5000                 # files looked at per check; a bigger folder is watched only in part
FOLDER_MAX_DEPTH = 4                      # subfolder levels when "Include subfolders" is on
FOLDER_SKIP_SUFFIXES = (".tmp", ".part", ".partial", ".crdownload", ".download", "~", ".lock", ".swp")
FLOW_CHAIN_MAX = 5                        # After-flow triggers in a row before the chain is stopped (loops)
FLOW_SEEN_KEEP = 200
FINISHED = ("done", "error", "cancelled", "invalid")

_FRESH = {"name": "fresh", "kind": "boolean", "label": "Ignore cache", "default": False,
          "description": "Triggered runs normally reuse cached steps like a normal Run. On: every step runs again."}
_ACTIVE = {"name": "active", "kind": "boolean", "label": "Active", "default": False,
           "description": "Off by default. Only an active trigger starts the flow by itself (while Hermes runs)."}


def specs() -> list:
    common = {"category": "Triggers", "inputs": [], "cacheable": False, "typical": "instant"}
    return [
        {**common, "type": SCHEDULE, "title": "Schedule", "icon": "clock",
         "description": "Starts the flow at set times while Hermes runs. Run by hand it outputs the current time.",
         "outputs": [{"name": "time", "type": "text", "label": "Time"}],
         "params": [
             {"name": "schedule", "kind": "text", "label": "When", "default": "every 1h",
              "description": "e.g. every 15m · every 2h · daily 08:00 · weekdays 08:00, 18:00 · mon,fri 09:30 · "
                             "cron 0 8 * * 1-5 (German works too: täglich 08:00, werktags 7:30). Local time."},
             dict(_ACTIVE), dict(_FRESH)]},
        {**common, "type": RSS, "title": "RSS feed", "icon": "rss",
         "description": "Starts the flow once for every new item of an RSS or Atom feed. The first check only "
                        "remembers the existing items. Run by hand it outputs the newest item.",
         "outputs": [{"name": "item", "type": "json", "label": "Item"},
                     {"name": "title", "type": "text", "label": "Title"},
                     {"name": "link", "type": "text", "label": "Link"},
                     {"name": "summary", "type": "text", "label": "Summary"}],
         "params": [
             {"name": "url", "kind": "text", "label": "Feed URL", "default": "", "required": True,
              "description": "http(s) address of the RSS or Atom feed."},
             {"name": "every_minutes", "kind": "number", "label": "Check every (minutes)",
              "default": RSS_DEFAULT_MINUTES, "min": RSS_MIN_MINUTES, "max": 1440, "integer": True},
             {"name": "max_items", "kind": "number", "label": "Max new items per check", "default": 3,
              "min": 1, "max": 20, "integer": True,
              "description": "Each new item starts its own run, one after another."},
             dict(_ACTIVE), dict(_FRESH)]},
        {**common, "type": WEBHOOK, "title": "Webhook", "icon": "plug",
         "description": "Starts the flow when its secret local URL receives a POST (shown in the inspector once "
                        "active). Run by hand it outputs the last request received.",
         "outputs": [{"name": "body", "type": "json", "label": "Body"},
                     {"name": "text", "type": "text", "label": "Raw text"}],
         "params": [dict(_ACTIVE), dict(_FRESH),
                    {"name": "hook_id", "kind": "text", "label": "Hook id", "default": "", "hidden": True,
                     "description": "Random part of the webhook URL; set when the trigger is first activated."}]},
        {**common, "type": FOLDER, "title": "Folder watch", "icon": "folder-opened",
         "description": "Starts the flow once for every new (or changed) file in a folder you chose. The first check "
                        "only remembers the files already there. Run by hand it outputs the newest matching file.",
         "outputs": [{"name": "file", "type": "any", "label": "File"},
                     {"name": "path", "type": "text", "label": "Path"},
                     {"name": "name", "type": "text", "label": "File name"},
                     {"name": "change", "type": "text", "label": "Change"}],
         "params": [
             {"name": "folder", "kind": "text", "label": "Folder", "default": "", "required": True, "browse": "folder",
              "description": "The folder to watch. Choose it with Browse…: a folder set by the agent is not watched."},
             {"name": "pattern", "kind": "text", "label": "Files", "default": "*",
              "description": "Which files count, e.g. * · *.md · *.png, *.jpg (comma-separated, case-insensitive)."},
             {"name": "on", "kind": "select", "label": "Start on", "default": "new", "options": ["new", "new or changed"],
              "description": "new: only files that appear. new or changed: also when an existing file is saved again."},
             {"name": "subfolders", "kind": "boolean", "label": "Include subfolders", "default": False},
             {"name": "max_items", "kind": "number", "label": "Max files per check", "default": 5, "min": 1, "max": 20,
              "integer": True, "description": "Each file starts its own run, one after another."},
             dict(_ACTIVE), dict(_FRESH)]},
        {**common, "type": AFTER_FLOW, "title": "After flow", "icon": "debug-step-over",
         "description": "Starts this flow when another flow finished (done, failed, or either). Its results come "
                        "along. Run by hand it uses that flow's last finished run.",
         "outputs": [{"name": "result", "type": "json", "label": "Result"},
                     {"name": "status", "type": "text", "label": "Status"},
                     {"name": "run", "type": "json", "label": "Run"}],
         "params": [
             {"name": "flow", "kind": "text", "label": "Flow", "default": "", "required": True, "picker": "flow",
              "description": "The flow to wait for (not this one). Stored as its id; a name works too."},
             {"name": "when", "kind": "select", "label": "When it", "default": "succeeded",
              "options": ["succeeded", "failed", "finished"],
              "description": "succeeded: the run finished without errors. failed: it ended with an error. "
                             "finished: either. Runs of a single node are ignored."},
             dict(_ACTIVE), dict(_FRESH)]},
    ]


def is_trigger(node) -> bool:
    return isinstance(node, dict) and node.get("type") in TYPES


def _on(value) -> bool:
    return value is True or str(value).strip().lower() in ("true", "1", "yes", "on")


def active(node) -> bool:
    return is_trigger(node) and _on((node.get("params") or {}).get("active"))


# ----------------------------------------------------------------- schedules

_DAYS = {"mo": 0, "tu": 1, "di": 1, "we": 2, "mi": 2, "th": 3, "do": 3, "fr": 4, "sa": 5, "su": 6, "so": 6}
_UNITS = {"s": 1, "sec": 1, "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60, "minuten": 60,
          "h": 3600, "std": 3600, "hour": 3600, "hours": 3600, "stunde": 3600, "stunden": 3600,
          "d": 86400, "day": 86400, "days": 86400, "tag": 86400, "tage": 86400}


class ScheduleError(ValueError):
    pass


def _cron_field(text: str, lo: int, hi: int, names=None) -> set:
    out = set()
    for part in text.split(","):
        part = part.strip().lower()
        if not part:
            raise ScheduleError("empty cron field")
        step = 1
        if "/" in part:
            part, raw = part.split("/", 1)
            if not raw.isdigit() or int(raw) < 1:
                raise ScheduleError(f"bad step {raw!r}")
            step = int(raw)
        if part in ("*", ""):
            a, b = lo, hi
        elif "-" in part:
            x, y = part.split("-", 1)
            a, b = _cron_value(x, lo, hi, names), _cron_value(y, lo, hi, names)
        else:
            a = b = _cron_value(part, lo, hi, names)
            if step > 1:
                b = hi
        if a > b:
            raise ScheduleError(f"range {part!r} runs backwards")
        out.update(range(a, b + 1, step))
    return out


def _cron_value(text: str, lo: int, hi: int, names) -> int:
    text = text.strip().lower()
    if names and text[:2] in names:
        return names[text[:2]]
    if not text.isdigit():
        raise ScheduleError(f"{text!r} is not a number")
    value = int(text)
    if hi == 6 and value == 7:          # cron: 0 and 7 are both Sunday
        value = 0
    if not lo <= value <= hi:
        raise ScheduleError(f"{value} is outside {lo}-{hi}")
    return value


def parse_schedule(text) -> dict:
    """Parse a schedule into {kind: 'interval', seconds} or {kind: 'calendar', minutes, hours, days(0=Mon), label}.

    Raises ScheduleError with a readable message."""
    raw = " ".join(str(text or "").split())
    s = raw.lower().replace("jede ", "every ").replace("alle ", "every ").replace("täglich", "daily") \
        .replace("taeglich", "daily").replace("werktags", "weekdays").replace("wochenende", "weekends") \
        .replace(" um ", " ").replace(" at ", " ").replace("uhr", "").strip()
    if not s:
        raise ScheduleError("Enter when to run, e.g. every 1h or daily 08:00.")
    if s == "hourly" or s == "stündlich":
        return {"kind": "interval", "seconds": 3600, "label": "every hour"}
    m = re.fullmatch(r"every\s*(\d+)\s*([a-zäöü]+)", s)
    if m:
        unit = _UNITS.get(m.group(2))
        if unit is None:
            raise ScheduleError(f"unknown unit {m.group(2)!r}; use m, h or d")
        seconds = int(m.group(1)) * unit
        if seconds < MIN_INTERVAL_S:
            raise ScheduleError("the shortest interval is 1 minute")
        return {"kind": "interval", "seconds": seconds, "label": f"every {m.group(1)}{m.group(2)[0]}"}
    if s.startswith("cron "):
        s = s[5:].strip()
    fields = s.split()
    if len(fields) == 5 and all(re.fullmatch(r"[\d*,/\-a-z]+", f) for f in fields):
        minute, hour, dom, month, dow = fields
        days_cron = _cron_field(dow, 0, 6, {k: (v + 1) % 7 for k, v in _DAYS.items()})
        return {"kind": "calendar", "minutes": _cron_field(minute, 0, 59), "hours": _cron_field(hour, 0, 23),
                "dom": None if dom == "*" else _cron_field(dom, 1, 31),
                "months": None if month == "*" else _cron_field(month, 1, 12),
                "days": {(d - 1) % 7 for d in days_cron}, "dow_any": dow == "*", "label": "cron " + s}
    times = re.findall(r"(\d{1,2})[:.](\d{2})", s)
    if not times:
        raise ScheduleError(f"cannot read {raw!r}; try every 30m, daily 08:00, weekdays 07:30 or cron 0 8 * * 1-5")
    head = re.split(r"\d", s, maxsplit=1)[0].strip(" ,")
    if head in ("", "daily", "every day", "jeden tag"):
        days = set(range(7))
    elif head in ("weekdays", "weekday", "mo-fr", "mon-fri"):
        days = set(range(5))
    elif head in ("weekends", "weekend", "sa-so", "sat-sun"):
        days = {5, 6}
    else:
        days = set()
        for token in re.split(r"[,\s]+", head):
            if not token:
                continue
            if "-" in token:
                a, b = token.split("-", 1)
                if a[:2] not in _DAYS or b[:2] not in _DAYS:
                    raise ScheduleError(f"unknown day range {token!r}")
                i, j = _DAYS[a[:2]], _DAYS[b[:2]]
                days.update(range(i, j + 1) if i <= j else list(range(i, 7)) + list(range(0, j + 1)))
            elif token[:2] in _DAYS:
                days.add(_DAYS[token[:2]])
            else:
                raise ScheduleError(f"unknown day {token!r}; use mon, tue, … or daily / weekdays")
    slots = set()
    for hh, mm in times:
        h, mi = int(hh), int(mm)
        if h > 23 or mi > 59:
            raise ScheduleError(f"{hh}:{mm} is not a time")
        slots.add((h, mi))
    return {"kind": "calendar", "slots": slots, "days": days, "label": raw}


def _calendar_match(spec: dict, dt: datetime) -> bool:
    if "slots" in spec:
        return dt.weekday() in spec["days"] and (dt.hour, dt.minute) in spec["slots"]
    if dt.minute not in spec["minutes"] or dt.hour not in spec["hours"]:
        return False
    if spec.get("months") is not None and dt.month not in spec["months"]:
        return False
    dom_ok = spec.get("dom") is None or dt.day in spec["dom"]
    dow_ok = spec.get("dow_any") or dt.weekday() in spec["days"]
    if spec.get("dom") is not None and not spec.get("dow_any"):
        return dom_ok or dow_ok          # cron: either restricted day field may match
    return dom_ok and dow_ok


def next_slot(spec: dict, after: float) -> float | None:
    """The first calendar minute strictly after `after` (epoch seconds), local time; None if none within 400 days."""
    dt = datetime.fromtimestamp(after).replace(second=0, microsecond=0) + timedelta(minutes=1)
    end = dt + timedelta(days=400)
    while dt < end:
        if _calendar_match(spec, dt):
            return dt.timestamp()
        # skip whole hours/days that cannot match, so a yearly cron does not scan 500k minutes one by one
        if "slots" in spec:
            if dt.weekday() not in spec["days"]:
                dt = dt.replace(hour=0, minute=0) + timedelta(days=1)
                continue
        elif dt.hour not in spec["hours"]:
            dt = dt.replace(minute=0) + timedelta(hours=1)
            continue
        dt += timedelta(minutes=1)
    return None


def schedule_due(spec: dict, st: dict, now: float) -> tuple:
    """(fire_now, next_epoch, armed_state_updates) for one schedule trigger."""
    armed = float(st.get("armed_at") or now)
    last = st.get("last_fire")
    if spec["kind"] == "interval":
        base = float(last) if last else armed
        due = base + spec["seconds"]
        if now >= due:
            return True, now + spec["seconds"], {}
        return False, due, {}
    slot = next_slot(spec, float(st.get("checked_at") or armed))
    if slot is None:
        return False, None, {"checked_at": now}
    if slot <= now:
        if now - slot <= LATE_GRACE_S:
            return True, next_slot(spec, now), {"checked_at": now}
        return False, next_slot(spec, now), {"checked_at": now}   # missed while Hermes was off: skipped
    return False, slot, {}


# ----------------------------------------------------------------- RSS / Atom

def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _child_text(el, *names) -> str:
    for child in el:
        if _local(child.tag) in names:
            text = "".join(child.itertext()).strip()
            if text:
                return text
    return ""


def _strip_html(text: str) -> str:
    import html
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", text or "", flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(html.unescape(text).split())


# Everything before the root element (BOM, XML declaration, comments, PIs, whitespace), then a DTD: refused
# wherever it sits in the prolog, not only in the first 4 KB. CDATA in items may still mention <!DOCTYPE.
_PROLOG_DTD = re.compile(rb"^(?:\xef\xbb\xbf)?(?:\s+|<\?.*?\?>|<!--.*?-->)*<!(?:doctype|entity)", re.I | re.S)


def parse_feed(data: bytes) -> list:
    """Items of an RSS 2.0 / RSS 1.0 / Atom document, newest first as listed: [{id, title, link, summary,
    published}]. Documents with a DOCTYPE are refused (no entity expansion)."""
    import xml.etree.ElementTree as ET
    if _PROLOG_DTD.match(data or b""):
        raise ValueError("feeds with a DOCTYPE are not accepted")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f"not a valid RSS/Atom feed: {exc}") from None
    items = []
    for el in root.iter():
        kind = _local(el.tag)
        if kind not in ("item", "entry"):
            continue
        link = ""
        for child in el:
            if _local(child.tag) == "link":
                link = (child.get("href") if child.get("rel", "alternate") == "alternate" else "") or \
                    (child.text or "").strip() or link
                if link:
                    break
        title = _strip_html(_child_text(el, "title"))
        summary = _strip_html(_child_text(el, "description", "summary", "content", "encoded"))[:4000]
        published = _child_text(el, "pubdate", "published", "updated", "date")
        ident = _child_text(el, "guid", "id") or link or hashlib.sha256(
            (title + "\x1f" + summary[:500]).encode("utf-8")).hexdigest()[:32]
        items.append({"id": ident[:500], "title": title[:500], "link": link[:2000], "summary": summary,
                      "published": published[:100]})
    return items


def _safe_url(url: str) -> bool:
    try:
        from tools.url_safety import is_safe_url   # public plugin API (plugin_api.json)
    except Exception:  # noqa: BLE001 - outside Hermes (tests): scheme check only
        return url.lower().startswith(("http://", "https://"))
    return bool(is_safe_url(url))


def fetch_feed(url: str, timeout: float = RSS_TIMEOUT_S, opener=None) -> list:
    url = str(url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("the feed URL must start with http:// or https://")
    if not _safe_url(url):
        raise ValueError("this feed address points to a private or blocked network address")

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if not _safe_url(newurl):
                raise ValueError("the feed redirected to a private or blocked network address")
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = opener or urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": "ArachneFlow/1 (+RSS trigger)",
                                               "Accept": "application/rss+xml, application/atom+xml, */*"})
    with opener.open(req, timeout=timeout) as resp:
        data = resp.read(RSS_MAX_BYTES + 1)
    if len(data) > RSS_MAX_BYTES:
        raise ValueError(f"the feed is larger than {RSS_MAX_BYTES // (1024 * 1024)} MB")
    return parse_feed(data)


def item_outputs(item: dict) -> dict:
    return {"item": item, "title": item.get("title", ""), "link": item.get("link", ""),
            "summary": item.get("summary", "")}


# ----------------------------------------------------------------- state

def _state_path(env) -> str:
    return os.path.join(S.data_dir(env), "triggers", "state.json")


def load_state(env) -> dict:
    data = S._try_read(_state_path(env))
    return data if isinstance(data, dict) else {}


def save_state(env, state: dict) -> None:
    S.write_json(_state_path(env), state)


def key(flow_id: str, node_id: str) -> str:
    return f"{flow_id}/{node_id}"


def _signature(node: dict) -> str:
    p = node.get("params") or {}
    relevant = {k: p.get(k) for k in ("schedule", "url", "every_minutes", "hook_id", "folder", "pattern",
                                      "subfolders", "on", "flow", "when")}
    return hashlib.sha256(json.dumps([node.get("type"), relevant], sort_keys=True, default=str).encode()).hexdigest()[:16]


# ----------------------------------------------------------------- webhook URLs

def webhook_port(env) -> int:
    try:
        value = env.ctx.get_config("webhook_port", DEFAULT_WEBHOOK_PORT) if env.ctx else None
        value = int(value) if value not in (None, "") else DEFAULT_WEBHOOK_PORT
    except Exception:  # noqa: BLE001
        value = DEFAULT_WEBHOOK_PORT
    env_port = os.environ.get("ARACHNE_FLOW_WEBHOOK_PORT", "").strip()
    if env_port.isdigit():
        value = int(env_port)
    return value if 0 <= value <= 65535 else DEFAULT_WEBHOOK_PORT


def new_hook_id() -> str:
    return secrets.token_hex(12)


def hook_token(env, flow_id: str, node_id: str, hook_id: str) -> str:
    from . import messaging as MSG
    payload = "\x1f".join(("webhook-v1", flow_id, node_id, hook_id))
    return hmac.new(MSG._secret(env), payload.encode("utf-8"), hashlib.sha256).hexdigest()[:40]


def webhook_url(env, flow_id: str, node: dict, port: int = None):
    hook_id = str((node.get("params") or {}).get("hook_id") or "")
    if not re.fullmatch(r"[0-9a-f]{24}", hook_id):
        return None
    port = port if port is not None else webhook_port(env)
    return f"http://127.0.0.1:{port}/hook/{flow_id}/{node['id']}/{hook_token(env, flow_id, node['id'], hook_id)}"


def check_hook(env, flow_id: str, node_id: str, token: str):
    """The active webhook node addressed by this URL, or None (unknown flow/node, inactive, wrong token)."""
    try:
        flow = S.get_flow(env, flow_id)
    except Exception:  # noqa: BLE001 - malformed ids and missing flows look the same to a caller
        return None
    node = next((n for n in flow.get("nodes", []) if n.get("id") == node_id), None)
    if not node or node.get("type") != WEBHOOK or not active(node):
        return None
    hook_id = str((node.get("params") or {}).get("hook_id") or "")
    if not re.fullmatch(r"[0-9a-f]{24}", hook_id):
        return None
    if not hmac.compare_digest(hook_token(env, flow_id, node_id, hook_id), str(token or "")):
        return None
    return flow, node


def webhook_event(raw: bytes, content_type: str = "", query: dict = None) -> dict:
    text = raw.decode("utf-8", "replace")
    body = None
    if text.strip():
        try:
            from . import types as ptypes
            body = ptypes.loads_untrusted(text)
        except ValueError:
            body = None
    if body is None and "x-www-form-urlencoded" in (content_type or "").lower():
        from urllib.parse import parse_qs
        body = {k: v[0] if len(v) == 1 else v for k, v in parse_qs(text).items()}
    if body is None:
        body = {"text": text} if text else {}
    if query:
        body = body if isinstance(body, dict) else {"body": body}
        body = {**{"query": query}, **body} if "query" not in body else body
    return {"body": body, "text": text}


# ----------------------------------------------------------------- folder watch

def _patterns(text) -> list:
    pats = [p.strip().lower() for p in str(text or "*").replace(";", ",").split(",") if p.strip()]
    return pats or ["*"]


def _skip_name(name: str) -> bool:
    low = name.lower()
    return low.startswith(("~$", ".")) or low.endswith(FOLDER_SKIP_SUFFIXES) or low in ("thumbs.db", "desktop.ini")


def scan_folder(folder: str, pattern="*", subfolders: bool = False) -> dict:
    """{relative path: [mtime_ns, size]} of the matching files (hidden, temporary and secret files left out)."""
    from . import media as M
    pats = _patterns(pattern)
    out, stack = {}, [(folder, "", 0)]
    while stack and len(out) < FOLDER_MAX_ENTRIES:
        base, rel, depth = stack.pop()
        try:
            entries = sorted(os.scandir(base), key=lambda e: e.name.lower())
        except OSError:
            continue
        for e in entries:
            if _skip_name(e.name):
                continue
            sub = f"{rel}{e.name}"
            try:
                if e.is_dir(follow_symlinks=False):
                    if subfolders and depth < FOLDER_MAX_DEPTH:
                        stack.append((e.path, sub + os.sep, depth + 1))
                    continue
                if not e.is_file(follow_symlinks=False):
                    continue
                if not any(fnmatch.fnmatchcase(e.name.lower(), p) for p in pats):
                    continue
                if M.secret_reason(e.path):
                    continue
                stat = e.stat(follow_symlinks=False)
            except OSError:
                continue
            out[sub] = [stat.st_mtime_ns, stat.st_size]
            if len(out) >= FOLDER_MAX_ENTRIES:
                break
    return out


def picked_folder(env, flow_id: str, node: dict) -> str:
    """The real path of the node's folder, only if the user picked it in the canvas (picks.py); else ValueError."""
    from . import media as M
    from . import picks as PK
    folder = str((node.get("params") or {}).get("folder") or "").strip().strip('"')
    if not folder:
        raise ValueError("choose the folder to watch")
    try:
        M.require_local_path(folder)
        real = M.real_path(folder)
    except (M.MediaError, OSError, ValueError) as exc:
        raise ValueError(str(exc)) from None
    if not os.path.isdir(real):
        raise ValueError(f"folder not found: {folder}")
    if real not in PK.node_picks(env, flow_id, node):
        raise ValueError("choose the folder with Browse… in the canvas (a folder set by the agent is not watched)")
    data = M.real_path(S.data_dir(env))
    if real == data or real.startswith(data.rstrip("\\/") + os.sep) or data.startswith(real.rstrip("\\/") + os.sep):
        raise ValueError("Arachne Flow's own data folder cannot be watched (its runs would start the flow again)")
    return real


def folder_roots(env, flow_id: str, flow: dict) -> tuple:
    """Folders the user picked for Folder watch nodes of this flow: their files may reach tools like a picked file."""
    out = []
    for node in (flow or {}).get("nodes") or []:
        if isinstance(node, dict) and node.get("type") == FOLDER:
            try:
                out.append(picked_folder(env, flow_id, node))
            except ValueError:
                continue
    return tuple(out)


def folder_event(folder: str, rel: str, change: str) -> dict:
    from . import media as M
    path = os.path.join(folder, rel)
    return {"file": M.from_local(path, copy=False), "path": path, "name": os.path.basename(rel), "change": change}


# ----------------------------------------------------------------- after another flow

def resolve_flow(env, ref, own_id: str = None) -> dict:
    """The flow named by id or (unique, case-insensitive) name; ValueError if none, ambiguous, or this flow."""
    ref = str(ref or "").strip()
    if not ref:
        raise ValueError("choose the flow to wait for")
    found = None
    try:
        found = S.get_flow(env, ref)
    except Exception:  # noqa: BLE001 - not an id: try names
        matches = [f for f in S.list_flows(env) if str(f.get("name") or "").strip().lower() == ref.lower()]
        if len(matches) > 1:
            raise ValueError(f"several flows are called {ref!r}; use the flow id") from None
        if matches:
            found = S.get_flow(env, matches[0]["id"])
    if not found:
        raise ValueError(f"no flow called {ref!r}")
    if own_id and found.get("id") == own_id:
        raise ValueError("a flow cannot wait for itself; choose another flow")
    return found


def _when_matches(when: str, status: str) -> bool:
    when = str(when or "succeeded").lower()
    if when == "failed":
        return status in ("error", "invalid", "cancelled")
    if when == "finished":
        return status in FINISHED
    return status == "done"


def run_result(source: dict, run: dict, env=None) -> dict:
    """Outputs of the source flow's end steps (nodes nothing reads from), by title."""
    from . import runner as R
    feeding = {e.get("from", {}).get("node") for e in source.get("edges", []) if isinstance(e, dict)}
    out = {}
    for node in source.get("nodes", []):
        nid = node.get("id")
        if not nid or nid in feeding or node.get("type") in ("note",) or is_trigger(node):
            continue
        st = (run.get("nodes") or {}).get(nid) or {}
        outputs = st.get("outputs")
        if not isinstance(outputs, dict) or st.get("status") not in ("done", "cached"):
            continue
        value = {k: R.load_value(v, env) for k, v in outputs.items() if not str(k).startswith("$")}
        if len(value) == 1:
            value = next(iter(value.values()))
        name = str(node.get("title") or nid)
        out[name if name not in out else f"{name} ({nid})"] = value
    return out


def flow_event(env, source: dict, run: dict) -> dict:
    summary = S.summarize_run(run)
    summary["error"] = run.get("error")
    return {"result": run_result(source, run, env), "status": run.get("status") or "", "run": summary}


def _chain_depth(run: dict) -> int:
    trig = run.get("trigger") if isinstance(run.get("trigger"), dict) else {}
    return int(trig.get("depth") or 0) if trig.get("type") == AFTER_FLOW else 0


# ----------------------------------------------------------------- executor

async def execute(env, node, spec, inputs, nctx):
    params = node.get("params") or {}
    if params.get(IDLE):
        return {X.BRANCH: IDLE_BRANCH}
    event = params.get(EVENT)
    if isinstance(event, dict):
        return dict(event)
    ntype = node.get("type")
    if ntype == SCHEDULE:
        return {"time": datetime.now().astimezone().isoformat(timespec="seconds")}
    if ntype == RSS:
        import asyncio
        try:
            items = await asyncio.wait_for(asyncio.to_thread(fetch_feed, params.get("url")),
                                           timeout=RSS_TIMEOUT_S + 5)
        except asyncio.TimeoutError:
            raise X.NodeError("the feed did not answer in time") from None
        except Exception as exc:  # noqa: BLE001 - shown on the node
            raise X.NodeError(f"could not read the feed: {exc}") from None
        if not items:
            raise X.NodeError("the feed has no items")
        nctx.log(f"newest of {len(items)} feed items (run by hand)")
        return item_outputs(items[0])
    if ntype == WEBHOOK:
        last = (load_state(env).get(key(nctx.flow_id or "", node["id"])) or {}).get("last_event")
        if isinstance(last, dict):
            nctx.log("last webhook request received (run by hand)")
            return {"body": last.get("body"), "text": last.get("text", "")}
        nctx.log("no webhook request received yet; empty body (run by hand)")
        return {"body": {}, "text": ""}
    if ntype == FOLDER:
        try:
            folder = picked_folder(env, nctx.flow_id, node)
        except ValueError as exc:
            raise X.NodeError(str(exc)) from None
        files = scan_folder(folder, params.get("pattern"), _on(params.get("subfolders")))
        if not files:
            raise X.NodeError("no matching file in the folder yet")
        newest = max(files, key=lambda rel: files[rel][0])
        nctx.log(f"newest of {len(files)} matching files (run by hand)")
        return folder_event(folder, newest, "sample")
    if ntype == AFTER_FLOW:
        from . import runner as R
        try:
            source = resolve_flow(env, params.get("flow"), nctx.flow_id)
        except ValueError as exc:
            raise X.NodeError(str(exc)) from None
        for summary in S.list_runs(env, source["id"], limit=20):
            if summary.get("status") in FINISHED and not summary.get("target_node"):
                nctx.log(f"last finished run of {source.get('name') or source['id']} (run by hand)")
                return flow_event(env, source, R.get_run(env, summary["id"]))
        raise X.NodeError(f"{source.get('name') or source['id']} has no finished run yet")
    raise X.NodeError(f"unknown trigger {ntype!r}")


def triggered_flow(flow: dict, node_id: str, event: dict) -> dict:
    """The effective flow of a triggered run: the firing node carries the event, other triggers are idle."""
    import copy
    out = copy.deepcopy(flow)
    for n in out.get("nodes", []):
        if not is_trigger(n):
            continue
        params = n.setdefault("params", {})
        if n.get("id") == node_id:
            params[EVENT] = event
        else:
            params[IDLE] = True
    return out


def disarm(flow: dict) -> dict:
    """Every trigger off (copies, templates, generated flows): arming is always an explicit user step."""
    for n in flow.get("nodes", []) if isinstance(flow, dict) else []:
        if is_trigger(n):
            params = n.setdefault("params", {})
            params["active"] = False
            params.pop("hook_id", None)
            params.pop(EVENT, None)
            params.pop(IDLE, None)
    return flow


# ----------------------------------------------------------------- the scheduler

def eligible(dashboard: bool = False) -> bool:
    """Only long-lived processes fire triggers: the gateway, or the Desktop backend that serves the canvas
    (``dashboard``). ``ARACHNE_FLOW_TRIGGERS=0/1`` forces it off/on."""
    forced = os.environ.get("ARACHNE_FLOW_TRIGGERS", "").strip()
    if forced in ("0", "1"):
        return forced == "1"
    argv = [a.lower() for a in sys.argv]
    return ("gateway" in argv and "run" in argv) or bool(dashboard)


class _Leader:
    """An OS file lock held for the life of the process; released by the OS when the process dies."""

    def __init__(self, path: str):
        self.path, self.handle = path, None

    def acquire(self) -> bool:
        if self.handle is not None:
            return True
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        fh = open(self.path, "a+b", buffering=0)
        try:
            if os.name == "nt":
                import msvcrt
                if fh.seek(0, os.SEEK_END) == 0:
                    fh.write(b"\0")
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self.handle = fh
        try:   # who fires (for the inspector); a separate file because the lock file itself is not readable
            with open(self.path + ".pid", "w", encoding="ascii") as out:
                out.write(str(os.getpid()))
        except OSError:
            pass
        return True

    def release(self) -> None:
        fh, self.handle = self.handle, None
        if fh is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        fh.close()


class Scheduler:
    """One per process (kept in engine state). ``tick`` is the whole policy and is called directly by tests."""

    def __init__(self, env_factory, clock=time.time, eligible_fn=None):
        self.env_factory, self.clock = env_factory, clock
        self.eligible_fn = eligible_fn or eligible
        self.stop = threading.Event()
        self.thread = None
        self.leader = None
        self.server = None
        self.queues: dict = {}          # webhook events waiting for a busy flow: key -> [event]
        self.lock = threading.RLock()
        self.flow_cache: dict = {}      # path -> (mtime_ns, flow)
        self.status: dict = {}          # key -> {"next": epoch|None, "error": str|None}

    # -- lifecycle
    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self._main, name="arachne-flow-triggers", daemon=True)
        self.thread.start()

    def shutdown(self) -> None:
        self.stop.set()
        self._stop_server()
        if self.leader:
            self.leader.release()

    def _main(self) -> None:
        if self.stop.wait(STARTUP_DELAY_S):
            return
        while not self.stop.is_set():
            wait = TICK_S
            try:
                env = self.env_factory()
                if not self.eligible_fn():
                    wait = LEADER_RETRY_S
                elif self._lead(env):
                    self.tick(env)
                else:
                    wait = LEADER_RETRY_S
            except Exception:  # noqa: BLE001 - the loop must survive anything a flow does
                logger.exception("arachne-flow: trigger tick failed")
            self.stop.wait(wait)
        self._stop_server()

    def _lead(self, env) -> bool:
        if self.leader is None:
            self.leader = _Leader(os.path.join(S.data_dir(env), "locks", "triggers.lock"))
        got = self.leader.acquire()
        if got and not getattr(self, "_announced", False):
            self._announced = True
            logger.info("arachne-flow: this process fires triggers (pid %s)", os.getpid())
        return got

    # -- flows
    def _flows(self, env) -> list:
        folder = S.flows_dir(env)
        out, seen = [], set()
        for name in sorted(os.listdir(folder)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(folder, name)
            seen.add(path)
            try:
                mtime = os.stat(path).st_mtime_ns
            except OSError:
                continue
            cached = self.flow_cache.get(path)
            if cached and cached[0] == mtime:
                flow = cached[1]
            else:
                flow = S._try_read(path)
                self.flow_cache[path] = (mtime, flow)
            if isinstance(flow, dict) and any(active(n) for n in flow.get("nodes") or []):
                out.append(flow)
        for path in [p for p in self.flow_cache if p not in seen]:
            self.flow_cache.pop(path, None)
        return out

    # -- one pass
    def tick(self, env) -> list:
        """Check every active trigger once; returns [(flow_id, node_id, run_id)] started in this pass."""
        from . import runner as R
        now = self.clock()
        started = []
        with self.lock:
            state = load_state(env)
            changed = False
            live_keys, want_server = set(), False
            for flow in self._flows(env):
                busy = bool(R.active_runs(env, flow["id"]))
                for node in flow.get("nodes", []):
                    if not active(node):
                        continue
                    k = key(flow["id"], node["id"])
                    live_keys.add(k)
                    st = state.get(k)
                    sig = _signature(node)
                    if not isinstance(st, dict) or st.get("sig") != sig:
                        st = {"sig": sig, "armed_at": now, **({"last_event": st.get("last_event")}
                                                              if isinstance(st, dict) and st.get("last_event") else {})}
                        state[k] = st
                        changed = True
                    try:
                        runs, upd = self._check(env, flow, node, st, now, busy)
                        if upd:
                            st.update(upd)
                            changed = True
                        for event in runs:
                            if busy:
                                break
                            extra = event.pop("$meta", None) if isinstance(event, dict) else None
                            run_id = self._fire(env, flow, node, event, st, now, extra)
                            started.append((flow["id"], node["id"], run_id))
                            busy, changed = True, True
                        if st.get("error"):
                            st.pop("error", None)
                            changed = True
                    except Exception as exc:  # noqa: BLE001 - one broken trigger must not stop the others
                        message = str(exc) or type(exc).__name__
                        if st.get("error") != message:
                            st["error"] = message
                            changed = True
                        logger.info("arachne-flow: trigger %s: %s", k, message)
                    if node.get("type") == WEBHOOK:
                        want_server = True
            for stale in [k for k in state if k not in live_keys]:
                # keep feed history and the last webhook body for a while; drop scheduling fields
                st = state[stale]
                if st.get("armed_at") is not None or st.get("next") is not None:
                    st.pop("armed_at", None)
                    st.pop("next", None)
                    st.pop("sig", None)
                    changed = True
            if changed:
                save_state(env, state)
        self._ensure_server(env, want_server)
        return started

    def _check(self, env, flow, node, st, now, busy) -> tuple:
        """([events to fire now], state updates) for one active trigger."""
        params = node.get("params") or {}
        ntype = node.get("type")
        if ntype == SCHEDULE:
            spec = parse_schedule(params.get("schedule"))
            fire, nxt, upd = schedule_due(spec, st, now)
            upd = dict(upd, next=nxt)
            if fire and busy:
                if spec["kind"] == "interval":      # retried on the next tick
                    return [], {"note": "waiting: the previous run is still running"}
                return [], dict(upd, skipped_at=now, note="skipped: the previous run was still running")
            stamp = datetime.fromtimestamp(now).astimezone().isoformat(timespec="seconds")
            return ([{"time": stamp}] if fire else []), upd
        if ntype == RSS:
            every = max(RSS_MIN_MINUTES, int(float(params.get("every_minutes") or RSS_DEFAULT_MINUTES))) * 60
            last_poll = float(st.get("polled_at") or 0)
            pending = [i for i in st.get("pending") or [] if isinstance(i, dict)]
            if not pending and now - last_poll < every:
                return [], {"next": last_poll + every}
            upd = {}
            if not pending:
                items = fetch_feed(params.get("url"))
                upd["polled_at"], upd["next"] = now, now + every
                seen = list(st.get("seen") or [])
                if "seen" not in st:                     # first poll: remember, do not flood
                    upd["seen"] = [i["id"] for i in items][:RSS_SEEN_KEEP]
                    upd["note"] = f"watching {len(items)} existing items; new ones start the flow"
                    return [], upd
                known = set(seen)
                fresh_items = [i for i in items if i["id"] not in known]
                limit = max(1, min(20, int(float(params.get("max_items") or 3))))
                pending = list(reversed(fresh_items[:limit]))     # oldest of the new ones first
                upd["seen"] = ([i["id"] for i in fresh_items] + seen)[:RSS_SEEN_KEEP]
                if not pending:                          # nothing new: wait for the next interval (review R3)
                    return [], upd
            if busy:
                upd["pending"] = pending
                return [], upd
            first, rest = pending[0], pending[1:]
            upd["pending"] = rest
            if rest:
                upd["next"] = now
            return [item_outputs(first)], upd
        if ntype == WEBHOOK:
            q = self.queues.get(key(flow["id"], node["id"])) or []
            if not q or busy:
                return [], {"next": None}
            return [q.pop(0)], {"next": None}
        if ntype == FOLDER:
            return self._check_folder(env, flow, node, st, busy)
        if ntype == AFTER_FLOW:
            return self._check_after(env, flow, node, st, busy)
        return [], {}

    def _check_folder(self, env, flow, node, st, busy) -> tuple:
        """New or changed files fire once they are stable (same size and time on two checks in a row)."""
        params = node.get("params") or {}
        folder = picked_folder(env, flow["id"], node)
        upd = {"next": None}
        pending = [p for p in st.get("pending") or [] if isinstance(p, list) and len(p) == 2]
        if not pending:
            current = scan_folder(folder, params.get("pattern"), _on(params.get("subfolders")))
            if "known" not in st:                     # first check: remember, do not flood
                upd.update(known=current, settling={},
                           note=f"watching {len(current)} existing file{'s' if len(current) != 1 else ''}; "
                                "new ones start the flow")
                return [], upd
            known, settling = dict(st.get("known") or {}), dict(st.get("settling") or {})
            changed_too = str(params.get("on") or "new").lower() != "new"
            ready, still = [], {}
            for rel, sig in current.items():
                before = known.get(rel)
                if before == sig:
                    continue
                if before is not None and not changed_too:
                    known[rel] = sig                  # an edit of a known file: just remember the new state
                    continue
                if settling.get(rel) == sig:          # unchanged since the last check: done being written
                    ready.append((sig[0], rel, "new" if before is None else "changed"))
                    known[rel] = sig
                else:
                    still[rel] = sig
            for rel in [r for r in known if r not in current]:
                known.pop(rel)                        # deleted: a file put back later counts as new
            ready.sort()
            limit = max(1, min(20, int(float(params.get("max_items") or 5))))
            pending = [[rel, change] for _t, rel, change in ready[:limit]]
            upd.update(known=known, settling=still)
            if len(ready) > limit:
                upd["note"] = f"{len(ready) - limit} more new files were skipped (max {limit} per check)"
        if busy:
            upd["pending"] = pending
            return [], upd
        events = []
        while pending and not events:
            rel, change = pending.pop(0)
            if os.path.isfile(os.path.join(folder, rel)):
                events.append(folder_event(folder, rel, change))
        upd["pending"] = pending
        return events, upd

    def _check_after(self, env, flow, node, st, busy) -> tuple:
        from . import runner as R
        params = node.get("params") or {}
        source = resolve_flow(env, params.get("flow"), flow["id"])
        upd = {"next": None}
        finished = [r for r in S.list_runs(env, source["id"], limit=20) if r.get("status") in FINISHED]
        if st.get("source") != source["id"] or "seen" not in st:   # first check: only later runs count
            return [], dict(upd, source=source["id"], seen=[r["id"] for r in finished][:FLOW_SEEN_KEEP],
                            pending=[], note=f"waiting for {source.get('name') or source['id']} to finish")
        seen = list(st.get("seen") or [])
        known = set(seen)
        pending = [p for p in st.get("pending") or [] if isinstance(p, str)]
        for summary in reversed(finished):                       # oldest first
            if summary["id"] in known:
                continue
            seen.insert(0, summary["id"])
            if not summary.get("target_node") and _when_matches(params.get("when"), summary.get("status")):
                pending.append(summary["id"])
        upd.update(seen=seen[:FLOW_SEEN_KEEP])
        if busy or not pending:
            upd["pending"] = pending
            return [], upd
        run_id, rest = pending[0], pending[1:]
        upd["pending"] = rest
        run = R.get_run(env, run_id)
        depth = _chain_depth(run)
        if depth >= FLOW_CHAIN_MAX:
            upd["note"] = f"stopped: {depth} flows in a row started each other (a loop?)"
            return [], upd
        event = flow_event(env, source, run)
        event["$meta"] = {"depth": depth + 1, "after_run": run_id}
        return [event], upd

    def _fire(self, env, flow, node, event, st, now, extra: dict = None) -> str:
        from . import runner as R
        params = node.get("params") or {}
        effective = triggered_flow(flow, node["id"], event)
        handle = R.start_run(env, flow["id"], fresh=_on(params.get("fresh")), flow=effective,
                             meta={"trigger": {"node": node["id"], "type": node.get("type"),
                                               "title": node.get("title") or "", **(extra or {})}})
        st.update(last_fire=now, last_run=handle.run["id"], fires=int(st.get("fires") or 0) + 1)
        st.pop("note", None)
        logger.info("arachne-flow: trigger %s started run %s", key(flow["id"], node["id"]), handle.run["id"])
        return handle.run["id"]

    # -- webhooks
    def receive(self, env, flow_id: str, node_id: str, token: str, raw: bytes, content_type: str = "",
                query: dict = None) -> tuple:
        """(http status, json body) for one POST to a webhook URL."""
        from . import runner as R
        hit = check_hook(env, flow_id, node_id, token)
        if hit is None:
            return 404, {"error": "unknown webhook"}
        flow, node = hit
        event = webhook_event(raw, content_type, query)
        k = key(flow_id, node_id)
        with self.lock:
            q = self.queues.setdefault(k, [])
            if len(q) >= WEBHOOK_QUEUE:
                return 429, {"error": "too many queued requests for this flow"}
            state = load_state(env)
            st = state.setdefault(k, {})
            st["last_event"] = {"body": event["body"], "text": event["text"][:20000],
                                "at": datetime.now().astimezone().isoformat(timespec="seconds")}
            run = None
            if not q and not R.active_runs(env, flow_id):
                run = self._fire(env, flow, node, event, st, self.clock())
            else:
                q.append(event)            # the next tick starts it once the flow is free
            save_state(env, state)
        return 202, {"ok": True, "run_id": run, "queued": run is None}

    def _ensure_server(self, env, wanted: bool) -> None:
        if not wanted:
            self._stop_server()
            return
        port = webhook_port(env)
        if self.server is not None and self.server.server_address[1] == port:
            return
        self._stop_server()
        try:
            self.server = make_server(self, self.env_factory, port)
        except OSError as exc:
            self.server = None
            msg = f"webhook port {port} is busy ({exc}); set ARACHNE_FLOW_WEBHOOK_PORT or webhook_port"
            if self.status.get("server_error") != msg:
                logger.warning("arachne-flow: %s", msg)
            self.status["server_error"] = msg
            return
        self.status.pop("server_error", None)
        threading.Thread(target=self.server.serve_forever, name="arachne-flow-webhooks", daemon=True).start()
        logger.info("arachne-flow: webhook listener on 127.0.0.1:%s", self.server.server_address[1])

    def _stop_server(self) -> None:
        server, self.server = self.server, None
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
            except Exception:  # noqa: BLE001
                pass


def make_server(scheduler: Scheduler, env_factory, port: int):
    """A loopback-only HTTP server: POST /hook/<flow>/<node>/<token>. Nothing else is served."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlsplit

    class Handler(BaseHTTPRequestHandler):
        server_version = "ArachneFlowHooks/1"

        def log_message(self, *args):    # no request logging: the URL contains the secret token
            return

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._send(405, {"error": "use POST"})

        def do_POST(self):
            parts = urlsplit(self.path)
            segs = [p for p in parts.path.split("/") if p]
            if len(segs) != 4 or segs[0] != "hook":
                return self._send(404, {"error": "unknown webhook"})
            length = self.headers.get("Content-Length", "0")
            if not length.isdigit() or int(length) > WEBHOOK_MAX_BYTES:
                if length.isdigit() and int(length) <= 4 * WEBHOOK_MAX_BYTES:
                    left = int(length)            # read it away first: closing unread makes the client see a reset
                    while left > 0:
                        chunk = self.rfile.read(min(left, 65536))
                        if not chunk:
                            break
                        left -= len(chunk)
                self.close_connection = True
                return self._send(413, {"error": f"body over {WEBHOOK_MAX_BYTES // 1024} KB or no length"})
            raw = self.rfile.read(int(length))
            query = {k: v[0] if len(v) == 1 else v for k, v in parse_qs(parts.query).items()} or None
            try:
                status, body = scheduler.receive(env_factory(), segs[1], segs[2], segs[3], raw,
                                                 self.headers.get("Content-Type", ""), query)
            except Exception:  # noqa: BLE001
                logger.exception("arachne-flow: webhook failed")
                status, body = 500, {"error": "internal error"}
            self._send(status, body)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def status(env, flow: dict, scheduler: Scheduler = None) -> dict:
    """What the inspector shows per trigger node: active, next/last fire, last run, error, webhook URL."""
    state = load_state(env)
    out = {}
    for node in flow.get("nodes", []):
        if not is_trigger(node):
            continue
        st = state.get(key(flow["id"], node["id"])) or {}
        info = {"active": active(node), "next": st.get("next"), "last_fire": st.get("last_fire"),
                "last_run": st.get("last_run"), "fires": st.get("fires", 0), "error": st.get("error"),
                "note": st.get("note")}
        if node.get("type") == SCHEDULE:
            try:
                info["schedule"] = parse_schedule((node.get("params") or {}).get("schedule")).get("label")
            except ScheduleError as exc:
                info["error"] = str(exc)
        if node.get("type") == WEBHOOK:
            info["url"] = webhook_url(env, flow["id"], node)
            last = st.get("last_event")
            info["last_event_at"] = last.get("at") if isinstance(last, dict) else None
        if node.get("type") == FOLDER:
            try:
                picked_folder(env, flow["id"], node)
                info["watching"] = str((node.get("params") or {}).get("folder") or "").strip()   # as the user wrote it
            except ValueError as exc:
                info["error"] = str(exc)
        if node.get("type") == AFTER_FLOW:
            try:
                source = resolve_flow(env, (node.get("params") or {}).get("flow"), flow["id"])
                info["source"] = source.get("name") or source["id"]
            except ValueError as exc:
                info["error"] = str(exc)
        out[node["id"]] = info
    leader_pid = None
    try:
        with open(os.path.join(S.data_dir(env), "locks", "triggers.lock.pid"), encoding="ascii") as fh:
            raw = fh.read(32).strip()
            leader_pid = int(raw) if raw.isdigit() and S.pid_alive(int(raw)) else None
    except (OSError, ValueError):
        pass
    return {"nodes": out, "runner_pid": leader_pid,
            "server_error": scheduler.status.get("server_error") if scheduler else None}


def validate_issues(node: dict) -> list:
    """Static problems of a trigger node for graph.validate."""
    params = node.get("params") or {}
    issues = []
    if node.get("type") == SCHEDULE:
        try:
            parse_schedule(params.get("schedule"))
        except ScheduleError as exc:
            issues.append(("error", f"schedule: {exc}"))
    elif node.get("type") == RSS:
        url = str(params.get("url") or "").strip()
        if not url:
            issues.append(("error", "enter the feed URL"))
        elif not url.lower().startswith(("http://", "https://")):
            issues.append(("error", "the feed URL must start with http:// or https://"))
    elif node.get("type") == FOLDER:
        if not str(params.get("folder") or "").strip():
            issues.append(("error", "choose the folder to watch (Browse…)"))
    elif node.get("type") == AFTER_FLOW:
        if not str(params.get("flow") or "").strip():
            issues.append(("error", "enter the name or id of the flow to wait for"))
    return issues
