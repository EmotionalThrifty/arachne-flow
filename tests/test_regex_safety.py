"""EN-4 repro: If/Switch regex must fail fast instead of hanging the run.

Current engine code runs stdlib ``re`` in-process (``engine/executors._regex``).
``(a+)+$`` against 100_000 ``a`` backtracks catastrophically, and Hermes'
Python 3.14 has no timeout-capable regex package: the call blocks the run /
async event loop for an unbounded time. This test is RED until regex work is
moved into a hard-time-limited worker: it expects a readable ``NodeError``
within 2 s.

The risky call never runs in this process. Every such call gets a fresh worker
process that is killed hard at the deadline, so a regression cannot hang the
suite and never turns into a false pass. ``re`` itself is not mocked.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

import helpers

E = helpers.load_engine()
X = E.executors

REPO = helpers.ROOT
TESTS = os.path.join(REPO, "tests")

BUDGET_S = 2.0            # target: an answer (NodeError) within this
WORKER_TIMEOUT_S = 6.0    # hard kill per worker; 2 workers keep the suite < 30 s
EVIL_PATTERN = "(a+)+$"
EVIL_TEXT_A_COUNT = 100_000

# Runs one risky call in its own process and reports the outcome as one line.
# The text is built here: 100k characters do not fit a Windows command line.
_CHILD = """
import json, sys, time
tests_dir, mode, pattern, count = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
sys.path.insert(0, tests_dir)
import helpers
X = helpers.load_engine().executors
text = "a" * count + "!"
started = time.monotonic()
try:
    if mode == "if":
        X.check_condition("regex", text, pattern)
    elif mode == "switch":
        X.switch_match("regex", text, pattern, False)
    else:
        raise SystemExit("unknown mode " + mode)
    payload = {"outcome": "returned"}
except X.NodeError as exc:
    payload = {"outcome": "NodeError", "message": str(exc)}
except BaseException as exc:
    payload = {"outcome": type(exc).__name__, "message": str(exc)}
payload["elapsed"] = round(time.monotonic() - started, 4)
print("RESULT " + json.dumps(payload))
"""


def tail(text: str, limit: int = 1200) -> str:
    text = (text or "").strip()
    return text[-limit:] if len(text) > limit else text


class RegexSafetyTest(unittest.TestCase):
    """Each risk case: worker process, hard kill, no result means failure."""

    @classmethod
    def setUpClass(cls):
        cls.data_dir = helpers.temp_data_dir()
        cls.cache_dir = tempfile.mkdtemp(prefix="flowcanvas-test-cache-")

    def run_worker(self, mode, pattern=EVIL_PATTERN, count=EVIL_TEXT_A_COUNT,
                   timeout=WORKER_TIMEOUT_S):
        label = "check_condition('regex', ...)" if mode == "if" else "switch_match('regex', ...)"
        env = dict(os.environ)
        env["FLOWCANVAS_DATA_DIR"] = self.data_dir
        env["FLOWCANVAS_CACHE"] = self.cache_dir
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        cmd = [sys.executable, "-c", _CHILD, TESTS, mode, pattern, str(count)]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace",
                                cwd=REPO, env=env)
        started = time.monotonic()
        timed_out = False
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()                     # hard stop, also inside C-level re
            out, err = proc.communicate()
            timed_out = True
        wall = time.monotonic() - started
        if timed_out:
            print(f"[EN-4] {label} worker pid={proc.pid} still inside stdlib re after "
                  f"{timeout:.1f}s; killed at {wall:.2f}s", file=sys.stderr, flush=True)
            self.fail(
                f"{label} did not return within {timeout:.1f}s; the worker was killed while "
                f"still inside stdlib re (wall clock {wall:.2f}s, exit code {proc.returncode}). "
                f"Expected a readable "
                f"NodeError within {BUDGET_S:.1f}s for pattern {pattern!r} on "
                f"{count} characters. Catastrophic backtracking must not run in the "
                f"run/async-event-loop process. The worker produced no result: this is a "
                f"real hang, not a slow pass."
            )
        line = next((ln for ln in out.splitlines() if ln.startswith("RESULT ")), None)
        if line is None:
            self.fail(
                f"{label}: worker exited {proc.returncode} without a result "
                f"(wall clock {wall:.2f}s).\nstderr:\n{tail(err)}"
            )
        result = json.loads(line[len("RESULT "):])
        result["wall"] = wall
        result["stderr"] = tail(err)
        return result

    def assert_fast_nodeerror(self, mode, count=EVIL_TEXT_A_COUNT):
        label = "check_condition('regex', ...)" if mode == "if" else "switch_match('regex', ...)"
        result = self.run_worker(mode, count=count)
        self.assertEqual(
            result["outcome"], "NodeError",
            f"{label} returned {result['outcome']!r} instead of NodeError for catastrophic "
            f"backtracking ({result.get('message')!r}); the run must reject it, not compute it. "
            f"stderr: {result['stderr']}"
        )
        self.assertLess(
            result["elapsed"], BUDGET_S,
            f"{label} raised NodeError only after {result['elapsed']:.2f}s "
            f"(budget {BUDGET_S:.1f}s); the run/event loop was blocked too long."
        )
        message = result.get("message") or ""
        self.assertGreaterEqual(len(message.strip()), 12,
                                f"{label} NodeError message is not understandable: {message!r}")
        self.assertTrue(
            "regex" in message.lower() or "expression" in message.lower(),
            f"{label} NodeError should say what failed (regex/expression), got: {message!r}"
        )
        return result

    def test_if_regex_catastrophic_pattern_fails_fast(self):
        self.assert_fast_nodeerror("if")

    def test_switch_regex_catastrophic_pattern_fails_fast(self):
        self.assert_fast_nodeerror("switch")

    def test_pathological_pattern_below_text_limit_still_has_a_deadline(self):
        # A size guard alone must not masquerade as a computation-time guard.
        self.assert_fast_nodeerror("if", count=64)

    def test_if_regex_valid_pattern_and_case_insensitive_match(self):
        self.assertTrue(X.check_condition("regex", "Order #A12", r"#a\d+", False))
        self.assertFalse(X.check_condition("regex", "Order #A12", r"#a\d+", True))
        self.assertFalse(X.check_condition("regex", "Order #A12", r"^B", False))

    def test_switch_regex_valid_pattern_and_case_insensitive_match(self):
        self.assertTrue(X.switch_match("regex", "Order #A12", r"#a\d+", False))
        self.assertFalse(X.switch_match("regex", "Order #A12", r"#a\d+", True))
        self.assertFalse(X.switch_match("regex", "Order #A12", r"^B", False))

    def test_invalid_pattern_is_a_nodeerror(self):
        with self.assertRaises(X.NodeError) as if_exc:
            X.check_condition("regex", "text", "(", False)
        self.assertIn("invalid regular expression", str(if_exc.exception))
        with self.assertRaises(X.NodeError) as switch_exc:
            X.switch_match("regex", "text", "(", False)
        self.assertIn("invalid regular expression", str(switch_exc.exception))

    def test_short_pathological_text_stays_correct_and_fast(self):
        """A nested quantifier on a short value must still be evaluated, not banned."""
        for label, call in (
            ("if", lambda: X.check_condition("regex", "aaaaaa!", EVIL_PATTERN, False)),
            ("switch", lambda: X.switch_match("regex", "aaaaaa!", EVIL_PATTERN, False)),
        ):
            started = time.monotonic()
            self.assertFalse(call(), f"{label}: short text should not match {EVIL_PATTERN!r}")
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, BUDGET_S, f"{label}: short-text regex took {elapsed:.2f}s")


if __name__ == "__main__":
    unittest.main(verbosity=2)
