"""Files attached to a run's goal. Text attachments live in the run state; images are stored next to the project's
database (``.octopus/attachments/<run_id>/``) and shown to every agent of the run as images (vision input)."""
from __future__ import annotations

import base64
import binascii
import re
import shutil
from pathlib import Path
from typing import Any

from app.core.config import PROJECT_DIRNAME
from app.services.files import MAX_IMAGE_BYTES, image_mime

MAX_FILES = 5
MAX_IMAGES = 4
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
NAME_RE = re.compile(r"^\d{2}-[\w.-]{1,80}\.(png|jpg|gif|webp)$")


class AttachmentError(ValueError):
    pass


def run_dir(root: Path, run_id: str) -> Path:
    return root / PROJECT_DIRNAME / "attachments" / run_id


def is_image(a: dict[str, Any]) -> bool:
    return a.get("kind") == "image" or bool(a.get("data"))


def store(root: Path, run_id: str, attachments: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Validate and keep a run's attachments; returns what goes into ``Run.state_json["attachments"]``."""
    out: list[dict[str, Any]] = []
    images = 0
    for i, a in enumerate(attachments[:MAX_FILES]):
        filename = str(a.get("filename") or "file")[:200]
        if not is_image(a):
            out.append({"filename": filename, "text": str(a.get("text", ""))[:30000]})
            continue
        images += 1
        if images > MAX_IMAGES:
            raise AttachmentError(f"At most {MAX_IMAGES} images per run")
        raw = str(a.get("data") or "")
        if raw.startswith("data:"):
            raw = raw.split(",", 1)[-1]
        try:
            data = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise AttachmentError(f"{filename}: the image data is not valid base64") from exc
        mime = image_mime(data)
        if mime is None:
            raise AttachmentError(f"{filename} is not a PNG, JPEG, GIF or WebP image")
        if len(data) > MAX_IMAGE_BYTES:
            raise AttachmentError(f"{filename} is too large (max {MAX_IMAGE_BYTES // (1024 * 1024)}MB)")
        stem = re.sub(r"[^\w.-]", "_", filename.rsplit(".", 1)[0])[:60] or "image"
        name = f"{i + 1:02d}-{stem}.{EXT[mime]}"
        d = run_dir(root, run_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_bytes(data)
        out.append({"filename": filename, "kind": "image", "mime": mime, "name": name, "bytes": len(data)})
    return out


def path(root: Path, run_id: str, name: str) -> Path | None:
    if not NAME_RE.match(name):
        return None
    p = run_dir(root, run_id) / name
    return p if p.is_file() else None


def load_images(root: Path, run_id: str, attachments: list[dict[str, Any]]) -> list[dict[str, str]]:
    """The run's images as model input ({mime, data: base64}); missing files are skipped."""
    out = []
    for a in attachments:
        if a.get("kind") != "image":
            continue
        p = path(root, run_id, str(a.get("name", "")))
        if p is not None:
            out.append({"mime": str(a.get("mime") or "image/png"), "data": base64.b64encode(p.read_bytes()).decode("ascii")})
    return out[:MAX_IMAGES]


def delete_run(root: Path, run_id: str) -> None:
    shutil.rmtree(run_dir(root, run_id), ignore_errors=True)
