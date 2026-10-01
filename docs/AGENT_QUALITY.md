# Output quality: why a team did worse than one agent, and what changed

The goal is simple: what a team of agents produces in Octopus must be at least as good as one strong agent working
alone, and better on work that really splits. This doc covers the failed "3D shooter in one HTML file" run, the
research behind the fixes, and what is still left to do.

## The run that failed (7 agents, 2.46M tokens, 19 min, cancelled)

| Symptom in the report | Root cause in the code |
|---|---|
| CEO delegated design, build and QA **in parallel** at turn 1; QA found an empty workspace; design specs arrived after `index.html` existed | Nothing told agents to order dependent work. Rule 7 actively encouraged parallel `delegate` calls. |
| The builder asked design and QA questions mid-build, then built anyway; the answers landed after its turn | In a delegated sub-turn, answers can only arrive after the turn ends. The member prompt said "don't guess requirements". |
| `run_code` rejected 3×: "Shell operators are not allowed" at **danger** level | A raw substring check rejected `>`, `&&` and newlines even inside quoted `node -e` / `python -c` code. |
| `edit_file … old_string not found` | Edits were made from memory after long tool output was compacted. A wrong guess got no help and no tolerance for whitespace. |
| The builder "used all 40 tool rounds" with T-1 / T-4 still in progress | No warning before the round budget ran out, so the turn just stopped. |
| 7 agents for one file; managers ordered "audits" of a file that had just been written | The org designer *required* 2-6 departments with 2-3 people each. Manager rules said to always split the work. |
| Ran 19 min although the active-time limit is 15 | The time limit only counted finished turns, and this one turn ran long with nested delegations. |

## What the research says (and how it was applied)

- **[Why Do Multi-Agent LLM Systems Fail? (MAST, Cemri et al.)](https://arxiv.org/abs/2503.13657v2)** sorts failures into three groups: specification issues, inter-agent misalignment and missing task verification. Its case studies conclude these failures need structural redesign, not prompt tweaks.
  - Applied: verify-before-done gate, instant checks after every write, refusing questions nobody can answer, sequencing rules.
- **Cognition, [Don't Build Multi-Agents](https://old.cognition.ai/blog/dont-build-multi-agents) / [What's actually working](https://old.cognition.ai/blog/multi-agents-working):** splitting one task means a "game of telephone". Agents should see the same sources, plan and priors.
  - Applied: one owner per coherent deliverable; design input goes into the builder's brief; goal images are shown to every agent.
- **Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system):** parallel subagents pay off on breadth-first, independent work. Effort should scale with the task, and briefs need to be detailed.
  - Applied: parallel delegation only for independent work that can start now; small goals use one builder and at most one check after the build; leaner generated orgs.
- **SWE-agent (agent-computer interface):** a linter in the edit loop and concise, actionable tool feedback are large wins.
  - Applied: syntax checks for `.py`, `.json`, `.js` and inline `<script>` in the tool result; a missed edit shows the real text where it belongs; edits tolerate an indentation shift.
- **Reliability of tool calling:** native function calling avoids the parse and repair failures of a JSON envelope.
  - Applied: Chat Completions endpoints (Azure chat style, litellm) now use native tools too. Only reasoning deployments on chat-only endpoints and the offline demo keep the envelope.

## Shipped, in stages (one commit each)

1. Live browser view, image goals, delegation messages collapsed, and the run-quality fixes listed above.
2. Instant syntax checks after every write; whitespace-tolerant `edit_file`.
3. Native function calling on Chat Completions.
4. Verify before done: an agent that can run code or browse, and finishes with unexercised code changes or a failing check, is sent back once inside the same turn. Toggle: *Limits & budget*.
5. Redesigned start page.

## Next stages (not done yet)

- **Measure:** run `scripts/bench.py` with a real model, single agent vs. team on the same tasks, and gate releases on it. Every claim above should be backed by a number.
- **Fresh-context reviewer (evaluator-optimizer):** after the build, one reviewer with a clean context checks the result against the goal and the running app, then hands concrete fixes back to the same builder.
- **Shared plan file:** one `.octopus/work/PLAN.md` todo list that every agent reads and updates, instead of retelling the plan in messages.
- **Cache-stable compaction:** compact tool rounds in blocks so the prompt prefix stays cached for several rounds. Count cached input separately in budgets: 2.46M "tokens" cost $0.13, so most of it was cached.
- **Org generator through native tools:** its company spec is still requested as JSON.
