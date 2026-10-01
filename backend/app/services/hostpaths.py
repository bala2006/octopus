"""Translate between laptop paths and container paths when Octopus runs in Docker.

docker-compose shares one laptop folder (``HOST_DIR``, e.g. ``C:\\Users\\me`` or ``/Users/me``) into the container at
``HOST_DIR_MOUNT`` (``/host``). The UI shows and accepts laptop paths; the backend works with container paths.
Without that configuration (Octopus running natively) both functions return the path unchanged.
"""
from __future__ import annotations

import re

from app.core.config import get_settings

_WIN = re.compile(r"^[A-Za-z]:([\\/]|$)")


def _mapping() -> tuple[str, str] | None:
    s = get_settings()
    host, mount = (s.host_dir or "").strip(), (s.host_dir_mount or "").strip()
    if not host or not mount:
        return None
    return host, mount.rstrip("/") or "/"


def _is_windows(p: str) -> bool:
    return bool(_WIN.match(p)) or ("\\" in p and "/" not in p)


def _norm(p: str) -> str:
    """Comparable form: forward slashes, no trailing slash, case-folded for Windows paths."""
    q = p.replace("\\", "/").rstrip("/")
    return q.lower() if _WIN.match(p) else q


def to_container(path: str) -> str:
    """A path the user typed or picked on the laptop → the same folder inside the container (unchanged if not shared)."""
    m = _mapping()
    if not m or not path:
        return path
    host, mount = m
    p, h = _norm(path.strip()), _norm(host)
    if p == h:
        return mount
    if p.startswith(h + "/"):
        rest = path.strip().replace("\\", "/").rstrip("/")[len(h) + 1:]
        return f"{mount.rstrip('/')}/{rest}"
    return path


def to_host(path: str) -> str:
    """A container path → how the user knows it on their laptop (unchanged outside the shared folder)."""
    m = _mapping()
    if not m or not path:
        return path
    host, mount = m
    if path != mount and not path.startswith(mount.rstrip("/") + "/"):
        return path
    rest = path[len(mount):].strip("/")
    if not rest:
        return host
    sep = "\\" if _is_windows(host) else "/"
    return host.rstrip("\\/") + sep + rest.replace("/", sep)


def outside_shared_folder(path: str) -> str | None:
    """If a laptop path can't be reached from the container, explain why (None when it can, or when not in Docker)."""
    m = _mapping()
    if not m:
        return None
    if to_container(path) == path and (_WIN.match(path) or path.startswith(("/Users/", "/home/"))):
        return (f"{path} isn't shared with the Octopus container. Only folders inside {m[0]} are; pick one there, "
                "or set OCTOPUS_HOST_DIR (see README → Docker) and restart.")
    return None
