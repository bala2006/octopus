"""Write the OpenAPI schema to a file (used to generate the typed frontend client): python -m app.export_openapi out.json"""
from __future__ import annotations

import json
import sys

from app.main import app

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "openapi.json"
    with open(out, "w") as f:
        json.dump(app.openapi(), f, indent=1)
    print(f"wrote {out}")
