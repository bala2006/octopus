"""Attachment parsing: txt, md, code and pdf → text."""
from __future__ import annotations

import io

MAX_CHARS = 60_000
TEXT_EXT = {".txt", ".md", ".markdown", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml", ".html",
            ".css", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".rb", ".php", ".sh", ".sql", ".csv", ".xml", ".ini", ".cfg"}


class UnsupportedFile(ValueError):
    pass


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
