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
chat. Octopus, the orchestrator, works out who the job needs, hires those specialists onto a live org chart, briefs
them, and runs the work: designers, engineers, reviewers and QA, in parallel where they can be. Every change is reviewed
by someone other than its author and checked with your project's own tests before Octopus reports back. Then you reply
with feedback or the next request, and the same team carries on.

## How it works

1. **You ask.** In the conversation, as in any coding assistant. Attach files, screenshots or code selections.
2. **Octopus staffs the work.** It reads the request and your code, answers directly when no work is needed, asks
   when a decision is genuinely yours, and otherwise hires from the role library (frontend, backend, design, QA,
   security, data, writing, …) and creates tasks with owners, acceptance criteria and an order. New hires appear on
   the canvas as they join.
3. **The team builds.** Each specialist works on their task with real tools: reading and editing files, running builds
   and tests, using a browser, searching the web, your MCP servers. They consult each other and keep notes that
   carry over to the next request.
4. **Quality is built in.** Every change gets an independent review, and requested changes go back to the author. Your
   project's tests, type checks and lint run after changes, and failures become fix tasks. The shared engineering
   standards ask for complete code, existing conventions, real copy and honest reporting.
5. **You get a report** with what changed, where, how it was verified and what is open. Your next message continues
   the conversation.

You can also design the team yourself on the canvas, start from a template (Software Startup, Web App Studio, Full
Company, …), chat one-on-one with any agent, or work in the built-in code workspace (editor, Git, terminal, preview).

## Safe in your project

Agents work in your real folder, so the server enforces the limits, not the model:

- **Nothing is lost.** Every file the team changes is versioned with its author and reason; *Changes* shows diffs and
  reverts any file. Deletes go to a recoverable trash.
- **Destructive commands never run.** Commands run without a shell, with a timeout and without your keys. `rm`,
  `git reset --hard`, `git clean`, force pushes, `sudo`, shells and paths outside the project are refused.
- **You approve what matters.** *Ask for permission* asks before the team edits files you already had, deletes, installs,
  changes Git history or uses an MCP server. *Approve for me* asks only for high-risk actions like pushing or
  publishing. Creating new files never asks.
- **Local only.** The server listens on `127.0.0.1`, rejects requests from other sites, and keeps your Azure key
  encrypted on your computer.

One limit to know: when the team runs your project's code (`npm test`, `node script.js`), that program runs with your
user's permissions. The policy checks which command runs, not what the program does, so use Git (or a worktree from
the project picker) for work you cannot afford to lose.

## Quick start

Requirements: **Node.js 22.22+** (24 recommended) and an **Azure OpenAI** deployment (`gpt-6-luna` by default).

```bash
npm install
npm start          # builds the app when needed and serves http://127.0.0.1:8000
# or, with hot reload:
npm run dev
```

1. Open **Settings → Model**, paste your Azure endpoint as the portal shows it, add the key (or use Microsoft Entra ID
   with `az login`), and press **Test connection**.
2. **Open project folder**, then type what you want: *"Build a landing page with a pricing section"*.
3. Watch the team on the canvas, approve what it asks, and reply when it reports.

Settings can also come from a `.env` file; see [`.env.example`](.env.example). Use `OCTOPUS_PORT` to change the port.

## Costs

Octopus reads the exact usage Azure reports for each call and prices it at gpt-6-luna Standard rates (USD per 1M
tokens: $0.10 input, $0.01 cached input, $0.50 output, with long-prompt and regional surcharges). You can override the
rates, show costs in your currency, and cap every conversation by model calls, tokens, cost and active time.

## Development

```bash
npm run typecheck   # all three workspaces
npm test            # server engine tests (scripted model, no credentials) and web tests
npm run build
```

The code is TypeScript end to end: `shared/` holds the contract, `server/` the engine and API, `web/` the app. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how a conversation runs and how safety is enforced.

## Screenshots

| | |
|---|---|
| ![Welcome](docs/screenshots/01-welcome.png) | ![Canvas and quick config](docs/screenshots/03-canvas-quick-config.png) |
| ![Live run](docs/screenshots/05-live-run.png) | ![Approval](docs/screenshots/09-approval.png) |
| ![Artifacts diff](docs/screenshots/07-artifacts-diff.png) | ![Team view](docs/screenshots/14-team-view.png) |

## Community

Octopus is released under the [MIT License](LICENSE). Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull
request, [SECURITY.md](SECURITY.md) for vulnerability reports, and [SUPPORT.md](SUPPORT.md) for help.
