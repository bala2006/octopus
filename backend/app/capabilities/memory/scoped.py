"""Scoped memory for authenticated owners and runtime-resolved agents.

The service enforces cooperative application ACLs. An unrestricted host shell can bypass them.
Pass the authenticated user and runtime agent identity, never an agent ID claimed by prompt text.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.repositories import AgentMemoryRepository, AgentRepository, CompanyRepository, MemoryRepository, RunRepository
from app.db.session import SessionFactory
from app.models import Message
from app.models.scoped_memory import MemoryGroup, MemoryGroupMember, MemoryHead, MemoryRecord

Scope = Literal["agent", "group", "chat", "project"]
Classification = Literal["proposed", "verified", "superseded", "deleted"]


class MemoryDenied(PermissionError):
    pass


class MemoryConflict(ValueError):
    pass


@dataclass(frozen=True)
class Actor:
    user_id: str
    company_id: str
    agent_id: str | None = None


@dataclass(frozen=True)
class Target:
    scope: Scope
    scope_id: str
    run_id: str | None = None


@dataclass(frozen=True)
class SourceRef:
    kind: Literal["memory", "message", "artifact"]
    id: str


@dataclass(frozen=True)
class MemoryView:
    id: str
    key: str
    version: int
    scope: str
    content: str
    classification: str
    pinned: bool
    source_refs: tuple[SourceRef, ...]
    scope_id: str = ""
    run_id: str | None = None


async def _identity(db: AsyncSession, actor: Actor) -> None:
    company = await CompanyRepository(db).get(actor.company_id)
    if not company or company.user_id != actor.user_id:
        raise MemoryDenied("Company does not belong to this user")
    if actor.agent_id:
        agent = await AgentRepository(db).get(actor.agent_id)
        if not agent or agent.company_id != company.id or not agent.active:
            raise MemoryDenied("Agent is not active in this company")


async def _audience(db: AsyncSession, company_id: str, target: Target) -> set[str]:
    if target.run_id:
        run = await RunRepository(db).get(target.run_id)
        if not run or run.company_id != company_id:
            raise MemoryDenied("Run belongs to another company")
    if target.scope == "agent":
        agent = await AgentRepository(db).get(target.scope_id)
        if not agent or agent.company_id != company_id:
            raise MemoryDenied("Agent memory belongs to another company")
        return {agent.id}
    if target.scope == "group":
        group = await MemoryRepository(db).group(target.scope_id)
        if not group or group.company_id != company_id:
            raise MemoryDenied("Unknown memory group")
        return set(await MemoryRepository(db).group_member_ids(group.id)) if group.active else set()
    if target.scope == "chat":
        run = await RunRepository(db).get(target.scope_id)
        if not run or run.company_id != company_id or target.run_id not in (None, run.id):
            raise MemoryDenied("Chat memory must bind to its run")
        assigned = {a["id"] for a in (run.snapshot_json or {}).get("agents", []) if a.get("active", True)}
        active = set(await AgentRepository(db).active_ids_in_company(company_id))
        return assigned & active
    elif target.scope != "project" or target.scope_id != company_id:
        raise MemoryDenied("Invalid project memory target")
    return await AgentRepository(db).ids_in_company(company_id)


async def _access(db: AsyncSession, actor: Actor, target: Target) -> set[str]:
    audience = await _audience(db, actor.company_id, target)
    if actor.agent_id and actor.agent_id not in audience:
        raise MemoryDenied("Memory is not shared with this agent")
    return audience


async def _sources(db: AsyncSession, actor: Actor, target: Target, refs: tuple[SourceRef, ...], *, share: bool) -> None:
    destination = await _access(db, actor, target)
    for ref in refs:
        if ref.kind == "memory":
            record = await MemoryRepository(db).record(ref.id)
            if not record or record.company_id != actor.company_id:
                raise MemoryDenied("Unknown memory source")
            head = await MemoryRepository(db).head(record.head_id)
            assert head
            source_target = Target(head.scope, head.scope_id, record.run_id)
            audience = await _access(db, actor, source_target)
            source_run = record.run_id or (head.scope_id if head.scope == "chat" else None)
        elif ref.kind in ("message", "artifact"):
            item = await MemoryRepository(db).source(ref.kind, ref.id)
            run = await RunRepository(db).get(item.run_id) if item and item.run_id else None
            if not run or run.company_id != actor.company_id:
                raise MemoryDenied("Source is outside this company")
            source_run = run.id
            audience = await _audience(db, actor.company_id, Target("chat", run.id))
            if isinstance(item, Message) and item.to_agent_id:
                audience = {item.to_agent_id}
                if item.from_agent_id:
                    audience.add(item.from_agent_id)
            if actor.agent_id and actor.agent_id not in audience:
                raise MemoryDenied("Source is not shared with this agent")
        else:
            raise ValueError("Unsupported source reference")
        destination_run = target.run_id or (target.scope_id if target.scope == "chat" else None)
        if not share and (not destination.issubset(audience) or source_run and source_run != destination_run):
            raise MemoryDenied("Source scope cannot be widened without owner sharing")


def _target(head: MemoryHead, record: MemoryRecord) -> Target:
    return Target(head.scope, head.scope_id, record.run_id)


async def _write(sf: SessionFactory, actor: Actor, target: Target, key: str, content: str, *, expected_version: int,
                 refs: tuple[SourceRef, ...], classification: Classification, pinned: bool, share: bool,
                 import_key: str | None = None) -> MemoryRecord:
    if not key.strip() or len(key) > 200 or len(content) > 50000 or expected_version < 0 or len(refs) > 100:
        raise ValueError("Invalid memory key, content, version, or sources")
    if classification not in ("proposed", "verified", "superseded", "deleted"):
        raise ValueError("Invalid classification")
    async with sf() as db:
        try:
            async with db.begin():
                await _identity(db, actor)
                await _access(db, actor, target)
                if import_key:
                    existing = await MemoryRepository(db).record_by_import_key(import_key)
                    if existing:
                        original_head = await MemoryRepository(db).head(existing.head_id)
                        if (existing.company_id != actor.company_id or not original_head or original_head.scope != target.scope
                                or original_head.scope_id != target.scope_id or original_head.key != key):
                            raise MemoryConflict("Import identity already belongs to another memory")
                        return existing
                await _sources(db, actor, target, refs, share=share)
                head = await MemoryRepository(db).head_by_identity(actor.company_id, target.scope, target.scope_id, key)
                if not head:
                    if expected_version:
                        raise MemoryConflict("Memory version changed")
                    head = MemoryHead(company_id=actor.company_id, scope=target.scope, scope_id=target.scope_id, key=key, version=0)
                    db.add(head)
                    await db.flush()
                elif actor.agent_id:
                    current = await MemoryRepository(db).current_record(head.id, head.version)
                    if current and (current.pinned or current.classification != "proposed"):
                        raise MemoryDenied("Agents cannot replace accepted memory; propose a separate note")
                rowcount = await MemoryRepository(db).bump_head_version(head.id, expected_version)
                if rowcount != 1:
                    raise MemoryConflict("Memory version changed")
                record = MemoryRecord(head_id=head.id, company_id=actor.company_id,
                    run_id=target.run_id or (target.scope_id if target.scope == "chat" else None),
                    version=expected_version + 1, content=content, classification=classification,
                    source_refs=[{"kind": ref.kind, "id": ref.id} for ref in refs],
                    author_agent_id=actor.agent_id, pinned=pinned, import_key=import_key)
                db.add(record)
                await db.flush()
            return record
        except IntegrityError as exc:
            raise MemoryConflict("Concurrent memory update or import") from exc


async def put(sf: SessionFactory, actor: Actor, target: Target, key: str, content: str, *, expected_version: int,
              refs: tuple[SourceRef, ...] = ()) -> MemoryRecord:
    """Agents can propose facts to scopes they belong to. This never promotes facts or expands source access."""
    if not actor.agent_id:
        raise MemoryDenied("Use the authenticated owner operation")
    return await _write(sf, actor, target, key, content, expected_version=expected_version, refs=refs,
                        classification="proposed", pinned=False, share=False)


async def owner_put(sf: SessionFactory, actor: Actor, target: Target, key: str, content: str, *, expected_version: int,
                    refs: tuple[SourceRef, ...] = (), classification: Classification = "verified", pinned: bool = False,
                    share_sources: bool = False, import_key: str | None = None) -> MemoryRecord:
    """Owner-only classification/pinning and explicit source sharing. Call only from an authenticated owner action."""
    if actor.agent_id:
        raise MemoryDenied("Only the owner can promote, pin, delete, or share sources")
    return await _write(sf, actor, target, key, content, expected_version=expected_version, refs=refs,
                        classification=classification, pinned=pinned, share=share_sources, import_key=import_key)


async def owner_group(sf: SessionFactory, actor: Actor, name: str, agent_ids: list[str]) -> str:
    if actor.agent_id:
        raise MemoryDenied("Only the owner can create sharing groups")
    if not name.strip() or len(name) > 200 or not agent_ids:
        raise ValueError("A named group needs members")
    async with sf() as db, db.begin():
        await _identity(db, actor)
        for agent_id in set(agent_ids):
            await _audience(db, actor.company_id, Target("agent", agent_id))
        group = MemoryGroup(company_id=actor.company_id, name=name)
        db.add(group)
        await db.flush()
        db.add_all(MemoryGroupMember(group_id=group.id, agent_id=aid) for aid in set(agent_ids))
        return group.id


async def owner_update_group(sf: SessionFactory, actor: Actor, group_id: str, *, name: str | None = None,
                             members: list[str] | None = None, active: bool | None = None) -> None:
    """Changing membership is an explicit owner sharing action. Archiving retains historical source records."""
    if actor.agent_id:
        raise MemoryDenied("Only the owner can change sharing groups")
    if name is not None and (not name.strip() or len(name) > 200):
        raise ValueError("Invalid group name")
    async with sf() as db, db.begin():
        await _identity(db, actor)
        group = await MemoryRepository(db).group(group_id)
        if not group or group.company_id != actor.company_id:
            raise MemoryDenied("Unknown memory group")
        if members is not None:
            for aid in set(members):
                await _audience(db, actor.company_id, Target("agent", aid))
            await MemoryRepository(db).replace_group_members(group.id, members)
        if name is not None:
            group.name = name
        if active is not None:
            group.active = active


async def runtime_context(sf: SessionFactory, user_id: str, company_id: str, agent_id: str, run_id: str) -> str:
    records = await context(sf, Actor(user_id, company_id, agent_id), run_id=run_id, include_proposed=True,
                            require_complete_pins=True)
    return "\n\n".join(f"[memory:{record.id} v{record.version}; {record.scope}; "
        f"{'pinned constraint' if record.pinned else record.classification}] {record.key}\n{record.content}\n"
        + "Sources: " + ", ".join(f"{ref.kind}:{ref.id}" for ref in record.source_refs) for record in records)


_SECRET = re.compile(r"(?im)\b(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+")


def _view(record: MemoryRecord, head: MemoryHead, *, redact: bool) -> MemoryView:
    content = _SECRET.sub(lambda m: m.group(1) + "=[REDACTED]", record.content) if redact else record.content
    return MemoryView(record.id, head.key, record.version, head.scope, content, record.classification, record.pinned,
                      tuple(SourceRef(ref["kind"], ref["id"]) for ref in record.source_refs), head.scope_id, record.run_id)


async def get(sf: SessionFactory, actor: Actor, record_id: str, *, redact: bool = True) -> MemoryView:
    """Exact version lookup, including superseded originals. Tombstone content is not returned."""
    async with sf() as db:
        await _identity(db, actor)
        record = await MemoryRepository(db).record(record_id)
        if not record or record.company_id != actor.company_id:
            raise MemoryDenied("Unknown memory reference")
        head = await MemoryRepository(db).head(record.head_id)
        assert head
        await _access(db, actor, _target(head, record))
        if record.classification == "deleted":
            raise MemoryDenied("Memory was deleted")
        return _view(record, head, redact=redact or bool(actor.agent_id))


async def context(sf: SessionFactory, actor: Actor, *, run_id: str | None = None, include_proposed: bool = False,
                  limit: int = 40, max_chars: int = 16000, query: str = "",
                  require_complete_pins: bool = False) -> list[MemoryView]:
    """Latest authorized versions only; originals stay available by exact reference. Pinned constraints come first."""
    if not 1 <= limit <= 200 or not 200 <= max_chars <= 100000 or len(query) > 200:
        raise ValueError("Invalid memory limit")
    async with sf() as db:
        await _identity(db, actor)
        if run_id:
            await _audience(db, actor.company_id, Target("chat", run_id))
        rows = await MemoryRepository(db).records_with_heads(actor.company_id)
        out = []
        remaining = max_chars
        overflow = False
        for record, head in rows:
            if record.classification not in (("verified", "proposed") if include_proposed else ("verified",)):
                continue
            if record.run_id and record.run_id != run_id:
                continue
            try:
                await _access(db, actor, _target(head, record))
            except MemoryDenied:
                continue
            view = _view(record, head, redact=True)
            if query and query.casefold() not in (view.key + "\n" + view.content).casefold():
                continue
            if require_complete_pins and view.pinned and (overflow or len(view.content) > remaining):
                raise MemoryConflict("Pinned constraints exceed the context budget. The owner must reduce or unpin constraints before execution.")
            if overflow:
                continue
            if len(view.content) > remaining:
                marker = f"\n[Truncated; retrieve memory:{view.id} for the original]"
                view = replace(view, content=view.content[:max(0, remaining - len(marker))] + marker)
            out.append(view)
            remaining -= len(view.content)
            if len(out) == limit or remaining < 200:
                if not require_complete_pins:
                    break
                overflow = True
        return out


async def import_legacy(sf: SessionFactory, owner: Actor, root: Path) -> int:
    """Idempotently import existing notes as proposals. Root must be the server-resolved project root."""
    if owner.agent_id:
        raise MemoryDenied("Only the owner can import memory")
    async with sf() as db:
        await _identity(db, owner)
        notes = await AgentMemoryRepository(db).notes_for_company(owner.company_id)
    entries = [(Target("agent", note.agent_id), note.key, note.value, f"legacy-agent:{note.id}") for note in notes]
    path = root.resolve() / ".octopus" / "memory.json"
    if path.exists():
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or path.stat().st_size > 2_000_000:
            raise ValueError("Unsafe legacy memory file")
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, note in data.get("notes", {}).items():
            if isinstance(note, dict) and isinstance(note.get("value"), str):
                digest = hashlib.sha256(key.encode()).hexdigest()
                entries.append((Target("project", owner.company_id), key, note["value"], f"legacy-project:{owner.company_id}:{digest}"))
        for retro in data.get("runs", []):
            if isinstance(retro, dict) and isinstance(retro.get("run_id"), str):
                async with sf() as db:
                    run = await RunRepository(db).get(retro["run_id"])
                if run and run.company_id == owner.company_id:
                    entries.append((Target("chat", run.id), "legacy-retrospective", json.dumps(retro, ensure_ascii=False), f"legacy-run:{run.id}"))
    imported = 0
    for target, key, content, import_key in entries:
        async with sf() as db:
            exists = await MemoryRepository(db).import_key_exists(import_key)
            head = await MemoryRepository(db).head_by_identity(owner.company_id, target.scope, target.scope_id, key)
        if exists or head:
            continue
        await owner_put(sf, owner, target, key, content, expected_version=0, classification="proposed", import_key=import_key)
        imported += 1
    return imported
