"""Model guide for Build with Hermes: which models each model setting can take and what they are good at.

Kept small on purpose (MAX_GUIDE_CHARS): models the user names come first, then models the flow already uses,
then a short ranked selection; the rest is only counted. Sources are the same lists the inspector shows:
  - LLM nodes: the providers/models Hermes offers (sent by the UI from the gateway's ``model.options``),
    enriched with descriptions/capabilities from an MCP text-model list tool when one exists;
  - tool / preset nodes: their ``options_source`` list tool (cached like the inspector, OPTIONS_TTL_S).
List tools are read-only catalog calls; a failing or slow one is skipped, never fatal.
"""
from __future__ import annotations

import asyncio
import re

from . import options as O

MAX_GUIDE_CHARS = 14000
MAX_DETAILED_PER_SOURCE = 18     # full lines (id, price, abilities, purpose) per list
MAX_INDEX_PER_SOURCE = 60        # further ids, names only
LIST_TIMEOUT_S = 25
MAX_PROVIDERS = 30
MAX_MODELS_PER_PROVIDER = 600
_WORD = re.compile(r"[a-z0-9]+(?:[.\-][a-z0-9]+)*")
_STOP = {"the", "and", "with", "for", "use", "model", "models", "modell", "modelle", "nimm", "nutze", "und",
         "mit", "der", "die", "das", "ein", "eine", "flow", "node", "nodes", "bitte", "please", "image", "text"}


def _text(value, limit=120) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def sanitize_llm_models(raw) -> list:
    """The UI's provider/model list is an untrusted hint: bounded, strings only, nothing else kept."""
    out = []
    if not isinstance(raw, list):
        return out
    for row in raw[:MAX_PROVIDERS]:
        if not isinstance(row, dict):
            continue
        provider = _text(row.get("provider"), 80)
        if not provider:
            continue
        models = []
        for m in (row.get("models") or [])[:MAX_MODELS_PER_PROVIDER]:
            if isinstance(m, str):
                m = {"id": m}
            if not isinstance(m, dict) or not _text(m.get("id")):
                continue
            item = {"id": _text(m.get("id"))}
            if isinstance(m.get("reasoning"), bool):
                item["reasoning"] = m["reasoning"]
            for key in ("input", "output"):
                if isinstance(m.get(key), (int, float, str)) and str(m[key]).strip():
                    item[key] = str(m[key]).strip()[:16]
            models.append(item)
        if models:
            out.append({"provider": provider, "name": _text(row.get("name"), 80) or provider,
                        "current": row.get("current") is True, "current_model": _text(row.get("current_model")),
                        "models": models})
    return out


def _prompt_words(prompt: str) -> set:
    return {w for w in _WORD.findall((prompt or "").casefold()) if (len(w) >= 3 or any(c.isdigit() for c in w))
            and w not in _STOP}


def _mention(words: set, *names) -> int:
    hay = " ".join(n.casefold() for n in names if n)
    flat = re.sub(r"[^a-z0-9.]+", "", hay)
    return sum(1 for w in words if w in hay or w.replace("-", "") in flat)


def _used(flow, types) -> dict:
    """(type, param) -> set of model values already set in the flow."""
    used = {}
    for n in (flow or {}).get("nodes", []) if isinstance(flow, dict) else []:
        params = n.get("params") or {}
        spec = types.get(n.get("type")) or {}
        for p in spec.get("params") or []:
            if (p.get("options_source") or p.get("kind") == "model") and isinstance(params.get(p.get("name")), str):
                used.setdefault(p.get("name"), set()).add(params[p["name"]])
    return used


def _rank(rows, words, used_values, key_price):
    def key(r):
        hit = _mention(words, r["id"], r.get("label", ""))
        price = key_price(r)
        return (-(1000 if r["id"] in used_values else 0) - hit * 10, price if price is not None else 1e9, r["id"])
    return sorted(rows, key=key)


def _section(title: str, rows: list, line, words: set, used_values: set, key_price) -> str:
    rows = _rank(rows, words, used_values, key_price)
    named = [r for r in rows if r["id"] in used_values or _mention(words, r["id"], r.get("label", ""))]
    detailed = named + [r for r in rows if r not in named][:max(0, MAX_DETAILED_PER_SOURCE - len(named))]
    rest = [r["id"] for r in rows if r not in detailed]
    lines = [title] + ["  " + line(r) for r in detailed]
    if rest:
        shown = rest[:MAX_INDEX_PER_SOURCE]
        more = len(rest) - len(shown)
        lines.append("  also: " + ", ".join(shown) + (f" (+{more} more; not listed)" if more else ""))
    return "\n".join(lines)


def _price(value) -> str:
    return "" if value is None else f"${value:g}"


async def _list(env, source, accepts=None):
    try:
        return (await asyncio.wait_for(O.fetch_options(env, source, accepts=accepts), LIST_TIMEOUT_S)).get("options") or []
    except Exception:  # noqa: BLE001 - a missing catalog only makes the guide shorter
        return []


async def _llm_details(env) -> dict:
    """id -> row info from the first text-model list tools (descriptions, abilities, token prices)."""
    try:
        from . import nodes as N
        tools = [t.get("name") for t in N.registry_tools(env)]
    except Exception:  # noqa: BLE001
        return {}
    info = {}
    for name in O.llm_list_candidates(tools, "")[:O.MAX_LL_LIST_TOOLS]:
        try:
            result, _cached = await asyncio.wait_for(O._list_result(env, name, False, {"detailed": True}), LIST_TIMEOUT_S)
        except Exception:  # noqa: BLE001
            continue
        for row in O._model_rows(result):
            mid = row.get("id") or row.get("model")
            if isinstance(mid, str) and mid not in info:
                info[mid] = O.llm_row_info(row)
    return info


def _abilities(info: dict, ui: dict) -> str:
    caps = info.get("capabilities") or {}
    tags = [k.replace("_", " ") for k, v in caps.items() if v][:6]
    ins = [m for m in info.get("input_modalities") or [] if m != "text"]
    if ins:
        tags.append("reads " + "/".join(ins))
    if ui.get("reasoning") and "reasoning" not in tags:
        tags.append("reasoning")
    if info.get("context_length"):
        tags.append(f"{info['context_length'] // 1000}k ctx")
    return ", ".join(dict.fromkeys(tags))


def _llm_section(llm_models: list, details: dict, words: set, used: set) -> list:
    sections = []
    for group in llm_models:
        rows = []
        for m in group["models"]:
            info = details.get(m["id"], {})
            pricing = info.get("pricing") or {}
            price = pricing.get("input") if pricing else None
            if price is None and m.get("input"):
                try:
                    price = float(str(m["input"]).lstrip("$"))
                except ValueError:
                    price = None
            rows.append({"id": m["id"], "label": info.get("label") or "", "price": price,
                         "out": pricing.get("output") if pricing else m.get("output"),
                         "abilities": _abilities(info, m), "purpose": _text(info.get("description"), 110)})

        def line(r):
            cost = f"in {_price(r['price'])}/out {_price(r['out']) if isinstance(r['out'], (int, float)) else r['out'] or '?'} per Mtok" \
                if r["price"] is not None else ""
            parts = [p for p in (r["abilities"], cost, r["purpose"]) if p]
            return r["id"] + (" — " + "; ".join(parts) if parts else "")

        cur = f", Hermes' active model: {group['current_model']}" if group.get("current") and group.get("current_model") else ""
        title = (f"llm.complete provider={group['provider']} ({group['name']}{cur}). "
                 f"Set params provider=\"{group['provider']}\" and model=<id> together:")
        sections.append(_section(title, rows, line, words, used, lambda r: r["price"]))
    return sections


async def build_guide(env, prompt: str, flow, types: dict, llm_models=None) -> str:
    """The MODEL GUIDE text, or "" when no list is available. Never raises."""
    words = _prompt_words(prompt)
    used = _used(flow, types)
    sources = {}                          # options_source -> {"param", "accepts", "types"}
    for name, spec in types.items():
        for p in spec.get("params") or []:
            src = p.get("options_source")
            if src and src != "messaging_channels":
                entry = sources.setdefault((src, p.get("options_accepts")), {"param": p.get("name"), "types": []})
                entry["types"].append(name)
    # Lists for node types the prompt or the flow touches first; the other lists fill the remaining budget.
    in_flow = {n.get("type") for n in (flow or {}).get("nodes", [])} if isinstance(flow, dict) else set()

    def interest(item):
        (src, _acc), entry = item
        hay = " ".join([src] + entry["types"])
        return (-(5 if in_flow & set(entry["types"]) else 0) - _mention(words, hay), src)

    ordered = sorted(sources.items(), key=interest)
    lists = await asyncio.gather(*(_list(env, src, acc) for (src, acc), _e in ordered))
    sections = []
    if llm_models:
        sections += _llm_section(llm_models, await _llm_details(env), words, used.get("model", set()))
    for ((_src, acc), entry), options in zip(ordered, lists, strict=True):
        if not options:
            continue
        rows = [{"id": o["value"], "label": o.get("label") if o.get("label") != o["value"] else "",
                 "price": o.get("price"), "unit": o.get("unit") or "",
                 "purpose": " · ".join(x for x in (o.get("operation") or "",
                                                   "in the user's plan" if o.get("included") else "",
                                                   _text(o.get("description"), 100)) if x)}
                for o in options if isinstance(o.get("value"), str)]
        node_list = ", ".join(entry["types"][:6]) + (" …" if len(entry["types"]) > 6 else "")

        def line(r):
            parts = [p for p in (r["label"], (_price(r["price"]) + r["unit"]) if r["price"] is not None else "",
                                 r["purpose"]) if p]
            return r["id"] + (" — " + "; ".join(parts) if parts else "")

        title = f"{node_list}: param {entry['param']} (accepts {acc} input)" if acc else f"{node_list}: param {entry['param']}"
        if acc == "3d":
            title += " — processes an existing 3D model (rig, animate, remesh, retexture); wire a 3D output into it"
        sections.append(_section(title + ":", rows, line, words, used.get(entry["param"], set()),
                                 lambda r: r["price"]))
    # Which provider each ready-made node runs on, so the generator picks the node of the provider the user names.
    providers = [f"{name} — {spec.get('provider') or 'Hermes'}"
                 + ("" if str(spec.get("tool") or "").startswith("mcp__") else " (model and backend set in Hermes' "
                                                                              "settings; no model param)")
                 for name, spec in sorted(types.items()) if spec.get("kind") == "preset" and spec.get("provider")]
    if providers:
        sections.insert(0, "READY-MADE NODES BY PROVIDER (a '~' id is the same step on another provider):\n  "
                        + "\n  ".join(providers[:40]))
    out, size = [], 0
    for s in sections:
        if size + len(s) + 2 > MAX_GUIDE_CHARS:
            head = s.split("\n", 1)[0]
            if size + len(head) + 40 <= MAX_GUIDE_CHARS:
                out.append(head + "\n  (list omitted for size; keep this setting unless the user names a model)")
                size += len(out[-1]) + 2
            continue
        out.append(s)
        size += len(s) + 2
    return "\n\n".join(out)
