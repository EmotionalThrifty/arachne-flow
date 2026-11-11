"""Deterministic, bounded data nodes. No tools, paths, network or evaluation."""
from __future__ import annotations
import json
import math
from . import graph as G
from . import types as T

MAX_JSON_BYTES = 1024 * 1024
MAX_DEPTH = 32
MAX_ITEMS = 50000
TYPES = ('input.json', 'json.build', 'json.set', 'text.split', 'text.join', 'list.filter', 'list.deduplicate')


def fail(message):
    from .executors import NodeError
    raise NodeError(message)


def bounded(value, depth=0, count=None):
    if count is None:
        count = [0, 0]
    count[0] += 1
    # Include container/key overhead without rejecting exactly 50,000 list items.
    if depth > MAX_DEPTH or count[0] > MAX_ITEMS + 16:
        fail('JSON is too deeply nested or has too many values (32 levels / 50,000 values)')
    if isinstance(value, str):
        if len(value) > MAX_JSON_BYTES:
            fail('Data exceeds 1 MiB')
        try:
            count[1] += len(value.encode('utf-8'))
        except UnicodeError:
            fail('JSON text must be valid UTF-8')
        if count[1] > MAX_JSON_BYTES:
            fail('Data exceeds 1 MiB')
    if isinstance(value, int) and value.bit_length() > 4096:
        fail('JSON integer is too large')
    if isinstance(value, float) and not math.isfinite(value):
        fail('JSON numbers must be finite')
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            fail('JSON object keys must be strings')
        for key, child in value.items():
            bounded(key, depth + 1, count)
            bounded(child, depth + 1, count)
    elif isinstance(value, list):
        for child in value:
            bounded(child, depth + 1, count)
    elif not isinstance(value, (str, int, float, bool, type(None))):
        fail('Value is not JSON-compatible')
    return value


def parse(text):
    if not isinstance(text, str):
        return T.defang(bounded(text))
    try:
        if len(text.encode('utf-8')) > MAX_JSON_BYTES:
            fail('JSON input exceeds 1 MiB')
        value = json.loads(text, parse_constant=lambda token: fail('JSON numbers must be finite'))
    except json.JSONDecodeError as exc:
        fail(f'Invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}')
    except (UnicodeError, RecursionError, ValueError):
        fail('Invalid JSON: number, encoding or nesting limit exceeded')
    return T.defang(bounded(value))


def collection(value):
    if not isinstance(value, list):
        fail('Expected a list, not a scalar or object')
    return bounded(value)


def param(params, key, default):
    return params[key] if key in params and params[key] is not None else default


def enabled(params, key, default=False):
    value = param(params, key, default)
    return value is True or value == 'true'


async def execute(env, node, spec, inputs, nctx):
    kind, params = node['type'], node.get('params') or {}
    bounded(inputs)
    if kind == 'input.json':
        value = params['value'] if 'value' in params else '{}'
        result = {'value': parse(value)}
    elif kind == 'json.build':
        names = G.template_placeholders(param(params, 'fields', '{{value}}'))
        result = {'value': {key: inputs.get(key) for key in names}}
    elif kind == 'json.set':
        data = inputs.get('data')
        if not isinstance(data, dict):
            fail('Set field requires a JSON object')
        key = param(params, 'key', '')
        if not isinstance(key, str) or not key:
            fail('Field name must not be empty')
        if key in T.ENGINE_KEYS:
            fail('This field name is reserved for engine values')
        result = {'value': {**data, key: T.defang(inputs.get('value'))}}
    elif kind == 'text.split':
        text, sep = inputs.get('text'), param(params, 'separator', '\n')
        if not isinstance(text, str) or not isinstance(sep, str) or not sep:
            fail('Split requires text and a non-empty literal separator')
        values = text.split(sep, MAX_ITEMS)
        if len(values) > MAX_ITEMS:
            fail('Split exceeds 50,000 values')
        if enabled(params, 'trim'):
            values = [v.strip() for v in values]
        if not enabled(params, 'keep_empty', True):
            values = [v for v in values if v != '']
        result = {'list': values}
    elif kind == 'text.join':
        values = collection(inputs.get('list'))
        sep = param(params, 'separator', '\n')
        if not isinstance(sep, str):
            fail('Join separator must be text')
        parts = [T.to_text(v) for v in values]
        try:
            if len(sep) > MAX_JSON_BYTES:
                fail('Join result exceeds 1 MiB')
            size = sum(len(v.encode('utf-8')) for v in parts) + len(sep.encode('utf-8')) * max(0, len(parts) - 1)
        except UnicodeError:
            fail('Join separator and values must be valid UTF-8')
        if size > MAX_JSON_BYTES:
            fail('Join result exceeds 1 MiB')
        result = {'text': sep.join(parts)}
    elif kind == 'list.deduplicate':
        values, seen, out = collection(inputs.get('list')), set(), []
        for value in values:
            key = json.dumps(value, ensure_ascii=True, sort_keys=True, allow_nan=False)
            if key not in seen:
                seen.add(key)
                out.append(value)
        result = {'list': out}
    elif kind == 'list.filter':
        values, op = collection(inputs.get('list')), param(params, 'op', 'not empty')
        if op == 'not empty':
            out = [v for v in values if v is not None and not (isinstance(v, (str, list, dict)) and not (v.strip() if isinstance(v, str) else v))]
        elif op == 'equals':
            comparison = inputs['compare'] if 'compare' in inputs else parse(param(params, 'compare', 'null'))
            target = json.dumps(comparison, sort_keys=True, allow_nan=False)
            out = [v for v in values if json.dumps(v, sort_keys=True, allow_nan=False) == target]
        else:
            fail('Filter operation must be not empty or equals')
        result = {'list': out}
    else:
        fail('Unknown data node')
    bounded(result)
    try:
        if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_JSON_BYTES:
            fail('Data node result exceeds 1 MiB')
    except (UnicodeError, ValueError, RecursionError):
        fail('Data node result is not valid bounded JSON')
    return result


def specs():
    def port(name, kind='any', required=True):
        return {'name': name, 'type': kind, 'required': required, 'label': name.title()}
    def setting(name, kind, default, label=None):
        return {'name': name, 'kind': kind, 'default': default, 'label': label or name.replace('_',' ').title()}
    def node(kind, title, category, inputs, outputs, params, description):
        return {'type': kind, 'title': title, 'category': category, 'icon': 'json' if category in ('Data','Inputs') else 'list-unordered',
                'inputs': inputs, 'outputs': outputs, 'params': params, 'description': description + ' Local only; at most 1 MiB / 50,000 values / 32 levels.'}
    build = node('json.build','Build object','Data',[],[port('value','json')],
                 [setting('fields','textarea','{{value}}','Fields — {{name}} per field')],
                 'Build a typed object from connected ports, without string interpolation. Missing fields become null.')
    build.update(dynamic_inputs='fields', dynamic_input_type='any')
    return [
        node('input.json','JSON','Inputs',[],[port('value','json')],[setting('value','json','{}','JSON value')],
             'An object, list or scalar, including false and null. Engine marker keys are made inert.'),
        build,
        node('json.set','Set field','Data',[port('data','json'),port('value',required=False)],[port('value','json')],
             [setting('key','text','','Field name')],'Set one top-level field without changing the upstream object.'),
        node('text.split','Split text','Text',[port('text','text')],[port('list','json')],
             [setting('separator','textarea','\n'),setting('trim','boolean',False),setting('keep_empty','boolean',True)],
             'Split by a literal separator, not a regex. Empty elements are preserved unless disabled.'),
        node('text.join','Join list','Text',[port('list','json')],[port('text','text')],
             [setting('separator','textarea','\n')],'Join list values as text. null becomes empty text; objects become JSON.'),
        node('list.filter','Filter list','Data',[port('list','json'),port('compare',required=False)],[port('list','json')],
             [{**setting('op','select','not empty'),'options':['not empty','equals']},setting('compare','json','null')],
             'Not empty retains false and zero. Equals uses JSON types, so false differs from zero.'),
        node('list.deduplicate','Deduplicate','Data',[port('list','json')],[port('list','json')],[],
             'Keep the first occurrence of each typed JSON value. Object key order does not matter.'),
    ]
