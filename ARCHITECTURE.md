# Octopus architecture

Octopus is a local web app that runs a company of AI specialists in your project folder. You talk to one
orchestrator. It staffs the team, plans the work, and makes sure every change is reviewed in proportion to its risk and
checked before it reports back. Everything is TypeScript, in three npm workspaces.

```
shared/   the contract: domain types, request schemas (zod), the REST route map, run events
server/   Fastify + Node's built-in SQLite: the engine, tools, safety, Azure OpenAI, projects
web/      React + Vite: the conversation, the canvas, the code workspace, settings
```

## 1. The contract (`shared/`)

`shared/src/api.ts` lists every JSON route with its body and response type. The server registers handlers against it
(`server/src/http/router.ts`) and the web client calls through it (`web/src/lib/api.ts`), so a mismatch is a compile
error on both sides. Request bodies are zod schemas, validated by the server at the boundary. `shared/src/events.ts`
types every run event (`RunEventMap`) and the socket messages. There is no code generation step.

## 2. The server (`server/src/`)

| Folder | What it holds |
|---|---|
| `engine/` | `conversation.ts` (the cycle below), `agent.ts` (the tool loop every agent turn uses, with checkpoints), `collab.ts` (what reaches each agent while it works: messages, pins, change notices), `ownership.ts` (who may write which files), `prompts.ts` (standards, procedures, review lenses), `risk.ts` (how much review a change gets), `acceptance.ts` and `checks.ts` (requirement checks and the project's own tests), `solo.ts` (the Solo with specialists turn, which pauses for your reply), `org.ts` (hiring, channels, layout), `bus.ts` (event log), `chat.ts` (chats with one agent) |
| `tools/` | What agents can do: files, commands, web, team tools (hiring, tasks, requirements, messages, acceptance), review, skills, budget and todo. `index.ts` picks an agent's tools from its switches and its current job |
| `safety/` | `paths.ts` (the project file boundary) and `commands.ts` (the command policy) |
| `llm/` | `azure.ts` (Responses API, streaming, tool calls, usage) and `pricing.ts` |
| `services/` | MCP servers and the built-in browser (Playwright MCP), the OS folder dialog, exchange rates |
| `workspace/` | Project folders, file versions (`snapshot.ts`), trash, Git, the terminal and dev server (`processes.ts`), project overview |
| `catalog/` | The role library, team templates, skills (Markdown playbooks) and the built-in specialists: Designer, Explorer, Reviewer, Security reviewer and Verifier |
| `db/` | `sqlite.ts` (migrations and a typed table helper), `registry.ts` and `project.ts` |
| `http/` | The server, the typed router, one route file per area, and the WebSockets |

### Storage

| Store | Location | Contents |
|---|---|---|
| Registry | `~/.octopus/registry.db` (`OCTOPUS_HOME` changes the folder) | Projects (`workspaces`), settings (keys are encrypted), MCP servers, custom roles, skills and templates |
| Project | `<folder>/.octopus/octopus.db` | The company (agents, channels, departments, edges), sessions, runs, messages, tasks, the event log (`run_events`), file versions (`artifacts`), agent memory (`memory`) |
| Working notes | `<folder>/.octopus/work/` | The only part of `.octopus/` agents may write |

## 3. A conversation

The team works like a good engineering team: each part of the product has **one owner** who builds it end to end and is
the only one who writes its files, and **specialists** review it. Every user message runs one cycle in
`engine/conversation.ts`:

1. **Plan.** The orchestrator (the company's entry agent) reads the request, the project overview and, when needed, the
   code. It answers directly (`reply_to_user`), asks a real question (`ask_user`), or staffs and plans. For a feature or
   product it first records the user's asks as requirements (`set_requirements`, R1, R2...): whole asks in the user's
   words, never fragments or instructions such as "hurry". `cut_requirement` leaves one out only with a reason the user
   sees. It splits the work into parts: one tightly connected artifact (a game, a page) stays with one owner; several
   parts only when they are independent, with a first task that builds a runnable skeleton and pins the interfaces.
   `hire_agent` adds people from the role library, and `create_task` gives each part its owner, acceptance criteria,
   requirements, owned files, skills and specialists. `start_work` hands over, and refuses while a requirement has no
   task.
2. **Build.** Tasks start as soon as their dependencies are done, several at a time. Owners with disjoint files run side
   by side; a write into a file another running task owns is refused. An owner gets up to 150 steps. When the
   transcript nears the model's context window, the model writes a checkpoint of its work and the middle of the
   transcript is replaced by it, so long work continues without a cutoff. Repeating the same call three times in a row
   gets a reminder.
3. **Review.** When an owner finishes a round, the critics for that part review it in parallel. A code reviewer joins
   unless a code specialist is already attached, and each attached specialist critiques through its own lens (code,
   design or security). A trivial change, one file with a few lines and nothing sensitive, is not reviewed. A small code
   change, up to 2 files and 80 changed lines, gets a quick review from its diff. Larger changes get a full review. When
   all critics have finished, the owner gets their requested changes together in one revision, for a bounded number of
   rounds.
4. **Verify.** The project's own checks (tests, type checks, lint) run after changes; failures become fix tasks. Then
   an acceptance check runs: a verifier runs the product and judges every open requirement with evidence
   (`submit_acceptance`). Unmet requirements go back to the owner of the part, and only those are checked again. A
   requirement never checked stays owed into the next request.
5. **Report.** The orchestrator tells the user what changed, how it was verified and how to try it. The engine appends
   the requirement table and everything still open (blocked tasks, review comments left at the revision limit, failing
   checks), so the report cannot claim what did not happen.

**Sessions.** An agent's work on one deliverable is one session: its transcript, instructions, tools and what it has
read. A revision continues the owner's session with the feedback; a re-review continues the critic's session with only
the change since its review; a fix after failed checks or acceptance continues the build it fixes. Continuing keeps the
model's cached prompt prefix and avoids re-reading files. Sessions live in memory and end with the request. After a
restart, the next turn starts from a brief. `read_file` pages large files and answers an unchanged re-read with one
line.

**Talking while working** (`engine/collab.ts`). Each agent has its own chat (its sessions, shown when you click it);
the team chat is shared. Nothing is broadcast into every agent's context, since every line there is paid again on each
later step. Before an agent's next step it receives only what concerns it:
- messages to it (`message`): a working agent answers with `reply` from inside its work; an idle one answers in a short
  turn that continues its latest session; `wait` blocks only when asked, and a wait that would close a cycle is refused;
- pinned posts (`pin`): interfaces and decisions about files it works on, with the current version in every brief;
- change notices: another agent changed a file it has read, and its earlier read no longer counts.
A message that arrives as an agent finishes is answered right after. A message you send from an agent's chat goes to
that agent: into its work if it is busy, or as a task continuing its session if it is idle.

A follow-up continues the same conversation, team, tasks and files. A message sent while the team works is planned in
alongside the running tasks (`amend_task` delivers a change to a running task before its next step); an answer goes to
whoever asked. The Solo with specialists template works alone on each request. Its turn pauses for your reply after a
step or token limit (`SOLO_TURN_TOKENS`, 8,000,000 weighted tokens by default).

## 4. Events

Everything the user sees is an event. `bus.ts` writes each one to `run_events` (except streaming deltas) and then
delivers it to live sockets. The run socket sends a snapshot, replays every stored event after the client's last
`seq`, then streams; reconnecting never loses anything. The same socket carries follow-ups, approvals and controls.

## 5. Safety

Agents work in your folder, so the server enforces what they can do, whatever the model asks for:

- **Files.** Paths are relative to the project; `..`, absolute paths and symlinks that leave the folder are refused, and
  so are `.git/` and `.octopus/` (except `work/`). Every write is versioned and can be reverted; deletes go to a
  recoverable trash. Files that look like secrets always ask first.
- **Commands.** No shell: one program with arguments, a timeout, bounded output and an environment without your keys.
  `safety/commands.ts` classifies each command: builds, tests and read-only tools run; installs, Git changes and unknown
  programs are *medium*; pushing, publishing and remote access are *high*; `rm`, `git reset --hard`, `git clean`, force
  pushes, `sudo`, shells and paths outside the project are refused.
- **Approvals.** In *Ask for permission* mode, medium actions (editing files you already had, deleting, medium commands,
  MCP calls) wait for you with a diff or the exact command. In *Approve for me* mode only high-risk actions ask.
  Creating files and editing files the team created never ask.
- **Limit.** Programs the team runs (tests, scripts, builds, including code it wrote) run with your user's permissions.
  The policy decides which command runs; it does not sandbox what that program does.
- **The server** listens on 127.0.0.1, answers only requests addressed to `127.0.0.1` or `localhost`, and rejects
  cross-site requests. Keys are encrypted at rest and never returned to the browser. Previews run in a sandboxed page
  that can load files but cannot change anything.

## 6. Tests

- `server/test/`: the engine end to end through the HTTP API with a scripted model (`fakeModel.ts`): staffing, review
  rounds, checks, follow-ups, approvals, refused commands. Plus unit tests of the safety rules.
- `web/src/**/*.test.ts(x)`: the run reducer, stores and components.
- `.github/workflows/ci.yml` runs `npm ci`, typecheck, tests and build on every push to `main` and every pull request.
