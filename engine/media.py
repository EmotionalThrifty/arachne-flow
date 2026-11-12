"""Media values: detect files/URLs in tool results, bring them into the run's
output folder, and turn media values back into tool arguments.

A media value is ``{"$media": {"kind", "file", "mime", "path", "source"?}}``. ``path`` is always a
local absolute path; ``source`` is the original URL when the file was downloaded.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import contextvars
import hashlib
import logging
import mimetypes
import os
import re
import shutil
from urllib.parse import unquote, urlparse

from . import types as ptypes

logger = logging.getLogger("arachne-flow.media")

MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
MAX_DATA_URL_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_BYTES = 25 * 1024 * 1024   # one canvas drop, multipart or base64 JSON; bigger files: Browse… (G3)
MAX_MEDIA_PER_RESULT = 8
DOWNLOAD_TIMEOUT_S = 120

EXT_KIND = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image", ".bmp": "image",
    ".tif": "image", ".tiff": "image", ".svg": "image", ".avif": "image", ".heic": "image",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".oga": "audio", ".opus": "audio", ".flac": "audio",
    ".m4a": "audio", ".aac": "audio", ".weba": "audio",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".avi": "video", ".m4v": "video",
    ".glb": "model3d", ".gltf": "model3d", ".obj": "model3d", ".fbx": "model3d", ".stl": "model3d",
    ".usdz": "model3d", ".ply": "model3d", ".3mf": "model3d",
    ".pdf": "file", ".zip": "file", ".csv": "file", ".txt": "file", ".json": "file", ".md": "file",
    ".blend": "file", ".step": "file", ".stp": "file",
}
MIME_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
    "image/svg+xml": ".svg", "image/bmp": ".bmp", "image/avif": ".avif",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav",
    "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/flac": ".flac", "audio/mp4": ".m4a", "audio/aac": ".aac",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "model/gltf-binary": ".glb", "model/gltf+json": ".gltf", "model/obj": ".obj", "model/stl": ".stl",
    "application/pdf": ".pdf", "application/zip": ".zip", "text/plain": ".txt", "application/json": ".json",
}
# Keys whose URL value is media even without a file extension (e.g. signed CDN links).
_MEDIA_KEYS = re.compile(r"(^|_)(image|img|images|thumbnail|glb|gltf|obj|fbx|usdz|stl|model|mesh|audio|video|"
                         r"file_url|download_url|asset_url|media|output_url|result_url)($|_|s$)", re.IGNORECASE)
_DATA_URL = re.compile(r"^data:([\w.+-]+/[\w.+-]+)?(;[\w=.+-]+)*;base64,(.*)$", re.DOTALL)
_MEDIA_LINE = re.compile(r"^\s*MEDIA:\s*(.+?)\s*$", re.MULTILINE)
_URL_IN_TEXT = re.compile(r"https?://[^\s\"'<>)\]]+")
_SAFE_STEM = re.compile(r"[^A-Za-z0-9._-]+")
# Review E-3: keys whose string is prose (a fetched page, a transcript, command output). A `MEDIA:` line or a bare
# path in there was written by whoever wrote the page, not by the tool, so it is never copied into the run.
FREE_TEXT_KEYS = frozenset({
    "content", "markdown", "html", "raw_content", "text_content", "body", "snippet", "description", "summary",
    "transcript", "text", "output", "stdout", "stderr", "page", "excerpt"})


class MediaError(Exception):
    def __init__(self, message: str, code: str = "media_error"):
        super().__init__(message)
        self.code = code


# ----------------------------------------------------------------- basics

def kind_for(name_or_mime: str) -> str:
    """Media kind from a file name, URL path or MIME type ('file' when unknown)."""
    if not name_or_mime:
        return "file"
    text = str(name_or_mime).lower()
    if "/" in text and not text.startswith(("/", "http")) and ":" not in text[:3] and "." not in text.split("/")[-1]:
        major = text.split("/")[0]
        if major in ("image", "audio", "video"):
            return major
        if major == "model":
            return "model3d"
        return "file"
    path = urlparse(text).path if text.startswith(("http://", "https://")) else text
    ext = os.path.splitext(path)[1]
    return EXT_KIND.get(ext, "file")


def mime_for(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    for mime, e in MIME_EXT.items():
        if e == ext:
            return mime
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def make_media(path: str, kind: str = None, source: str = None, mime: str = None) -> dict:
    path = os.path.abspath(path)
    meta = {
        "kind": kind if kind in ptypes.MEDIA_KINDS or kind == "file" else kind_for(path),
        "file": os.path.basename(path),
        "mime": mime or mime_for(path),
        "path": path,
    }
    if source:
        meta["source"] = source
    return {"$media": meta}


def media_path(value) -> str:
    return value["$media"].get("path", "") if ptypes.is_media(value) else ""


def blocked_local_path(path) -> bool:
    """Lexical only: probing a Windows UNC/device path can contact SMB before a root check runs."""
    if not path:
        return False
    text = os.path.expanduser(os.fsdecode(os.fspath(path))).replace("/", "\\")
    return text.startswith(("\\\\", "\\??\\", "\\Device\\"))


def require_local_path(path):
    if blocked_local_path(path):
        raise MediaError("UNC and device paths are not supported; choose a local file")
    return path


def file_sha256(path: str) -> str:
    require_local_path(path)
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _unique_path(out_dir: str, stem: str, ext: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    stem = _SAFE_STEM.sub("_", stem).strip("._") or "file"
    candidate = os.path.join(out_dir, stem + ext)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(out_dir, f"{stem}-{i}{ext}")
        i += 1
    return candidate


# ----------------------------------------------------------------- uploads (G3)

_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_WIN_UNSAFE = re.compile(r'[<>:"|?*]')
_WIN_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.IGNORECASE)


def clean_upload_name(name) -> str:
    """File name of an upload: base name only, no control or Windows-reserved characters, at most 120 chars."""
    text = _CONTROL.sub("", str(name or "")).replace("\\", "/").split("/")[-1]
    text = _WIN_UNSAFE.sub("_", text).strip().strip(".").strip()
    stem, ext = os.path.splitext(text)
    if _WIN_RESERVED.match(stem):
        stem = "_" + stem
    if len(stem) + len(ext) > 120:
        stem = stem[:120 - len(ext)].rstrip(". ")
    return stem + ext if stem else ""


def _upload_target(name) -> tuple:
    """``(display, ext)`` of one upload: the cleaned base name, and its extension if it is a known file type."""
    display = clean_upload_name(name)
    ext = os.path.splitext(display)[1].lower()
    if not os.path.splitext(display)[0] or ext not in EXT_KIND:
        raise MediaError(f"unsupported file type {ext or '(none)'!r}", "bad_type")
    return display, ext


def _store_upload(raw, display: str, ext: str, folder: str) -> dict:
    """Write one file to ``<folder>/<sha256[:12]>/<display>``; the same content under the same name is stored once."""
    digest = hashlib.sha256(raw).hexdigest()
    target = os.path.join(os.path.abspath(folder), digest[:12])
    os.makedirs(target, exist_ok=True)
    path = os.path.join(target, display)
    if os.path.dirname(os.path.abspath(path)) != target:   # belt and braces: the name must stay a plain file name
        raise MediaError("invalid file name", "bad_type")
    deduped = os.path.isfile(path) and os.path.getsize(path) == len(raw)
    if not deduped:
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "wb") as fh:
            fh.write(raw)
        os.replace(tmp, path)
    return {"path": path, "name": display, "kind": EXT_KIND[ext], "size": len(raw), "deduped": deduped}


def save_upload(name, data_url, folder: str, max_bytes: int = MAX_UPLOAD_BYTES) -> dict:
    """Store one dropped file as ``<folder>/<sha256[:12]>/<clean name>`` and describe it.

    The extension must be a known media/file extension (``EXT_KIND``). Only the cleaned base name of the client's
    name is used, inside a folder named by the content hash, so traversal is impossible and the file keeps its
    readable name for previews and tools. The same content under the same name is stored once (``deduped``).

    The body is a base64 data URL (older desktop builds); :func:`save_upload_bytes` is the multipart twin.
    """
    display, ext = _upload_target(name)
    m = _DATA_URL.match(str(data_url or "").strip()) if isinstance(data_url, str) else None
    if not m:
        raise MediaError("not a base64 data URL", "bad_data")
    payload = m.group(3)
    if len(payload) * 3 // 4 > max_bytes + 3:
        raise MediaError(f"file is larger than {max_bytes // (1024 * 1024)} MB", "too_large")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise MediaError("invalid base64 data", "bad_data") from None
    if len(raw) > max_bytes:
        raise MediaError(f"file is larger than {max_bytes // (1024 * 1024)} MB", "too_large")
    return _store_upload(raw, display, ext, folder)


def save_upload_bytes(raw, name, folder: str, max_bytes: int = MAX_UPLOAD_BYTES) -> dict:
    """Store one dropped file from its raw bytes (review U-10: the plugin SDK's multipart ``upload`` option).

    Same name, type, size and dedupe rules as :func:`save_upload` — only the transport differs.
    """
    display, ext = _upload_target(name)
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise MediaError("not file bytes", "bad_data")
    raw = bytes(raw)
    if len(raw) > max_bytes:
        raise MediaError(f"file is larger than {max_bytes // (1024 * 1024)} MB", "too_large")
    return _store_upload(raw, display, ext, folder)


# ----------------------------------------------------------------- ingest

def from_data_url(data_url: str, out_dir: str, stem: str) -> dict:
    m = _DATA_URL.match(data_url.strip())
    if not m:
        raise MediaError("not a base64 data URL")
    mime = (m.group(1) or "application/octet-stream").lower()
    try:
        raw = base64.b64decode(m.group(3), validate=False)
    except (binascii.Error, ValueError) as exc:
        raise MediaError(f"invalid base64 data: {exc}") from None
    if len(raw) > MAX_DOWNLOAD_BYTES:
        raise MediaError("data URL too large")
    ext = MIME_EXT.get(mime) or mimetypes.guess_extension(mime) or ".bin"
    path = _unique_path(out_dir, stem, ext)
    with open(path, "wb") as fh:
        fh.write(raw)
    return make_media(path, kind=kind_for(mime) if kind_for(mime) != "file" else kind_for(path), mime=mime)


def from_local(path: str, out_dir: str = None, stem: str = None, kind: str = None, copy: bool = True) -> dict:
    """A local file as media; copied into out_dir unless it already lives there (or copy=False)."""
    require_local_path(path)
    path = os.path.abspath(os.path.expanduser(path))
    require_readable(path)
    if not os.path.isfile(path):
        raise MediaError(f"file not found: {path}")
    if copy and out_dir:
        out_abs = os.path.abspath(out_dir)
        if os.path.dirname(path) != out_abs:
            ext = os.path.splitext(path)[1].lower()
            target = _unique_path(out_abs, stem or os.path.splitext(os.path.basename(path))[0], ext)
            shutil.copy2(path, target)
            path = target
    return make_media(path, kind=kind)


def _http_get(url: str, dest: str, timeout: float, max_bytes: int) -> str:
    """Sync media-ingest adapter, called in a worker; use Hermes' public asynchronous SSRF client."""
    return asyncio.run(_http_get_async(url, dest, timeout, max_bytes))


async def _http_get_async(url: str, dest: str, timeout: float, max_bytes: int) -> str:
    """Validate each redirect and pin the checked IP at connect time; never use proxy env mounts."""
    try:
        from tools.url_safety import create_ssrf_safe_async_client, is_safe_url
    except ImportError:  # outside Hermes: no private-network guard available -> refuse
        raise MediaError("url safety check unavailable") from None
    current = url
    async with create_ssrf_safe_async_client(follow_redirects=False, timeout=timeout, trust_env=False) as client:
        for _ in range(5):
            if not is_safe_url(current):
                raise MediaError(f"refusing to download from a private or invalid address: {current}")
            async with client.stream("GET", current, headers={"User-Agent": "hermes-arachne-flow/1"}) as resp:
                if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                    current = str(resp.url.join(resp.headers["location"]))
                    continue
                if resp.status_code != 200:
                    raise MediaError(f"download failed: HTTP {resp.status_code}")
                declared = int(resp.headers.get("content-length") or 0)
                if declared > max_bytes:
                    raise MediaError(f"download too large ({declared} bytes)")
                size = 0
                with open(dest, "wb") as fh:
                    async for chunk in resp.aiter_bytes():
                        size += len(chunk)
                        if size > max_bytes:
                            raise MediaError("download too large")
                        fh.write(chunk)
                return (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    raise MediaError("too many redirects")


def from_url(url: str, out_dir: str, stem: str, timeout: float = DOWNLOAD_TIMEOUT_S) -> dict:
    url_path = unquote(urlparse(url).path)
    ext = os.path.splitext(url_path)[1].lower()
    ext = ext if ext in EXT_KIND else ""
    tmp = _unique_path(out_dir, stem, ext or ".download")
    try:
        content_type = _http_get(url, tmp, timeout, MAX_DOWNLOAD_BYTES)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    path = tmp
    if not ext:
        better = MIME_EXT.get(content_type) or mimetypes.guess_extension(content_type or "") or ".bin"
        path = _unique_path(out_dir, stem, better)
        os.replace(tmp, path)
    kind = kind_for(path)
    if kind == "file" and content_type:
        kind = kind_for(content_type)
    return make_media(path, kind=kind, source=url, mime=content_type or None)


# ----------------------------------------------------------------- trusted local folders (review E-3)

def _hermes_home() -> str:
    try:
        from hermes_constants import get_hermes_home  # Hermes public surface
        return str(get_hermes_home())
    except Exception:  # noqa: BLE001 - outside Hermes: same rule as Hermes' own default
        env = os.environ.get("HERMES_HOME", "").strip()
        if env:
            return env
        if os.name == "nt":
            return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local"), "hermes")
        return os.path.expanduser("~/.hermes")


def default_roots() -> tuple:
    """Folders a tool result may point into: Hermes' home (tool caches such as ``cache/audio``) and Arachne Flow's
    data dir (outputs, uploads, cache), plus the folders in ``$ARACHNE_FLOW_MEDIA_ROOTS`` (``os.pathsep``-separated,
    e.g. a custom TTS output folder). Anything else on disk is not the tool's output."""
    from . import store
    extra = [r.strip() for r in os.environ.get("ARACHNE_FLOW_MEDIA_ROOTS", "").split(os.pathsep) if r.strip()]
    roots = []
    for root in (_hermes_home(), store.data_dir(None), *extra):
        if root and root not in roots:
            roots.append(root)
    return tuple(roots)


def _real(path: str) -> str:
    require_local_path(path)
    return os.path.normcase(os.path.realpath(os.path.abspath(os.path.expanduser(path))))


def local_ref_allowed(path: str, roots=None) -> bool:
    """A local file named by a tool result is taken only when it is a media file (image/audio/video/3D, not
    ``.env``, ``.json`` …) whose real path lies under one of ``roots`` (default: ``default_roots()``)."""
    if blocked_local_path(path) or EXT_KIND.get(os.path.splitext(path)[1].lower(), "file") == "file":
        return False
    target = _real(path)
    for root in (default_roots() if roots is None else roots):
        base = _real(root).rstrip("\\/")
        if base and target.startswith(base + os.sep):
            return True
    return False


# ----------------------------------------------------------------- read guard (catalog review: model-set paths)
# Credential stores under Hermes' home and root, mirroring Hermes' own read denylist: never read, whoever names
# them (agent, template or user). Relative to a Hermes dir; forward slashes are normalized below.
_CREDENTIAL_FILES = (
    "auth.json", "auth.lock", ".anthropic_oauth.json", ".env", "webhook_subscriptions.json", "auth/google_oauth.json",
    "bws_cache.json", "bws_cache.enc.json", "op_cache.json", "photon-sidecar.json",
    "cache/bws_cache.json", "cache/bws_cache.enc.json", "cache/op_cache.json", "runtime/photon-sidecar.json",
)
_CREDENTIAL_DIRS = ("mcp-tokens", "browser-profile", "vault", "webapp", "skills/.hub")
# Arachne Flow's own consent key (messaging and file picks) and its staging names.
_OWN_SECRET_NAMES = ("messaging-secret",)
_OWN_SECRET_PREFIXES = (".messaging-key-",)
# (real paths the user picked in the canvas for the flow being run, folders of this run's own outputs);
# set per node by executors.execute.
_APPROVED = contextvars.ContextVar("arachne_flow_approved_paths", default=(frozenset(), ()))


def _hermes_dirs() -> list:
    home = _hermes_home()
    dirs = [home]
    try:
        from hermes_constants import get_default_hermes_root  # Hermes public surface
        dirs.append(str(get_default_hermes_root()))
    except Exception:  # noqa: BLE001 - older Hermes or outside Hermes: derive the root from a profile home
        pass
    parent = os.path.dirname(os.path.abspath(os.path.expanduser(home)))
    if os.path.basename(parent).lower() == "profiles":
        dirs.append(os.path.dirname(parent))
    out = []
    for d in dirs:
        if d and d not in out:
            out.append(d)
    return out


def _within(target: str, base: str) -> bool:
    base = base.rstrip("\\/")
    return bool(base) and (target == base or target.startswith(base + os.sep))


def secret_reason(path):
    """Why ``path`` must never be read, or None. Lexical name checks first, then the resolved path."""
    if not path:
        return None
    if blocked_local_path(path):
        return "UNC and device paths are not supported; choose a local file"
    raw = os.fsdecode(os.fspath(path))
    target = _real(raw)
    for name in {os.path.basename(raw.rstrip("\\/")).lower(), os.path.basename(target).lower()}:
        if name.startswith(".env"):
            return ".env files are never read by Arachne Flow"
        if name in _OWN_SECRET_NAMES or name.startswith(_OWN_SECRET_PREFIXES):
            return "this is Arachne Flow's consent key"
    for home in _hermes_dirs():
        try:
            base = _real(home)
        except (OSError, ValueError, MediaError):
            continue
        for rel in _CREDENTIAL_FILES:
            if target == os.path.normcase(os.path.normpath(os.path.join(base, *rel.split("/")))):
                return "this is a Hermes credential store"
        for rel in _CREDENTIAL_DIRS:
            if _within(target, os.path.normcase(os.path.normpath(os.path.join(base, *rel.split("/"))))):
                return "this is inside a Hermes credential folder"
    return None


def require_readable(path):
    """Raise MediaError for paths Arachne Flow never reads (credential stores, ``.env*``, its own key)."""
    reason = secret_reason(path)
    if reason:
        raise MediaError(f"refusing {path}: {reason}")
    return path


def real_path(path: str) -> str:
    return _real(path)


def set_approved(paths, roots=()):
    """Make ``paths`` (files the user picked in this flow) and engine media under ``roots`` (this run's output
    folder) sendable for the current node; returns a reset token for ``reset_approved``."""
    real = frozenset(_real(p) for p in paths if p and not blocked_local_path(p))
    dirs = tuple(_real(r) for r in roots if r and not blocked_local_path(r))
    return _APPROVED.set((real, dirs))


def reset_approved(token) -> None:
    _APPROVED.reset(token)


class approved:
    """``with M.approved([path]):`` — the same as a canvas pick, for code and tests outside a run."""

    def __init__(self, paths, roots=()):
        self.paths, self.roots, self.token = list(paths), list(roots), None

    def __enter__(self):
        self.token = set_approved(self.paths, self.roots)
        return self

    def __exit__(self, *exc):
        reset_approved(self.token)
        return False


def _engine_dirs() -> tuple:
    from . import store
    root = store.data_dir(None)
    return tuple(os.path.join(root, sub) for sub in ("uploads", "outputs", "cache"))


def may_send(path: str, engine_value: bool = False) -> bool:
    """A local file may leave the machine inside a tool argument only when it is not a secret and is either picked
    or dropped by the user in this flow, an engine media value under Arachne Flow's uploads/outputs/cache, or a
    media file under Hermes' or Arachne Flow's folders (``local_ref_allowed``)."""
    if not path or secret_reason(path):
        return False
    target = _real(path)
    picked, run_dirs = _APPROVED.get()
    if target in picked:
        return True
    if engine_value and any(_within(target, d) for d in (*run_dirs, *(_real(d) for d in _engine_dirs()))):
        return True
    return local_ref_allowed(path)


def inline_local(path: str, engine_value: bool = False, max_bytes: int = None) -> str:
    """``data_url`` for a local file a tool argument names, after the read guard and ``may_send``."""
    require_readable(path)
    if not may_send(path, engine_value=engine_value):
        raise MediaError(f"refusing to send {path}: a local file outside Arachne Flow's uploads and outputs must be "
                         "picked with Browse… or dropped on the canvas by you")
    return data_url(path) if max_bytes is None else data_url(path, max_bytes)


def ingest(ref: str, out_dir: str, stem: str, allow_download: bool = True, roots=None) -> dict:
    """One reference (MEDIA: line, data URL, https URL or local path) from a tool result -> media value.

    Local paths must pass ``local_ref_allowed`` (review E-3); trusted paths (File node) use ``from_local``."""
    ref = (ref or "").strip()
    m = _MEDIA_LINE.match(ref)
    if m:
        ref = m.group(1).strip()
    if ref.startswith("data:"):
        return from_data_url(ref, out_dir, stem)
    if ref.startswith(("http://", "https://")):
        if not allow_download:
            raise MediaError("downloads disabled")
        return from_url(ref, out_dir, stem)
    if not local_ref_allowed(ref, roots):
        raise MediaError(f"refusing a local file outside Hermes' and Arachne Flow's folders or not media: {ref}")
    return from_local(ref, out_dir, stem)


# ----------------------------------------------------------------- detection

def _looks_like_local_media(text: str) -> bool:
    if len(text) > 1024 or "\n" in text or blocked_local_path(text):
        return False
    if not (os.path.isabs(text) or text.startswith("~")):
        return False
    return os.path.splitext(text)[1].lower() in EXT_KIND and os.path.isfile(os.path.expanduser(text))


def _url_is_media(url: str, key: str) -> bool:
    if len(url) > 4096:
        return False
    ext = os.path.splitext(unquote(urlparse(url).path))[1].lower()
    if ext in EXT_KIND:
        return EXT_KIND[ext] != "file" or bool(key and _MEDIA_KEYS.search(key))
    return bool(key and _MEDIA_KEYS.search(key))


def find_refs(value, key: str = "", depth: int = 0, out=None) -> list:
    """Media references inside a tool result, in document order, without duplicates."""
    out = [] if out is None else out
    if depth > 8 or len(out) >= MAX_MEDIA_PER_RESULT * 3:
        return out

    def add(ref):
        if ref not in out:
            out.append(ref)

    if isinstance(value, str):
        text = value.strip()
        if key.lower() in FREE_TEXT_KEYS:   # prose: data URLs, whole-value or top-level URLs, never local refs
            if text.startswith("data:") and _DATA_URL.match(text):
                add(text)
            elif text.startswith(("http://", "https://")) and " " not in text and _url_is_media(text, key):
                add(text)
            elif depth == 0 and "http" in text:
                for url in _URL_IN_TEXT.findall(text):
                    if EXT_KIND.get(os.path.splitext(unquote(urlparse(url).path))[1].lower(), "file") != "file":
                        add(url)
            return out
        for m in _MEDIA_LINE.finditer(value):
            add("MEDIA:" + m.group(1).strip())
        if text.startswith("data:") and _DATA_URL.match(text):
            add(text)
        elif text.startswith(("http://", "https://")) and " " not in text:
            if _url_is_media(text, key):
                add(text)
        elif _looks_like_local_media(text):
            add(text)
        elif depth == 0 and "http" in text:
            for url in _URL_IN_TEXT.findall(text):
                ext = os.path.splitext(unquote(urlparse(url).path))[1].lower()
                if EXT_KIND.get(ext, "file") != "file":
                    add(url)
    elif isinstance(value, dict):
        if ptypes.is_media(value):
            return out
        for k, v in value.items():
            if k in ("media_tag",) and isinstance(v, str):
                for m in _MEDIA_LINE.finditer(v):
                    add("MEDIA:" + m.group(1).strip())
                continue
            find_refs(v, str(k), depth + 1, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            find_refs(v, key, depth + 1, out)
    return out


def _ref_identity(ref: str) -> str:
    m = _MEDIA_LINE.match(ref)
    target = m.group(1).strip() if m else ref
    if target.startswith(("http://", "https://", "data:")):
        return target
    return os.path.normcase(os.path.abspath(os.path.expanduser(target)))


def extract_media(result, out_dir: str, stem: str, allow_download: bool = True,
                  limit: int = MAX_MEDIA_PER_RESULT, roots=None, log=None) -> list:
    """Ingest every media reference in ``result`` (best effort; failures are logged and skipped).

    ``log`` (the node's status line) hears every skip, so a refused file is not a silent empty output."""
    roots = default_roots() if roots is None else roots
    media, seen = [], set()
    for ref in find_refs(result):
        ident = _ref_identity(ref)
        if ident in seen:
            continue
        seen.add(ident)
        try:
            media.append(ingest(ref, out_dir, f"{stem}-{len(media)}", allow_download=allow_download, roots=roots))
        except Exception as exc:  # noqa: BLE001 - one broken link must not fail the node
            logger.info("arachne-flow: skipped media %s: %s", ref[:120], exc)
            if log is not None:
                log(f"media skipped: {exc}")
        if len(media) >= limit:
            break
    return media


# ----------------------------------------------------------------- media -> tool argument

def data_url(path: str, max_bytes: int = MAX_DATA_URL_BYTES) -> str:
    require_readable(path)
    size = os.path.getsize(path)
    if size > max_bytes:
        raise MediaError(f"file too large for a data URL ({size} bytes)")
    with open(path, "rb") as fh:
        payload = base64.b64encode(fh.read()).decode("ascii")
    return f"data:{mime_for(path)};base64,{payload}"


def to_arg(value, param_name: str = ""):
    """Media values as tool arguments, including lists and local paths picked in the inspector.

    ``*DataUrl``/base64 arguments inline local files. Remote HTTPS sources stay remote for URL
    arguments. Other providers receive their usual path/URL shape; no provider-specific branch.
    """
    if isinstance(value, list):
        return [to_arg(item, param_name) for item in value]
    name = (param_name or "").lower().replace("-", "_")
    inline = any(k in name for k in ("dataurl", "data_url", "b64", "base64"))
    if isinstance(value, str) and not ptypes.is_media(value):
        require_local_path(value)
        if (inline or "url" in name) and value and not value.startswith(("data:", "http://", "https://")) \
                and os.path.isfile(value):
            return inline_local(value)   # a text naming a file: only picked/dropped files or Hermes media folders
        return value
    if not ptypes.is_media(value):
        return value
    meta = value["$media"]
    require_local_path(meta.get("path"))
    if inline:
        return inline_local(meta["path"], engine_value=True)
    if "url" in name and str(meta.get("source", "")).startswith("https://"):
        return meta["source"]
    return meta.get("path") or meta.get("source") or ""
