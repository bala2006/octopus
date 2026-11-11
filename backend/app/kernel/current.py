"""The kernel of this process. The composition root sets it once (``create_app``); code that cannot receive the kernel as an
argument (a run built by a test, a script) asks for it here. Nothing else in the kernel is global."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from app.kernel.core import Kernel

_current: Kernel | None = None


def set_current(kernel: Kernel | None) -> None:
    global _current
    _current = kernel


def current() -> Kernel:
    if _current is None:
        raise RuntimeError("The Octopus kernel is not built yet. Import app.main (or call app.bootstrap.build_kernel) first.")
    return _current
