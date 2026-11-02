"""Transactional requests and attempts. RunEvent rows are the replayable outbox."""
from __future__ import annotations

import hashlib
import json
import asyncio
from weakref import WeakValueDictionary
from datetime import timedelta
from typing import Any

from sqlalchemy import case, select, update
from sqlalchemy.exc import IntegrityError
from app.db.base import new_id, utcnow
from app.db.session import SessionFactory
from app.models import Run, RunEvent
from app.models.runtime_records import RunRequest, TaskAttempt, ExecutionEvidence, Consultation
from app.orchestrator.contracts import Assignment


class Conflict(ValueError):
    pass


_mutation_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()


def mutation_lock(run_id: str) -> asyncio.Lock:
    """Serialize steering with canonical writes in this backend process. Database CAS still guards durable state.

    Weak entries do not retain completed runs or locks bound to a closed test event loop.
    Call from the application's event loop, before entering filesystem worker threads.
    """
    lock = _mutation_locks.get(run_id)
    if lock is None:
        lock = asyncio.Lock()
        _mutation_locks[run_id] = lock
    return lock


def request_out(row: RunRequest) -> dict[str, Any]:
    return {"id": row.id, "client_id": row.client_id, "kind": row.kind, "content": row.content,
            "target": row.target, "revision": row.revision, "state": row.state,
            "attachments": row.attachments_json, "created_at": row.created_at.isoformat()}


def event(db, run_id: str, kind: str, payload: dict) -> RunEvent:
    row = RunEvent(run_id=run_id, type=kind, payload_json=payload)
    db.add(row)
    return row


class RuntimeStore:
    def __init__(self, sf: SessionFactory, run_id: str):
        self.sf, self.run_id = sf, run_id

    async def commit(self, db) -> None:
        rows = [row for row in db.new if isinstance(row, RunEvent)]
        await db.flush()
        await db.commit()
        from app.orchestrator.bus import bus
        for row in rows:
            bus.relay({"run_id": row.run_id, "type": row.type, "data": row.payload_json,
                       "seq": row.id, "ts": row.created_at.isoformat()})

    async def enqueue(self, *, client_id: str, content: str, target: str, attachments: list[dict], kind: str = "queue") -> tuple[dict, bool]:
        async with mutation_lock(self.run_id):
            return await self._enqueue(client_id=client_id, content=content, target=target, attachments=attachments, kind=kind)

    async def _enqueue(self, *, client_id: str, content: str, target: str, attachments: list[dict], kind: str) -> tuple[dict, bool]:
        if kind not in ("queue", "steer"):
            raise ValueError("Request must queue or steer")
        digest = hashlib.sha256(json.dumps([content, target, attachments, kind], sort_keys=True).encode()).hexdigest()
        async with self.sf() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(turns=Run.turns))
            existing = (await db.execute(select(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.client_id == client_id))).scalar_one_or_none()
            if existing:
                if existing.content_hash != digest:
                    raise Conflict("The request ID was already used for different content")
                return request_out(existing), False
            run = await db.get(Run, self.run_id)
            if not run:
                raise ValueError("Run not found")
            revision = int((run.state_json or {}).get("plan_revision", 1))
            if kind == "steer":
                revision = await self._advance_revision(db, run)
            row = RunRequest(id=new_id(), run_id=self.run_id, client_id=client_id, content=content, content_hash=digest,
                             target=target, attachments_json=attachments, kind=kind, revision=revision, state="queued", created_at=utcnow())
            db.add(row)
            event(db, self.run_id, "request_updated", request_out(row))
            try:
                await self.commit(db)
            except IntegrityError:
                await db.rollback()
                return await self._enqueue(client_id=client_id, content=content, target=target, attachments=attachments, kind=kind)
            return request_out(row), True

    async def requests(self) -> list[dict]:
        async with self.sf() as db:
            rows = (await db.execute(select(RunRequest).where(RunRequest.run_id == self.run_id).order_by(RunRequest.created_at, RunRequest.id))).scalars()
            return [request_out(row) for row in rows]

    async def cancel_request(self, request_id: str) -> None:
        async with self.sf() as db:
            changed = await db.execute(update(RunRequest).where(RunRequest.id == request_id, RunRequest.run_id == self.run_id,
                                                               RunRequest.state == "queued").values(state="cancelled"))
            if changed.rowcount != 1:
                raise Conflict("Only a queued request can be removed")
            event(db, self.run_id, "request_updated", {"id": request_id, "state": "cancelled"})
            await self.commit(db)

    async def steer_request(self, request_id: str) -> tuple[dict, bool]:
        async with mutation_lock(self.run_id):
            return await self._steer_request(request_id)

    async def _steer_request(self, request_id: str) -> tuple[dict, bool]:
        async with self.sf() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(turns=Run.turns))
            row = await db.scalar(select(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id == request_id))
            if not row or row.state != "queued":
                raise Conflict("Only a queued request can steer work")
            if row.kind == "steer":
                return request_out(row), False
            changed = await db.execute(update(RunRequest).where(RunRequest.id == row.id, RunRequest.state == "queued",
                RunRequest.kind == "queue").values(kind="steer"))
            if changed.rowcount != 1:
                raise Conflict("Request changed while steering")
            row.kind = "steer"
            run = await db.get(Run, self.run_id)
            if not run:
                raise Conflict("Run no longer exists")
            row.revision = await self._advance_revision(db, run)
            event(db, self.run_id, "request_updated", request_out(row))
            await self.commit(db)
            return request_out(row), True

    async def claim(self) -> RunRequest | None:
        async with self.sf() as db:
            row = (await db.execute(select(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.state == "queued")
                                    .order_by(case((RunRequest.kind == "steer", 0), else_=1), RunRequest.created_at, RunRequest.id).limit(1))).scalar_one_or_none()
            if not row:
                return None
            changed = await db.execute(update(RunRequest).where(RunRequest.id == row.id, RunRequest.state == "queued").values(state="claimed"))
            if changed.rowcount != 1:
                await db.rollback()
                return None
            row.state = "claimed"
            event(db, self.run_id, "request_updated", request_out(row))
            await self.commit(db)
            return row

    async def request_state(self, request_id: str, state: str) -> None:
        if state not in ("applied", "failed", "recovery_required"):
            raise ValueError("Invalid request transition")
        async with self.sf() as db:
            changed = await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id == request_id,
                                                               RunRequest.state == "claimed").values(state=state))
            if changed.rowcount != 1:
                raise Conflict("Request is no longer claimed")
            event(db, self.run_id, "request_updated", {"id": request_id, "state": state})
            await self.commit(db)

    async def start_attempt(self, assignment: Assignment) -> str:
        if assignment.run_id != self.run_id:
            raise Conflict("Assignment belongs to another run")
        async with self.sf() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(turns=Run.turns))
            run = await db.get(Run, self.run_id)
            if not run or int((run.state_json or {}).get("plan_revision", 1)) != assignment.revision:
                raise Conflict("Assignment belongs to a stale plan revision")
            active = await db.scalar(select(TaskAttempt.id).where(TaskAttempt.run_id == self.run_id,
                TaskAttempt.agent_id == assignment.owner, TaskAttempt.state.in_(("running", "recovery_required"))))
            if active:
                raise Conflict("Agent already has a running or uncertain invocation")
            row = TaskAttempt(id=new_id(), run_id=self.run_id, agent_id=assignment.owner, revision=assignment.revision,
                              assignment_json=assignment.model_dump(mode="json"), state="running")
            db.add(row)
            event(db, self.run_id, "attempt_updated", {"id": row.id, "agent_id": row.agent_id, "revision": row.revision,
                                                       "state": "running", "assignment": row.assignment_json})
            await self.commit(db)
            return row.id

    async def _advance_revision(self, db, run: Run) -> int:
        revision = int((run.state_json or {}).get("plan_revision", 1)) + 1
        run.state_json = {**(run.state_json or {}), "plan_revision": revision, "waiting_peers": {}, "delegation_chains": {}}
        await self._supersede(db, revision)
        event(db, self.run_id, "plan_revised", {"revision": revision, "reason": "User steering superseded prior work. Host side effects may already have occurred."})
        return revision

    async def _supersede(self, db, revision: int) -> None:
        attempts = (await db.scalars(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id,
                TaskAttempt.revision < revision, TaskAttempt.state.in_(("running", "waiting_reply", "blocked"))))).all()
        for attempt in attempts:
            attempt.state, attempt.ended_at = "superseded", utcnow()
            event(db, self.run_id, "attempt_updated", {"id": attempt.id, "state": "superseded", "revision": attempt.revision})
        consultations = (await db.scalars(select(Consultation).where(Consultation.run_id == self.run_id,
                Consultation.revision < revision, Consultation.state == "waiting"))).all()
        for consultation in consultations:
            consultation.state = "superseded"
            event(db, self.run_id, "consultation_updated", {"id": consultation.id, "sender": consultation.sender, "state": "superseded"})
        await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id,
                RunRequest.state == "queued").values(revision=revision))

    async def supersede_revision(self, revision: int) -> None:
        """Invalidate pending old work without pretending in-flight host actions were undone."""
        async with self.sf() as db:
            await self._supersede(db, revision)
            await self.commit(db)

    async def finish_attempt(self, attempt_id: str, revision: int, state: str, result: dict) -> None:
        if state not in ("completed", "unverified", "waiting_reply", "blocked", "failed", "cancelled", "superseded", "recovery_required"):
            raise ValueError("Invalid attempt result")
        async with self.sf() as db:
            changed = await db.execute(update(TaskAttempt).where(TaskAttempt.id == attempt_id, TaskAttempt.run_id == self.run_id,
                                                                 TaskAttempt.revision == revision, TaskAttempt.state == "running")
                                       .values(state=state, result_json=result, ended_at=utcnow()))
            if changed.rowcount:
                event(db, self.run_id, "attempt_updated", {"id": attempt_id, "state": state, "result": result})
                if state == "recovery_required":
                    attempt = await db.get(TaskAttempt, attempt_id)
                    request_id = (attempt.assignment_json or {}).get("request_id") if attempt else None
                    if request_id:
                        await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id == request_id,
                            RunRequest.state == "applied").values(state="recovery_required"))
                        event(db, self.run_id, "request_updated", {"id": request_id, "state": "recovery_required"})
                await self.commit(db)

    async def recover(self) -> bool:
        async with self.sf() as db:
            interrupted = (await db.scalars(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id,
                TaskAttempt.state == "running"))).all()
            request_ids = [(a.assignment_json or {}).get("request_id") for a in interrupted]
            if request_ids:
                await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id.in_(request_ids),
                    RunRequest.state == "applied").values(state="recovery_required"))
            a = await db.execute(update(TaskAttempt).where(TaskAttempt.run_id == self.run_id, TaskAttempt.state == "running")
                                 .values(state="recovery_required", ended_at=utcnow()))
            r = await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.state == "claimed")
                                 .values(state="recovery_required"))
            changed = bool(a.rowcount or r.rowcount)
            if changed:
                run = await db.get(Run, self.run_id)
                if run:
                    state = dict(run.state_json or {})
                    state["recovery_required"] = True
                    current_id = state.get("current_request_id")
                    if current_id and a.rowcount:
                        await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id,
                            RunRequest.id == current_id, RunRequest.state == "applied").values(state="recovery_required"))
                    run.state_json = state
                event(db, self.run_id, "execution_recovery", {"state": "recovery_required", "reason": "An invocation may have started. Inspect its effects before explicitly resuming."})
            await self.commit(db)
            return changed

    async def recover_request(self, request_id: str, action: str, *, acknowledged: bool) -> dict:
        if not acknowledged or action not in ("retry", "cancel"):
            raise Conflict("Inspect possible side effects and explicitly acknowledge recovery")
        async with self.sf() as db:
            row = await db.scalar(select(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id == request_id))
            if not row or row.state != "recovery_required":
                raise Conflict("Request does not require recovery")
            changed = await db.execute(update(RunRequest).where(RunRequest.id == row.id, RunRequest.state == "recovery_required")
                .values(state="queued" if action == "retry" else "cancelled"))
            if changed.rowcount != 1:
                raise Conflict("Recovery changed concurrently")
            row.state = "queued" if action == "retry" else "cancelled"
            uncertain = (await db.scalars(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id,
                TaskAttempt.state == "recovery_required"))).all()
            for attempt in uncertain:
                if attempt.assignment_json.get("request_id") == request_id:
                    attempt.state, attempt.result_json, attempt.ended_at = "cancelled", {**attempt.result_json, "recovery_acknowledged": True, "action": action}, utcnow()
            run = await db.get(Run, self.run_id)
            if run:
                run.state_json = self.reconciled_state(run.state_json or {},
                    {a.agent_id for a in uncertain if a.assignment_json.get("request_id") == request_id}, action,
                    any(attempt.state == "recovery_required" for attempt in uncertain))
            event(db, self.run_id, "request_updated", request_out(row))
            event(db, self.run_id, "execution_recovery", {"state": "acknowledged", "action": action})
            await self.commit(db)
            return request_out(row)

    async def acknowledge_recovery(self, action: str, *, acknowledged: bool) -> None:
        if not acknowledged or action not in ("acknowledge", "cancel"):
            raise Conflict("Inspect possible side effects and explicitly acknowledge recovery")
        async with self.sf() as db:
            run = await db.get(Run, self.run_id)
            if not run:
                raise Conflict("Run does not exist")
            attempts = (await db.scalars(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id,
                TaskAttempt.state == "recovery_required"))).all()
            for attempt in attempts:
                attempt.state, attempt.ended_at = "cancelled", utcnow()
                attempt.result_json = {**attempt.result_json, "recovery_acknowledged": True, "action": action}
            # Interrupted requests remain explicit decisions; acknowledgment never silently requeues them.
            if action == "cancel":
                await db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.state.in_(("queued", "recovery_required")))
                    .values(state="cancelled"))
            run.state_json = self.reconciled_state(run.state_json or {}, {a.agent_id for a in attempts}, action, False)
            event(db, self.run_id, "execution_recovery", {"state": "acknowledged", "action": action})
            await self.commit(db)

    @staticmethod
    def reconciled_state(state: dict, agents: set[str], action: str, pending: bool) -> dict:
        sessions = dict(state.get("worker_sessions") or {})
        history = list(state.get("worker_session_history") or [])
        for aid in agents:
            if prior := sessions.pop(aid, None):
                history.append({**prior, "agent_id": aid, "recovery_action": action, "reconciled_at": utcnow().isoformat()})
        return {**state, "worker_sessions": sessions, "worker_session_history": history[-100:], "recovery_required": pending}

    async def add_evidence(self, attempt_id: str, revision: int, record: dict) -> str:
        async with self.sf() as db:
            attempt = await db.get(TaskAttempt, attempt_id)
            if not attempt or attempt.run_id != self.run_id or attempt.revision != revision or attempt.state not in ("running", "completed", "unverified"):
                raise Conflict("Evidence belongs to a stale attempt")
            row = ExecutionEvidence(id=new_id(), run_id=self.run_id, attempt_id=attempt_id, revision=revision, record_json=record)
            db.add(row)
            event(db, self.run_id, "evidence_updated", {"id": row.id, "attempt_id": attempt_id, "revision": revision, **record})
            await self.commit(db)
            return row.id

    async def summary(self) -> dict:
        async with self.sf() as db:
            attempts = (await db.execute(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id).order_by(TaskAttempt.started_at))).scalars().all()
            evidence = (await db.execute(select(ExecutionEvidence).where(ExecutionEvidence.run_id == self.run_id))).scalars().all()
            consultations = (await db.execute(select(Consultation).where(Consultation.run_id == self.run_id))).scalars().all()
            run = await db.get(Run, self.run_id)
            saved = (run.state_json or {}) if run else {}
            return {"requests": await self.requests(), "recovery_required": bool(saved.get("recovery_required")),
                    "plan_revision": int(saved.get("plan_revision", 1)),
                    "lead_agent_id": saved.get("lead_agent_id", ""),
                    "engineering_workflow": saved.get("engineering_workflow", "auto"),
                    "execution_mode": saved.get("execution_mode", (run.budget_json or {}).get("execution_mode", "trusted_host") if run else "trusted_host"),
                    "engineering_checkpoints": saved.get("engineering_checkpoints", []), "engineering_blockers": saved.get("engineering_blockers", []),
                    "attempts": [{"id": a.id, "agent_id": a.agent_id, "revision": a.revision,
                    "state": a.state, "assignment": a.assignment_json, "result": a.result_json} for a in attempts],
                    "evidence": [{"id": e.id, "attempt_id": e.attempt_id, "revision": e.revision, **e.record_json} for e in evidence],
                    "consultations": [{"id": c.id, "sender": c.sender, "recipient": c.recipient, "state": c.state,
                                       "question": c.question, "answer": c.answer, "revision": c.revision, "deadline": c.deadline.isoformat()} for c in consultations]}

    async def consult(self, sender: str, recipient: str, revision: int, question: str) -> str:
        if sender == recipient:
            raise Conflict("An agent cannot wait on itself")
        if not sender or not recipient or not question.strip() or len(question) > 8000:
            raise ValueError("A consultation needs valid participants and a bounded question")
        async with self.sf() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(turns=Run.turns))
            run = await db.get(Run, self.run_id)
            if not run or int((run.state_json or {}).get("plan_revision", 1)) != revision:
                raise Conflict("Consultation belongs to a stale plan revision")
            await self._expire(db)
            rows = (await db.execute(select(Consultation).where(Consultation.run_id == self.run_id, Consultation.state == "waiting"))).scalars().all()
            if any(row.sender == sender for row in rows):
                raise Conflict("An agent already has an outstanding consultation")
            graph = {row.sender: row.recipient for row in rows}
            seen = {sender}
            node = recipient
            while node:
                if node in seen:
                    raise Conflict("Consultation would create a waiting cycle")
                seen.add(node)
                node = graph.get(node)
            row = Consultation(id=new_id(), run_id=self.run_id, revision=revision, sender=sender, recipient=recipient,
                               question=question, deadline=utcnow() + timedelta(minutes=5))
            db.add(row)
            event(db, self.run_id, "consultation_updated", {"id": row.id, "sender": sender, "recipient": recipient, "state": "waiting"})
            await self.commit(db)
            return row.id

    async def answer(self, sender: str, recipient: str, content: str) -> list[str]:
        async with self.sf() as db:
            await self._expire(db)
            rows = (await db.execute(select(Consultation).where(Consultation.run_id == self.run_id, Consultation.sender == recipient,
                                                              Consultation.recipient == sender, Consultation.state == "waiting"))).scalars().all()
            for row in rows:
                row.answer, row.state = content, "answered"
                event(db, self.run_id, "consultation_updated", {"id": row.id, "state": "answered"})
            await self.commit(db)
            return [row.id for row in rows]

    async def _expire(self, db) -> list[dict]:
        rows = (await db.scalars(select(Consultation).where(Consultation.run_id == self.run_id,
            Consultation.state == "waiting", Consultation.deadline <= utcnow()))).all()
        for row in rows:
            row.state = "expired"
            event(db, self.run_id, "consultation_updated", {"id": row.id, "sender": row.sender, "state": "expired"})
        return [{"id": row.id, "sender": row.sender, "recipient": row.recipient, "state": "expired"} for row in rows]

    async def expire_consultations(self) -> list[dict]:
        async with self.sf() as db:
            expired = await self._expire(db)
            await self.commit(db)
            return expired
