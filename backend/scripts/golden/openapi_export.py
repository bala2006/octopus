"""OpenAPI schema, generated the same way as app/export_openapi.py (app.openapi()), with sorted keys and indent 2."""
from __future__ import annotations

from app.main import app
from scripts.golden.canon import dump_json


def openapi_json() -> str:
    return dump_json(app.openapi())
