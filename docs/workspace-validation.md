# Workspace validation

Verified on Windows on 6 October 2026 with Python 3.12.14, Node 24.19.0, and Chromium.

## Verified workflows

| Workflow | Evidence |
| --- | --- |
| Text editing | Create, edit, save, rename, delete, undo, and compare disk conflicts through the browser; assert the actual files afterward. |
| Draft recovery | Modify without saving, read the real IndexedDB transaction, reload the browser, recover the draft, then save it to disk. |
| Assets and folders | Upload and download binary bytes, move a folder with open tabs, delete/undo the folder, then restore an asset from Trash after reload. |
| App preview | Click a static HTML preview; start a real HTTP server; preview its app, fetch its files, use local storage, navigate away and return, then stop the server. |
| Git review | Read a real repository’s working and staged patches; stage and unstage files while preserving working contents. Backend cases cover new repositories, detached HEAD, renames, and deletes. |
| Layout | Desktop and 390 px phone checks, keyboard and pointer resizing, navigation shortcuts, and no horizontal page overflow. |
| Real project build | Octopus’s project command endpoint ran `npm run build --prefix frontend` against this repository. TypeScript and Vite completed with exit code 0 and no timeout. |
| Process lifecycle | Start, stop, restart, shutdown cleanup, bounded live logs, and concurrent start/stop without leaving an inaccessible server. |
| Live commands | Stream output before completion, navigate away and return, send prompt input, inspect the resulting file, cancel a running process, clear output, and enforce permissions and timeouts. |

The complete backend suite passed **260 tests with one skip**. The frontend suite passed **63 tests**. The complete Chromium suite passed **17 tests**, including eight workspace cases. After the final command-environment update, nine focused backend checks passed, including an offline npm install and a Git commit in an isolated repository. Typechecking, production build, API generation, and workspace formatting checks passed.

## Reproduce

On Windows, run `./octopus.ps1 setup`, then `./octopus.ps1 test`. For browser checks, run `npm run build` and `npm run e2e` in `frontend`; install Playwright Chromium first with `npx playwright install chromium` if needed. The browser tests use isolated project folders and a dedicated backend, not your working repository’s Git index.

## Scope of this evidence

Live Azure agent quality and performance against Codex or Claude Code have not been benchmarked. The agent-run browser tests use Demo Mode. These checks establish the local development workflows and regression coverage, not product parity or hosted CI results.

Workspace commands stream output, accept line input, and have a one-hour limit. Managed servers are separate, persist across page navigation, and run until stopped or backend shutdown. Docker deployments cannot start these managed local processes. Full-screen terminal applications requiring a TTY still need a system terminal.
