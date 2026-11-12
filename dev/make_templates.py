"""Regenerate the extra bundled templates with the real engine (apply_ops + auto_layout).

  bash scripts/hpy dev/make_templates.py

Uses the fake tool registry from the tests, so the output never depends on what this machine has installed.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import helpers  # noqa: E402
from test_templates import template_tools  # noqa: E402

E = helpers.load_engine()
env = E.env.Env(ctx=helpers.FakeCtx({}), state={"tool_source": template_tools}, emit=lambda *a: None)
TYPES = E.nodes.types_by_name(env)

TEMPLATES = {
    "youtube-summary": ("YouTube summary", "Get a video's transcript and turn it into key points and takeaways.", [
        {"op": "add_node", "ref": "url", "type": "input.text", "title": "Video link",
         "params": {"value": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}},
        {"op": "add_node", "ref": "yt", "type": "preset.youtube_transcript", "title": "Transcript"},
        {"op": "add_node", "ref": "llm", "type": "llm.complete", "title": "Summary",
         "params": {"system": "You summarise videos for busy people. Be concrete, no filler.",
                    "template": "Summarise this video transcript.\n\n1. Five key points as bullets\n"
                                "2. Three takeaways I can act on\n\nTranscript:\n{{transcript}}"}},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
        {"op": "connect", "from": "url.text", "to": "yt.url"},
        {"op": "connect", "from": "yt.text", "to": "llm.transcript"},
        {"op": "connect", "from": "llm.text", "to": "out.value"},
    ]),
    "edit-image": ("Edit an image", "Change a picture with a plain-language instruction.", [
        {"op": "add_node", "ref": "img", "type": "input.file", "title": "Picture",
         "params": {"path": "", "kind": "image"}},
        {"op": "add_node", "ref": "ins", "type": "input.text", "title": "Instruction",
         "params": {"value": "Replace the background with a sunny beach, keep the person unchanged."}},
        {"op": "add_node", "ref": "edit", "type": "preset.image_edit", "title": "Edit image"},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
        {"op": "connect", "from": "img.file", "to": "edit.image"},
        {"op": "connect", "from": "ins.text", "to": "edit.prompt"},
        {"op": "connect", "from": "edit.image", "to": "out.value"},
    ]),
    "idea-to-video": ("Idea to video", "Turn a short idea into a cinematic video prompt, then a 6-second clip.", [
        {"op": "add_node", "ref": "idea", "type": "input.text", "title": "Idea",
         "params": {"value": "a paper boat sailing through a rainy city street"}},
        {"op": "add_node", "ref": "llm", "type": "llm.complete", "title": "Video prompt",
         "params": {"system": "You write prompts for text-to-video models: one paragraph, subject, action, "
                              "camera movement, lighting, mood. No lists.",
                    "template": "Write a video prompt for: {{idea}}"}},
        {"op": "add_node", "ref": "vid", "type": "preset.text_to_video", "title": "Video"},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
        {"op": "connect", "from": "idea.text", "to": "llm.idea"},
        {"op": "connect", "from": "llm.text", "to": "vid.prompt"},
        {"op": "connect", "from": "vid.video", "to": "out.value"},
    ]),
    "animate-image": ("Animate a picture", "Bring a still image to life as a short video clip.", [
        {"op": "add_node", "ref": "img", "type": "input.file", "title": "Picture",
         "params": {"path": "", "kind": "image"}},
        {"op": "add_node", "ref": "how", "type": "input.text", "title": "Motion",
         "params": {"value": "slow camera push-in, leaves moving gently in the wind"}},
        {"op": "add_node", "ref": "vid", "type": "preset.image_to_video", "title": "Video"},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
        {"op": "connect", "from": "img.file", "to": "vid.image"},
        {"op": "connect", "from": "how.text", "to": "vid.prompt"},
        {"op": "connect", "from": "vid.video", "to": "out.value"},
    ]),
    "translate-and-speak": ("Translate and speak", "Translate a text into another language and read it aloud.", [
        {"op": "add_node", "ref": "txt", "type": "input.text", "title": "Text",
         "params": {"value": "Guten Morgen! Heute testen wir Arachne Flow."}},
        {"op": "add_node", "ref": "lang", "type": "input.text", "title": "Language", "params": {"value": "English"}},
        {"op": "add_node", "ref": "llm", "type": "llm.complete", "title": "Translate",
         "params": {"system": "You are a translator. Answer with the translation only.",
                    "template": "Translate into {{language}}:\n\n{{text}}"}},
        {"op": "add_node", "ref": "tts", "type": "preset.tts", "title": "Speak"},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Audio"},
        {"op": "connect", "from": "txt.text", "to": "llm.text"},
        {"op": "connect", "from": "lang.text", "to": "llm.language"},
        {"op": "connect", "from": "llm.text", "to": "tts.text"},
        {"op": "connect", "from": "tts.audio", "to": "out.value"},
    ]),
    "blog-post-writer": ("Blog post writer", "Research a topic on the web, outline it, then write the article.", [
        {"op": "add_node", "ref": "topic", "type": "input.text", "title": "Topic",
         "params": {"value": "how to start running as a beginner"}},
        {"op": "add_node", "ref": "search", "type": "preset.web_search", "title": "Research"},
        {"op": "add_node", "ref": "outline", "type": "llm.complete", "title": "Outline",
         "params": {"system": "You plan clear, practical blog posts.",
                    "template": "Make an outline (H2 headings + 2 bullets each) for a blog post about {{topic}}. "
                                "Use these search results as facts:\n{{results}}"}},
        {"op": "add_node", "ref": "write", "type": "llm.complete", "title": "Article",
         "params": {"system": "You write friendly, concrete blog posts in Markdown.",
                    "template": "Write the full blog post (about 800 words) following this outline:\n\n{{outline}}"}},
        {"op": "add_node", "ref": "out", "type": "output.preview", "title": "Result"},
        {"op": "connect", "from": "topic.text", "to": "search.query"},
        {"op": "connect", "from": "topic.text", "to": "outline.topic"},
        {"op": "connect", "from": "search.text", "to": "outline.results"},
        {"op": "connect", "from": "outline.text", "to": "write.outline"},
        {"op": "connect", "from": "write.text", "to": "out.value"},
    ]),
}


def main():
    for tid, (name, description, ops) in TEMPLATES.items():
        flow = E.graph.new_flow(name, description)
        flow, _ = E.graph.apply_ops(flow, ops + [{"op": "auto_layout"}], TYPES)
        issues = E.graph.validate(flow, TYPES)
        errors = [i for i in issues if i.get("level") == "error"]
        if errors:
            raise SystemExit(f"{tid}: {errors}")
        data = {"schema": "arachne-flow/1", "name": name, "description": description,
                "nodes": flow["nodes"], "edges": flow["edges"]}
        with open(os.path.join(ROOT, "templates", tid + ".json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        print(tid, len(flow["nodes"]), "nodes", len(flow["edges"]), "edges", "issues:", issues)


if __name__ == "__main__":
    main()
