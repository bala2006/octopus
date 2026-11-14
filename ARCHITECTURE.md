# Octopus architecture

Octopus is a local web app that runs a company of AI specialists in your project folder. You talk to one
orchestrator; it staffs the team, plans the work, and makes sure every change is reviewed and checked before it reports
back. Everything is TypeScript, in three npm workspaces.

```
shared/   the contract: domain types, request schemas (zod), the REST route map, run events
server/   Fastify + Node's built-in SQLite: the engine, tools, safety, Azure OpenAI, projects
web/      React + Vite: the conversation, the canvas, the code workspace, settings
```

## 1. The contract (`shared/`)

`shared/src/api.ts` lists every JSON route with its body and response type. The server registers handlers against it
(`server/src/http/router.ts`) and the web client calls through it (`web/src/lib/api.ts`), so a mismatch is a compile
error on both sides. Request bodies are zod schemas, validated by the server at the boundary. `events.ts` types every
run event (`RunEventMap`) and the socket messages. There is no code generation.

## 2. The server (`server/src/`)

| Folder | What it holds |
|---|---|
| `engine/` | `conversation.ts` (the cycle below), `agent.ts` (the tool loop every agent turn uses), `prompts.ts` (standards and procedures), `org.ts` (hiring, channels, layout), `bus.ts` (event log), `chat.ts` (direct chats) |
| `tools/` | What agents can do: files, commands, web, team and planning tools, memory. `index.ts` picks an agent's tools from its switches and its current job |
| `safety/` | `paths.ts` (the project file boundary) and `commands.ts` (the command policy) |
| `llm/` | `azure.ts` (Responses API, streaming, tool calls, usage) and `pricing.ts` |
| `services/` | MCP servers and the built-in browser, the OS folder dialog, exchange rates |
| `workspace/` | Project folders, file history, trash, Git, the terminal and dev server, project overview and checks |
| `catalog/` | The role library, team templates and skills (Markdown playbooks) |
| `db/` | `sqlite.ts` (migrations and a typed table helper), `registry.ts` and `project.ts` |
| `http/` | The server, the typed router, one route file per area, and the WebSockets |

### Storage

| Store | Location | Contents |
|---|---|---|
| Registry | `~/.octopus/registry.db` | Projects, settings, the encrypted Azure key, MCP servers, custom roles, skills and templates |
| Project | `<folder>/.octopus/octopus.db` | The company (agents, channels, departments), conversations, messages, tasks, the event log, file versions, agent memory |
| Working notes | `<folder>/.octopus/work/` | The only part of `.octopus/` agents may write |

## 3. A conversation

Every user message runs one cycle in `engine/conversation.ts`:

1. **Plan.** The orchestrator (the company's entry agent) reads the request, the project overview and, when needed, the
   code. It answers directly (`reply_to_user`), asks a real question (`ask_user`), or staffs and plans. For a feature or
   product it first records the user's asks as requirements (`set_requirements`, R1, R2...); `cut_requirement` leaves one
   out only with a reason the user sees. `hire_agent` adds a specialist from the role library to the canvas, and
   `create_task` assigns work with acceptance criteria, dependencies, the requirements it delivers, the paths it owns
   and the skills to follow. `start_work` hands over, and refuses while a requirement has no task. A message addressed to
   one specialist (`@Name`) skips planning.
2. **Build.** Tasks start as soon as their dependencies are done, several at a time, each run by its owner through the
   shared agent loop with their own tools, memory, skills and the shared engineering standards. Tasks that write run side
   by side only when the paths they own do not overlap; a write into a path another running task owns is refused.
   Small documents from finished dependencies come inside the brief. Specialists can ask a teammate (`ask_teammate`) or
   the user, and finish with `complete_task` or `block_task`.
3. **Review.** Every task that changed files is reviewed by someone else: the author's department lead, a reviewer on
   the team, or a tech lead the engine hires. A change of up to 80 lines is reviewed from its diff in one step. Requested
   changes go back to the author for a bounded number of rounds.
4. **Verify.** The project's own checks (tests, type checks, lint) run after changes; failures become fix tasks. Then
   an acceptance check: a verifier (a QA engineer, else someone with a browser who did not build it, else a hired QA
   engineer) runs the product and judges every open requirement with evidence (`submit_acceptance`). Unmet
   requirements go back to the task that owns them, and only those are checked again, for a bounded number of rounds.
5. **Report.** The orchestrator tells the user what changed, how it was verified and how to try it. The engine appends
   the requirement table and everything still open (blocked tasks, review comments left at the revision limit, failing
   checks), so the report cannot claim what did not happen.

**Sessions.** An agent's work on one deliverable is one session: its transcript, instructions, tools and what it has
read. A revision continues the author's session with the feedback; a re-review continues the reviewer's session with
only the change since its review; a fix after failed checks or acceptance continues the build it fixes; a re-check
continues the verifier's session. Continuing keeps the model's cached prompt prefix and avoids re-reading files.
Sessions live in memory and end with the request; after a restart, an error or past a size limit, the next turn starts
from a brief. `read_file` pages large files and answers an unchanged re-read with one line.

A follow-up continues the same conversation, team, tasks and files. A message sent while the team works is planned in
alongside the running tasks (`amend_task` delivers a change to a running task before its next step); an answer goes to
whoever asked. Each task has a step limit, and a task near it is told to wrap up. A conversation has no token, cost or
time cap; any message continues it.

## 4. Events

Everything the user sees is an event. `bus.ts` writes each one to `run_events` (except streaming deltas) and then
delivers it to live sockets. The run socket sends a snapshot, replays every stored event after the client's last
`seq`, then streams; reconnecting never loses anything. The same socket carries follow-ups, approvals and controls.

## 5. Safety

Agents work in your folder, so the server enforces what they can do, whatever the model asks for:

- **Files.** Paths are relative to the project; `..`, absolute paths and symlinks that leave the folder are refused, and
  so are `.git/` and `.octopus/` (except `work/`). Every write is versioned and can be reverted; deletes go to a
  recoverable trash.
- **Commands.** No shell: one program with arguments, a timeout, bounded output and an environment without your keys.
  `safety/commands.ts` classifies each command: builds, tests and read-only tools run; installs, Git changes and unknown
  programs are *medium*; pushing, publishing and remote access are *high*; `rm`, `git reset --hard`, `git clean`, force
  pushes, `sudo`, shells and paths outside the project are refused.
- **Approvals.** In *Ask for permission* mode, medium actions (editing files you already had, deleting, medium commands,
  MCP calls) wait for you with a diff or the exact command. In *Approve for me* mode only high-risk actions ask.
  Creating files and editing files the team created never ask. Reading secret-looking files always asks.
- **Limit.** Programs the team runs (tests, scripts, builds, including code it wrote) run with your user's permissions.
  The policy decides which command runs; it does not sandbox what that program does.
- **The server** listens on 127.0.0.1, answers only requests addressed to `127.0.0.1` or `localhost`, and rejects
  cross-site requests. Keys are encrypted at rest and never returned to the browser. Previews run in a CSP sandbox.

## 6. Tests

- `server/test/`: the engine end to end through the HTTP API with a scripted model (staffing, review rounds, checks,
  follow-ups, approvals, refused commands), plus unit tests of the safety rules.
- `web/src/**/*.test.ts(x)`: the run reducer, stores and components.
