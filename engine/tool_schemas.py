"""Public schemas for Arachne Flow's agent tools."""
from __future__ import annotations


def _object(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or []}


SCHEMAS = [
    {"name": "flow_list",
     "description": "List saved flows in Arachne Flow (ids, revisions, node counts, latest runs) and the templates "
                    "a new flow can start from (built-in and the user's own).",
     "parameters": _object()},
    {"name": "flow_get",
     "description": "Get a flow by id, exact name or unique name prefix. Returns nodes, edges, validation issues and compact text.",
     "parameters": _object({"flow": {"type": "string", "description": "Flow id or name."}}, ["flow"])},
    {"name": "flow_node_types",
     "description": "List available built-in, preset, Hermes and MCP node types with typed ports, parameter "
                    "limits, model sources and model-dependent settings.",
     "parameters": _object({"query": {"type": "string", "description": "Optional case-insensitive text filter."},
                            "category": {"type": "string", "description": "Optional exact category name."}})},
    {"name": "flow_apply",
     "description": "Create a flow or atomically apply graph operations to an existing flow. "
                    "Returns the saved flow and its validation issues without running it. "
                    "Use ref on add_node and ref.port in later operations; failed operations change nothing.",
     "parameters": _object({
         "flow": {"type": "string", "description": "Existing flow id/name; omit to create a new flow."},
         "name": {"type": "string", "description": "Name for a newly created flow."},
         "template": {"type": "string",
                      "description": "New flows only: start from this template (id or exact name from flow_list); "
                                     "ops then apply on top of it. Node ids are new: read them from the result."},
         "base_revision": {"type": "integer", "description": "Optional optimistic revision check."},
         "ops": {"type": "array", "items": {"type": "object"},
                 "description": "Atomic operations: add_node{ref?,type,title?,params?,x?,y?}, "
                                "update_node{node,title?,params?,x?,y?} (params merge; null clears a key), "
                                "remove_node{node}, connect{from:'ref.port',to:'ref.port'}, disconnect{to:'ref.port'}, "
                                "set_meta{name?,description?}, auto_layout{}."}},
         ["ops"])},
    {"name": "flow_run",
     "description": "Run a saved flow by id/name and wait up to 60 seconds by default. "
                    "Supports input overrides by node id/title, partial target runs and cache bypass.",
     "parameters": _object({
         "flow": {"type": "string", "description": "Flow id or name."},
         "inputs": {"type": "object", "description": "Input values keyed by input node id or title."},
         "target_node": {"type": "string", "description": "Optional node id: run only its ancestor subgraph."},
         "fresh": {"type": "boolean", "default": False, "description": "Bypass the node cache."},
         "wait": {"type": "integer", "default": 60, "minimum": 0, "maximum": 900,
                  "description": "Seconds to wait; 0 returns immediately."}}, ["flow"])},
    {"name": "flow_template_save",
     "description": "Save a flow as one of the user's templates, so it appears under 'Your templates' in Flow "
                    "Canvas and can start new flows (flow_apply template). Name and description default to the "
                    "flow's. replace overwrites one of the user's templates instead of adding a new one.",
     "parameters": _object({
         "flow": {"type": "string", "description": "Flow id or name to save."},
         "name": {"type": "string", "description": "Template name (max 80 characters)."},
         "description": {"type": "string", "description": "One or two sentences: what the template does."},
         "clear_inputs": {"type": "boolean", "default": False,
                          "description": "Empty Text/Number/File input values, e.g. personal prompts or paths."},
         "replace": {"type": "string", "description": "Optional id (u-…) of the user's template to overwrite."}},
         ["flow"])},
    {"name": "flow_status",
     "description": "Get a run record by run id, including per-node status, outputs, previews and errors.",
     "parameters": _object({
         "run": {"type": "string", "description": "Run id returned by flow_run."},
         "wait": {"type": "integer", "default": 0, "minimum": 0, "maximum": 900,
                  "description": "Optional seconds to wait for completion."}}, ["run"])},
]
