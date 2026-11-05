"""File actions: read, list, search, create folder, move, write and edit. Every write goes through commit_file: permission gate, per-path lock, version history, events and the automatic check."""

from __future__ import annotations

import asyncio
from sqlalchemy import select
from typing import TYPE_CHECKING

from app.core.config import PROJECT_DIRNAME
from app.core.logging import get_logger
from app.db.base import new_id, utcnow
from app.models import Artifact
from app.orchestrator import actions as A
from app.orchestrator.context import TOOL_RESULT_CHARS, AgentSpec
from app.orchestrator.execution import ACTIVE_ATTEMPT
from app.orchestrator.permissions import is_dangerous_edit
from app.tools.workspace import WorkspaceError

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime

log = get_logger("orchestrator")


READ_PAGE_CHARS = TOOL_RESULT_CHARS - 500  # one read_file page fits in a tool result with room for its header


def apply_edits(text: str, edits: list[A.Edit]) -> tuple[str, int]:
    """Apply exact-text edits in order. Returns (new text, 1-based line of the first change). Raises ValueError (nothing
    applied) when an old_string is missing or ambiguous, with enough detail for the model to fix its call."""
    first: int | None = None
    for i, e in enumerate(edits, 1):
        n = text.count(e.old_string)
        label = f"edit {i}" if len(edits) > 1 else "old_string"
        if n == 0 and not e.replace_all and (loose := loose_match(text, e.old_string, e.new_string)):
            start, end, new = loose  # same lines, different indentation / trailing whitespace: apply, re-indented
            line = text.count("\n", 0, start) + 1
            first = line if first is None else min(first, line)
            text = text[:start] + new + text[end:]
            continue
        if n == 0:
            stripped = e.old_string.strip()
            hint = (" (it does appear with different surrounding whitespace or indentation)" if stripped and stripped in text
                    else " (read_file to get the exact current text)")
            near = closest_region(text, e.old_string)
            raise ValueError(f"{label}: old_string not found{hint}"
                             + (f". The current text where it probably belongs (line numbers are not part of "
                                f"the file):\n{near}" if near else ""))
        if n > 1 and not e.replace_all:
            raise ValueError(f"{label}: old_string occurs {n} times; include more surrounding lines to make it unique, "
                             "or set replace_all")
        pos = text.index(e.old_string)
        line = text.count("\n", 0, pos) + 1
        first = line if first is None else min(first, line)
        text = text.replace(e.old_string, e.new_string) if e.replace_all else text.replace(e.old_string, e.new_string, 1)
    return text, first or 1


def loose_match(text: str, old: str, new: str) -> tuple[int, int, str] | None:
    """Find ``old`` in ``text`` when it differs only by a uniform indentation shift and trailing whitespace (the most
    common reason an edit from memory misses). Returns (start, end, new re-indented by the same shift), only when that
    match is unique; otherwise None. Edits that differ in anything else still fail with a hint."""
    o_lines = old.strip("\n").split("\n")
    if not old.strip() or len(o_lines) > 400:
        return None
    lines = text.split("\n")
    offsets = [0]
    for ln in lines:
        offsets.append(offsets[-1] + len(ln) + 1)
    nonblank = [ln for ln in o_lines if ln.strip()]
    o_ind = min(len(ln) - len(ln.lstrip()) for ln in nonblank)
    o_core = [ln[o_ind:].rstrip() if ln.strip() else "" for ln in o_lines]
    hits: list[tuple[int, str]] = []
    for i in range(len(lines) - len(o_lines) + 1):
        win = lines[i:i + len(o_lines)]
        nb = [ln for ln in win if ln.strip()]
        if len(nb) != len(nonblank):
            continue
        ind = min(len(ln) - len(ln.lstrip()) for ln in nb)
        prefix = nb[0][:ind]
        if any(ln.strip() and not ln.startswith(prefix) for ln in win):
            continue
        if [ln[ind:].rstrip() if ln.strip() else "" for ln in win] == o_core:
            hits.append((i, prefix))
            if len(hits) > 1:
                return None
    if len(hits) != 1:
        return None
    i, prefix = hits[0]
    n_lines = new.strip("\n").split("\n") if new.strip() else []

    def reindent(ln: str) -> str:  # keep each new line's indentation relative to the old text, on the file's base indent
        lead = len(ln) - len(ln.lstrip())
        if lead >= o_ind:
            return prefix + ln[o_ind:]
        return prefix[:max(0, len(prefix) - (o_ind - lead))] + ln.lstrip()

    new_text = "\n".join(reindent(ln) if ln.strip() else "" for ln in n_lines)
    start, end = offsets[i], offsets[i + len(o_lines)] - 1
    return start, end, new_text


def closest_region(text: str, old: str, span: int = 8) -> str:
    """Where a missed edit most likely applies: the current lines around the first distinctive line of ``old_string``.

    A missed old_string usually comes from editing from memory (an earlier read was shortened in a long tool loop, or a
    teammate changed the file). Showing the real text there lets the model retry at once instead of re-reading a big file."""
    lines = text.split("\n")
    wanted = sorted({ln.strip() for ln in old.split("\n") if len(ln.strip()) >= 12}, key=len, reverse=True)
    for w in wanted[:6]:
        hits = [i for i, ln in enumerate(lines) if w in ln]
        if len(hits) == 1:
            return numbered_excerpt(text, hits[0] + 1, before=3, after=span + old.count("\n"))[:4000]
    return ""


def numbered_excerpt(text: str, line: int, before: int = 3, after: int = 12) -> str:
    lines = text.split("\n")
    lo, hi = max(1, line - before), min(len(lines), line + after)
    return "\n".join(f"{n:>5}  {lines[n - 1]}" for n in range(lo, hi + 1))


# code an agent can run or open: finishing with changes to these that nothing exercised is sent back once to verify
VERIFIABLE_EXT = {"py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "html", "htm", "go", "rs", "java", "rb", "php", "sh"}  # tool rounds left in a turn at which the agent is told to wrap up


async def act_search_project(rt: RunRuntime, agent: AgentSpec, a: A.SearchProject) -> None:
    cid = await rt._tool_event(agent, "search_project", {"query": a.query, "path_prefix": a.path_prefix})
    await rt.set_agent_status(agent.id, "reading", f"Searching for {a.query[:40]}…")
    try:
        hits, total, n = await asyncio.to_thread(
            rt.fs_for(agent.id).search, a.query, regex=a.regex, prefix=a.path_prefix, max_results=a.max_results
        )
        out = (f"{total} match{'es' if total != 1 else ''} in {n} files" + (f" (showing {len(hits)})" if total > len(hits) else "")
               + (":\n" + "\n".join(hits) if hits else "."))
        ok = True
    except WorkspaceError as exc:
        out, ok = str(exc), False
    rt.observe(agent.id, {"tool": "search_project", "ok": ok, "content": out})
    await rt._tool_result(agent, cid, "search_project", ok, out[:2000])


async def act_write_file(rt: RunRuntime, agent: AgentSpec, a: A.WriteFile) -> None:
    cid = await rt._tool_event(agent, "write_file", {"path": a.path, "bytes": len(a.content), "note": a.note})
    fs = rt.fs_for(agent.id)
    try:
        rel, _ = fs.resolve(a.path)
        old = fs.current(rel)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, "write_file", f"write_file failed: {exc}")
        return
    appending = a.mode == "append"
    content = (old or "") + a.content if appending else a.content
    await rt.commit_file(agent, cid, "write_file", rel, old, content, a.note, appending=appending, partial=a.partial)


async def act_edit_file(rt: RunRuntime, agent: AgentSpec, a: A.EditFile) -> None:
    """Targeted change: each edit replaces exact existing text. All edits apply, or none do."""
    cid = await rt._tool_event(agent, "edit_file", {"path": a.path, "edits": len(a.edits), "note": a.note})
    fs = rt.fs_for(agent.id)
    try:
        rel, _ = fs.resolve(a.path)
        old = fs.current(rel)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, "edit_file", f"edit_file failed: {exc}")
        return
    if old is None:
        await rt.deny(agent, cid, "edit_file", f"edit_file failed: {rel} does not exist (create it with write_file)")
        return
    try:
        content, first_line = apply_edits(old, a.edits)
    except ValueError as exc:
        await rt.deny(agent, cid, "edit_file", f"edit_file failed on {rel}: {exc}. The file was not changed.")
        return
    await rt.commit_file(agent, cid, "edit_file", rel, old, content, a.note, context_line=first_line)


async def commit_file(rt: RunRuntime, agent: AgentSpec, cid: str, tool: str, rel: str, old: str | None, content: str, note: str, *,
                      appending: bool = False, partial: bool = False, context_line: int | None = None) -> None:
    """Permission gate, write, version history, events and the agent's confirmation, shared by write_file / edit_file.
        One writer per path at a time (parallel delegations may touch the same file)."""
    async with rt.file_lock(rel):
        await rt._commit_file(agent, cid, tool, rel, old, content, note, appending=appending, partial=partial,
                                context_line=context_line)


async def _commit_file(rt: RunRuntime, agent: AgentSpec, cid: str, tool: str, rel: str, old: str | None, content: str, note: str, *,
                       appending: bool = False, partial: bool = False, context_line: int | None = None) -> None:
    fs = rt.fs_for(agent.id)
    if rt.engineering_workflow == "fix" and rt.budget.verify_before_finish and not any(
        r["revision"] == rt.plan_revision and r["step"] == "reproduce" for r in rt.engineering_checkpoints):
        await rt.deny(agent, cid, tool, "Record the reproduction checkpoint before editing; use unavailable with the reason when reproduction cannot run.")
        return
    if tool == "edit_file" or appending:  # the file may have changed while waiting for the lock: re-apply on current content
        current = fs.current(rel)
        if current != old:
            await rt.deny(agent, cid, tool, f"{tool} failed: {rel} was changed by a teammate meanwhile; read it again")
            return
    if old == content:
        rt.notice(agent.id, f"{rel} unchanged ({'nothing to append' if appending else 'identical content'}).")
        await rt._tool_result(agent, cid, tool, True, "unchanged")
        return
    action = "edit" if tool == "edit_file" else "append to" if appending and old is not None else ("create" if old is None else "modify")
    ok, reason = await rt.guard(agent, "write_file", f"{agent.name} wants to {action} {rel}",
                                  content, {"path": rel, "old": (old or "")[:20000], "new": content[:20000], "note": note},
                                  dangerous=is_dangerous_edit(rel))
    if not ok:
        await rt.deny(agent, cid, tool, reason)
        return
    await rt.set_agent_status(agent.id, "writing", f"{'Editing' if tool == 'edit_file' else 'Appending to' if appending else 'Saving'} {rel}…")
    from app.orchestrator.runtime_store import mutation_lock
    async with mutation_lock(rt.run_id):
        context = ACTIVE_ATTEMPT.get()
        await rt.execution.assert_durable_revision(context.assignment.revision if context else rt.plan_revision)
        await rt._write_checked_file(agent, cid, tool, rel, old, content, note,
                                       appending=appending, partial=partial, context_line=context_line)


async def _write_checked_file(rt: RunRuntime, agent: AgentSpec, cid: str, tool: str, rel: str, old: str | None, content: str,
                              note: str, *, appending: bool, partial: bool,
                              context_line: int | None) -> None:
    fs = rt.fs_for(agent.id)
    try:
        fs.write(rel, content)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, tool, f"{tool} failed: {exc}")
        return
    context = ACTIVE_ATTEMPT.get()
    if context and context.workspace is not None and not context.integrated:
        previous = context.pending_artifacts.get(rel)
        context.pending_artifacts[rel] = {"old": previous["old"] if previous else old, "content": content, "note": note}
        rt.notice(agent.id, f"Staged {rel}; integration and canonical verification are pending.", activate=partial)
        await rt._tool_result(agent, cid, tool, True, f"Staged {rel}; not yet applied to the project")
        return
    await rt.publish_file(agent, rel, old, content, note, tool=tool, cid=cid,
                            appending=appending, partial=partial, context_line=context_line)


async def publish_file(rt: RunRuntime, agent: AgentSpec, rel: str, old: str | None, content: str, note: str, *,
                       tool: str = "write_file", cid: str | None = None,
                       appending: bool = False, partial: bool = False, context_line: int | None = None,
                       deleted: bool = False) -> None:
    rt.mark_progress()
    if not rel.startswith(PROJECT_DIRNAME + "/"):  # a deliverable (not a working doc)
        rt.mark_work(agent.id)
        if rel.rsplit(".", 1)[-1].lower() in VERIFIABLE_EXT:
            rt.unverified[rel] = rt.turn_no
        if rt.first_deliverable_turn is None:
            rt.first_deliverable_turn = rt.turn_no
    prev = rt.artifacts.get(rel)
    if old is not None and prev is None and not await rt.written_by_octopus(rel):
        # never silently overwrite the user's own file (whatever the approval mode): say so, loudly
        await rt.emit("error", {"kind": "warning", "agent_id": agent.id, "path": rel, "message": (
            f"{agent.name} changed {rel}, a file that existed before Octopus touched it. "
            "The original is kept: revert it from Artifacts → Run changes.")})
    version = (prev or {}).get("version", 0) + 1
    art = Artifact(id=new_id(), run_id=rt.run_id, path=rel, content=content, version=version, author_agent_id=agent.id,
                   change_note=note[:1000], deleted=deleted, created_at=utcnow(),
                   previous_content=old if prev is None else None)
    async with rt.db() as db:
        db.add(art)
        await db.commit()
    added = 0 if deleted else content.count("\n") + 1
    removed = (old or "").count("\n") + 1 if old else 0
    rt.artifacts[rel] = {"version": version, "author": agent.id, "note": note, "deleted": deleted}
    await rt.emit("artifact_updated", {"artifact": {"id": art.id, "run_id": rt.run_id, "path": rel, "version": version,
                                                      "author_agent_id": agent.id, "change_note": note, "size": len(content),
                                                      "deleted": deleted, "created": old is None and not deleted, "appended": appending,
                                                      "edited": tool == "edit_file", "lines": added, "previous_lines": removed,
                                                      "created_at": art.created_at.isoformat()}})
    verb = "Deleted" if deleted else ("Created" if old is None else "Edited" if tool == "edit_file" else "Appended to" if appending else "Updated")
    rt.log(agent.id, f"{verb.lower()} {rel} (v{version})" + (f": {note[:200]}" if note else ""))
    await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                            content=f"{verb} `{rel}` (v{version})" + (f": {note}" if note else ""),
                            meta={"path": rel, "version": version, "artifact_id": art.id, "deleted": deleted}, deliver=False)
    size_note = (f" It now has {added} lines; append the next part now (mode \"append\")." if partial
                 else f" It now has {added} lines." if appending else "")
    if context_line is not None:  # show the edited region so the agent can check the result without re-reading the file
        size_note = f" Lines around the change:\n{numbered_excerpt(content, context_line)}"
    if deleted:
        rt.broken_files.pop(rel, None)
    problem = None if partial or deleted else await rt.check_written(rel, content)
    rt.notice(agent.id, f"{verb} {rel} (v{version}).{size_note}"
                + (f"\n\nAUTOMATIC CHECK FAILED for {rel}:\n{problem}\nFix this before anything else." if problem else ""),
                activate=partial or bool(problem))
    if cid is not None:
        await rt._tool_result(agent, cid, tool, True, f"{rel} v{version}{' (appended)' if appending else ''}")


async def check_written(rt: RunRuntime, rel: str, content: str) -> str | None:
    """Syntax-check a file right after it was written (services/checks.py); remembered until a later write fixes it."""
    from app.services.checks import check_file

    try:
        problem = await check_file(rel, content)
    except Exception as exc:  # noqa: BLE001 - a checker bug must never fail the write
        log.warning("file_check_failed", path=rel, error=str(exc)[:200])
        return None
    if problem:
        rt.broken_files[rel] = problem[:1500]
    else:
        rt.broken_files.pop(rel, None)
    return problem


async def written_by_octopus(rt: RunRuntime, rel: str) -> bool:
    """Did any run in this project ever write ``rel``? (Otherwise it is the user's own file.)"""
    async with rt.db() as db:
        return (await db.execute(select(Artifact.id).where(Artifact.path == rel).limit(1))).first() is not None


async def act_create_folder(rt: RunRuntime, agent: AgentSpec, a: A.CreateFolder) -> None:
    cid = await rt._tool_event(agent, "create_folder", {"path": a.path})
    fs = rt.fs_for(agent.id)
    try:
        rel, real = fs.resolve(a.path)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, "create_folder", f"create_folder failed: {exc}")
        return
    if real.is_dir():
        rt.notice(agent.id, f"Folder {rel}/ already exists.")
        await rt._tool_result(agent, cid, "create_folder", True, "exists")
        return
    ok, reason = await rt.guard(agent, "write_file", f"{agent.name} wants to create the folder {rel}/", f"mkdir {rel}",
                                  {"path": rel + "/", "old": "", "new": "", "note": a.note or "new folder"},
                                  dangerous=is_dangerous_edit(rel))
    if not ok:
        await rt.deny(agent, cid, "create_folder", reason)
        return
    try:
        from app.orchestrator.runtime_store import mutation_lock
        async with mutation_lock(rt.run_id):
            context = ACTIVE_ATTEMPT.get()
            await rt.execution.assert_durable_revision(context.assignment.revision if context else rt.plan_revision)
            fs.make_dir(rel)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, "create_folder", f"create_folder failed: {exc}")
        return
    rt.mark_progress()
    await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                            content=f"Created folder `{rel}/`" + (f": {a.note}" if a.note else ""),
                            meta={"path": rel + "/", "folder": True}, deliver=False)
    await rt.emit("folder_created", {"path": rel, "agent_id": agent.id})
    rt.notice(agent.id, f"Created folder {rel}/.")
    await rt._tool_result(agent, cid, "create_folder", True, f"{rel}/")


async def act_move_file(rt: RunRuntime, agent: AgentSpec, a: A.MoveFile) -> None:
    cid = await rt._tool_event(agent, "move_file", {"source": a.source, "destination": a.destination})
    fs = rt.fs_for(agent.id)
    try:
        src, _ = fs.resolve(a.source)
        dst, _ = fs.resolve(a.destination)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, "move_file", f"move_file failed: {exc}")
        return
    ok, reason = await rt.guard(agent, "write_file", f"{agent.name} wants to move {src} → {dst}", f"mv {src} {dst}",
                                  {"path": f"{src} → {dst}", "old": "", "new": "", "note": a.note or "move / rename"},
                                  dangerous=is_dangerous_edit(src, move=True))
    if not ok:
        await rt.deny(agent, cid, "move_file", reason)
        return
    await rt.set_agent_status(agent.id, "writing", f"Moving {src} → {dst}…")
    try:
        from app.orchestrator.runtime_store import mutation_lock
        async with mutation_lock(rt.run_id):
            context = ACTIVE_ATTEMPT.get()
            await rt.execution.assert_durable_revision(context.assignment.revision if context else rt.plan_revision)
            src, dst, moved = fs.move(src, dst)
    except WorkspaceError as exc:
        await rt.deny(agent, cid, "move_file", f"move_file failed: {exc}")
        return
    rt.mark_progress()
    context = ACTIVE_ATTEMPT.get()
    if context and context.workspace is not None and not context.integrated:
        rt.notice(agent.id, f"Staged move {src} → {dst}; canonical integration is pending.")
        await rt._tool_result(agent, cid, "move_file", True, "Staged move; not yet applied to the project")
        return
    # keep the run's file list in step with the project
    for old_path in [p for p in list(rt.artifacts) if p == src or p.startswith(src + "/")]:
        rt.artifacts[dst + old_path[len(src):]] = rt.artifacts.pop(old_path)
    await rt.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                            content=f"Moved `{src}` → `{dst}`" + (f" ({len(moved)} files)" if len(moved) > 1 else "") + (f": {a.note}" if a.note else ""),
                            meta={"path": dst, "moved_from": src, "moved": moved[:200]}, deliver=False)
    await rt.emit("file_moved", {"source": src, "destination": dst, "files": moved[:200], "agent_id": agent.id})
    rt.notice(agent.id, f"Moved {src} → {dst} ({len(moved)} file{'s' if len(moved) != 1 else ''}).")
    await rt._tool_result(agent, cid, "move_file", True, f"{src} → {dst}")


async def act_read_file(rt: RunRuntime, agent: AgentSpec, a: A.ReadFile) -> None:
    cid = await rt._tool_event(agent, "read_file", {"path": a.path})
    await rt.set_agent_status(agent.id, "reading", f"Reading {a.path}…")
    try:
        content = rt.fs_for(agent.id).read(a.path)
        ok = True
    except WorkspaceError as exc:
        content, ok = str(exc), False
    header = f"{a.path}:"
    if ok and (a.offset or len(content) > READ_PAGE_CHARS):  # page big files explicitly instead of a silent cut
        end = min(len(content), a.offset + READ_PAGE_CHARS)
        more = f"; read_file with \"offset\": {end} for the next part" if end < len(content) else " (end of file)"
        header = f"{a.path} [characters {a.offset:,}-{end:,} of {len(content):,}{more}]:"
        content = content[a.offset:end]
    rt.observe(agent.id, {"tool": "read_file", "ok": ok, "content": f"{header}\n{content}"})
    await rt._tool_result(agent, cid, "read_file", ok, content[:1000])


async def act_list_files(rt: RunRuntime, agent: AgentSpec, a: A.ListFiles) -> None:
    cid = await rt._tool_event(agent, "list_files", {"prefix": a.prefix})
    await rt.set_agent_status(agent.id, "reading", f"Listing {a.prefix or 'project'} files…")
    try:
        fs = rt.fs_for(agent.id)
        files = await asyncio.to_thread(fs.list, a.prefix.strip().strip("/"))
        if not a.prefix.strip().strip("/"):  # the whole project: working documents too (they live in .octopus/work/)
            files += await asyncio.to_thread(fs.list_work)
        out, ok = ("\n".join(files[:400]) + (f"\n… {len(files) - 400} more" if len(files) > 400 else "")) or "(no files)", True
    except WorkspaceError as exc:
        out, ok = str(exc), False
    rt.observe(agent.id, {"tool": "list_files", "ok": ok, "content": out})
    await rt._tool_result(agent, cid, "list_files", ok, out[:2000])
