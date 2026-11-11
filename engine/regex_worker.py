"""Isolated, short-lived regex evaluator. Parent enforces a killable wall-clock deadline.

Only JSON data crosses stdin/stdout; no host tools, imports from the plugin or user code are executed.
"""
import json
import re
import sys


def main():
    payload = json.loads(sys.stdin.buffer.read(262144))
    pattern, text = payload["pattern"], payload["text"]
    if not isinstance(pattern, str) or not isinstance(text, str) or len(pattern) > 512 or len(text) > 16384:
        raise ValueError("regular expression input exceeds limits")
    try:
        matched = re.search(pattern, text, 0 if payload.get("case_sensitive") else re.IGNORECASE) is not None
        result = {"matched": matched}
    except re.error as exc:
        result = {"error": str(exc)}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))


if __name__ == "__main__":
    main()
