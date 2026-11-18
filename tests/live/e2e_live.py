"""Live end-to-end check of the ready-made nodes against the providers THIS Hermes setup really has.

Test harness only (tests/ is never loaded by Hermes at plugin runtime) and never part of check.sh: it calls
paid providers and needs Hermes' own MCP discovery. Each category runs one node with the cheapest
listed model; a step whose price is unknown or above the cap is skipped, so one run can never cost more than
roughly the sum of the printed prices.

  bash scripts/hpy tests/live/e2e_live.py                 plan only: which node, provider, model and price (no calls)
  bash scripts/hpy tests/live/e2e_live.py --run           run the plan (paid), default cap $0.30 per step
  bash scripts/hpy tests/live/e2e_live.py --run --cap 0.5 --only image,3d,edit3d --unpriced

Steps: image (Text to image), tts (Text to speech), video (Text to video, 4-6 s), 3d (Text to 3D),
edit3d (Edit 3D model on the 3d result). Output files land in a temp dir that is printed at the end.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tests"))
os.environ.setdefault("ARACHNE_FLOW_TRIGGERS", "0")
os.environ.setdefault("ARACHNE_FLOW_DATA_DIR", tempfile.mkdtemp(prefix="arachne-e2e-data-"))

import helpers  # noqa: E402

STEPS = (  # (key, node type, inputs)
    ("image", "preset.text_to_image", {"prompt": "a small red wooden toy robot, plain white background"}),
    ("tts", "preset.tts", {"text": "Arachne Flow end to end check."}),
    ("video", "preset.text_to_video", {"prompt": "a paper boat drifting on a calm pond, soft morning light"}),
    ("3d", "preset.text_to_3d", {"prompt": "a small wooden treasure chest"}),
    ("edit3d", "preset.edit_3d", {}),          # mesh: the 3d step's result
)


class Ctx:
    """The real Hermes tool registry (MCP servers discovered like at Hermes start)."""

    def __init__(self, registry):
        self.registry = registry

    def dispatch_tool(self, name, args, **_kw):
        return self.registry.dispatch(name, args)


def load():
    import model_tools  # noqa: F401 - registers Hermes' built-in and plugin tools, like a running Hermes
    from tools.mcp_tool_discovery import discover_mcp_tools
    discover_mcp_tools()
    from tools.registry import registry
    engine = helpers.load_engine()
    env = engine.env.Env(ctx=Ctx(registry), state={})
    return engine, env


async def plan_step(engine, env, key, type_name, cap, unpriced):
    """``{key, type, provider, model, price, run, why}`` for one step, without calling a paid tool."""
    spec = engine.nodes.types_by_name(env).get(type_name)
    row = {"key": key, "type": type_name, "provider": "", "model": "", "price": None, "run": False, "why": ""}
    if spec is None:
        row["why"] = "no provider in this setup (node hidden)"
        return row, None
    row["provider"] = spec.get("provider") or "Hermes"
    model = next((p for p in spec.get("params") or [] if p.get("options_source") and p.get("auto")), None)
    if model is None:
        row.update(model="(Hermes backend setting)", why="price unknown (Hermes backend)")
        row["run"] = unpriced
        return row, spec
    listed = (await engine.options.fetch_options(env, model["options_source"],
                                                 accepts=model.get("options_accepts")))["options"]
    pick = engine.presets.auto_pick(listed)
    if not pick:
        row["why"] = "the provider lists no fitting model"
        return row, spec
    row["model"], row["price"] = pick["value"], pick.get("price")
    if row["price"] is None:
        row["run"], row["why"] = unpriced, "price unknown"
    elif row["price"] > cap:
        row["why"] = f"over the cap (${row['price']:.2f} > ${cap:.2f})"
    else:
        row["run"] = True
    return row, spec


async def run_step(engine, env, spec, row, inputs, out_dir):
    node = {"id": f"e2e_{row['key']}", "type": row["type"],
            "params": {"model": row["model"]} if row["model"] and not row["model"].startswith("(") else {}}
    if row["key"] == "video":
        node["params"]["duration"] = 5
    lines = []
    nctx = engine.executors.NodeContext(run_id="e2e", node_id=node["id"], out_dir=out_dir, allow_download=True,
                                        timeout_s=900, log=lambda m: (lines.append(m), print(f"    · {m}")))
    started = time.monotonic()
    result = await engine.executors.execute(env, node, spec, inputs, nctx)
    return result, time.monotonic() - started


def media_of(result):
    for value in (result or {}).values():
        if isinstance(value, dict) and "$media" in value:
            return value
    return None


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true", help="really call the providers (paid)")
    ap.add_argument("--cap", type=float, default=0.30, help="max list price per step in USD")
    ap.add_argument("--only", default="", help="comma list of steps: image,tts,video,3d,edit3d")
    ap.add_argument("--unpriced", action="store_true", help="also run steps whose price is unknown")
    a = ap.parse_args()
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    engine, env = load()
    out_dir = tempfile.mkdtemp(prefix="arachne-e2e-out-")
    rows, specs = [], {}
    for key, type_name, _inputs in STEPS:
        if only and key not in only:
            continue
        row, spec = await plan_step(engine, env, key, type_name, a.cap, a.unpriced)
        rows.append(row)
        specs[key] = spec
    total = sum(r["price"] or 0 for r in rows if r["run"])
    print(f"{'step':<7} {'provider':<12} {'model':<44} {'price':>7}  plan")
    for r in rows:
        price = f"${r['price']:.3f}" if isinstance(r["price"], (int, float)) else "?"
        print(f"{r['key']:<7} {r['provider'][:12]:<12} {r['model'][:44]:<44} {price:>7}  "
              f"{'run' if r['run'] else 'skip'}{(' — ' + r['why']) if r['why'] else ''}")
    print(f"planned cost ≈ ${total:.2f} (list prices)")
    if not a.run:
        print("plan only; add --run to call the providers")
        return 0
    results, failed = {}, 0
    for r in rows:
        if not r["run"]:
            continue
        inputs = dict(next(i for k, _t, i in STEPS if k == r["key"]))
        if r["key"] == "edit3d":
            mesh = media_of(results.get("3d"))
            if mesh is None:
                print("edit3d  skipped — needs the 3d step's model")
                continue
            inputs["mesh"] = mesh
        print(f"\n▶ {r['key']} · {r['provider']} · {r['model']}")
        try:
            result, took = await run_step(engine, env, specs[r["key"]], r, inputs, out_dir)
        except Exception as exc:  # noqa: BLE001 - report every step
            failed += 1
            print(f"  ✖ {type(exc).__name__}: {str(exc)[:400]}")
            continue
        results[r["key"]] = result
        media = media_of(result)
        if media is None:
            failed += 1
            print(f"  ✖ no media in the result: {json.dumps(result)[:300]}")
        else:
            meta = media["$media"]
            print(f"  ✔ {meta.get('kind')} {meta.get('path') or meta.get('source')} ({took:.0f} s)")
    print(f"\noutputs: {out_dir}\nE2E: {'FAIL' if failed else 'PASS'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
