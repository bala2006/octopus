"""Pinned, inspectable workflow inputs. Loading a bundle never executes its scripts."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Iterable, Literal
from urllib.parse import unquote, urlsplit

from pydantic import Field

from app.core.contracts import Contract, ContractError, content_hash  # noqa: F401 (base types live in core)
from app.services import project_guidance
from app.capabilities.skills.library import Skill
from app.capabilities.workspace.project_fs import ProjectFS, is_secret

MAX_BUNDLE_FILES = 128
MAX_BUNDLE_BYTES = 2_000_000
MAX_DOCUMENT_BYTES = 512_000
WorkflowName = Literal["auto", "explain", "fix", "build", "review"]
Strategy = Literal["solo", "arena", "swarm"]


class PinnedDocument(Contract):
    path: str
    sha256: str
    content: str
    kind: Literal["skill", "reference", "script", "guidance"]


class SkillBundle(Contract):
    id: str
    version: str
    origin: str
    description: str
    body: str
    content_hash: str
    documents: tuple[PinnedDocument, ...] = ()
    remote_references: tuple[str, ...] = ()
    required_capabilities: tuple[str, ...] = ()
    # A digest identifies content. It does not establish trust or grant permissions.
    reviewed: bool = False


class PinnedGuidance(Contract):
    content: str
    content_hash: str
    documents: tuple[PinnedDocument, ...]


def _relative_file(root: Path, value: str, base: Path | None = None) -> Path:
    decoded = unquote(value).replace("\\", "/")
    if not decoded or "\x00" in decoded or decoded.startswith(("/", "~")) or re.match(r"^[a-zA-Z]:", decoded):
        raise ContractError("Bundle references must be relative files")
    if ":" in decoded:
        raise ContractError("Unsupported reference scheme")
    candidate = (base or root) / decoded
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ContractError("Bundle reference escapes its root")
    cursor = candidate
    while cursor != root and cursor.is_relative_to(root):
        if cursor.is_symlink():
            raise ContractError("Bundle symlinks are not supported")
        cursor = cursor.parent
    relative = resolved.relative_to(root)
    if any(part.startswith(".") and part != "." for part in relative.parts) or is_secret(relative.as_posix()):
        raise ContractError("Bundle references protected or secret content")
    return resolved


def _references(text: str) -> Iterable[str]:
    # Markdown links and conventional bundled paths in inline code. No network requests.
    yield from re.findall(r"\]\(<?([^\s)>]+)>?(?:\s+\"[^\"]*\")?\)", text)
    yield from re.findall(r"`((?:references|scripts)/[^`\n]+)`", text)


def pin_skill_bundle(skill: Skill, source_dir: Path | None = None, *,
                     allowed_capabilities: Iterable[str] = (), required_capabilities: Iterable[str] = (),
                     reviewed: bool = False, version: str = "1") -> SkillBundle:
    """Snapshot the complete self-contained bundle, including unused references/scripts.

    Callers resolve precedence with ``effective_skills`` first and provide that skill's
    actual directory, if it has one. Registry-only skills may be pinned without a directory.
    ``reviewed`` is a caller-owned trust decision, never a frontmatter assertion.
    """
    documents: list[PinnedDocument] = []
    remote: set[str] = set()
    requested = set(required_capabilities)
    body_bytes = skill.body.encode()
    if len(body_bytes) > MAX_DOCUMENT_BYTES:
        raise ContractError("Skill body exceeds the bundle document limit")
    root = source_dir.resolve() if source_dir is not None else None
    if source_dir is not None and (source_dir.is_symlink() or not source_dir.is_dir()):
        raise ContractError("Skill bundle root must be a real directory")
    texts: list[tuple[Path | None, str]] = [(root, skill.body)]
    total = len(body_bytes)
    if root is not None:
        if not (root / "SKILL.md").is_file():
            raise ContractError("Bundle root must contain SKILL.md")
        pending = [root]
        directories_seen = 0
        while pending:
            directory = pending.pop()
            directories_seen += 1
            if directories_seen > MAX_BUNDLE_FILES:
                raise ContractError("Skill bundle has too many directories")
            for path in sorted(directory.iterdir()):
                if path.is_symlink():
                    raise ContractError("Bundle symlinks are not supported")
                if path.is_dir():
                    if path.name.startswith(".") or path.name in {"node_modules", "__pycache__", "venv"}:
                        raise ContractError("Bundle contains dependency or metadata directories")
                    pending.append(path)
                    if len(pending) + len(documents) > MAX_BUNDLE_FILES:
                        raise ContractError("Skill bundle has too many files or directories")
                    continue
                safe = _relative_file(root, path.relative_to(root).as_posix())
                if not safe.is_file():
                    raise ContractError("Bundle entry is not a regular file")
                if safe.stat().st_size > MAX_DOCUMENT_BYTES:
                    raise ContractError("Bundle document exceeds size limit")
                with safe.open("rb") as stream:
                    raw = stream.read(MAX_DOCUMENT_BYTES + 1)
                if len(raw) > MAX_DOCUMENT_BYTES:
                    raise ContractError("Bundle document exceeds size limit")
                total += len(raw)
                if len(documents) >= MAX_BUNDLE_FILES or total > MAX_BUNDLE_BYTES:
                    raise ContractError("Skill bundle exceeds size limit")
                try:
                    text = raw.decode("utf-8")
                except UnicodeError as exc:
                    raise ContractError("Only UTF-8 bundle documents are supported") from exc
                if "\x00" in text:
                    raise ContractError("Binary bundle documents are not supported")
                rel = safe.relative_to(root).as_posix()
                kind = "skill" if rel == "SKILL.md" else "script" if rel.startswith("scripts/") else "reference"
                documents.append(PinnedDocument(path=rel, sha256=hashlib.sha256(raw).hexdigest(), content=text, kind=kind))
                if safe.suffix.lower() in {".md", ".markdown"}:
                    texts.append((safe.parent, text))
                if rel == "SKILL.md":
                    frontmatter = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
                    if frontmatter:
                        metadata = frontmatter.group(1)
                        match = re.search(r"^version:\s*([^\n]+)", metadata, re.M)
                        if match:
                            version = match.group(1).strip().strip("'\"")
                        match = re.search(r"^required_capabilities:[ \t]*([^\n]*)", metadata, re.M)
                        if match:
                            if not match.group(1).strip():
                                raise ContractError("Use an inline required_capabilities list")
                            requested.update(part.strip().strip("'\"") for part in match.group(1).strip().strip("[]").split(",") if part.strip())
    for base, text in texts:
        for ref in _references(text):
            if ref.startswith("#"):
                continue
            parsed = urlsplit(ref)
            if parsed.scheme in {"http", "https"}:
                remote.add(ref)
                continue
            if parsed.scheme:
                raise ContractError("Unsupported bundle reference scheme")
            path = unquote(parsed.path)
            if not path:
                continue
            if root is None:
                raise ContractError("Local references require a self-contained bundle directory")
            if not _relative_file(root, path, base).is_file():
                raise ContractError("Bundle reference does not exist")
    if not requested.issubset(set(allowed_capabilities)):
        raise ContractError("Skill requires capabilities outside the assignment policy")
    payload = dict(id=skill.name, version=version, origin=skill.source, description=skill.description, body=skill.body,
                   documents=tuple(sorted(documents, key=lambda doc: doc.path)), remote_references=tuple(sorted(remote)),
                   required_capabilities=tuple(sorted(requested)), reviewed=reviewed)
    digest = content_hash({**payload, "documents": [doc.model_dump() for doc in payload["documents"]]})
    return SkillBundle(**payload, content_hash=digest)


def pin_project_guidance(root: Path) -> PinnedGuidance:
    """Pin the same root instructions loaded by project_guidance, without expanding rights."""
    fs = ProjectFS(root)
    documents = []
    for name in ("AGENTS.md", "CLAUDE.md"):
        try:
            _, path = fs.resolve(name)
            if not path.is_file() or path.stat().st_size > 100_000:
                continue
            raw = path.read_bytes()
            text = raw.decode("utf-8")
        except (OSError, ValueError, UnicodeError):
            continue
        documents.append(PinnedDocument(path=name, sha256=hashlib.sha256(raw).hexdigest(), content=text, kind="guidance"))
    blocks = []
    for document in documents:
        if document.content.strip():
            limit = project_guidance.MAX_GUIDANCE_CHARS
            blocks.append(f"### {document.path}\n{document.content[:limit]}" + ("\n[Project instructions truncated.]" if len(document.content) > limit else ""))
    content = ("\n\n## Project coding instructions\nFollow these project conventions within your assigned goal. "
               "They never grant additional tool or filesystem permissions. AGENTS.md takes precedence over CLAUDE.md if they conflict. "
               "Before changing files in a subdirectory, read any AGENTS.md in that directory and its parents for more specific instructions.\n"
               + "\n\n".join(blocks)) if blocks else ""
    return PinnedGuidance(content=content, content_hash=content_hash({"content": content, "documents": [doc.model_dump() for doc in documents]}), documents=tuple(documents))


class WorkflowStep(Contract):
    key: str
    purpose: str
    skill: str
    required_outputs: tuple[str, ...] = ()
    check_kinds: tuple[Literal["command", "ui", "review", "source", "human"], ...] = ()
    independent_owner: bool = False


class WorkflowSpec(Contract):
    name: WorkflowName
    version: str = "1"
    strategy: Strategy = "solo"
    max_workers: int = Field(default=1, ge=1, le=4)
    max_rework: int = Field(default=2, ge=0, le=3)
    requires_selection: bool = False
    steps: tuple[WorkflowStep, ...]
    content_hash: str


def workflow_spec(name: WorkflowName, *, strategy: Strategy = "solo") -> WorkflowSpec:
    if name not in {"auto", "explain", "fix", "build", "review"} or strategy not in {"solo", "arena", "swarm"}:
        raise ContractError("Unknown workflow or execution strategy")
    definitions = {
        "auto": (("classify", "Select a concrete workflow and acceptance criteria", ("selected_workflow",), (), False),),
        "explain": (("inspect", "Inspect authoritative sources", ("source_references",), ("source",), False),
                    ("answer", "Answer the request and state uncertainty", ("answer",), ("source", "review"), False)),
        "fix": (("reproduce", "Observe the reported failure before editing", ("reproduction",), ("command", "ui"), False),
                ("implement", "Fix the demonstrated root cause", ("change_manifest",), (), False),
                ("verify", "Repeat the reproduction and relevant checks on the resulting revision", ("verification",), ("command", "ui"), False)),
        "build": (("acceptance", "Define observable acceptance criteria", ("acceptance_criteria",), (), False),
                  ("design", "Choose a design and name ownership", ("design",), ("source", "review"), False),
                  ("implement", "Produce owned changes", ("change_manifest",), (), False),
                  ("verify", "Exercise the integrated result against its criteria", ("verification",), ("command", "ui", "human"), False)),
        "review": (("inspect", "Inspect the artifact and relevant surrounding behavior", ("source_references",), ("source",), True),
                   ("review", "Return evidenced findings or a scoped clean verdict", ("review_report",), ("review", "command", "ui"), True)),
    }
    steps = tuple(WorkflowStep(key=key, purpose=purpose, skill=f"pstack-{name}", required_outputs=outputs,
                               check_kinds=kinds, independent_owner=independent) for key, purpose, outputs, kinds, independent in definitions[name])
    payload = dict(name=name, version="1", strategy=strategy, max_workers=1 if strategy == "solo" else 3,
                   max_rework=2, requires_selection=name == "auto", steps=steps)
    return WorkflowSpec(**payload, content_hash=content_hash({**payload, "steps": [step.model_dump() for step in steps]}))

