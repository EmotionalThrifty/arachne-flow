"""G9: how long nodes really take — averages of the last finished runs per node type and model.

The runner writes ``type`` and ``model`` into every node state it starts; this module reads the stored run
records back. Only real work counts (status ``done``): cached hits, failures, cancels and records from before
G9 (no ``type``) are ignored. Run files never change after they finish, so each one is parsed once per
process and reused while its mtime and size stay the same (cache in ``env.state``, no module globals).
"""
from __future__ import annotations

import os

from . import graph as G
from . import store as S

WINDOW = 5  # "the last runs": newest five finished executions per type/model


def _blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def model_key(spec, node) -> str:
    """The node's model, as the duration statistics group it: the model setting, else its default, else ''."""
    if not isinstance(spec, dict):
        return ""
    field = next((p for p in spec.get("params") or [] if p.get("options_source") or p.get("kind") == "model"), None)
    if not field:
        return ""
    value = ((node or {}).get("params") or {}).get(field["name"])
    if _blank(value):
        value = field.get("default")
    return "" if _blank(value) else str(value).strip()


def _samples(run: dict) -> list:
    """(started_at, run started_at, run id, type, model, ms) for every node of `run` that did real work."""
    out = []
    for parent in (run.get("nodes") or {}).values():
        if not isinstance(parent, dict) or not parent.get("type"):
            continue
        # a For each body node holds one record per item (G11); each item is one real execution
        states = parent["iterations"] if isinstance(parent.get("iterations"), list) else [parent]
        for state in states:
            sample = _sample(run, parent, state)
            if sample:
                out.append(sample)
    return out


def _sample(run: dict, parent: dict, state):
    if not isinstance(state, dict) or state.get("status") != "done":
        return None
    ms = state.get("ms")
    if isinstance(ms, bool) or not isinstance(ms, (int, float)) or ms < 0:
        return None
    return (str(parent.get("started_at") or ""), str(run.get("started_at") or ""), str(run.get("id") or ""),
            str(parent["type"]), str(parent.get("model") or ""), int(ms))


def _summary(samples: list, window: int) -> dict:
    last = sorted(samples, reverse=True)[:window]
    values = [s[5] for s in last]
    return {"n": len(values), "avg_ms": int(round(sum(values) / len(values))), "min_ms": min(values),
            "max_ms": max(values)}


def collect(runs, window: int = WINDOW) -> dict:
    """Pure: run records -> {window, nodes: [{type, model, n, avg_ms, min_ms, max_ms}], types: [{type, ...}]}."""
    samples = [s for run in runs if isinstance(run, dict) for s in _samples(run)]
    return _aggregate(samples, window)


def _aggregate(samples: list, window: int) -> dict:
    by_model: dict = {}
    by_type: dict = {}
    for s in samples:
        by_model.setdefault((s[3], s[4]), []).append(s)
        by_type.setdefault(s[3], []).append(s)
    nodes = [{"type": t, "model": m, **_summary(v, window)} for (t, m), v in sorted(by_model.items())]
    types = [{"type": t, **_summary(v, window)} for t, v in sorted(by_type.items())]
    return {"window": window, "nodes": nodes, "types": types}


def _run_files(env):
    root = S.runs_dir(env)
    try:
        flow_ids = [d for d in os.listdir(root) if G.FLOW_ID_RE.match(d)]
    except OSError:
        return
    for fid in flow_ids:
        folder = os.path.join(root, fid)
        try:
            names = os.listdir(folder)
        except OSError:
            continue
        for name in names:
            if name.endswith(".json") and S.RUN_ID_RE.match(name[:-5]):
                yield os.path.join(folder, name)


def stats(env, window: int = WINDOW) -> dict:
    """Durations from every stored run (GET /x/timings). Unchanged run files are not parsed again."""
    cache = env.state.setdefault("timings_cache", {})
    seen = set()
    samples = []
    for path in _run_files(env):
        try:
            st = os.stat(path)
        except OSError:
            continue
        sig = (st.st_mtime_ns, st.st_size)
        seen.add(path)
        hit = cache.get(path)
        if not hit or hit[0] != sig:
            run = S._try_read(path)
            hit = (sig, _samples(run) if isinstance(run, dict) else [])
            cache[path] = hit
        samples.extend(hit[1])
    for gone in set(cache) - seen:
        cache.pop(gone, None)
    return _aggregate(samples, window)
