# Developer workbench

Octopus opens projects in **Workspace**. The workbench combines the explorer, code editor, command output, browser preview, source control, and company agent conversation. The activity rail keeps Canvas, direct Chat, Runs, Artifacts, Settings, and Guide available.

## Work with an agent beside your code

Create or select a company, then use the agent panel on the right. A quick request starts a real company run without leaving the editor. The panel streams replies, shows changed files, asks for approvals, and supports pause, resume, stop, and follow-up messages on the same run. **Full run** opens the graph, task board, tool log, browser, and report.

Use **New conversation** to start a separate run. History and unfinished composer drafts are scoped to the project and company. Changing companies switches their conversation history and drafts. Closing the panel does not stop its run.

| Mode | Behavior |
| --- | --- |
| Agent | Implement and verify using the project's permission level. Ask projects require approvals; danger projects do not. |
| Plan | Propose changes in the existing shadow-file plan system. Project files are unchanged. |
| Ask | Read and explain. File writes and commands are disabled. |

Modes cannot elevate a read-only or plan project's permissions. A continuing conversation keeps the permission level it started with; start a new conversation to change mode. The panel labels **Offline demo** when no live model is configured. Demo results are scripted; configure a model in Settings for real coding assistance.

Attach context explicitly with **@ Files**, **Current**, or **Selection**. File attachments use the latest editor draft when the file is open, or read its saved content when it is closed. A selection is a snapshot with its path and line range. Unsaved snapshots are labelled and never saved just because they were attached. Large context is bounded and marked as truncated. The advanced run dialog also provides image and file attachments and budget controls.

Root `AGENTS.md` and `CLAUDE.md` instructions are loaded for each agent turn. `AGENTS.md` takes precedence when they conflict. Agents are instructed to read more specific nested `AGENTS.md` files before editing their directories. Guidance stays inside the project sandbox and does not grant extra permissions.

## Edit, run, and review

The editor keeps per-file undo models while tabs remain open. **Save all** saves dirty tabs using each file's revision and retains drafts if a save fails. Clean tabs automatically refresh after disk changes. A background read does not replace a dirty draft or a newer completed save. Existing conflict comparisons, draft recovery, file management, persistent Trash, and preview controls are retained.

The command panel discovers tasks from root and immediate-child `package.json`, Makefile, Cargo, Go, and pytest manifests. It respects the declared JavaScript package manager or lockfile. Selecting a task prepares its command and working directory; **Run** or **Start server** executes it explicitly. The working directory is editable, relative to the project, and cannot escape the sandbox. Command output can be placed in the agent composer with **Explain output**; the request is sent only when you submit it. Commands remain subprocess sessions, not full TTY terminals.

Git review still compares working and staged patches. Stage individual files and enter a message to **Commit staged**. The commit includes staged content, preserves unstaged edits, rejects a changed index since the review, and refuses hidden/private staged paths. Octopus serializes its own staging and commit operations. Other Git clients should not stage concurrently with a commit. UI commits skip repository hooks and signing; use Commands or your Git client for those. Commit uses your normal Git identity and does not push.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+K or Ctrl/Cmd+P | Quick open |
| Ctrl/Cmd+L | Focus the company agent composer |
| Ctrl/Cmd+I in the editor | Attach selected code and focus the composer |
| Ctrl/Cmd+S | Save the current file |
| Ctrl/Cmd+Shift+S | Save all dirty tabs |
| Ctrl/Cmd+Shift+F | Search project contents |
| Ctrl/Cmd+` | Toggle command output |
| Alt+1 / Alt+7 | Canvas / Workspace |

Resize the explorer, preview, command output, and agent pane with their dividers. Mobile uses a dismissible agent overlay so the editor remains available. The company selector in the agent header works on mobile.
