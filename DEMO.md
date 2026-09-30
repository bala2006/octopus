# Demo scripts

**1-minute video:** [`docs/media/octopus-demo.mp4`](docs/media/octopus-demo.mp4). It's recorded from the real app in Demo Mode and can be regenerated with `node scripts/demo-video/record.mjs`.

## Live demo (≈10 minutes)

**Setup.** Run `make setup && make start` and open http://localhost:8000. Demo Mode needs no keys. To show the real model, connect Azure OpenAI (`gpt-6-luna`) in **Settings → Model** first and turn Demo Mode off in the Run dialog.

| # | Time | Do | Say |
|---|---|---|---|
| 1 | 0:00 | Welcome → **Open project folder**. Your OS folder window opens; click *New Folder* → `todo-demo` → Open | "It's your own folder picker. Octopus creates and manages `todo-demo/.octopus/`, like `.git`, and git ignores it automatically." |
| 2 | 0:40 | **Create company** → scroll the 14 templates → *Software Startup* | "Eight agents in four departments, wired with typed channels: delegate down, report up, review, debate, consult." |
| 3 | 1:10 | Click **Marcus**. In quick config set **Reasoning effort → High**, look at tools and MCP, then double-click for the inspector | "Every agent has its own prompt, tools, permission level and how hard the model should think." |
| 4 | 2:00 | Drag a role in from **Roles**, connect it to Marcus, set the channel to *Review*. Ctrl+Z, then *Tidy up* | "Arrows go bottom → top between levels and side to side between peers. Undo, redo and autosave all work." |
| 5 | 2:40 | **Chat** → Ava → "Please calculate 12*7" | Streaming, tool calls, and exact token usage and cost on every message. |
| 6 | 3:20 | Canvas → **Run** → goal *"Build a todo app with auth"*, permission **Ask**, effort *Per agent* → Start | "The goal goes to the entry agent and only flows along channels; the server enforces that." |
| 7 | 3:50 | Live view: activity on nodes, messages along edges. Drag a node around | The **debate**: the CEO proposes sharing, the PM objects, the CEO compromises, and both explicitly agree. |
| 8 | 4:40 | An approval card appears → look at the diff → **Always allow** | "Ask mode: writes, commands and MCP calls need approval. 'Always allow' applies to this agent and action for the rest of the run." |
| 9 | 5:20 | Click the token/cost meter. Then **Settings → Appearance & currency → INR** and come back | "Exact Azure usage (uncached, cached, cache writes, output with reasoning) priced at gpt-6-luna rates, shown in rupees with live exchange rates." |
| 10 | 6:00 | The **review loop**: Marcus requests changes and Diego revises to v2 with PBKDF2. QA's `run_code` shows real `unittest` output | "Nothing is faked. QA runs the tests in the sandbox." |
| 11 | 7:00 | Completed → type *"Add a 'clear completed' button"* in the same box | "Runs are conversations. Same run, same team, same files; they build on it instead of starting over." |
| 12 | 7:40 | **Artifacts** → `todo_api.py` v1 → v2 **Diff** → **Project files** → `frontend/index.html` → **Preview** | "Real, versioned files in your folder, and a live preview of the app." |
| 13 | 8:30 | **Settings → MCP servers → Test browser** | "Octopus runs Playwright for the agents. Testers open this preview in their own tab and click through it." |
| 14 | 9:00 | **New company** → *Generate with AI*: "Build and launch a habit tracker with a marketing campaign" → Create. Then a *Self-organizing* run: the Founder hires heads, who hire specialists live | "Agents can grow and reconfigure the org themselves, within the permission level." |
| 15 | 9:40 | Open **Guide** | "Every feature, explained with screenshots." |

**Backup plan.** If anything misbehaves, open a finished run from **Runs** and replay it with the timeline scrubber.

**Q&A talking points**
- Agents act only through a validated JSON action schema. Consensus is explicit: both sides must send `agreement`.
- When an agent asks you something it offers options with a **Recommended** one, and you can always type your own answer.
- CI runs about 70 backend tests, unit tests and Playwright E2E on every push, including continuing a finished run.
