"""Versioned file and folder operations, including binary assets and reversible deletion."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Literal, TypedDict

from app.services.editor import FileConflict
from app.tools.workspace import IGNORED_DIRS, WORK_DIR, ProjectFS, WorkspaceError, is_secret

MAX_ITEM_ENTRIES = 10_000
MAX_UPLOAD_BYTES = 20_000_000
MAX_MANAGED_BYTES = 100_000_000


class Item(TypedDict):
    path: str
    kind: Literal["file", "folder"]
    size: int
    revision: str


class TrashItem(TypedDict):
    token: str
    path: str
    kind: Literal["file", "folder"]
    size: int
    deleted_at: float


def list_trash(fs: ProjectFS) -> list[TrashItem]:
    directory = fs.root / ".octopus" / "trash"
    if not directory.is_dir():
        return []
    result: list[TrashItem] = []
    for entry in directory.iterdir():
        if len(entry.name) != 32 or any(c not in "0123456789abcdef" for c in entry.name) or entry.is_symlink():
            continue
        try:
            content = entry / "content"
            metadata = json.loads((entry / "metadata.json").read_text(encoding="utf-8"))
            rel, _ = fs.resolve(metadata["path"])
            if not content.exists():
                continue
            size = metadata.get("size", content.stat().st_size if content.is_file() else 0)
            if not isinstance(size, int) or size < 0:
                continue
            result.append({"token": entry.name, "path": rel, "kind": "folder" if content.is_dir() else "file",
                           "size": size, "deleted_at": entry.stat().st_mtime})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return sorted(result, key=lambda item: item["deleted_at"], reverse=True)[:100]


def inspect(fs: ProjectFS, path: str) -> Item:
    rel, target = fs.resolve(path)
    if not target.exists():
        raise FileNotFoundError(rel)
    if target.is_symlink() or rel == WORK_DIR:
        raise WorkspaceError("Operate on original files and folders instead of symbolic links or internal working folders.")
    if any(part.lower() in IGNORED_DIRS or is_secret(part) for part in Path(rel).parts):
        raise WorkspaceError("Dependencies, generated folders, and private files cannot be moved or deleted here.")
    digest = hashlib.sha256()
    size = 0
    if target.is_file():
        if target.stat().st_size > MAX_MANAGED_BYTES:
            raise WorkspaceError("This file exceeds the 100 MB management limit. Use your local file manager.")
        with target.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                digest.update(block)
                size += len(block)
                if size > MAX_MANAGED_BYTES:
                    raise WorkspaceError("This file grew beyond the 100 MB management limit.")
        return {"path": rel, "kind": "file", "size": size, "revision": digest.hexdigest()}
    entries = 0
    for parent, dirs, files in os.walk(target, followlinks=False):
        dirs.sort()
        for name in sorted(dirs + files):
            child = Path(parent) / name
            if child.is_symlink() or name.lower() in IGNORED_DIRS or is_secret(name):
                raise WorkspaceError("This folder contains private files, dependencies, or symbolic links. Manage those locally first.")
            fs.resolve(child.relative_to(fs.root).as_posix())
            stat = child.stat()
            digest.update(json.dumps([child.relative_to(target).as_posix(), child.is_dir(), stat.st_size, stat.st_mtime_ns, stat.st_ino]).encode())
            size += stat.st_size if child.is_file() else 0
            entries += 1
            if entries > MAX_ITEM_ENTRIES:
                raise WorkspaceError("This folder is too large to manage here. Use your local file manager.")
    return {"path": rel, "kind": "folder", "size": size, "revision": digest.hexdigest()}


def checked(fs: ProjectFS, path: str, revision: str) -> Item:
    item = inspect(fs, path)
    if item["revision"] != revision:
        raise FileConflict("This file or folder changed on disk. Refresh it before moving or deleting it.")
    return item


def move(fs: ProjectFS, path: str, destination: str, revision: str) -> Item:
    checked(fs, path, revision)
    rel, target = fs.resolve(destination)
    if any(part.lower() in IGNORED_DIRS or is_secret(part) for part in Path(rel).parts):
        raise WorkspaceError("Choose a destination outside dependencies and private folders.")
    if target.exists():
        raise FileConflict("A file or folder already exists at the destination.")
    _, moved, _ = fs.move(path, destination)
    return inspect(fs, moved)


def trash(fs: ProjectFS, path: str, revision: str) -> str:
    item = checked(fs, path, revision)
    _, target = fs.resolve(path)
    token = uuid.uuid4().hex
    directory = fs.root / ".octopus" / "trash" / token
    directory.mkdir(parents=True)
    try:
        (directory / "metadata.json").write_text(json.dumps(item), encoding="utf-8")
        os.replace(target, directory / "content")
    except OSError:
        (directory / "metadata.json").unlink(missing_ok=True)
        directory.rmdir()
        raise
    return token


def restore(fs: ProjectFS, token: str) -> Item:
    directory = fs.root / ".octopus" / "trash" / token
    content = directory / "content"
    if directory.is_symlink() or content.is_symlink():
        raise WorkspaceError("Symbolic links cannot be restored from project trash.")
    if not content.exists():
        raise FileNotFoundError(token)
    metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    rel, target = fs.resolve(metadata["path"])
    if target.exists():
        raise FileConflict("A file or folder already exists at the original path. Rename it before restoring.")
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(content, target)
    (directory / "metadata.json").unlink()
    directory.rmdir()
    return inspect(fs, rel)
