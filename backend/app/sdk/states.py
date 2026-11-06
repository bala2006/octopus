"""Constants that more than one action handler or runtime module uses."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    pass


OPEN_TASK_STATES = {"todo", "in_progress", "in_review", "blocked"}
