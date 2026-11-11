"""Transactional requests and attempts. RunEvent rows are the replayable outbox."""
from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any

from sqlalchemy.exc import IntegrityError
from app.storage.base import new_id, utcnow
from app.storage.repositories import ConsultationRepository, EvidenceRepository, RunRepository, RunRequestRepository, TaskAttemptRepository
from app.storage.session import SessionFactory
from app.storage.models import Run, RunEvent
from app.storage.models.runtime_records import RunRequest, TaskAttempt, ExecutionEvidence, Consultation
from app.sdk.contracts import Assignment
from app.sdk.execution_contracts import Conflict, mutation_lock


def request_out(row: RunRequest) -> dict[str, Any]:
    return {"id": row.id, "client_id": row.client_id, "kind": row.kind, "content": row.content,
            "target": row.target, "revision": row.revision, "state": row.state,
            "attachments": row.attachments_json, "created_at": row.created_at.isoformat()}


def event(db, run_id: str, kind: str, payload: dict) -> RunEvent:
    row = RunEvent(run_id=run_id, type=kind, payload_json=payload)
    db.add(row)
    return row


class RuntimeStore:
    def __init__(self, sf: SessionFactory, run_id: str, eventlog: Any | None = None):
        self.sf, self.run_id = sf, run_id
        self._eventlog = eventlog

    async def commit(self, db) -> None:
        rows = [row for row in db.new if isinstance(row, RunEvent)]
        await db.flush()
        await db.commit()
        from app.kernel.current import current
        bus = self._eventlog if self._eventlog is not None else current().eventlog
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
            await RunRepository(db).touch(self.run_id)
            existing = await RunRequestRepository(db, self.run_id).by_client_id(client_id)
            if existing:
                if existing.content_hash != digest:
                    raise Conflict("The request ID was already used for different content")
                return request_out(existing), False
            run = await RunRepository(db).get(self.run_id)
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
            rows = await RunRequestRepository(db, self.run_id).list_for_run()
            return [request_out(row) for row in rows]

    async def cancel_request(self, request_id: str) -> None:
        async with self.sf() as db:
            changed = await RunRequestRepository(db, self.run_id).transition(request_id, "queued", state="cancelled")
            if changed.rowcount != 1:
                raise Conflict("Only a queued request can be removed")
            event(db, self.run_id, "request_updated", {"id": request_id, "state": "cancelled"})
            await self.commit(db)

    async def steer_request(self, request_id: str) -> tuple[dict, bool]:
        async with mutation_lock(self.run_id):
            return await self._steer_request(request_id)

    async def _steer_request(self, request_id: str) -> tuple[dict, bool]:
        async with self.sf() as db:
            await RunRepository(db).touch(self.run_id)
            row = await RunRequestRepository(db, self.run_id).get(request_id)
            if not row or row.state != "queued":
                raise Conflict("Only a queued request can steer work")
            if row.kind == "steer":
                return request_out(row), False
            changed = await RunRequestRepository(db, self.run_id).transition(row.id, "queued", RunRequest.kind == "queue", kind="steer")
            if changed.rowcount != 1:
                raise Conflict("Request changed while steering")
            row.kind = "steer"
            run = await RunRepository(db).get(self.run_id)
            if not run:
                raise Conflict("Run no longer exists")
            row.revision = await self._advance_revision(db, run)
            event(db, self.run_id, "request_updated", request_out(row))
            await self.commit(db)
            return request_out(row), True

    async def claim(self) -> RunRequest | None:
        async with self.sf() as db:
            row = await RunRequestRepository(db, self.run_id).first_queued()
            if not row:
                return None
            changed = await RunRequestRepository(db, self.run_id).transition(row.id, "queued", state="claimed")
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
            changed = await RunRequestRepository(db, self.run_id).transition(request_id, "claimed", state=state)
            if changed.rowcount != 1:
                raise Conflict("Request is no longer claimed")
            event(db, self.run_id, "request_updated", {"id": request_id, "state": state})
            await self.commit(db)

    async def start_attempt(self, assignment: Assignment) -> str:
        if assignment.run_id != self.run_id:
            raise Conflict("Assignment belongs to another run")
        async with self.sf() as db:
            await RunRepository(db).touch(self.run_id)
            run = await RunRepository(db).get(self.run_id)
            if not run or int((run.state_json or {}).get("plan_revision", 1)) != assignment.revision:
                raise Conflict("Assignment belongs to a stale plan revision")
            active = await TaskAttemptRepository(db, self.run_id).active_id(assignment.owner, ("running", "recovery_required"))
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
        attempts = await TaskAttemptRepository(db, self.run_id).find(TaskAttempt.revision < revision, TaskAttempt.state.in_(("running", "waiting_reply", "blocked")))
        for attempt in attempts:
            attempt.state, attempt.ended_at = "superseded", utcnow()
            event(db, self.run_id, "attempt_updated", {"id": attempt.id, "state": "superseded", "revision": attempt.revision})
        consultations = await ConsultationRepository(db, self.run_id).find(Consultation.revision < revision, Consultation.state == "waiting")
        for consultation in consultations:
            consultation.state = "superseded"
            event(db, self.run_id, "consultation_updated", {"id": consultation.id, "sender": consultation.sender, "state": "superseded"})
        await RunRequestRepository(db, self.run_id).supersede_queued(revision)

    async def supersede_revision(self, revision: int) -> None:
        """Invalidate pending old work without pretending in-flight host actions were undone."""
        async with self.sf() as db:
            await self._supersede(db, revision)
            await self.commit(db)

    async def finish_attempt(self, attempt_id: str, revision: int, state: str, result: dict) -> None:
        if state not in ("completed", "unverified", "waiting_reply", "blocked", "failed", "cancelled", "superseded", "recovery_required"):
            raise ValueError("Invalid attempt result")
        async with self.sf() as db:
            changed = await TaskAttemptRepository(db, self.run_id).finish(attempt_id, revision, state, result)
            if changed.rowcount:
                event(db, self.run_id, "attempt_updated", {"id": attempt_id, "state": state, "result": result})
                if state == "recovery_required":
                    attempt = await TaskAttemptRepository(db, self.run_id).get(attempt_id)
                    request_id = (attempt.assignment_json or {}).get("request_id") if attempt else None
                    if request_id:
                        await RunRequestRepository(db, self.run_id).transition(request_id, "applied", state="recovery_required")
                        event(db, self.run_id, "request_updated", {"id": request_id, "state": "recovery_required"})
                await self.commit(db)

    async def recover(self) -> bool:
        async with self.sf() as db:
            interrupted = await TaskAttemptRepository(db, self.run_id).find(TaskAttempt.state == "running")
            request_ids = [(a.assignment_json or {}).get("request_id") for a in interrupted]
            if request_ids:
                await RunRequestRepository(db, self.run_id).mark_recovery(request_ids, "applied")
            a = await TaskAttemptRepository(db, self.run_id).mark_running_recovery()
            r = await RunRequestRepository(db, self.run_id).claimed_to_recovery()
            changed = bool(a.rowcount or r.rowcount)
            if changed:
                run = await RunRepository(db).get(self.run_id)
                if run:
                    state = dict(run.state_json or {})
                    state["recovery_required"] = True
                    current_id = state.get("current_request_id")
                    if current_id and a.rowcount:
                        await RunRequestRepository(db, self.run_id).transition(current_id, "applied", state="recovery_required")
                    run.state_json = state
                event(db, self.run_id, "execution_recovery", {"state": "recovery_required", "reason": "An invocation may have started. Inspect its effects before explicitly resuming."})
            await self.commit(db)
            return changed

    async def recover_request(self, request_id: str, action: str, *, acknowledged: bool) -> dict:
        if not acknowledged or action not in ("retry", "cancel"):
            raise Conflict("Inspect possible side effects and explicitly acknowledge recovery")
        async with self.sf() as db:
            row = await RunRequestRepository(db, self.run_id).get(request_id)
            if not row or row.state != "recovery_required":
                raise Conflict("Request does not require recovery")
            changed = await RunRequestRepository(db, self.run_id).transition(row.id, "recovery_required", state="queued" if action == "retry" else "cancelled")
            if changed.rowcount != 1:
                raise Conflict("Recovery changed concurrently")
            row.state = "queued" if action == "retry" else "cancelled"
            uncertain = await TaskAttemptRepository(db, self.run_id).find(TaskAttempt.state == "recovery_required")
            for attempt in uncertain:
                if attempt.assignment_json.get("request_id") == request_id:
                    attempt.state, attempt.result_json, attempt.ended_at = "cancelled", {**attempt.result_json, "recovery_acknowledged": True, "action": action}, utcnow()
            run = await RunRepository(db).get(self.run_id)
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
            run = await RunRepository(db).get(self.run_id)
            if not run:
                raise Conflict("Run does not exist")
            attempts = await TaskAttemptRepository(db, self.run_id).find(TaskAttempt.state == "recovery_required")
            for attempt in attempts:
                attempt.state, attempt.ended_at = "cancelled", utcnow()
                attempt.result_json = {**attempt.result_json, "recovery_acknowledged": True, "action": action}
            # Interrupted requests remain explicit decisions; acknowledgment never silently requeues them.
            if action == "cancel":
                await RunRequestRepository(db, self.run_id).cancel_in_states(("queued", "recovery_required"))
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
            attempt = await TaskAttemptRepository(db, self.run_id).get(attempt_id)
            if not attempt or attempt.run_id != self.run_id or attempt.revision != revision or attempt.state not in ("running", "completed", "unverified"):
                raise Conflict("Evidence belongs to a stale attempt")
            row = ExecutionEvidence(id=new_id(), run_id=self.run_id, attempt_id=attempt_id, revision=revision, record_json=record)
            db.add(row)
            event(db, self.run_id, "evidence_updated", {"id": row.id, "attempt_id": attempt_id, "revision": revision, **record})
            await self.commit(db)
            return row.id

    async def summary(self) -> dict:
        async with self.sf() as db:
            attempts = await TaskAttemptRepository(db, self.run_id).ordered()
            evidence = await EvidenceRepository(db).for_run(self.run_id)
            consultations = await ConsultationRepository(db, self.run_id).find()
            run = await RunRepository(db).get(self.run_id)
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
            await RunRepository(db).touch(self.run_id)
            run = await RunRepository(db).get(self.run_id)
            if not run or int((run.state_json or {}).get("plan_revision", 1)) != revision:
                raise Conflict("Consultation belongs to a stale plan revision")
            await self._expire(db)
            rows = await ConsultationRepository(db, self.run_id).find(Consultation.state == "waiting")
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
            rows = await ConsultationRepository(db, self.run_id).find(Consultation.sender == recipient, Consultation.recipient == sender, Consultation.state == "waiting")
            for row in rows:
                row.answer, row.state = content, "answered"
                event(db, self.run_id, "consultation_updated", {"id": row.id, "state": "answered"})
            await self.commit(db)
            return [row.id for row in rows]

    async def _expire(self, db) -> list[dict]:
        rows = await ConsultationRepository(db, self.run_id).find(Consultation.state == "waiting", Consultation.deadline <= utcnow())
        for row in rows:
            row.state = "expired"
            event(db, self.run_id, "consultation_updated", {"id": row.id, "sender": row.sender, "state": "expired"})
        return [{"id": row.id, "sender": row.sender, "recipient": row.recipient, "state": "expired"} for row in rows]

    async def expire_consultations(self) -> list[dict]:
        async with self.sf() as db:
            expired = await self._expire(db)
            await self.commit(db)
            return expired
