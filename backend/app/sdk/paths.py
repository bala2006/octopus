"""Path policy shared by every layer: directories never read and secret filenames never read or shown to agents.
"""
from __future__ import annotations

import fnmatch

PROJECT_DIRNAME = ".octopus"  # the folder Octopus keeps in every project (database, working documents, exports)

IGNORED_DIRS = {".git", PROJECT_DIRNAME, "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
                ".ruff_cache", ".tmp", "dist", "build", ".next", ".turbo", ".idea", ".vscode", ".ds_store",
                ".dart_tool", ".gradle", ".cxx", ".pub-cache", ".npm", "coverage"}
SECRET_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", ".npmrc", ".pypirc",
                   ".netrc", "credentials*", "*.keystore", "secrets.*"]
# Source files whose syntax Octopus checks after a write and that count as a deliverable to run or open.
VERIFIABLE_EXT = {"py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "html", "htm", "go", "rs", "java", "rb", "php", "sh"}
SECRET_ALLOW = {".env.example", ".env.sample", ".env.template"}


def is_secret(rel: str) -> bool:
    name = rel.rsplit("/", 1)[-1].lower()
    if name in SECRET_ALLOW:
        return False
    return any(fnmatch.fnmatch(name, pat) for pat in SECRET_PATTERNS)
