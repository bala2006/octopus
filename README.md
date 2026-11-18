<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/banner-dark.png">
    <img src="docs/brand/banner-light.png" alt="Octopus: your AI company, in one folder" width="760">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/bala2006/octopus/actions/workflows/ci.yml"><img src="https://github.com/bala2006/octopus/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f855a" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/runs-locally-6B8440" alt="Runs locally">
  <img src="https://img.shields.io/badge/model-Azure%20OpenAI-66839A" alt="Azure OpenAI">
</p>

**Octopus** is a one-person company. You open a project folder and say what you want, the way you would in a coding
chat. Octopus, the team lead, works out who the job needs, hires those specialists onto a live org chart, briefs
them, and runs the work: designers, engineers, reviewers and QA, in parallel where they can be. Changes are reviewed in
proportion to their risk, and your project's own tests and checks run after them before Octopus reports back. Then you
reply with feedback or the next request, and the same team carries on.

## How it works

1. **You ask.** In the conversation, as in any coding assistant. Attach files or images.
2. **Octopus staffs the work.** It reads the request and your code, answers directly when no work is needed, asks
   when a decision is genuinely yours, and otherwise hires from the role library (frontend, backend, design, QA,
   security and more). It creates tasks with owners, acceptance criteria and an order. New hires appear on the team's
   org chart as they join.
3. **The team builds.** Each specialist works on its task with real tools: reading and editing files, running builds
   and tests, using a browser, searching the web and your MCP servers. Specialists consult each other and keep notes
   that carry over to the next request.
4. **Changes are checked.** Your asks become numbered requirements in your words, and anything left out is shown with
   the reason. Each part has one owner who builds it. A code reviewer checks code changes, and any specialist attached
   to the part (for example the Designer or the Security reviewer) critiques it through its own lens. A small code
   change gets a quick review from its diff. A trivial one-file edit gets no review. Your project's tests and checks
   run after changes. Then a verifier runs the product and judges each requirement with evidence. Failures go back to
   the owner of that part.
5. **You get a report** with what changed, where and how it was verified, followed by each requirement's status and
   everything still open. Your next message continues the conversation.

The app has three main spaces, listed in the **View** menu and the sidebar: **Chats**, **Changes** and **History**.
**Chats** holds the conversation with the team lead, the **Canvas** tab where you see and design the team's org chart,
and chat windows for talking to one agent. A project can hold several teams. The team switcher in the header changes
between them, and **New team** starts one from a template such as Software Startup or Web App Studio. **Changes** lists
every file a conversation changed, with diffs and revert. **History** lists every conversation with its cost and
outcome. Inside a conversation you can also open the **Files** (editor), **Git changes**, **Browser**, **Review** and
**Usage** tabs.

## Safe in your project

Agents work in your real folder, so the server enforces the limits, not the model:

- **Nothing is lost.** Every file the team changes is versioned; *Changes* shows diffs and reverts any file. Deletes go
  to a recoverable trash.
- **Destructive commands never run.** Commands run without a shell, with a timeout and without your keys. `rm`,
  `git reset --hard`, `git clean`, force pushes, `sudo`, shells and paths outside the project are refused.
- **You approve what matters.** *Ask for permission* asks before the team edits files you already had, deletes,
  installs, changes Git history, runs unfamiliar programs or uses an MCP server. *Approve for me* asks only for
  high-risk actions such as pushing, publishing, deploying or reading files that look like secrets. Creating new files
  never asks.
- **Local only.** The server listens on `127.0.0.1`, answers only requests addressed to `127.0.0.1` or `localhost`,
  rejects cross-site requests, and keeps your Azure key encrypted on your computer.

One limit to know: when the team runs your project's code (`npm test`, `node script.js`), that program runs with your
user's permissions. The policy checks which command runs, not what the program does, so use Git (or a worktree from
the project picker) for work you cannot afford to lose.

## Quick start

Requirements: **Node.js 22.22.2 or newer** (`.nvmrc` pins 24) and an **Azure OpenAI** deployment (`gpt-6-luna` by
default).

```bash
npm install
npm start          # builds the app when needed and serves http://127.0.0.1:8000
# or, with hot reload:
npm run dev
```

1. Open **Settings → Model**, paste your Azure endpoint as the portal shows it, add the key (or use Microsoft Entra ID
   with `az login`), and press **Test connection**.
2. **Open project folder** from the **File** menu, then type what you want: *"Build a landing page with a pricing
   section"*.
3. Watch the team work next to the chat, approve what it asks, and reply when it reports.

Settings can also come from a `.env` file; see [`.env.example`](.env.example). Use `OCTOPUS_PORT` to change the port.

## Costs

Octopus reads the exact usage Azure reports for each call and prices it at gpt-6-luna Standard rates (USD per 1M
tokens: $0.10 input, $0.01 cached input, $0.50 output). A prompt over 272,000 input tokens costs double on input and
1.5 times on output. Data Zone and regional deployments add 10%. You can override the rates in **Settings → Model →
Advanced**, and show costs in your currency under **Preferences**. A task that nears its step limit is told to wrap up.

## Development

```bash
npm run typecheck   # all three workspaces
npm test            # server engine tests (scripted model, no credentials) and web tests
npm run build
```

The code is TypeScript end to end: `shared/` holds the contract, `server/` the engine and API, `web/` the app. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how a conversation runs and how safety is enforced.

## Screenshots

Captured from the running app in dark mode. Light versions are in `web/public/guide/`.

| | |
|---|---|
| ![Home](web/public/guide/welcome-dark.jpg) | ![Live conversation](web/public/guide/run-dark.jpg) |
| ![Team](web/public/guide/canvas-dark.jpg) | ![Agent quick config](web/public/guide/quick-config-dark.jpg) |
| ![Changes and diffs](web/public/guide/artifacts-dark.jpg) | ![Settings](web/public/guide/settings-dark.jpg) |

## Community

Octopus is released under the [MIT License](LICENSE). Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, [SECURITY.md](SECURITY.md) for vulnerability reports, and [SUPPORT.md](SUPPORT.md) for help.
