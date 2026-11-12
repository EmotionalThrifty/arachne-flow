---
name: arachne-flow
description: Use when building, editing, debugging, or running Arachne Flow node flows or chaining tools/LLM steps.
---

# Arachne Flow

Arachne Flow (plugin id `arachne-flow`) is a node editor inside Hermes Desktop. A **flow** is a saved graph: nodes (inputs, LLM calls,
Hermes tools, MCP tools, curated presets) wired output → input. The user sees every flow you build on the
canvas, with live status per node, and can edit and re-run it without you.

## When to build a flow

- The user asks for a repeatable pipeline ("every time I give you X, do A, then B, then C").
- A task chains 3+ steps whose intermediate results are worth seeing (prompt → image → 3D, search → summary).
- The user says "flow", "canvas", "pipeline", "node", or wants to tweak the steps later themselves.

Do **not** build a flow for a one-off answer you can give directly with one or two tool calls.
When the user discards a demo design or requests deletion, do not recreate it automatically; agree the new scenario before building replacements.

## Autonomy and safety

Finish the design, implementation, and verification without asking for plan approval. Do not ask the
user to choose node types, routine defaults, or settings that the available catalogs can determine.
Make reasonable assumptions, choose the simplest reliable design, and state only assumptions that
matter. Ask only when required information cannot be retrieved or an action needs a real approval.

Building and static validation do not execute the flow. **Do not run paid generation** (image, video,
3D, speech, paid LLM calls) unless the user asked for that run or clearly confirmed the cost. Building
a paid flow is allowed; leave it validated and say that it was not executed. Never put credentials or
secrets into node parameters. Do not overwrite concurrent edits: use `base_revision` on existing flows.

**Do not run or arm a `Send message` node on the user's behalf.** Enabling it is
only the user's own explicit action because a run sends a real, irreversible message. Do not set
`send_enabled`, `authorized_target`, `allow_attachments` or `optin_token` through `flow_apply` or another param write and do
not call the opt-in action on the user's behalf. Building and static validation do not send a message.

## Workflow

1. **Establish the contract.** Identify inputs, final outputs, transformations, branch/loop behavior,
   failure behavior, and whether execution is requested. `flow_list` shows existing flows, templates,
   and each flow's latest run. Reuse a suitable flow or template instead of creating a near-duplicate.
   For an existing flow, always `flow_get` first and preserve working nodes, connections, models, and
   settings unless the request or evidence requires a change.
2. **Discover before designing.** Use `flow_node_types(query="image")` or
   `flow_node_types(category="Presets")` for every relevant capability. Only returned types exist right
   now. Read exact ports, parameter defaults, descriptions, options, limits, and model metadata before
   writing ops. Prefer `preset.*` over raw `tool:*` nodes: presets have typed media ports and map fields.
3. **Design the whole graph.** Map every input to the final output, including extraction, prompts,
   branch joins, loop collectors, and a useful preview or terminal node. Perform the **Mandatory flow
   audit** below for every node and every parameter, not only nodes you added or changed.
4. **Apply atomically.** Build the complete graph in ONE `flow_apply` call. Give new nodes unique refs,
   connect with `"ref.port"`, set dynamic templates before their connections, and finish with
   `{"op":"auto_layout"}` unless exact positions matter. For edits, send the minimal complete set of
   changes plus the `base_revision` from `flow_get`. Operation errors change nothing and name the op index.
5. **Close the static loop.** Read `issues` in the `flow_apply` result. Fix every error and every warning
   that affects the request, then `flow_get` and audit the saved result. Empty issues are required, but
   do not prove semantic or model correctness; complete the audit too.
6. **Verify execution when safe and requested.** Use `flow_run(flow="<id or name>")`, then
   `flow_status(run="r_...", wait=60)` for long jobs. Override Text/Number/File inputs with
   `inputs={"<input title or id>": value}`. Use `target_node` for a focused ancestor run. Keep the cache
   by default; `fresh=true` deliberately repeats cached work and can repeat charges. Never start a
   duplicate paid job just because the first is pending.
7. **Deliver evidence.** Name the flow id, what changed, validation/run status, important model choices,
   and any unverified constraint. Summarize per-node results and copy generated `MEDIA:<path>` lines into
   the reply. Never say "tested" when only saved, or "working" when only validation passed. `/flow open
   <name>` shows the flow on the canvas.

## Templates

Templates are starting points for new flows: built-in ones ship with Arachne Flow, the user's own ones (ids
`u-…`) appear under **Your templates** in the Flows menu and on the start screen. Instantiate one with
`flow_apply(template="<id or exact name>", name="…", ops=[{"op":"auto_layout"}])`. The result is a copy
with **fresh node ids**. Read that result (or `flow_get`) before wiring its existing nodes; use their real
ids in a second `flow_apply` call. New nodes in the first call can still use your refs.

- **Save one** when the user asks to keep a flow as a template or reuse it as a pattern:
  `flow_template_save(flow="<id or name>", name="…", description="…")`. Pass `clear_inputs=true` when the
  Text/Number/File inputs hold personal or one-off values (prompts, file paths); otherwise the example
  values stay, which helps the next user understand the flow.
- **Update one** with `replace="u-…"` (overwrites that template); without it a second template is added.
- Built-in templates cannot be changed. Renaming and deleting the user's templates happens in Arachne Flow.

## Scheduling a flow

When the user wants a flow to run on a schedule ("every morning", "in 30m"), create a cron job with
`cronjob_manage(action='create')` — a flow is run by the agent, not by a scheduler inside the plugin. Each tick
costs one small agent turn; there is no LLM-free path because the tool nodes need the gateway's tool registry
and MCP connections. Canvas **Flows > Schedule with Hermes…** hands the same request to the chat composer.
The job prompt must be self-contained: `In Arachne Flow, run flow <id> with flow_run(flow="<id>", inputs={...})`.
Only while Hermes runs; the flow is used as saved at that time.

## Mandatory flow audit

Apply this audit while designing and again after every build or repair. **Do not delegate the thinking
to graph validation.** Validation catches structural errors; the agent must also check meaning, every
setting, model compatibility, runtime behavior, privacy, and cost.

### 1. Node and data-contract audit — every node

- Confirm the exact available type is the right capability and no nearly duplicate node is needed.
  Give each node a specific title and purpose. Trace its outputs to a useful destination; remove orphan
  nodes and accidental dead ends. Ensure at least one useful final output or preview.
- Satisfy every required input by a compatible upstream connection or a deliberate same-named constant
  in `params`. A connection overrides a single-value constant. For `media_list` inputs, direct files in
  `params.image` are **prepended** to wired images instead: clear that constant when wiring unless the
  combination is intentional. Only ports marked `multiple` accept several wires; respect wire order,
  port `min`/`max`, and parameter `min_items`/`max_items`.
- Check output-to-input direction, exact port names, and types. `any` is a runtime promise, not proof
  that the value is semantically suitable. Check actual payload shape: a tool's `text` can contain JSON,
  while `result` can be an object or wrapper. Add extraction/conversion when text, JSON, media, single
  values, and lists differ. Use `json.pick` with a path such as `results.0.url` or `items[0].url`.
- For media, check single-item versus list behavior and supported input representation (local path,
  public URL, data URL). Presets handle their documented conversions; low-level tools may not.
- Check dynamic inputs before connecting them: `text.template` and `llm.complete` create one text input
  per `{{placeholder}}`. Connect every placeholder, wire the composed text onward, and avoid accidental
  or misspelled variables.

### 2. Parameter audit — every parameter of every node

- Inspect the catalog entry for **every parameter**, including those left at defaults. Decide whether
  each default fits; do not fill optional fields just to make them non-empty or copy settings from
  another node type. Unknown fields are forbidden unless `open_params` and the executor support them.
- Check `required`, `kind`, `default`, `options`, numeric `min`/`max`, `integer`, list
  `min_items`/`max_items`, and descriptions. Use exact enum values and correctly typed JSON values.
  A list-of-choices setting takes a JSON list such as `["a","b"]`.
- Parameters marked `from_model` belong to the selected model. Validate them against that model's
  current catalog entry; never reuse another model's sizes, durations, resolutions, quality values, or
  extra settings. Parameters marked `fallback` fall back when empty—blank is often safer than a guess.
  Video/3D `open_params` accept only settings evidenced by the selected model's catalog; unlisted names
  can be dropped at run time.
- Write prompts for the actual downstream consumer: required context, output format, constraints, and
  placeholders. If structured data is required, request a strict shape and extract it explicitly rather
  than hoping prose will parse.
- Review execution parameters too: cache, timeout, iteration limit, and parallelism. Do not disable
  cache on side-effecting or paid nodes without a reason. Long media jobs need suitable timeouts; loops
  can multiply both runtime and charges.
- Check privacy and cost after fitness: local files sent to remote tools leave the machine; paid nodes
  can charge once per run and once per loop item. Choose the cheapest option only among models/settings
  that satisfy the task.

### 3. Model compatibility audit

- **Chat agent only — never Build with Hermes:** a parameter with `options_source` names its read-only
  model-list tool. Inspect that tool's schema, call it (`detailed: true` only if supported), and extract
  the chosen or default model's entry without dumping a large catalog into the conversation. Build with
  Hermes must instead use the supplied catalog and preserve live-catalog-dependent defaults.
- Verify exact model id, input/output modalities, required inputs, accepted media count,
  `capabilities.max_images`, supported parameter names, options/ranges, defaults, and price. Fitness
  and compatibility come before cost. If no live catalog is available, keep a preset's working
  default/fallback and disclose the limitation rather than inventing a model or setting.
- Media presets carry a working default `model`; leaving it empty uses the preset fallback. Keep
  `size`, `n`, `duration`, `resolution`, `aspect_ratio`, and `quality` empty unless a deliberate choice
  is verified against the selected model. The canvas shows that model's choices and cost estimate.
- For `llm.complete`, blank `provider` and `model` use Hermes' active model. Set them only as a verified,
  configured pair; never combine one provider with another provider's model. Use a vision preset for
  image understanding rather than feeding media into a text-only LLM contract.
- For image/video/3D models, distinguish text-to-media, image-to-media, editing, and multiview jobs.
  Several views are not universally supported: send multiple 3D reference images only when the model's
  catalog explicitly allows them (`max_images`, multi-image/multiview capability, or equivalent).
  Otherwise send one image and align the requested view count with the model.
- Match aspect ratio, resolution/size, duration, quality, audio/voice, rigging, and mesh options to the
  selected model. Do not assume a parameter that exists on one preset or provider works on another.

### 4. Control-flow and runtime audit

- **If/Switch:** audit every branch, including Default. Put `logic.merge` after branches that continue
  together and route every relevant taken output into its `value` input. A normal node wired from both
  branches would always be skipped. Set Switch `cases` before connecting `caseN` ports.
- **For each:** connect the source list, set a deliberate limit, and use **`item`** inside the body, not
  the original list. End the body at **`logic.collect`**; nodes after it consume only the collected list.
  No For each inside a loop. Every branch that rejoins inside a loop needs its own Merge.
- Inspect expected failure paths: empty search results, malformed JSON, missing media, skipped branches,
  provider errors, and timeouts. Add a fallback only when it serves the request; do not hide failures
  behind unconditional success text.
- When this audit is used by **Build with Hermes**, tool calls are forbidden. Use only the supplied
  catalog and current flow. Keep live-catalog-dependent models/settings at known defaults and never
  claim live model verification.

## Node types (always available)

| Type | Ports | Key params |
|---|---|---|
| `input.text` | out `text` | `value` |
| `input.number` | out `number` | `value` |
| `input.file` | out `file` | `path`, `kind` |
| `llm.complete` | out `text`; one text input per `{{placeholder}}` in `template` | `template` (default `{{prompt}}`), `system`, `temperature`, `max_tokens`, optional `provider` + `model` (set both; empty = Hermes' active model) |
| `text.template` | out `text`; inputs from `{{placeholders}}` | `template` |
| `json.pick` | in `data`, out `value` | `path` (e.g. `items.0.url`) |
| `logic.if` | in `value` (+ optional `compare`), out `true` / `false` | `op` (`contains`, `not contains`, `equals`, `not equals`, `regex`, `>`, `>=`, `<`, `<=`, `empty`, `not empty`), `compare`, `case_sensitive` |
| `logic.switch` | in `value`, out `case1`…`caseN` (one per line of `cases`) + `default` | `cases` (one per line, max 20), `op` (`equals`, `contains`, `starts with`, `regex`), `case_sensitive` |
| `logic.merge` | in `value` (several wires), out `value` | — (first wire whose branch ran wins, in wire order) |
| `logic.foreach` | in `list`, out `item`; `index` (1, 2, …) is available **only inside the loop body** | `limit` (empty = plugin setting `max_items`, default 100) |
| `logic.collect` | in `value`, out `list` | — (one entry per item, item order; items that took another If branch are left out) |
| `output.preview` | in `value` | — |
| `output.send_message` | in `message` / `attachment`, out `result` / `text` | `target` (fixed recipient), optional `message`, `timeout_s`; the user must explicitly enable file sending before an `attachment` can upload. Only supported files produced in the current run are accepted. |
| `note` | — | `text` (comment on the canvas) |

**Branches:** If/Switch pass the value on through the taken output only; every step that hangs off another
output is skipped for that run (status skipped, not an error). Join branches with `logic.merge` before a shared
next step — a normal node with one wire from each branch would always be skipped. Set Switch `cases` before
connecting `caseN` ports. Cases are **positional**: removing/reordering lines shifts surviving wires. Through
`flow_apply`, disconnect affected downstream inputs before updating `cases`, then reconnect; `update_node`
prunes only dangling edges *into* the edited node, not stale outgoing `caseN` wires.

**Loops:** everything after a `logic.foreach` and before its `logic.collect` runs once per item (in parallel,
cached per item); nodes after the Collect run once and must take results from its `list`, never `item` or
`index`. The list input takes a list, a JSON list as text, or text with one item per line. No nested For each.

Presets (only when the tool exists): `preset.text_to_image` (`prompt` → `image`), `preset.image_edit`
(`image` multiple + `prompt` → `image`), `preset.image_to_3d` (`image` multiple, up to 4 → `model`),
`preset.text_to_3d` (`prompt` → `model`), `preset.text_to_video` (`prompt` → `video`),
`preset.image_to_video` (`image` + `prompt` → `video`), `preset.vision` (`image` + `question` → `text`),
`preset.tts` (`text` → `audio`), `preset.web_search` (`query` → `results` json + `text`),
`preset.web_extract` (`url` → `text`), `preset.youtube_transcript` (`url` → `text`). 3D/video jobs are slow
and have `timeout_s`; video `duration` defaults to 6. The 3D runtime trims images to the selected model's
limit and records that in `progress`, so a four-wire port does not mean the model accepts four views.
Media presets carry a working default `model`; blank uses the fallback. Model and model-dependent settings
follow the **Model compatibility audit** above: verify deliberate choices against the selected model's
current catalog instead of copying values between models. Respect `options`, `min`/`max`, `integer`, and
list limits in the type catalog. Video/3D presets accept additional model settings only when the selected
model's catalog lists them; unlisted names are dropped at run time.
Any other enabled tool is `tool:<name>` with inputs from its schema and outputs `result` (json), `text`, `media`.

**Port types:** text, number, boolean, json, image, audio, video, model3d, file, any. A connection is valid when
types match, either side is `any`, number/boolean/json → text, or a media type → file.
A required input is satisfied by a connection OR by a constant in `params` with the same name.

## Ops for `flow_apply`

- `add_node {ref?, type, title?, params?, x?, y?}`
- `update_node {node, title?, params?, x?, y?}` — params merge; a `null` value clears that key
- `remove_node {node}` — also removes its edges
- `connect {from: "ref.port", to: "ref.port"}` — replaces the edge into a single-value input, but **appends**
  on a `multiple` input (Merge, media lists); an identical wire is left unchanged
- `disconnect {to: "ref.port"}` — removes **all** wires into that input; use it before reconnecting a
  multiple input when replacement, not accumulation, is intended
- `set_meta {name?, description?}`
- `auto_layout {}`

`node` and the part before the dot accept a `ref` from the same call or an existing node id.
Edit an existing flow with `flow_apply(flow="<id>", base_revision=<revision>, ops=[...])`; a conflict
means re-read before retrying. `flow_apply` returns the saved flow, ref-to-id mapping, validation `issues`,
and compact text without executing it.

## Example 1 — idea → image prompt → image

```json
{"name": "Idea to image", "ops": [
  {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea", "params": {"value": "a lighthouse made of glass"}},
  {"op": "add_node", "ref": "prompt", "type": "llm.complete", "title": "Image prompt",
   "params": {"system": "You write vivid, concrete prompts for image models. Answer with the prompt only.",
              "template": "Write an image prompt for: {{idea}}"}},
  {"op": "add_node", "ref": "image", "type": "preset.text_to_image", "title": "Image"},
  {"op": "add_node", "ref": "show", "type": "output.preview", "title": "Result"},
  {"op": "connect", "from": "idea.text", "to": "prompt.idea"},
  {"op": "connect", "from": "prompt.text", "to": "image.prompt"},
  {"op": "connect", "from": "image.image", "to": "show.value"},
  {"op": "auto_layout"}
]}
```

Building and validating this example is free. Run a paid image generation only when requested or approved:
`flow_run(flow="Idea to image", inputs={"Idea": "a fox in the snow"})`.

## Example 2 — web research digest

```json
{"name": "Research digest", "ops": [
  {"op": "add_node", "ref": "topic", "type": "input.text", "title": "Topic", "params": {"value": "solid-state batteries 2026"}},
  {"op": "add_node", "ref": "search", "type": "preset.web_search", "title": "Search", "params": {"limit": 5}},
  {"op": "add_node", "ref": "digest", "type": "llm.complete", "title": "Digest",
   "params": {"template": "Summarise the key findings about {{topic}} in 5 bullet points with sources.\n\n{{results}}"}},
  {"op": "add_node", "ref": "show", "type": "output.preview", "title": "Digest"},
  {"op": "connect", "from": "topic.text", "to": "search.query"},
  {"op": "connect", "from": "topic.text", "to": "digest.topic"},
  {"op": "connect", "from": "search.text", "to": "digest.results"},
  {"op": "connect", "from": "digest.text", "to": "show.value"},
  {"op": "auto_layout"}
]}
```

## Debugging and repair

1. **Read evidence before editing.** Use `flow_get` for graph and static `issues`, `flow_list` for
   `last_run.id`, then `flow_status` for that run. Inspect the raw run JSON's `issues` (especially status
   `invalid`), `nodes.<id>.error`, `outputs`, `preview`, `skip`, timing, and live `progress` (3D/video
   job states and image-limit messages). Do not rerun a paid flow merely to rediscover recorded evidence.
2. **Find the first causal failure.** Follow topological order. Downstream skipped/missing inputs are
   often consequences. Compare actual upstream output with the failing node's required input, parameter,
   and model contract. If no run exists and execution is safe, use a focused `target_node`.
3. **Classify before fixing:** missing/wrong wire; wrong payload extraction; wrong placeholder; invalid
   default/enum/range; unsupported model modality or setting; too many reference images; branch/loop
   mistake; timeout; approval/blocked result; provider/auth/credit error. An approval-held tool did **not**
   run: answer the approval in chat or adjust Hermes' approval settings. For provider/auth/credit failures,
   fix the external cause or report it—do not randomly rewrite a correct graph.
4. **Repair minimally and re-audit everything.** Use `flow_apply` with `base_revision`, preserving
   unrelated working nodes/settings. Read returned `issues`, then `flow_get` and repeat the mandatory
   audit. Check downstream payload shapes and avoid duplicate paid work.
5. **Verify the original symptom when execution is authorized.** Prefer a targeted run that can reuse
   cached ancestors. Presets and read-only tool nodes cache by default; raw paid tool nodes normally do
   not, so re-running them can re-bill. `params.cache` is the per-node override; `fresh=true` bypasses
   cache for the run. Use `fresh` only for suspected stale results or a required fresh result. Report
   first cause, exact change, validation result, run evidence, and any remaining external blocker.

## Delivery checklist

Do not finish until every applicable answer is yes:

- every node is available, necessary, titled, and connected into the requested end-to-end result;
- every required input and edge has been checked for direction, type, cardinality, and payload shape;
- every parameter/default has been considered, with enums, bounds, templates, and extraction checked;
- every selected/default model fits the modalities and settings, or an unverified constraint is explicit;
- branches, merges, loops, collectors, cache, timeout, privacy, and cost behavior are deliberate;
- `flow_get` returns no unresolved validation errors, and execution status is reported without inflation.
