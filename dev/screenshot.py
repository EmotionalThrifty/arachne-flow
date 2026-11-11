"""Screenshot desktop/plugin.js in headless Chrome against the dev server.

  bash scripts/hpy dev/screenshot.py <scenario> [--width 1600 --height 1000] [--wait-ms 6000]

Scenarios (dev_server.reset): empty, template, running, done, inspector.
Writes dev/out/<scenario>.png and prints its path plus a short sanity summary. Live events are
disabled (?events=0: an open SSE stream would keep headless Chrome from ever settling); the page
must fall back to polling, exactly like Desktop does when events are delayed.
"""
from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import dev_server  # noqa: E402

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def chrome() -> str:
    for path in CHROME_CANDIDATES:
        if os.path.isfile(path):
            return path
    found = shutil.which("chrome") or shutil.which("msedge")
    if not found:
        sys.exit("no Chrome/Edge found")
    return found


def sanity(path: str) -> str:
    from PIL import Image, ImageStat
    with Image.open(path) as img:
        stat = ImageStat.Stat(img.convert("L"))
        colors = len(img.convert("RGB").resize((200, 125)).getcolors(200 * 125) or [])
        return f"{img.size[0]}x{img.size[1]}, luminance stddev {stat.stddev[0]:.1f}, ~{colors} colours"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", nargs="?", default="template")
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--height", type=int, default=1000)
    parser.add_argument("--wait-ms", type=int, default=6000)
    parser.add_argument("--query", default="", help="extra query string, e.g. inspector=0")
    args = parser.parse_args()

    seeded = dev_server.reset(args.scenario)
    port = free_port()
    dev_server.serve(port, block=False)
    query = {"events": "0"}
    if seeded.get("flow_id"):
        query["flow"] = seeded["flow_id"]
    if seeded.get("select"):
        query["select"] = seeded["select"]
    if args.scenario in ("quick", "quick_add"):
        query.update(quick="add" if args.scenario == "quick_add" else "1", recent="llm.complete,input.text")
    url = f"http://127.0.0.1:{port}/?{urlencode(query)}" + (f"&{args.query}" if args.query else "")
    out_dir = os.path.join(HERE, "out")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"{args.scenario}.png")
    if os.path.exists(out):
        os.remove(out)
    profile = tempfile.mkdtemp(prefix="fc-chrome-")
    cmd = [chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
           "--no-default-browser-check", f"--user-data-dir={profile}",
           f"--window-size={args.width},{args.height}", f"--virtual-time-budget={args.wait_ms}",
           f"--screenshot={out}", url]
    try:
        subprocess.run(cmd, check=False, timeout=90, capture_output=True)
    except subprocess.TimeoutExpired:
        print("chrome timed out", file=sys.stderr)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        pending = dev_server.drain_runs()
    if pending:
        print(f"runs did not stop: {pending}", file=sys.stderr)
        return 1
    if not os.path.isfile(out):
        print("no screenshot written", file=sys.stderr)
        return 1
    print(out)
    print(sanity(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
