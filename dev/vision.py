"""Look at a screenshot with a NanoGPT vision model (requires an explicit NANOGPT_API_KEY).

  bash scripts/hpy dev/vision.py dev/out/<file>.png "<question>" [x0,y0,x1,y1 | -] [scale]
"""
import base64, io, json, os, sys, urllib.request
from PIL import Image

def key():
    value = os.environ.get("NANOGPT_API_KEY")
    if not value:
        raise SystemExit("set NANOGPT_API_KEY explicitly")
    return value

img = Image.open(sys.argv[1]).convert("RGB")
if len(sys.argv) > 3 and sys.argv[3] != "-":
    img = img.crop(tuple(int(v) for v in sys.argv[3].split(",")))
scale = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
if scale != 1.0:
    img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
buf = io.BytesIO(); img.save(buf, "PNG")
url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
body = {"model": os.environ.get("VISION_MODEL", "deepseek/deepseek-v4.1-flash-1017"), "max_tokens": 1200,
        "messages": [{"role": "user", "content": [{"type": "text", "text": sys.argv[2]}, {"type": "image_url", "image_url": {"url": url}}]}]}
req = urllib.request.Request("https://nano-gpt.com/api/v1/chat/completions", data=json.dumps(body).encode(),
                             headers={"Authorization": "Bearer " + key(), "Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=120) as r:
    print(json.load(r)["choices"][0]["message"]["content"])
