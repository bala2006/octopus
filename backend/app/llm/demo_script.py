"""Deterministic, role-aware scripted policies for Demo Mode.

The mock provider receives a `mock_context` describing the agent, its unread inbox,
tool observations and the channels it may use, and returns the same JSON action
envelope a real LLM would. Policies degrade gracefully when the topology differs
from the built-in templates (e.g. the user deleted QA): unknown roles fall back to
a generic "respond to whoever wrote to me" behaviour so every run terminates.
"""
from __future__ import annotations

import re
from typing import Any

from app.llm import demo_assets as A

Ctx = dict[str, Any]
Action = dict[str, Any]

ROLE_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("ceo", ("ceo", "chief executive", "founder")),
    ("pm", ("product manager", "product owner", "pm")),
    ("architect", ("architect",)),
    ("frontend", ("frontend", "front-end", "ui developer")),
    ("backend", ("backend", "back-end")),
    ("qa", ("qa", "quality", "tester", "test engineer")),
    ("designer", ("designer", "ux", "ui/ux")),
    ("devops", ("devops", "sre", "infrastructure", "platform")),
    ("moderator", ("moderator", "judge")),
    ("proposer", ("proposer", "advocate")),
    ("critic", ("critic", "skeptic")),
    ("techlead", ("tech lead", "reviewer")),
    ("developer", ("developer", "engineer", "programmer")),
]


def role_category(role: str, template_key: str = "") -> str:
    if template_key:
        return template_key
    r = role.lower()
    for cat, words in ROLE_KEYWORDS:
        if any(re.search(rf"\b{re.escape(w)}\b", r) for w in words):
            return cat
    return "generic"


# ---------------------------------------------------------------- helpers
def _find(ctx: Ctx, *cats: str) -> str | None:
    for cat in cats:
        for a in ctx["allowed"]:
            if a["category"] == cat:
                return a["name"]
    return None


def _in_roster(ctx: Ctx, *cats: str) -> list[str]:
    return [a["name"] for a in ctx["roster"] if a["category"] in cats]


def _msg(to: str, type_: str, content: str, **extra: Any) -> Action:
    return {"action": "send_message", "to": to, "type": type_, "content": content, **extra}


def _write(path: str, content: str, note: str) -> Action:
    return {"action": "write_file", "path": path, "content": content, "note": note}


def _tasks(*items: dict[str, Any]) -> Action:
    return {"action": "update_task_board", "tasks": list(items)}


def _finish(summary: str) -> Action:
    return {"action": "finish", "summary": summary}


def _upstream(ctx: Ctx, sender: str | None = None) -> str | None:
    """Someone to report to: the sender if allowed, else any agent reachable over a report edge."""
    names = {a["name"] for a in ctx["allowed"]}
    if sender and sender in names:
        return sender
    for a in ctx["allowed"]:
        if "report" in a["edge_types"]:
            return a["name"]
    return None


def _task_key(ctx: Ctx, assignee: str | None) -> str | None:
    for t in ctx["tasks"]:
        if assignee and t["assignee"] == assignee and t["status"] != "done":
            return t["key"]
    return None


def _run_result(ctx: Ctx) -> dict[str, Any] | None:
    for o in ctx["observations"]:
        if o.get("tool") == "run_code":
            return o
    return None


# ---------------------------------------------------------------- role policies
def ceo(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    pm = _find(ctx, "pm")
    for m in ctx["inbox"]:
        t, frm = m["type"], m["from"]
        if frm == "user" and not st.get("started"):
            st["started"] = True
            if pm:
                out.append(_msg(pm, "proposal",
                                "Scope proposal for the MVP:\n1. Todo CRUD with due dates\n2. User registration + login\n"
                                "3. Sharing lists with teammates\n4. Dark mode\nTarget: one sprint. Can we commit to this?"))
            else:
                for a in ctx["allowed"]:
                    out.append(_msg(a["name"], "task", f"Goal from the user: {ctx['goal']}. Own your part and report back."))
                st["delegated"] = [a["name"] for a in ctx["allowed"]]
        elif frm == "user":
            if pm:
                out.append(_msg(pm, "task", f"User guidance (please factor it in): {m['content']}"))
        elif t == "objection" and frm == pm:
            out.append(_msg(pm, "proposal",
                            "Compromise: keep 1 (CRUD + due dates), 2 (auth) and 4 (dark mode, cheap). "
                            "Move 3 (sharing) to v2. Agreed?"))
        elif t == "agreement" and frm == pm and not st.get("agreed"):
            st["agreed"] = True
            out.append(_msg(pm, "agreement", "Agreed. Decision: MVP = CRUD + due dates, auth, dark mode. Sharing deferred to v2."))
            out.append(_msg(pm, "task", "Deliver the agreed MVP scope. Keep the task board current and send me a final report when QA and DevOps sign off."))
        elif t == "question":
            out.append(_msg(frm, "answer", "Prioritise a secure, working core over breadth. Anything not in the agreed scope goes to v2."))
        elif t in ("final_report", "status_update") and (t == "final_report" or "complete" in m["content"].lower()):
            st["done"] = True
        elif t in ("answer", "status_update") and st.get("delegated"):
            st.setdefault("answered", []).append(frm)
    if st.get("done") or (st.get("delegated") and set(st["delegated"]) <= set(st.get("answered", []))):
        out.append(_finish(
            "Shipped the Todo MVP: authentication with salted PBKDF2 hashing, todo CRUD with due dates, dark-mode UI, "
            "an automated test suite (passing) and a Dockerfile/README. Deferred to v2: list sharing."))
    return out


def pm(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    ceo_name = _find(ctx, "ceo")
    arch = _find(ctx, "architect")
    dev = _find(ctx, "developer", "backend")
    for m in ctx["inbox"]:
        t, frm = m["type"], m["from"]
        if t == "proposal":
            if not st.get("objected"):
                st["objected"] = True
                out.append(_msg(frm, "objection",
                                "Objection to item 3 (sharing): it needs invitations, permissions and conflict handling. "
                                "That roughly doubles the backend work and the test surface. It won't fit one sprint with quality. "
                                "Suggest moving it to v2."))
            else:
                out.append(_msg(frm, "agreement", "Agreed: CRUD + due dates, auth, dark mode. Sharing in v2."))
        elif t in ("task", "user_interjection") and not st.get("planned") and (frm == "user" or frm == ceo_name or not ceo_name):
            st["planned"] = True
            roster = {a["category"]: a["name"] for a in ctx["roster"]}
            items = []
            if "architect" in roster:
                items.append({"title": "System architecture & API contract", "assignee": roster["architect"], "status": "todo",
                              "acceptance_criteria": ".octopus/work/ARCHITECTURE.md covers components, data model and service API"})
            be = roster.get("backend") or roster.get("developer")
            if be:
                items.append({"title": "Backend: auth + todo service", "assignee": be, "status": "todo",
                              "acceptance_criteria": "Passwords hashed; per-user isolation; empty titles rejected"})
            if "frontend" in roster:
                items.append({"title": "Frontend: todo UI with dark mode", "assignee": roster["frontend"], "status": "todo",
                              "acceptance_criteria": "Add/complete/delete todos; keyboard accessible; theme toggle"})
            if "qa" in roster:
                items.append({"title": "Automated test suite", "assignee": roster["qa"], "status": "todo",
                              "acceptance_criteria": "Tests cover all PRD acceptance criteria and pass"})
            if "devops" in roster:
                items.append({"title": "Dockerfile + README", "assignee": roster["devops"], "status": "todo",
                              "acceptance_criteria": "docker build runs tests; README documents setup"})
            out.append(_write(".octopus/work/PRD.md", A.prd(ctx["goal"]), "Initial PRD reflecting the agreed MVP scope"))
            if items:
                out.append(_tasks(*items))
            target = arch or dev
            if target:
                ask = "design the architecture and split work across the developers." if arch else "implement the service and get it reviewed."
                out.append(_msg(target, "task", "PRD is in .octopus/work/PRD.md and the task board is set up. Please take it from here: " + ask))
        elif t in ("status_update", "final_report", "review_result"):
            st.setdefault("reports", {})[m["from_category"]] = m["content"]
            done = [{"key": k["key"], "status": "done"} for k in ctx["tasks"] if k["assignee"] == frm and k["status"] != "done"]
            if done:
                out.append(_tasks(*done))
        elif t == "question":
            out.append(_msg(frm, "answer", "Follow .octopus/work/PRD.md; anything ambiguous: choose the simplest option that meets the acceptance criteria."))
    reports = st.get("reports", {})
    needed = [c for c in ("qa", "devops") if _in_roster(ctx, c)] or ["developer"]
    if st.get("planned") and not st.get("reported") and all(c in reports for c in needed):
        st["reported"] = True
        summary = ("Final report: all MVP tasks are done. QA: " + reports.get("qa", "n/a").split("\n")[0] +
                   " DevOps: " + reports.get("devops", "n/a").split("\n")[0])
        open_tasks = [{"key": k["key"], "status": "done"} for k in ctx["tasks"] if k["status"] != "done"]
        if open_tasks:
            out.append(_tasks(*open_tasks))
        if ceo_name:
            out.append(_msg(ceo_name, "final_report", summary + " Deliverables: backend/, frontend/, tests/, Dockerfile, README.md (specs and plans in .octopus/work/)."))
        else:
            out.append(_finish(summary))
    return out


def architect(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    for m in ctx["inbox"]:
        t, frm = m["type"], m["from"]
        if t == "task" and not st.get("designed"):
            st["designed"] = True
            out.append(_write(".octopus/work/ARCHITECTURE.md", A.ARCHITECTURE, "Architecture + service API contract"))
            mine = [{"key": k["key"], "status": "done"} for k in ctx["tasks"] if k["assignee"] == ctx["agent"]["name"]]
            if mine:
                out.append(_tasks(*mine))
            be, fe = _find(ctx, "backend", "developer"), _find(ctx, "frontend")
            if be:
                out.append(_msg(be, "task", "Implement `backend/todo_api.py` per .octopus/work/ARCHITECTURE.md (TodoService API table). "
                                "Standard library only. Send it to me for review.", task_id=_task_key(ctx, be)))
            if fe:
                out.append(_msg(fe, "task", "Build `frontend/index.html` (vanilla JS + localStorage). Get the visual spec from design first, then send it to me for review.",
                                task_id=_task_key(ctx, fe)))
        elif t == "review_request":
            n = st.setdefault("reviews", {}).get(frm, 0)
            st["reviews"][frm] = n + 1
            if m["from_category"] in ("backend", "developer") and n == 0:
                out.append(_msg(frm, "review_result", "Changes requested before this can go to QA.", verdict="request_changes",
                                comments=["[backend/todo_api.py] Passwords stored in plaintext → hash with PBKDF2-HMAC-SHA256 + per-user salt, compare with hmac.compare_digest",
                                          "[backend/todo_api.py] create() accepts empty titles → strip and reject",
                                          "[backend/todo_api.py] complete()/delete() don't check ownership → users can modify others' todos"]))
            else:
                out.append(_msg(frm, "review_result", "Looks good. Approved, hand it to QA.", verdict="approve", comments=[]))
        elif t == "question":
            out.append(_msg(frm, "answer", "Follow the service API table in .octopus/work/ARCHITECTURE.md; keep it dependency-free."))
    return out


def backend(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    me = ctx["agent"]["name"]
    reviewer = _find(ctx, "architect", "techlead", "qa")
    for m in ctx["inbox"]:
        t = m["type"]
        if t == "task" and not st.get("v1"):
            st["v1"] = True
            key = _task_key(ctx, me)
            if key:
                out.append(_tasks({"key": key, "status": "in_progress"}))
            out.append(_write("backend/todo_api.py", A.BACKEND_V1, "First implementation of TodoService"))
            if reviewer:
                out.append(_msg(reviewer, "review_request", "Please review backend/todo_api.py (v1): TodoService with register/login/create/list/complete/delete."))
                if key:
                    out.append(_tasks({"key": key, "status": "in_review"}))
        elif t == "review_result" and m.get("verdict") == "request_changes":
            out.append(_write("backend/todo_api.py", A.BACKEND_V2,
                              "Address review: PBKDF2 password hashing, title validation, ownership checks"))
            out.append(_msg(m["from"], "review_request", "Revised per your comments: 1) salted PBKDF2 + compare_digest 2) empty titles rejected 3) owner checks on complete/delete."))
        elif t == "review_result" and m.get("verdict") == "approve" and not st.get("handed"):
            st["handed"] = True
            key = _task_key(ctx, me)
            if key:
                out.append(_tasks({"key": key, "status": "done"}))
            qa = _find(ctx, "qa")
            if qa and m["from_category"] != "qa":
                out.append(_msg(qa, "task", "Backend approved. Please test TodoService in backend/todo_api.py (auth, validation, per-user isolation)."))
            up = _upstream(ctx)
            if not qa and up:
                out.append(_msg(up, "status_update", "Backend implemented and approved in review."))
            elif m["from_category"] == "qa" and up:
                out.append(_msg(up, "status_update", "Implementation complete and approved by QA."))
            out.append(_finish("Backend delivered and approved."))
    return out


def frontend(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    me = ctx["agent"]["name"]
    reviewer = _find(ctx, "architect", "techlead")
    designer = _find(ctx, "designer")

    def build() -> None:
        out.append(_write("frontend/index.html", A.FRONTEND_HTML, "Todo UI per the style guide: dark mode, a11y labels, empty state"))
        if reviewer:
            out.append(_msg(reviewer, "review_request", "Please review frontend/index.html: vanilla JS, localStorage persistence, theme toggle, aria-labels, no innerHTML."))

    for m in ctx["inbox"]:
        t = m["type"]
        if t == "task" and not st.get("started"):
            st["started"] = True
            key = _task_key(ctx, me)
            if key:
                out.append(_tasks({"key": key, "status": "in_progress"}))
            if designer:
                out.append(_msg(designer, "question", "Could you share the visual spec (palette, spacing, components, empty state) for the todo UI?"))
            else:
                build()
        elif t == "answer" and m["from"] == designer and not st.get("built"):
            st["built"] = True
            build()
        elif t == "review_result" and m.get("verdict") == "request_changes":
            build()
        elif t == "review_result" and m.get("verdict") == "approve" and not st.get("handed"):
            st["handed"] = True
            key = _task_key(ctx, me)
            if key:
                out.append(_tasks({"key": key, "status": "done"}))
            qa = _find(ctx, "qa")
            if qa:
                out.append(_msg(qa, "task", "Frontend approved: frontend/index.html. Please add static checks (required elements, a11y labels, no unsafe DOM APIs)."))
            out.append(_finish("Frontend delivered and approved."))
    return out


def designer(ctx: Ctx) -> list[Action]:
    out = []
    for m in ctx["inbox"]:
        if m["type"] in ("question", "task"):
            out.append(_write(".octopus/work/design/style-guide.md", A.STYLE_GUIDE, "Style guide for the todo MVP"))
            out.append(_msg(m["from"], "answer", "Spec is in .octopus/work/design/style-guide.md. Key values: accent #818cf8 (dark) / #6366f1 (light), "
                            "surface #141a2e, 44px touch targets, 4px spacing scale, focus ring 2px accent, empty state copy included."))
            out.append(_finish("Style guide delivered."))
            break
    return out


def qa(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    me = ctx["agent"]["name"]
    result = _run_result(ctx)
    for m in ctx["inbox"]:
        t, cat = m["type"], m["from_category"]
        if t in ("task", "review_request"):
            if t == "review_request":
                st["review_for"] = m["from"]
            if cat == "frontend":
                st["frontend"] = True
                out.append(_write("tests/test_frontend_static.py", A.TESTS_FRONTEND, "Static UI checks: elements, a11y, unsafe DOM APIs"))
            else:
                st["backend"] = True
                out.append(_write("tests/test_todo_api.py", A.TESTS_BACKEND, "Service tests: auth, validation, isolation"))
            st["need_run"] = True
    if result is not None:
        st["pending"] = False
        st["passed"] = bool(result.get("ok"))
        st["last_output"] = result.get("content", "")[-600:]
    if st.get("need_run") and not st.get("pending"):
        st["need_run"] = False
        st["pending"] = True
        key = _task_key(ctx, me)
        if key:
            out.append(_tasks({"key": key, "status": "in_progress"}))
        out.append({"action": "run_code", "command": "python -m unittest discover -s tests -v"})
        return out
    if result is None or st.get("pending"):
        return out
    summary = ("All tests passed." if st["passed"] else "Tests FAILED.") + "\n```\n" + st["last_output"].strip() + "\n```"
    if st.get("review_for"):
        dev = st.pop("review_for")
        verdict = "approve" if st["passed"] else "request_changes"
        out.append(_msg(dev, "review_result", summary, verdict=verdict,
                        comments=[] if st["passed"] else ["Fix the failing tests shown in the output"]))
        up = _upstream(ctx)
        if up and st["passed"]:
            out.append(_msg(up, "status_update", "QA sign-off: " + summary))
        return out
    expected_fe = bool(_in_roster(ctx, "frontend"))
    expected_be = bool(_in_roster(ctx, "backend", "developer"))
    if (st.get("frontend") or not expected_fe) and (st.get("backend") or not expected_be) and not st.get("reported"):
        st["reported"] = True
        key = _task_key(ctx, me)
        if key and st["passed"]:
            out.append(_tasks({"key": key, "status": "done"}))
        devops = _find(ctx, "devops")
        if devops and st["passed"]:
            out.append(_msg(devops, "task", "All tests pass. Please package the app: Dockerfile that runs the test suite at build time + README."))
        pm_name = _find(ctx, "pm") or _upstream(ctx)
        if pm_name:
            out.append(_msg(pm_name, "status_update", "QA report: " + summary))
        out.append(_finish("QA complete: " + ("passing" if st["passed"] else "failing")))
    return out


def devops(ctx: Ctx) -> list[Action]:
    out = []
    for m in ctx["inbox"]:
        if m["type"] == "task":
            out.append(_write("Dockerfile", A.DOCKERFILE, "Container image that runs tests at build time, non-root"))
            out.append(_write("README.md", A.readme(ctx["goal"]), "Project README: structure, tests, run, docker"))
            up = _find(ctx, "pm") or _upstream(ctx)
            if up:
                out.append(_msg(up, "status_update", "Deployment ready: `docker build -t todo-mvp . && docker run -p 8000:8000 todo-mvp`. The build runs the test suite."))
            out.append(_finish("Packaging complete."))
            break
    return out


def developer(ctx: Ctx) -> list[Action]:
    return backend(ctx)


def proposer(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    critic = _find(ctx, "critic") or next((a["name"] for a in ctx["allowed"] if "debate" in a["edge_types"]), None)
    moderator = _find(ctx, "moderator")
    for m in ctx["inbox"]:
        t = m["type"]
        if m["from"] == "user" and not st.get("opened") and critic:
            st["opened"] = True
            out.append(_msg(critic, "proposal", f"Proposal on \"{ctx['goal']}\":\n1. Adopt it company-wide within one quarter\n"
                            "2. Fund it from the existing tooling budget\n3. Measure impact with a before/after productivity metric"))
        elif t == "objection":
            st["rounds"] = st.get("rounds", 0) + 1
            if st["rounds"] == 1:
                out.append(_msg(m["from"], "proposal", "Revised (compromise): 1) Pilot with two teams for 6 weeks 2) Ring-fenced budget capped at 10% "
                                "3) Go/no-go on pre-agreed metrics (cycle time, defect rate)."))
            elif moderator:
                out.append(_msg(moderator, "question", "We've exhausted two rounds without consensus. Please rule on the revised pilot proposal."))
            else:
                out.append(_msg(m["from"], "agreement", "I accept your conditions; let's proceed on that basis."))
        elif t == "agreement":
            if not st.get("agreed"):
                st["agreed"] = True
                out.append(_msg(m["from"], "agreement", "Agreed. We have consensus."))
            out.append(_finish("Consensus reached on the revised pilot proposal."))
        elif t == "decision":
            out.append(_finish("Debate concluded by moderator decision: " + m["content"].split("\n")[0]))
    return out


def critic(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    for m in ctx["inbox"]:
        if m["type"] == "proposal":
            st["seen"] = st.get("seen", 0) + 1
            if st["seen"] == 1:
                out.append(_msg(m["from"], "objection", "Objections: 1) Company-wide in one quarter is high risk with no pilot data → run a pilot. "
                                "2) Unbounded budget → cap it. 3) A single metric is gameable → use two independent metrics."))
            elif st["seen"] == 2:
                out.append(_msg(m["from"], "objection", "Better, but 6 weeks is too short to observe defect-rate changes → 10 weeks minimum, and require a rollback plan."))
            else:
                out.append(_msg(m["from"], "agreement", "My concerns are addressed. Agreed."))
        elif m["type"] == "decision":
            out.append(_finish("Accepted the moderator's decision."))
    return out


def moderator(ctx: Ctx) -> list[Action]:
    out = []
    for m in ctx["inbox"]:
        if m["type"] in ("question", "task") and m["from"] != "user":
            out.append(_write("decision.md", A.DECISION, "Moderator ruling"))
            ruling = ("Ruling: adopt the revised pilot, extended to 10 weeks with a documented rollback plan.\n"
                      "Decisive arguments: 1) pilot data de-risks the rollout 2) capped budget bounds downside. Conditions: two metrics agreed upfront.")
            for a in ctx["allowed"]:
                out.append(_msg(a["name"], "decision", ruling))
            out.append(_finish("Decision issued."))
            break
    return out


def generic(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    me = ctx["agent"]
    for m in ctx["inbox"]:
        t, frm = m["type"], m["from"]
        if frm == "user" and not st.get("delegated"):
            targets = [a["name"] for a in ctx["allowed"] if "delegate" in a["edge_types"] or "consult" in a["edge_types"]]
            st["delegated"] = targets
            for n in targets:
                out.append(_msg(n, "task", f"Goal: {ctx['goal']}. Please contribute from your role and report back."))
            if not targets:
                out.append(_write(f"notes/{me['name'].lower().replace(' ', '_')}.md", f"# {me['name']}\n\nGoal: {ctx['goal']}\n", "Working notes"))
                out.append(_finish(f"{me['name']} completed the goal alone (no connected teammates)."))
        elif t in ("task", "question"):
            path = f"notes/{me['name'].lower().replace(' ', '_')}.md"
            out.append(_write(path, f"# {me['name']} ({me['role']})\n\nRequest from {frm}:\n\n> {m['content']}\n\nContribution: done.\n", "Contribution notes"))
            reply_to = frm if frm in {a['name'] for a in ctx['allowed']} else _upstream(ctx)
            if reply_to:
                out.append(_msg(reply_to, "answer" if t == "question" else "status_update", f"Done. Notes in {path}."))
            out.append(_finish("Contribution delivered."))
        elif t == "review_request":
            out.append(_msg(frm, "review_result", "Approved.", verdict="approve", comments=[]))
        elif t in ("proposal", "objection"):
            out.append(_msg(frm, "agreement", "Agreed."))
        elif t in ("answer", "status_update", "final_report"):
            st.setdefault("answered", []).append(frm)
    if st.get("delegated") and set(st["delegated"]) <= set(st.get("answered", [])) and me.get("is_entry"):
        out.append(_finish("All teammates reported back; goal complete."))
    return out


# ---------------------------------------------------------------- org building (hiring at runtime)
HIRE_PLAN = {
    "Engineering": [("Leo", "Backend Engineer", "fullstack_dev", ["file_read", "file_write", "list_files", "terminal"]),
                    ("Ana", "Frontend Engineer", "fullstack_dev", ["file_read", "file_write", "list_files"])],
    "Quality": [("Sam", "QA Engineer", "qa_engineer", ["file_read", "file_write", "list_files", "terminal"])],
    "Product": [("Priya", "Product Manager", "product_manager", ["file_read", "file_write"])],
    "Growth": [("Zoe", "Content Writer", "content_writer", ["file_read", "file_write"])],
    "Research": [("Ravi", "Researcher", "researcher", ["file_read", "file_write"])],
}


def founder(ctx: Ctx) -> list[Action]:
    st, out = ctx["state"], []
    for m in ctx["inbox"]:
        if m["from"] == "user" and not st.get("hired"):
            st["hired"] = ["Omar", "Tess"]
            out.append({"action": "list_agents"})
            out.append({"action": "create_agent", "name": "Omar", "role": "Engineering Manager", "department": "Engineering",
                        "is_manager": True, "role_template": "eng_manager",
                        "tools": ["file_read", "file_write", "list_files", "terminal", "manage_team"],
                        "brief": f"Lead Engineering for: {ctx['goal']}. Hire the engineers you need (keep it to 2), have them "
                                 "build it, review their work and send me a status_update when it's done."})
            out.append({"action": "create_agent", "name": "Tess", "role": "QA Lead", "department": "Quality", "is_manager": True,
                        "role_template": "qa_lead", "tools": ["file_read", "file_write", "list_files", "terminal", "manage_team"],
                        "connect": [{"to": "Omar", "type": "review", "bidirectional": True, "label": "Release review"}],
                        "brief": f"Lead Quality for: {ctx['goal']}. Hire a QA engineer, define the test plan and report results to me."})
            out.append({"action": "update_agent", "target": "self", "reason": "Record the org design so I keep it consistent",
                        "changes": {"append_to_prompt": "## Org chart (designed by me)\n- Engineering: Omar (manager) builds the product\n"
                                                        "- Quality: Tess (manager) verifies it\nKeep the company lean; hire only for real gaps."}})
        elif m["type"] in ("status_update", "final_report"):
            st.setdefault("reported", []).append(m["from"])
    if st.get("hired") and set(st["hired"]) <= set(st.get("reported", [])) and not st.get("done"):
        st["done"] = True
        out.append({"action": "list_agents"})
        out.append(_finish("Built a 2-department company (Engineering: Omar + hires, Quality: Tess + hires). Both departments delivered and reported."))
    return out


def manager(ctx: Ctx) -> list[Action]:
    """Generic department head: hire (if the team is empty) or delegate, collect reports, refine, report upward."""
    st, out = ctx["state"], []
    me = ctx["agent"]
    dept = me.get("department") or "Team"
    for m in ctx["inbox"]:
        t = m["type"]
        if t in ("task", "user_interjection") and not st.get("started"):
            st["started"] = True
            st["boss"] = m["from"] if m["from"] != "user" else me.get("manager")
            out.append({"action": "list_agents", "department": dept})
            slug = dept.lower().replace(" ", "-")
            out.append(_write(f"departments/{slug}/plan.md", f"# {dept} plan\n\nOwner: {me['name']}\n\nBrief:\n> {m['content'][:800]}\n\n"
                              "## Approach\n1. Split the work across the team\n2. Review every deliverable\n3. Report results upward\n",
                              f"{dept} plan"))
            reports = me.get("reports") or []
            if reports:
                st["waiting"] = list(reports)
                for r in reports:
                    out.append(_msg(r, "task", f"{dept} task for {ctx['goal']}: deliver your part (see departments/{slug}/plan.md) "
                                               "and send me a status_update with the file paths."))
            elif me.get("tools", {}).get("manage_team"):
                hires = HIRE_PLAN.get(dept) or [(f"{dept[:12]} Specialist", f"{dept} Specialist", "specialist", ["file_read", "file_write"])]
                st["waiting"] = []
                for name, role, tpl, tools in hires:
                    st["waiting"].append(name)
                    out.append({"action": "create_agent", "name": name, "role": role, "department": dept, "role_template": tpl, "tools": tools,
                                "brief": f"You're on the {dept} team working on: {ctx['goal']}. Deliver your part as files under "
                                         f"departments/{slug}/ and send me a status_update when done."})
            else:
                st["waiting"] = []
        elif t in ("status_update", "answer", "final_report"):
            st.setdefault("got", []).append(m["from"])
        elif t == "question":
            out.append(_msg(m["from"], "answer", f"Keep it simple and within {dept}'s scope; see departments/{dept.lower().replace(' ', '-')}/plan.md."))
        elif t == "review_request":
            out.append(_msg(m["from"], "review_result", "Reviewed: meets the bar.", verdict="approve", comments=[]))
    waiting = st.get("waiting")
    # resolve names of hires that were renamed on collision (e.g. "Sam 2")
    if waiting is not None and st.get("started") and not st.get("reported"):
        got = set(st.get("got", []))
        if all(any(g == w or g.startswith(w + " ") for g in got) for w in waiting):
            st["reported"] = True
            if waiting and not st.get("refined"):
                st["refined"] = True
                first = next(g for g in st["got"] if g == waiting[0] or g.startswith(waiting[0] + " "))
                out.append({"action": "update_agent", "target": first, "reason": "Codify what worked for the next iteration",
                            "changes": {"append_to_prompt": f"## Team standard ({dept})\nAlways list the files you produced in your status_update."}})
            slug = dept.lower().replace(" ", "-")
            out.append(_write(f"departments/{slug}/summary.md", f"# {dept} summary\n\nDelivered by: {', '.join(st.get('got', [])) or me['name']}\n"
                              f"Reviewed by: {me['name']}\n", f"{dept} results"))
            boss = st.get("boss") or _upstream(ctx)
            up = boss if boss in {x["name"] for x in ctx["allowed"]} else _upstream(ctx)
            if up:
                out.append(_msg(up, "status_update", f"{dept} is done: {len(st.get('got', []))} deliverable(s) reviewed. "
                                                     f"Summary in departments/{slug}/summary.md."))
            out.append(_finish(f"{dept} delivered."))
    return out


POLICIES = {
    "ceo": ceo, "pm": pm, "architect": architect, "backend": backend, "frontend": frontend, "designer": designer,
    "qa": qa, "devops": devops, "developer": developer, "techlead": architect, "proposer": proposer,
    "critic": critic, "moderator": moderator, "generic": generic, "founder": founder, "manager": manager,
    **{k: manager for k in ("eng_manager", "qa_lead", "head_of_product", "devops_lead", "marketing_lead", "research_director",
                            "editor_in_chief", "department_head")},
}

THOUGHTS = {
    "ceo": "Align scope with the PM, then delegate and wait for the final report.",
    "pm": "Keep scope tight, write the PRD, keep the task board accurate.",
    "architect": "Design first, then review rigorously; security issues block approval.",
    "backend": "Implement to the contract, then get it reviewed.",
    "frontend": "Get the design spec, build, get review, hand to QA.",
    "designer": "Give concrete, accessible visual values.",
    "qa": "Only report results that run_code actually returned.",
    "devops": "Make it reproducible.",
    "proposer": "Concede valid points; converge.",
    "critic": "Stress-test, but agree when concerns are resolved.",
    "moderator": "Rule decisively with reasons.",
    "founder": "Design the smallest org that can deliver; hire managers, let them hire specialists.",
    "manager": "Plan, staff or delegate, review, then report upward.",
}


FOLLOWUP = "Follow-up from the user:"
FU_TASK = "Follow-up change request:"


def _followup_text(content: str) -> str:
    return content.split(FOLLOWUP, 1)[-1].split("\n\n", 1)[0].strip()


def followup(ctx: Ctx) -> list[Action] | None:
    """Continued runs (Demo Mode): apply a follow-up on top of the existing work instead of starting over.

    The entry agent logs the request, hands it to one teammate, and finishes again once that teammate reports back.
    The teammate records the change in the project (docs/CHANGES.md) and reports.
    """
    st, me = ctx["state"], ctx["agent"]
    fu = st.setdefault("followups", {})
    out: list[Action] = []
    handled = False
    for m in ctx["inbox"]:
        c = m.get("content") or ""
        if m["from"] == "user" and FOLLOWUP in c:
            handled = True
            req = _followup_text(c)
            n = len(fu.get("log", [])) + 1
            fu.setdefault("log", []).append(req)
            target = next((a["name"] for a in ctx["allowed"] if "delegate" in a["edge_types"]), None) or \
                next((a["name"] for a in ctx["allowed"]), None)
            if target:
                fu["waiting"] = target
                out.append(_msg(target, "task", f"{FU_TASK} {req}\nKeep everything that already works; change only what's needed "
                                                f"and report back. (request #{n})"))
            else:
                out.append(_write("docs/CHANGES.md", _changes(fu["log"], me["name"]), f"Follow-up #{n}: {req[:60]}"))
                out.append(_finish(f"Applied follow-up #{n}: {req}"))
        elif FU_TASK in c:
            handled = True
            req = c.split(FU_TASK, 1)[1].split("\n", 1)[0].strip()
            log = st.setdefault("fu_log", [])
            log.append(req)
            out.append(_write("docs/CHANGES.md", _changes(log, me["name"]), f"Follow-up: {req[:60]}"))
            back = m["from"] if m["from"] in {a["name"] for a in ctx["allowed"]} else _upstream(ctx)
            if back:
                out.append(_msg(back, "status_update", f"Done: {req}. Existing work kept; change recorded in docs/CHANGES.md."))
            if not me.get("is_entry"):
                out.append(_finish(f"Follow-up applied: {req}"))
        elif fu.get("waiting") and m["from"] == fu.get("waiting") and m["type"] in ("status_update", "final_report", "answer"):
            handled = True
            fu["waiting"] = None
            last = fu["log"][-1] if fu.get("log") else "the requested change"
            out.append(_finish(f"Follow-up done: {last}. Built on the previous work (see docs/CHANGES.md)."))
    return out if handled else None


def _changes(items: list[str], by: str) -> str:
    return "# Changes after the first delivery\n\n" + "\n".join(f"{i}. {x} ({by})" for i, x in enumerate(items, 1)) + "\n"


def decide(ctx: Ctx) -> dict[str, Any]:
    fu = followup(ctx)
    if fu is not None:
        return {"thought": "A follow-up on delivered work: change only what's needed and report back.", "actions": fu or [{"action": "wait"}]}
    cat = ctx["agent"]["category"]
    if cat == "generic" and ctx["agent"].get("is_manager") and ctx["agent"].get("department") and not ctx["agent"].get("is_entry"):
        cat = "manager"
    policy = POLICIES.get(cat, generic)
    actions = policy(ctx)
    if not actions:
        actions = [{"action": "wait"}]
    return {"thought": THOUGHTS.get(cat, "Respond to my inbox and move the goal forward."), "actions": actions}
