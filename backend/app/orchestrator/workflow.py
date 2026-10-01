"""The company workflow: defined phases with owners, document handoffs and exit gates (an SOP the engine enforces).

Research basis: MetaGPT (SOPs + structured documents between roles), ChatDev (design → code → test → document phases),
AgentCoder (independent test designer feeding failures back to the programmer), MAST (most multi-agent failures are
specification, misalignment and missing verification: fixed by structure, not prompts).

Flow of a run with a workflow:

1. **Intake**: the goal goes to the company head, who reads it and calls ``set_track`` (quick / standard / large, plus
   whether research is needed). The head never retells the goal: every phase owner gets the original text and images.
2. The engine starts each phase in order: it picks the owner (the agent whose role fits; the head can override), sends
   the brief (goal verbatim, the documents of earlier phases by path, the phase's skill, the done-when), and waits.
3. When the owner calls ``finish``, the phase's **gate** is checked (the document exists, the build changed and was
   exercised, tests reported pass…). A failed gate sends the owner back once or twice with what is missing.
4. Test or review ``finish`` with ``outcome: "fail"`` loops back to Build with the findings (at most MAX_FIX_LOOPS),
   then Test/Review again: the AgentCoder loop.
5. **Accept**: the head checks the result against the acceptance criteria and finishes the run.

Phases without anyone suited to own them are skipped (e.g. no QA on the team: the builder's own verification counts).
Companies run free-form when the run's ``workflow`` option is ``off`` (or ``auto`` and the team can't staff a build and
an independent test).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec, clip

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime

WORK = ".octopus/work"
MAX_GATE_BOUNCES = 2
MAX_FIX_LOOPS = 3


@dataclass(frozen=True)
class Phase:
    key: str
    title: str
    roles: tuple[str, ...]  # role keys that own it, best first
    title_re: str  # fallback: role titles that fit
    skill: str
    doc: str = ""  # the document this phase hands over (relative path), if any
    done_when: str = ""


PHASES: dict[str, Phase] = {p.key: p for p in [
    Phase("intake", "Intake", (), "", "intake-and-plan", done_when="You called set_track."),
    Phase("research", "Research", ("researcher", "research_director", "ux_researcher", "data_analyst", "growth_analyst"),
          r"research|analyst", "research-brief", f"{WORK}/research.md",
          "research.md answers the open questions and ends in a recommendation with sources."),
    Phase("spec", "Spec", ("pm", "product_manager", "head_of_product", "game_designer", "game_director"),
          r"product|\bpm\b|game design", "write-spec", f"{WORK}/spec.md",
          "spec.md has scope, non-goals and numbered, testable acceptance criteria."),
    Phase("design", "Design", ("architect", "techlead", "eng_manager", "data_science_lead", "ux_designer", "designer"),
          r"architect|tech lead|design", "technical-design", f"{WORK}/design.md",
          "design.md maps every acceptance criterion to a file/module and says how to run and test it."),
    Phase("build", "Build", ("fullstack_dev", "developer", "gameplay_programmer", "frontend", "backend", "mobile_dev", "data_engineer",
                             "ml_engineer", "devops", "sre", "security_engineer"),
          r"engineer|developer|programmer|\bdev\b|builder", "implement-feature",
          done_when="The deliverable exists, passes the automatic checks, and you ran or opened it and saw it work."),
    Phase("test", "Test", ("qa", "qa_engineer", "e2e_tester", "playtester", "qa_lead"), r"\bqa\b|test|quality",
          "write-tests-from-spec", f"{WORK}/test-report.md",
          "test-report.md lists every acceptance criterion with pass/fail and the commands or checks you ran; "
          "finish with outcome \"pass\" or \"fail\" (failures go back to the builder)."),
    Phase("review", "Review", ("techlead", "architect", "eng_manager", "security_lead", "qa_lead"), r"tech lead|review|architect|lead",
          "code-review", done_when="You reviewed the change against the goal and spec and ran it; finish with outcome "
          "\"pass\" (approve) or \"fail\" with numbered, concrete fixes."),
    Phase("accept", "Accept", (), "", "release-checklist",
          done_when="Every acceptance criterion is met with evidence; finish the run with what shipped and how it was verified."),
]}
TRACKS: dict[str, list[str]] = {
    "quick": ["intake", "build", "test", "review", "accept"],  # review only when nobody can test
    "standard": ["intake", "research", "spec", "design", "build", "test", "review", "accept"],
    "large": ["intake", "research", "spec", "design", "build", "test", "review", "accept"],
}
TRACK_HELP = {"quick": "one coherent deliverable (a fix, a script, one page, a single-file game)",
              "standard": "a feature or app with a few parts", "large": "several independent parts built in parallel"}


def _fits(agent: AgentSpec, phase: Phase) -> int:
    """How well an agent fits a phase: 2 = its role is made for it, 1 = its title matches, 0 = no."""
    key = str(agent.behavior.get("template_key") or "")
    if key in phase.roles:
        return 2 + (len(phase.roles) - phase.roles.index(key)) / 100
    if phase.title_re and re.search(phase.title_re, agent.role or "", re.I):
        if phase.key == "build" and re.search(r"\bqa\b|test|quality", agent.role or "", re.I):
            return 0
        return 1
    return 0


def pick_owner(agents: list[AgentSpec], phase: Phase, *, exclude: set[str] = frozenset()) -> AgentSpec | None:  # type: ignore[assignment]
    best = sorted(((_fits(a, phase), a) for a in agents if a.active and a.id not in exclude), key=lambda t: -t[0])
    return best[0][1] if best and best[0][0] > 0 else None


def can_staff(agents: list[AgentSpec], head: AgentSpec | None) -> bool:
    """``auto`` turns the workflow on when the team has a builder and someone else to test or review the build."""
    others = [a for a in agents if a.active and (head is None or a.id != head.id)]
    builder = pick_owner(others, PHASES["build"])
    if builder is None:
        return False
    return any(pick_owner(others, PHASES[k], exclude={builder.id}) for k in ("test", "review"))


class WorkflowMixin:
    """Mixed into RunRuntime. State lives in ``self.wf`` (persisted in the run state)."""

    wf: dict[str, Any] | None

    # ------------------------------------------------------------ state
    def wf_active(self: RunRuntime) -> bool:
        return bool(self.wf) and not self.wf.get("ended")

    def wf_phase(self: RunRuntime) -> dict[str, Any] | None:
        if not self.wf_active():
            return None
        i = self.wf["index"]
        return self.wf["phases"][i] if 0 <= i < len(self.wf["phases"]) else None

    def wf_enabled_for_run(self: RunRuntime) -> bool:
        mode = getattr(self.budget, "workflow", "auto")
        if mode == "off" or self.budget.force_mock:
            return False
        heads = self.entry_agents()
        if len(heads) != 1:
            return False
        return mode == "on" or can_staff(list(self.agents.values()), self.agents[heads[0]])

    def wf_tool_exclusions(self: RunRuntime, agent: AgentSpec) -> set[str]:
        ph = self.wf_phase()
        out = set()
        if not (ph and ph["key"] == "intake" and agent.is_entry):
            out.add("set_track")
        if ph and ph["key"] != "accept" and agent.is_entry:
            out.add("delegate")  # the engine hands work to phase owners; the head plans and accepts
        return out

    def wf_owner_of_active(self: RunRuntime, agent_id: str) -> bool:
        ph = self.wf_phase()
        return bool(ph and ph["owner"] == agent_id and ph["key"] not in ("intake", "accept"))

    async def wf_emit(self: RunRuntime) -> None:
        if self.wf:
            await self.emit("workflow_updated", {"workflow": self.wf_view()})

    def wf_view(self: RunRuntime) -> dict[str, Any]:
        w = self.wf or {}
        return {"track": w.get("track"), "index": w.get("index", 0), "ended": bool(w.get("ended")), "reason": w.get("reason", ""),
                "phases": [{"key": p["key"], "title": PHASES[p["key"]].title, "owner": p["owner"], "status": p["status"],
                            "loops": p.get("loops", 0), "summary": p.get("summary", "")[:300]} for p in w.get("phases", [])]}

    def wf_blackboard(self: RunRuntime) -> str:
        if not self.wf:
            return ""
        marks = {"done": "✓", "active": "▶", "pending": "·", "skipped": "–", "failed": "✗"}
        rows = [f"{marks.get(p['status'], '?')} {PHASES[p['key']].title}"
                + (f" ({self.names.get(p['owner'], '?')})" if p.get("owner") else "")
                + (f": {PHASES[p['key']].doc}" if PHASES[p["key"]].doc and p["status"] == "done" else "")
                for p in self.wf["phases"]]
        return f"Workflow (track: {self.wf.get('track') or 'choosing'}):\n" + "\n".join(f"- {r}" for r in rows)

    # ------------------------------------------------------------ start
    def wf_init(self: RunRuntime) -> None:
        head = self.entry_agents()[0]
        self.wf = {"track": None, "index": 0, "ended": False, "reason": "",
                   "phases": [{"key": "intake", "owner": head, "status": "active", "bounces": 0, "loops": 0, "summary": ""}]}

    def wf_intake_note(self: RunRuntime) -> str:
        tracks = "; ".join(f"{k} = {v}" for k, v in TRACK_HELP.items())
        return ("\n\n--- How this company works ---\nYou run the intake. Read the goal, any images and the project, then call "
                f"`set_track` with the track ({tracks}) and whether research is needed "
                '(JSON: {"action":"set_track","track":"quick|standard|large","research":false,"reason":"…"}). '
                "Octopus then hands each phase (spec → design → build → test → review) to the teammate whose role fits, with this goal verbatim, and comes "
                "back to you for acceptance. Load the `intake-and-plan` skill first. Don't delegate the phases yourself.")

    async def act_set_track(self: RunRuntime, agent: AgentSpec, a: A.SetTrack) -> None:
        cid = await self._tool_event(agent, "set_track", {"track": a.track, "research": a.research})
        ph = self.wf_phase()
        if not (ph and ph["key"] == "intake" and agent.is_entry):
            await self.deny(agent, cid, "set_track", "set_track is only for the company head during intake.")
            return
        keys = [k for k in TRACKS[a.track] if k != "research" or a.research]
        agents = list(self.agents.values())
        head = self.agents[ph["owner"]]
        overrides = {k.lower(): self.resolve_agent(v) for k, v in (a.owners or {}).items()}
        phases, builder = [], None
        for k in keys:
            if k in ("intake", "accept"):
                phases.append({"key": k, "owner": head.id, "status": "done" if k == "intake" else "pending", "bounces": 0, "loops": 0, "summary": ""})
                continue
            exclude = {head.id} | ({builder} if builder and k in ("test", "review") else set())  # independent checks
            owner_id = overrides.get(k) or (o.id if (o := pick_owner(agents, PHASES[k], exclude=exclude)) else None)
            if k == "build" and owner_id is None:
                owner_id = head.id  # somebody has to build it
            if k == "build":
                builder = owner_id
            phases.append({"key": k, "owner": owner_id, "status": "pending" if owner_id else "skipped", "bounces": 0, "loops": 0, "summary": ""})
        if a.track == "quick":  # one independent check is enough for a quick goal: a tester, else a reviewer
            test = next(p for p in phases if p["key"] == "test")
            review = next(p for p in phases if p["key"] == "review")
            if test["status"] != "skipped" and review["status"] != "skipped":
                review.update({"status": "skipped", "owner": None})
        self.wf.update({"track": a.track, "phases": phases, "index": 0, "reason": a.reason[:500]})
        ph = phases[0]
        ph["summary"] = a.reason[:500]
        plan = ", ".join(f"{PHASES[p['key']].title}: {self.names.get(p['owner'], '-')}" for p in phases[1:] if p["status"] != "skipped")
        skipped = [PHASES[p["key"]].title for p in phases if p["status"] == "skipped"]
        self.decide(f"Track {a.track}: {plan}" + (f" (skipped, nobody suited: {', '.join(skipped)})" if skipped else ""), agent.id)
        self.mark_progress()
        await self._tool_result(agent, cid, "set_track", True, a.track)
        self.notice(agent.id, f"Track set: {a.track}. Plan: {plan}." + (f" Skipped (nobody suited): {', '.join(skipped)}." if skipped else "")
                    + " Octopus now briefs each owner in turn and comes back to you for acceptance; end your turn.")
        await self.wf_advance()

    # ------------------------------------------------------------ transitions
    async def wf_advance(self: RunRuntime) -> None:
        """Move to the next phase that has an owner and brief it."""
        w = self.wf
        i = w["index"] + 1
        while i < len(w["phases"]) and w["phases"][i]["status"] == "skipped":
            i += 1
        w["index"] = i
        if i >= len(w["phases"]):
            w["ended"] = True
            await self.wf_emit()
            return
        await self.wf_start(w["phases"][i])

    async def wf_start(self: RunRuntime, ph: dict[str, Any], *, extra: str = "") -> None:
        ph["status"], ph["bounces"] = "active", 0
        ph["start_versions"] = {p: v["version"] for p, v in self.artifacts.items()}
        phase = PHASES[ph["key"]]
        owner = self.agents[ph["owner"]]
        head_id = self.wf["phases"][0]["owner"]
        await self.post_message(sender="agent", from_id=head_id, to_id=owner.id, type_="task", content=self.wf_brief(ph) + extra,
                                meta={"workflow_phase": ph["key"], "task_id": None})
        self.log(head_id, f"workflow: {phase.title} → {owner.name}")
        await self.wf_emit()

    def wf_brief(self: RunRuntime, ph: dict[str, Any]) -> str:
        phase = PHASES[ph["key"]]
        docs = [f"- {PHASES[p['key']].title}: {PHASES[p['key']].doc}" for p in self.wf["phases"]
                if p["status"] == "done" and PHASES[p["key"]].doc]
        summaries = [f"- {PHASES[p['key']].title} ({self.names.get(p['owner'], '?')}): {p['summary'][:600]}" for p in self.wf["phases"]
                     if p["status"] == "done" and p.get("summary") and p["key"] != "intake"]
        if ph["key"] == "accept":
            lead = "All phases are done. Accept the result: check it against the goal and the acceptance criteria, with evidence."
        else:
            lead = f"You own the **{phase.title}** phase of this goal."
        parts = [f"Workflow phase: {phase.title} (track {self.wf['track']}). {lead}",
                 "The goal, verbatim (attached images are shown to you as well):\n> "
                 + clip(getattr(self, "goal_content", "") or self.goal, 20000).replace("\n", "\n> ")]
        if docs:
            parts.append("Documents from earlier phases (read them first):\n" + "\n".join(docs))
        if summaries:
            parts.append("What earlier phases reported:\n" + "\n".join(summaries))
        if phase.doc:
            parts.append(f"Your deliverable: `{phase.doc}`" + ("" if ph["key"] != "test" else " plus the tests themselves"))
        parts.append(f"First load the `{phase.skill}` skill (use_skill) and follow it.")
        parts.append(f"Done when: {phase.done_when}")
        if ph["key"] != "accept":
            parts.append("Then call `finish` with a short summary (what you produced, where, how you verified it). Don't ask "
                         "teammates for specs: everything you need is in the goal and the documents above.")
        return "\n\n".join(parts)

    def wf_gate(self: RunRuntime, agent: AgentSpec, ph: dict[str, Any], a: A.Finish) -> str | None:
        """What's missing before this phase can close, or None."""
        phase = PHASES[ph["key"]]
        fs = self.fs_for(agent.id)
        if phase.doc:
            try:
                text = fs.current(fs.resolve(phase.doc)[0])
            except Exception:  # noqa: BLE001
                text = None
            if not text or len(text.strip()) < 80:
                return f"`{phase.doc}` doesn't exist yet (or is nearly empty): write it with write_file, following the `{phase.skill}` skill."
            if ph["key"] == "spec" and "acceptance" not in text.lower():
                return "spec.md has no acceptance criteria section: add numbered, testable acceptance criteria."
        if ph["key"] == "build":
            before = ph.get("start_versions") or {}
            changed = [p for p, v in self.artifacts.items() if not p.startswith(".octopus/") and before.get(p) != v["version"]]
            if not changed:
                return "Nothing was built in this phase: no project file changed. Build the deliverable, run or open it, then finish."
        if ph["key"] in ("test", "review") and a.outcome not in ("pass", "fail"):
            return "Finish with outcome \"pass\" or \"fail\" (with the failures listed in the summary) so the result can be routed."
        return None

    async def wf_on_finish(self: RunRuntime, agent: AgentSpec, a: A.Finish) -> str | None:
        """Called for a phase owner's finish. Returns a refusal (the owner keeps working) or None (phase closed)."""
        ph = self.wf_phase()
        assert ph is not None
        why = self.wf_gate(agent, ph, a)
        if why and ph["bounces"] < MAX_GATE_BOUNCES:
            ph["bounces"] += 1
            return f"Phase {PHASES[ph['key']].title} isn't done yet: {why}"
        ph["summary"] = (a.summary or "")[:2000]
        if ph["key"] in ("test", "review") and a.outcome == "fail":
            build = next((p for p in self.wf["phases"] if p["key"] == "build"), None)
            if build and build.get("loops", 0) < MAX_FIX_LOOPS:
                build["loops"] = build.get("loops", 0) + 1
                ph["status"] = "pending"
                for p in self.wf["phases"][self.wf["phases"].index(build) + 1:]:
                    if p["status"] == "done":
                        p["status"] = "pending"
                self.wf["index"] = self.wf["phases"].index(build)
                self.log(agent.id, f"workflow: {PHASES[ph['key']].title} failed, back to Build (fix round {build['loops']})")
                await self.wf_start(build, extra=f"\n\n--- Fix round {build['loops']}/{MAX_FIX_LOOPS}: {PHASES[ph['key']].title} "
                                                 f"by {agent.name} FAILED ---\n{a.summary[:4000]}\nFix every point, re-verify, then finish.")
                return None
            ph["status"] = "failed"
        else:
            ph["status"] = "done"
        self.mark_progress()
        self.log(agent.id, f"workflow: {PHASES[ph['key']].title} {ph['status']}")
        await self.wf_advance()
        return None

    async def nudge_workflow(self: RunRuntime) -> bool:
        """Nobody has work but the workflow isn't over: remind the active phase's owner once, then hand it to the head."""
        ph = self.wf_phase()
        if ph is None:
            return False
        if ph.get("nudged", 0) >= 2:
            if ph["key"] in ("intake", "accept"):
                return False
            ph["status"] = "failed"
            ph["summary"] = (ph.get("summary") or "") + " (stalled: the owner stopped without finishing)"
            await self.wf_advance()
            return True
        ph["nudged"] = ph.get("nudged", 0) + 1
        what = "call `set_track`" if ph["key"] == "intake" else "call `finish`"
        self.notice(ph["owner"], f"The workflow is waiting on you: phase {PHASES[ph['key']].title}. Continue the work, then {what}.",
                    activate=True)
        await self.set_agent_status(ph["owner"], "waiting")
        return True
