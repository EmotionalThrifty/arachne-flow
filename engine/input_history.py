"""Opt-in, best-effort-redacted snapshots of the runner's actual wired inputs."""
from __future__ import annotations
import json
import math
import re

MAX_BYTES = 1024 * 1024
MAX_VALUES = 10000
MAX_DEPTH = 32
_SENSITIVE = re.compile(r'password|passwd|secret|token|api.?key|authorization|credential|cookie|private.?key', re.I)
_BEARER = re.compile(r'(?i)\bBearer\s+[^\s,;]+')
_QUERY_SECRET = re.compile(r'(?i)([?&](?:token|access_token|api_key|key|password|secret)=)[^&#\s]+')


def snapshot(inputs, spec=None):
    count, sizes = [0], [0]
    sensitive = {p.get('name') for p in ((spec or {}).get('params', []) + (spec or {}).get('inputs', []))
                 if p.get('secret') or p.get('sensitive') or p.get('writeOnly') or p.get('format') == 'password'}
    def visit(value, depth=0, key=''):
        count[0] += 1
        if depth > MAX_DEPTH or count[0] > MAX_VALUES:
            raise ValueError('input history nesting or item limit exceeded')
        if _SENSITIVE.search(key) or (depth == 1 and key in sensitive):
            return '[redacted]'
        if isinstance(value, str):
            if len(value) > MAX_BYTES:
                raise ValueError('input history byte limit exceeded')
            sizes[0] += len(value.encode('utf-8'))
            if sizes[0] > MAX_BYTES:
                raise ValueError('input history byte limit exceeded')
            return _QUERY_SECRET.sub(r'\1[redacted]', _BEARER.sub('Bearer [redacted]', value))
        if isinstance(value, dict):
            if len(value) > MAX_VALUES:
                raise ValueError('input history item limit exceeded')
            result = {}
            for name, child in value.items():
                if not isinstance(name, str) or len(name) > 1000:
                    raise ValueError('invalid input history key')
                sizes[0] += len(name.encode('utf-8'))
                if sizes[0] > MAX_BYTES:
                    raise ValueError('input history byte limit exceeded')
                result[name] = visit(child, depth + 1, name)
            return result
        if isinstance(value, (list, tuple)):
            if len(value) > MAX_VALUES:
                raise ValueError('input history item limit exceeded')
            return [visit(child, depth + 1) for child in value]
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError('input history numbers must be finite')
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return '[unsupported input type]'
    result = visit(inputs)
    size = len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8'))
    if size > MAX_BYTES:
        raise ValueError('input history byte limit exceeded')
    return result, size
