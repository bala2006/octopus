# Capstone demo script (≈10 minutes)

**Setup (before presenting):** `make setup && make start`, then open http://localhost:8000. Create an empty folder such as `~/projects/todo-demo` inside an allowed root. Demo Mode needs no keys. If you want to show a real model, configure Azure in Settings beforehand.

| # | Time | Do | Say |
|---|---|---|---|
| 1 | 0:00 | Welcome screen → **Open project folder** → browse to `todo-demo` → pick **Ask** → *Use this folder* | "Everything is local. The folder is the agents' sandbox, and all app data goes into `todo-demo/.octopus/`." |
| 2 | 0:45 | **Create company** → *Software Startup* | "Eight agents and fourteen typed channels: delegate, review, debate, report, consult." |
| 3 | 1:15 | Click **Marcus** → quick config opens beside the node. Rename him, toggle **Terminal**, show the MCP section, then open the full inspector (Prompt, Behavior tabs). Watch the *Saved* indicator. | "Each agent has its own prompt, model (Azure deployment or Foundry model), tools, permission level and memory." |
| 4 | 2:15 | Drag a **Tech Lead** from the palette. Connect it to Marcus (a channel editor opens) and set the type to *Review*. Undo with Ctrl+Z, then **Auto-layout**. | "Connection rules: no self-loops, no duplicate channel types. Undo/redo and copy/paste work as expected." |
| 5 | 3:00 | **Chat** → Ava → "Please calculate 12*7" | Streaming, typing and tool phases, a collapsible tool call, metadata, regenerate. |
| 6 | 3:45 | Canvas → **Run** → goal *"Build a todo app with auth"*, mode **Autonomous**, permission **Ask**, Demo Mode on → Start | "The goal goes to the entry agent and then flows only along edges. The server enforces that." |
| 7 | 4:15 | Live view: point out the edge particles, node glow and live activity (*"Drafting proposal to Priya…"*) | The **debate**: CEO proposes sharing, PM objects, the CEO compromises, and both explicitly agree (consensus badge). |
| 8 | 5:00 | An approval card appears (*Priya wants to create docs/PRD.md*). Show the diff, then click **Always allow** | "Ask mode: dangerous actions need approval. 'Always allow' applies to this agent and action for the rest of the run." |
| 9 | 5:45 | Answer the next approvals (Marcus, Diego…) or pause (Space) and interject to Diego: "Keep it stdlib-only" | Pause, interject and resume. |
| 10 | 6:30 | The **review loop**: Marcus requests changes (plaintext passwords), and Diego revises to v2 with PBKDF2 | "Reviews loop until approval or max revisions." |
| 11 | 7:15 | QA's `run_code` → **Tools** tab shows real `unittest` output: *Ran 10 tests … OK* | "Nothing is faked. QA runs the tests in the sandbox and reports the actual output." |
| 12 | 8:00 | Completed → **Report** tab → **Artifacts**: `backend/todo_api.py` v1 → v2 **Diff**, version history, `frontend/index.html` **Preview** | "Real files, versioned, with author and reason. One-click revert and ZIP download." |
| 13 | 9:00 | Drag the **timeline** back to replay the debate | "Every event is persisted, so runs can be replayed and resumed." |
| 14 | 9:30 | (Optional) **Runs** → new run with **Max turns = 5** → it halts ("Budget: max turns reached") | Guardrails: turns, tokens, cost, time, and the loop detector. |

**Backup plan:** if anything misbehaves live, open a finished run from **Runs** and walk through it with the timeline scrubber.

**Talking points for Q&A:**
- Agents act only through a validated JSON action schema, which is provider-agnostic.
- Consensus detection is explicit (both sides must send `agreement`), not heuristic.
- The test suite covers edge enforcement, debate termination, review loops, budgets, the loop detector, path traversal and symlink escape, permission levels, and a full offline company run (`make test`).
