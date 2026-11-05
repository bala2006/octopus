"""Command sandbox outcomes for a fixed list of commands. Only the pure checks run: no command is executed."""
from __future__ import annotations

from typing import Any

from app.tools.sandbox import (
    SandboxError,
    analyze_command,
    parse_command,
    shell_operators,
)
from scripts.golden.canon import dump_json

COMMANDS: dict[str, list[str]] = {
    "allowed_programs": [
        "python -V", "python3 -m pytest -q", "pytest", "pytest tests/test_app.py -k add", "node index.js", "npm test",
        "npm run build", "npm ci", "npm install", "npm create vite@latest app", "npm init -y", "npx vitest run",
        "npx create-vite app", "git status", "git diff --stat", "git log -n 3", "git commit -m \"add feature\"", "git push",
        "ls -la", "go test ./...", "go build", "go run main.go", "cargo test", "cargo build", "cargo run", "flutter doctor",
        "dart --version", "dotnet build", "python", "pytest", "  python   src/app.py  ",
    ],
    "not_on_allowlist": ["npm", "npx", "git clone https://example.com/r.git", "echo hi", "/usr/bin/python3 x.py", "cat README.md",
                         "bash run.sh", "make test"],
    "blocked_programs": ["sudo python -V", "rm -rf build", "/bin/rm -rf build", "curl https://example.com", "wget https://example.com/x",
                         "ssh host", "dd if=/dev/zero of=x", "chmod +x run.sh", "shutdown now"],
    "shell_operators": ["python a.py; rm a.py", "python a.py && pytest", "python a.py || true", "python a.py | head",
                        "python a.py > out.txt", "python a.py < in.txt", "python a.py &", "echo `id`", "python -m pytest $(pwd)",
                        "python a.py\nrm b.py"],
    "operators_inside_quotes": ["python -m pytest -k \"a and b\"", "npm test -- --grep 'a | b'"],
    "inline_code": ["python -c \"print(1)\"", "python3 -c 'print(1)'", "node -e \"console.log(1)\"", "node --eval \"1\"",
                    "python -c", "node -e"],
    "paths_outside_project": ["python ../secret.py", "python /etc/hosts", "python ~/notes.py", "pytest C:\\Users\\me\\t.py",
                              "pytest --rootdir=/tmp/x", "pytest --rootdir=../x", "ls ../..", "python tests/../../x.py", "ls /",
                              "python ..hidden.py"],
    "paths_inside_project": ["python ./src/app.py", "python src/app.py", "python -m pytest tests/", "python .github/workflows/ci.yml",
                             "python src/.gitignore_check.py"],
    "protected_paths": ["python .git/config", "git diff .git/HEAD", "python .octopus/octopus.db", "ls .octopus",
                        "python src/.GIT/x", "pytest --cov=.git", "python -m pytest .octopus/work/test-report.md"],
    "empty": ["", "   "],
    "unparseable": ["python \"unterminated", "python 'x"],
}


def _analyze(command: str) -> dict[str, Any]:
    try:
        plan = analyze_command(command)
    except SandboxError as exc:
        return {"kind": "error", "argv": None, "outside": None, "error": str(exc)}
    return {"kind": "plan", "argv": plan.argv, "outside": plan.outside, "error": None}


def _parse(command: str, allow_outside: bool) -> dict[str, Any]:
    try:
        argv = parse_command(command, allow_outside=allow_outside)
    except SandboxError as exc:
        return {"kind": "error", "argv": None, "error": str(exc)}
    return {"kind": "argv", "argv": argv, "error": None}


def sandbox_records() -> list[dict[str, Any]]:
    records = []
    for group, commands in COMMANDS.items():
        for command in commands:
            records.append({
                "group": group,
                "command": command,
                "shell_operators": shell_operators(command),
                "analyze_command": _analyze(command),
                "parse_command": _parse(command, allow_outside=False),
                "parse_command_allow_outside": _parse(command, allow_outside=True),
            })
    return records


def sandbox_json() -> str:
    return dump_json(sandbox_records())
