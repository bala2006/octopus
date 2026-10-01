"""Images the user attaches to a message (pasted, dropped or picked): validated data URLs the model can look at."""
from __future__ import annotations

import base64
import binascii
import re
from typing import Any

MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MEDIA_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_DATA_URL = re.compile(r"^data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$")
_MAGIC = {"image/png": b"\x89PNG", "image/jpeg": b"\xff\xd8\xff", "image/gif": b"GIF8", "image/webp": b"RIFF"}


class ImageError(ValueError):
    pass


def parse_images(raw: Any) -> list[dict[str, str]]:
    """[{name, data_url}] from a client → [{name, media_type, data_url}], or ImageError with a reason for the user."""
    if not raw:
        return []
    if not isinstance(raw, list):
        raise ImageError("images must be a list")
    if len(raw) > MAX_IMAGES:
        raise ImageError(f"at most {MAX_IMAGES} images per message")
    out = []
    for i, item in enumerate(raw):
        url = str((item or {}).get("data_url", "")) if isinstance(item, dict) else ""
        name = str((item or {}).get("name") or f"image-{i + 1}")[:120] if isinstance(item, dict) else f"image-{i + 1}"
        m = _DATA_URL.match(url)
        if not m or m.group(1) not in MEDIA_TYPES:
            raise ImageError(f"{name}: only PNG, JPEG, WebP or GIF images can be attached")
        try:
            data = base64.b64decode(m.group(2), validate=False)
        except (binascii.Error, ValueError) as exc:
            raise ImageError(f"{name}: the image data is not valid base64") from exc
        if len(data) > MAX_IMAGE_BYTES:
            raise ImageError(f"{name}: images can be at most {MAX_IMAGE_BYTES // (1024 * 1024)} MB")
        if not data.startswith(_MAGIC[m.group(1)]):
            raise ImageError(f"{name}: the file is not a {m.group(1).split('/')[1].upper()} image")
        out.append({"name": name, "media_type": m.group(1), "data_url": f"data:{m.group(1)};base64,{base64.b64encode(data).decode()}"})
    return out


def decode(data_url: str) -> tuple[str, bytes]:
    m = _DATA_URL.match(data_url)
    if not m:
        raise ImageError("not an image")
    return m.group(1), base64.b64decode(m.group(2))


def attach_text(content: str, attachments: Any, limit: int = 30000) -> str:
    """Parsed text files (txt, md, pdf, code) appended to a message, as for goals and direct chats."""
    from app.orchestrator.context import clip

    for a in (attachments or [])[:5]:
        if isinstance(a, dict):
            content += f"\n\n--- Attached file: {str(a.get('filename', 'file'))[:200]} ---\n" + clip(str(a.get("text", "")), limit)
    return content
