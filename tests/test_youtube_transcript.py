"""Red regression tests: ``preset.youtube_transcript`` must output the transcript, not the tool notice.

The NanoGPT MCP tool (``@nanogpt/mcp`` ``youtubeTranscribe.js``) puts a human-readable notice in the
MCP text block and the payload in ``structuredContent``::

    {"result": "Transcribed 1 video(s):\\n- <url>: <title> (<first 100 chars>...)"
               "\\n\\nSummary: 1 succeeded, 0 failed",
     "structuredContent": {"transcripts": [{"url": ..., "success": true,
                                            "title": ..., "language": "en",
                                            "transcript": "<full spoken text>"}],
                           "summary": {"successful": 1, "failed": 0}}}

Hermes renders that as ``{"result": <notice>, "structuredContent": {...}}`` (text block -> "result").
The preset returned ``best_text(result)``, and ``best_text`` finds the ``"result"`` key first, so a
live run sent "Transcribed 1 video(s): ... (100-character preview...)" down the ``text`` port. The
raw tool plus ``json.pick structuredContent.transcripts.0.transcript`` produced the real transcript.

These tests drive the real preset executor (curated spec + ``engine.executors.execute``) with a fake
tool through ``helpers.FakeCtx``: no network, no provider, no implementation changes.
"""
import asyncio
import json
import os
import tempfile
import unittest

import helpers

PRESET = "preset.youtube_transcript"
TOOL = "mcp__nanogpt__nanogpt_youtube_transcribe"
URL = "https://www.youtube.com/watch?v=ppu_p2ojG8U"
URL2 = "https://youtu.be/dQw4w9WgXcQ"

TOOLS = [{
    "name": TOOL, "toolset": "test", "description": "Fake YouTube transcript tool",
    "parameters": {
        "type": "object",
        "properties": {
            "urls": {"type": "array", "items": {"type": "string"}},
            "include_raw": {"type": "boolean", "default": False},
        },
        "required": ["urls"],
    },
}]

# Transcripts keep their line breaks and blank lines; nothing here needs trimming or normalising.
ONE = ('Most people\'s "first\nAI agent" is a chatbot. It waits for you to type,\n'
       'it answers, and then it does nothing until you come back.\n\n'
       'A real agent does the work while you\'re asleep.')
TWO = "Zweiter Vortrag:\nZeile eins\nZeile zwei\n\nUnd ein neuer Absatz."
THREE = 'Third talk — em dash, umlauts (äöü) and "quotes" stay byte-for-byte.'

_MISSING = object()


def entry(url, transcript=None, title="A talk", success=True, **extra):
    item = {"url": url, "success": success, "title": title, "language": "en"}
    if transcript is not None:
        item["transcript"] = transcript
    item.update(extra)
    return item


def notice(entries, summary=None):
    """The tool's text block, mirroring @nanogpt/mcp youtubeTranscribe.js."""
    text = f"Transcribed {len(entries)} video(s):"
    for item in entries:
        if not isinstance(item, dict):
            text += "\n- Unknown"
            continue
        url = item.get("url") or "Unknown"
        if item.get("success"):
            text += f"\n- {url}: {item.get('title') or 'No title'}"
            body = item.get("transcript")
            if isinstance(body, str) and body:
                text += f" ({body[:100]}{'...' if len(body) > 100 else ''})"
        else:
            text += f"\n- {url}: FAILED - {item.get('error') or 'Unknown error'}"
    if summary is not None:
        text += f"\n\nSummary: {summary[0]} succeeded, {summary[1]} failed"
    return text


def tool_result(entries, text=None, structured=_MISSING, summary=None):
    """The JSON string the MCP registry handler hands the plugin for this call."""
    body = {"result": notice(entries) if text is None else text}
    if structured is not _MISSING:
        body["structuredContent"] = structured
    return json.dumps(body)


def structured(entries, summary=None):
    counts = summary or (sum(1 for e in entries if isinstance(e, dict) and e.get("success")),
                         sum(1 for e in entries if not (isinstance(e, dict) and e.get("success"))))
    return {"transcripts": entries, "summary": {"successful": counts[0], "failed": counts[1]}}


class YouTubeTranscriptPresetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="arachne-flow-youtube-transcript-")
        self.addCleanup(self.tmp.cleanup)
        self._old_data_dir = os.environ.get("ARACHNE_FLOW_DATA_DIR")
        os.environ["ARACHNE_FLOW_DATA_DIR"] = self.tmp.name
        self.addCleanup(self._restore_data_dir)
        self.out = os.path.join(self.tmp.name, "outputs")
        os.makedirs(self.out)

    def _restore_data_dir(self):
        if self._old_data_dir is None:
            os.environ.pop("ARACHNE_FLOW_DATA_DIR", None)
        else:
            os.environ["ARACHNE_FLOW_DATA_DIR"] = self._old_data_dir

    def spec(self):
        engine = helpers.load_engine()
        env = engine.env.Env(ctx=helpers.FakeCtx(), state={})
        return engine.nodes.types_by_name(env, tools=TOOLS)[PRESET]

    def run_preset(self, raw_result, inputs=None, params=None):
        """Execute the real preset node; returns (outputs, FakeCtx with the recorded tool calls)."""
        engine = helpers.load_engine()
        ctx = helpers.FakeCtx({TOOL: lambda args: raw_result})
        env = engine.env.Env(ctx=ctx, state={})
        node = {"id": "yt", "type": PRESET, "params": params or {}}
        nctx = engine.executors.NodeContext(run_id="run_youtube", node_id="yt", out_dir=self.out,
                                            allow_download=False, log=lambda msg: None)
        result = asyncio.run(engine.executors.execute(env, node, self.spec(), inputs or {"url": URL}, nctx))
        return result, ctx

    # ------------------------------------------------------------- the bug

    def test_single_transcript_returns_the_full_text_not_the_tool_notice(self):
        item = entry(URL, ONE, title="Build Your First AI Agent for Free (No Code, 2026)")
        raw = tool_result([item], structured=structured([item], (1, 0)))
        result, _ = self.run_preset(raw)

        self.assertEqual(result["text"], ONE)
        self.assertNotIn("Transcribed 1 video(s)", result["text"])
        self.assertNotIn("Summary: 1 succeeded", result["text"])
        # The notice only carries a 100-character preview; the full text must survive intact.
        self.assertIn("A real agent does the work while you're asleep.", result["text"])
        self.assertGreater(len(result["text"]), 100)

    def test_multiple_transcripts_join_in_order_with_a_blank_line(self):
        items = [entry(URL, ONE, title="One"),
                 entry(URL2, TWO, title="Two"),
                 entry("https://www.youtube.com/watch?v=third", THREE, title="Three")]
        raw = tool_result(items, structured=structured(items, (3, 0)))
        result, _ = self.run_preset(raw)

        self.assertEqual(result["text"], ONE + "\n\n" + TWO + "\n\n" + THREE)
        # Order is the payload's order, not the titles' alphabetical order.
        self.assertLess(result["text"].index(ONE), result["text"].index(TWO))
        self.assertLess(result["text"].index(TWO), result["text"].index(THREE))
        self.assertNotIn("Transcribed 3 video(s)", result["text"])

    def test_empty_and_malformed_entries_are_skipped(self):
        items = [
            entry(URL, success=False, error="no captions available"),
            entry(URL2, ""),
            entry("https://www.youtube.com/watch?v=blank", "   \n\t "),
            {"url": "https://www.youtube.com/watch?v=missing", "success": True},
            {"url": "https://www.youtube.com/watch?v=none", "success": True, "transcript": None},
            {"url": "https://www.youtube.com/watch?v=number", "success": True, "transcript": 42},
            {"url": "https://www.youtube.com/watch?v=list", "success": True,
             "transcript": ["not", "a", "transcript"]},
            "not an object",
            None,
            entry("https://www.youtube.com/watch?v=good", THREE),
        ]
        raw = tool_result(items, structured={"transcripts": items, "summary": {"successful": 1, "failed": 9}})
        result, _ = self.run_preset(raw)

        self.assertEqual(result["text"], THREE)
        self.assertNotIn("Transcribed 10 video(s)", result["text"])
        self.assertNotIn("FAILED", result["text"])

    def test_entries_without_usable_text_fall_back_to_the_tool_text(self):
        items = [entry(URL, success=False, error="no captions available"), entry(URL2, "")]
        text = notice(items, (0, 1))
        raw = tool_result(items, text=text, structured=structured(items, (0, 1)))
        result, _ = self.run_preset(raw)

        self.assertEqual(result["text"], text)
        self.assertIn("FAILED - no captions available", result["text"])

    # ------------------------------------------------------------- shapes the executor must keep working

    def test_missing_structured_content_uses_the_tool_text(self):
        # Older servers / other transcript tools: the text block itself is all there is.
        text = "Here is the transcript:\n" + ONE
        result, _ = self.run_preset(tool_result([entry(URL, ONE)], text=text))
        self.assertEqual(result["text"], text)

        blocks = json.dumps({"content": [{"type": "text", "text": text}]})
        result, _ = self.run_preset(blocks)
        self.assertEqual(result["text"], text)

    def test_structured_content_as_a_json_string_is_understood(self):
        # Hermes caps oversized structuredContent as a string; a string-encoded payload is still a payload.
        item = entry(URL, ONE)
        raw = tool_result([item], structured=json.dumps(structured([item], (1, 0))))
        result, _ = self.run_preset(raw)
        self.assertEqual(result["text"], ONE)

    # ------------------------------------------------------------- the existing node contract

    def test_url_port_still_maps_to_the_required_urls_argument(self):
        spec = self.spec()
        self.assertEqual(spec["kind"], "preset")
        self.assertEqual(spec["tool"], TOOL)
        port = spec["inputs"][0]
        self.assertEqual((port["name"], port["type"], port["required"]), ("url", "text", True))
        self.assertEqual(spec["outputs"][0]["name"], "text")
        self.assertEqual(spec["outputs"][0]["type"], "text")

        item = entry(URL, ONE)
        result, ctx = self.run_preset(tool_result([item], structured=structured([item], (1, 0))),
                                      inputs={"url": URL})
        self.assertEqual(ctx.calls, [(TOOL, {"urls": [URL]})])
        self.assertNotIn("include_raw", ctx.calls[0][1])
        self.assertEqual(result["text"], ONE)

    def test_missing_url_is_still_a_node_error(self):
        engine = helpers.load_engine()
        ctx = helpers.FakeCtx({TOOL: lambda args: tool_result([entry(URL, ONE)], structured=structured([entry(URL, ONE)]))})
        env = engine.env.Env(ctx=ctx, state={})
        node = {"id": "yt", "type": PRESET, "params": {}}
        nctx = engine.executors.NodeContext(run_id="run_youtube", node_id="yt", out_dir=self.out,
                                            allow_download=False, log=lambda msg: None)
        with self.assertRaisesRegex(engine.executors.NodeError, "missing required input: url"):
            asyncio.run(engine.executors.execute(env, node, self.spec(), {}, nctx))
        self.assertEqual(ctx.calls, [])


if __name__ == "__main__":
    unittest.main()
