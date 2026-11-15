# One writer, read-only specialists

Status: Phase 1 in progress on `feat/one-writer`, branched from `main` at `0285ddf`.

## Goal

One agent writes the product files of each part. Every other agent reads, runs and looks, then reports structured
findings. The writer answers each finding before the part can finish. System prompts are short, specific to the role,
and do not conflict with the user's request.

## Starting point

The engine already has review tasks, a critic set per part, one revision for the owner with all feedback together,
and no self-review. The gaps, checked in code:

1. Write and command rights come from per-agent switches and the mode. The designer and QA templates set
   `file_write: true` (`catalog/roles.ts`). Critics in review mode received `run_command`, which can write files.
2. A specialist may be a writer. `addTask` only rejects an owner who is also a specialist.
3. The acceptance verifier may be any non-lead agent, including a writer (`verifierFor` fallback).
4. Review comments are one free-text string (`submit_review`). The writer cannot answer each finding, and the engine
   cannot gate completion on them.
5. Reviews are not pinned to a file state, so edits made after a review are never reviewed.
6. The writer prompt adds a standards block, and playbooks add rules that conflict with the user's brief (a module
   split for a one-file request, a CDN import map for a no-CDN request, a different test-hook name).

## Phases

### Phase 1: kinds and enforcement

- `catalog/kinds.ts`: each agent is a `writer`, a `critic` or the `lead`. Built-in roles have a fixed kind. A custom
  role keeps the meaning of its file-write switch: writes make it a writer.
- `tools/index.ts`: `policyFor(agent, mode)` is the only place that decides writes, commands, browser and MCP.
  - Writer in a build turn: writes and all commands.
  - Critic in review: no writes, no commands, no MCP. Browser stays, because the engine saves screenshots itself.
  - Critic in acceptance: may start the app (`start_dev_server`) and browse. No other commands.
  - Lead, and anyone in other modes: no writes.
- `engine/conversation.ts`: `staffingError` on `create_task`. The owner must be a writer. Specialists must be critics
  and must not be the owner. Critic selection and the verifier pool exclude writers.
- Tests: `server/test/policy.test.ts` covers `kindOf`, `policyFor` per kind and mode, `staffingError`, and the tool
  names each mode returns.
- Done when: typecheck and every server test pass.

### Phase 2: structured findings, response gate, pinned rounds

- `submit_review` takes `verdict` and `findings[]`. Each finding has `severity` (blocker, major or minor), `file`,
  `lines`, `problem`, `evidence` and `fix`. `request_changes` needs at least one blocker or major finding.
- The engine gives each finding an id (F1, F2, ...) and records the round's artifact fingerprint, a hash of the task's
  files.
- A new writer tool, `respond_to_findings`, marks each open finding `fixed` or `disputed`, with a reason.
- `complete_task` is refused while a blocker or major finding is open, and while the files changed after the latest
  round (a stale round).
- The next round's critics mark each earlier finding resolved or still open. New problems get new ids.
- Done when: unit tests cover the gate and the stale check, and a conversation test shows that a writer cannot
  complete with an open finding.

### Phase 3: minimal prompts

- Writer prompt: identity, one mandate, and the finding contract, about eight lines. The standards block is removed.
  Its three must-keep rules move into the writer mandate: verify before saying done, report honestly, stay within the
  brief.
- Critic prompts: one short prompt per lens (code quality, duplication, requirements, visual, play, security).
- Lead procedure: trimmed to planning rules.
- Playbooks: at most one per writer. Remove the lines that conflict with the brief: the CDN import map, the module
  split when the brief asks for one file, and the test-hook names. Critics get checklists, not playbooks.
- Every prompt says that the user's request wins. A conflict is shown to the user, not resolved silently.
- Done when: prompt snapshot tests pass, and no shipped playbook contradicts the single-file or no-CDN rules.

### Phase 4: specialist roster

- New critic roles: code quality and duplication checker.
- A build task that writes code gets both critics by default. Whether they always run or are chosen per task is an
  open question for the user.
- Done when: role library tests pass, and a build task created by the lead receives both critics.

### Phase 5: verification and pull request

- Typecheck, server tests and web tests.
- One live run on the T3 brief once the user restarts the server. This spends Azure tokens, so it waits for the user.

## Decision log

| # | Decision | Why | Evidence |
|---|---|---|---|
| 1 | Kind comes from the role, not from a per-agent flag | The designer template had `file_write: true` while being a critic | `catalog/roles.ts`, agents table |
| 2 | Critics get no commands | `run_command` can write files | `tools/index.ts`, reviewer mode |
| 3 | Acceptance keeps `start_dev_server` | The verifier must run the app to check it | acceptance procedure |
| 4 | Custom roles keep the file-write meaning | Changing them silently would change users' teams | `catalog/roles.ts`, Settings |
| 5 | A spec document is written by a technical writer, not the PM | The PM is a critic and cannot write files | `server/test/conversation.test.ts` |
