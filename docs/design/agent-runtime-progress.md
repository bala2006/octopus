# Agent runtime implementation

This checklist tracks execution of [the approved design](agent-runtime-pstack-plan.md). Existing uncommitted workspace changes are preserved. The installed OpenCode executable is preserved. GitHub PR publication was authorized by the user after implementation.

## Definition of done

Both native and installed-OpenCode workers follow versioned assignments, permission caps, pinned workflows, durable control, scoped context, and artifact-bound evidence. Desktop controls expose effective execution and honest verification outcomes. Reliability scenarios and baseline comparisons have recorded results. Unsupported restricted execution must block explicitly rather than claim isolation.

## Checklist

- [x] Phase 0: baseline, installed capability report, representative fixtures.
- [x] Phase 1: versioned task, attempt, routing and policy contracts.
- [x] Phase 2: common worker contract and OpenCode capability/session handling.
- [x] Phase 3: durable queue, revisions, recovery and control.
- [x] Phase 4: pinned pstack workflows and revision-bound proof.
- [x] Phase 5: transactional scoped memory and source-preserving context.
- [x] Phase 6: controlled specialist teams, consultation and integration.
- [x] Phase 7 implementation: desktop controls, repeatable reliability evaluation and rollout gates.
- [ ] Comparative promotion gate: repeated live model quality/cost/latency comparisons have not qualified a team strategy as a default.

## Execution discipline

Use the existing RunRuntime as the integration owner unless the architecture comparison proves a separate coordinator necessary. Verify each phase before enabling dependent behavior. Keep changes to independent new modules separate from shared runtime/schema edits. Runtime, API, and database lifecycle changes have one owner.

Architecture sketch comparison, implementation decisions, and observed check results are recorded in `agent-runtime-decisions.tsv` and evidence reports. A checkbox is checked only when the relevant integration behavior is verified.

## Delivered behavior

The existing RunRuntime owns both native and installed-OpenCode agent turns. Each attempt records its request, owner, selected model/effort, revision, capabilities, pinned skill hashes, and base files. Initial requests and follow-ups deduplicate by client ID. REST and WebSocket delivery use the durable queue. Steering, pending approvals, conflict integration, and recovery are checked in the coordinator; ambiguous side effects are never replayed automatically.

Pinned Explain/Fix/Build/Review contracts require ordered typed outputs. Fix needs an observed failing reproduction and the same check passing on the integrated revision. Evidence binds explicit file coverage, task revision and execution environment. Source inspections and model review are distinguishable from executed checks. Independent review rejects artifact authors. Specialist questions yield, reject waiting cycles, and resume on an answer or decision. Worker stages preserve shared working documents while excluding databases, secrets, dependencies and runtime metadata.

Versioned scoped memory supports private agents, arbitrary sharing groups, a chat, and a project. Source-preserving digests retain exact message references. Owner edits, promotion, tombstones, membership changes, and explicit group sharing are available in the desktop Memory panel. Older Inspector memory controls use the same canonical records; legacy notes are imported once.

## Verification record

- Complete backend suite: **410 passed, 1 skipped**, including real filesystem, SQLite, local MCP and subprocess behavior. The skipped opt-in live browser stream test requires a separate browser fixture. Subsequent Auto-thinking and specialist-authority changes were checked with focused integration/provider/team tests and the source-stable evaluation below.
- Frontend: **86 passed**, TypeScript check and production build passed. Generated API bindings were refreshed.
- Source-stable evaluation: **123/123 passed**; see `runtime-evaluation.md` and its JSON for timestamps and exact source hashes. The final Auto-thinking and specialist-authority regressions are included.
- Installed OpenCode v2.2.5 was discovered and initialized without installation or upgrade. Its handshake advertises HTTP MCP but no enforceable restricted isolation or effort selector.
- A single non-sensitive live greeting reached the installed CLI using the selected free model; the provider rejected inference because **free usage quota was exhausted**. `installed-opencode-smoke.json` records that result. No fallback model or quota retry was attempted. Live answer quality is not verified.
- Desktop browser: opened agent configuration and scoped Memory, opened the model popup, focused the canvas to collapse chat, restored chat, and reopened the popup at the composer. The local project loaded after reload and API health returned healthy. No prompt was sent to the user's G3 project.

The engineering workflow implementation is prepared for PR review. Automatic promotion of arena/swarm or claims of better model quality remain gated on comparative evidence. Existing user work was preserved. PR publication is authorized; no deployment or OpenCode installation was performed.


## PR audit and verification stop

The publication audit added durable task dependencies, scoped write targets, per-task turn budgets and typed acceptance criteria; inherited subtask constraints; ACL-filtered recall/search; pinned-context overflow checks; observed UI interaction evidence; source-inspection provenance; fresh-session recovery; and canonical deletion/change history. Removed the obsolete project JSON writer, unused execution tracking/state helpers, duplicate prompt assembly and competing verification rules. Frontend response parsers share one implementation.

The user requested stopping verification and creating the PR. The most recent completed full backend run reported **431 passed, 1 failed, 1 skipped**. Its sole failure was system-prompt cache stability: per-turn assignments were appended to the system message. Assignment context has been moved to the user message; this final fix has **not been rerun**. Later-added focused UI/memory and task regressions passed separately. Frontend tests/build and the browser result are reported in the PR description. Earlier evaluation reports are retained as historical records, not certification of the PR head. Further CI verification remains pending.
