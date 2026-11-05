"""Screenshots of what each agent's browser tab showed, so people can watch an agent browse (live and on replay).

Images live on disk under OCTOPUS_HOME/browser-frames/<run_id>/; run events only carry the file name, never image bytes.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

from app.core.config import get_settings

KEEP_PER_RUN = 120  # oldest frames are pruned; the event that names a pruned frame shows "no longer kept"
NAME_RE = re.compile(r"^\d{6}\.(jpeg|png)$")
_ID_RE = re.compile(r"^[\w-]{1,80}$")


def run_dir(run_id: str) -> Path:
    if not _ID_RE.match(run_id):
        raise ValueError("bad run id")
    return get_settings().octopus_home / "browser-frames" / run_id


def _ext(data: bytes) -> str:
    return "png" if data.startswith(b"\x89PNG") else "jpeg"


def save(run_id: str, data: bytes) -> str:
    d = run_dir(run_id)
    d.mkdir(parents=True, exist_ok=True)
    existing = sorted(p for p in d.iterdir() if NAME_RE.match(p.name))
    seq = int(existing[-1].name.split(".")[0]) + 1 if existing else 1
    name = f"{seq:06d}.{_ext(data)}"
    (d / name).write_bytes(data)
    for old in existing[: max(0, len(existing) + 1 - KEEP_PER_RUN)]:
        old.unlink(missing_ok=True)
    return name


def path(run_id: str, name: str) -> Path | None:
    if not NAME_RE.match(name):
        return None
    p = run_dir(run_id) / name
    return p if p.is_file() else None


def delete_run(run_id: str) -> None:
    try:
        shutil.rmtree(run_dir(run_id), ignore_errors=True)
    except ValueError:
        pass
