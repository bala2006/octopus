"""Human file editing, using the same project boundary as agent tools."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from app.tools.workspace import IGNORED_DIRS, MAX_FILE_BYTES, MAX_LIST, ProjectFS, WorkspaceError, is_secret


class FileConflict(WorkspaceError):
    pass


def read_document(fs: ProjectFS, path: str) -> dict:
    rel, target = fs.resolve(path)
    if not target.is_file():
        raise FileNotFoundError(rel)
    with target.open("rb") as stream:
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise WorkspaceError("This file exceeds the 1 MB editor limit. Open it in your local editor.")
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkspaceError("This is a binary or non-UTF-8 file. Use Preview or download it.") from exc
    if "\x00" in content:
        raise WorkspaceError("This is a binary file. Use Preview or download it.")
    return {"path": rel, "content": content, "size": len(data), "revision": hashlib.sha256(data).hexdigest()}


def save_document(fs: ProjectFS, path: str, content: str, revision: str | None) -> dict:
    rel, target = fs.resolve(path)
    if target.is_symlink():
        raise WorkspaceError("Edit the original file instead of replacing a symbolic link.")
    if revision is None:
        if target.exists():
            raise FileConflict("A file or folder already exists at this path.")
    elif not target.is_file() or read_document(fs, rel)["revision"] != revision:
        raise FileConflict("This file changed on disk. Compare with the disk version before saving.")
    fs.write(rel, content)
    return read_document(fs, rel)


def folders(fs: ProjectFS) -> tuple[list[str], bool]:
    result = []
    for parent, dirs, _ in os.walk(fs.root):
        dirs[:] = sorted(d for d in dirs if d.lower() not in IGNORED_DIRS and not is_secret(d)
                         and not (Path(parent) / d).is_symlink())
        for name in dirs:
            result.append((Path(parent) / name).relative_to(fs.root).as_posix())
            if len(result) >= MAX_LIST:
                return result, True
    return result, False
