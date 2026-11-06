"""Attachment parsing: txt, md, code and pdf → text; png / jpeg / gif / webp → an image the model looks at."""
from __future__ import annotations

import base64
import io

MAX_CHARS = 60_000
TEXT_EXT = {".txt", ".md", ".markdown", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml", ".html",
            ".css", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".rb", ".php", ".sh", ".sql", ".csv", ".xml", ".ini", ".cfg"}


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # vision models take ~20MB, but every image is resent with each model call


class UnsupportedFile(ValueError):
    pass


def image_mime(data: bytes) -> str | None:
    """The real image type from the file's magic bytes (never trust the name or the browser's Content-Type)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def parse_image(filename: str, data: bytes) -> tuple[str, str] | None:
    """(mime, base64) when ``data`` is a supported image, None when it isn't an image at all. Raises for bad images."""
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    mime = image_mime(data)
    if mime is None:
        if ext in IMAGE_EXT:
            raise UnsupportedFile(f"{filename} is not a valid PNG, JPEG, GIF or WebP image")
        return None
    if len(data) > MAX_IMAGE_BYTES:
        raise UnsupportedFile(f"Image too large ({len(data) / 1e6:.1f}MB, max {MAX_IMAGE_BYTES // (1024 * 1024)}MB)")
    return mime, base64.b64encode(data).decode("ascii")


def parse_file(filename: str, data: bytes) -> tuple[str, bool]:
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext == ".pdf":
        from pypdf import PdfReader

        try:
            reader = PdfReader(io.BytesIO(data))
            text = "\n\n".join((p.extract_text() or "") for p in reader.pages[:200])
        except Exception as exc:
            raise UnsupportedFile(f"Could not read PDF: {exc}") from exc
    elif ext in TEXT_EXT or not ext:
        if b"\x00" in data[:4096]:
            raise UnsupportedFile("Binary files are not supported")
        text = data.decode("utf-8", errors="replace")
    else:
        raise UnsupportedFile(f"Unsupported file type '{ext}'")
    truncated = len(text) > MAX_CHARS
    return text[:MAX_CHARS], truncated
