# Work on project files

Open a project to enter **Workspace**. You can edit your own files and the files your agents produce. The [developer workbench](developer-workbench.md) keeps the company agent beside the editor, while the activity rail preserves all team and canvas views.

## Find and edit a file

1. Select a file in the explorer. Use **Find a file** to filter by its path.
2. Edit the file in the code editor.
3. Press **Ctrl+S** on Windows or Linux, or **Command+S** on macOS, to save.

A dot on the file tab marks unsaved changes. Switching files, pages, or projects preserves drafts. Octopus stores open tabs and drafts in the browser's local IndexedDB database and restores them after a reload. Closing a dirty tab asks before discarding changes. Reloading or closing the browser also warns about unsaved drafts. If browser storage is unavailable, the workspace displays a warning so you can save before closing it.

Use **Reload file from disk** to read a newer saved version when your tab has no unsaved changes. If an agent or another editor changes the file before you save, Octopus displays a comparison. Choose **Keep my edits**, then save, or choose **Use disk version** to discard your draft. Octopus does not silently overwrite the detected change.

Text editing supports UTF-8 files up to 1 MB. Use Preview for supported binary formats and your local editor for larger or other encoded files.

## Create and organize files

- **New file** creates a file. Enter `src/components/Button.tsx` to create its parent folders too.
- **New folder** creates a folder, including empty folders shown in the explorer.
- Use the explorer’s **⋯** menu to rename, move, or delete files and folders, or download an individual file. Folder moves update open tabs. Save drafts inside a folder first.
- **Upload file** accepts assets and text files up to 20 MB. Choose a project-relative destination. Existing files are never overwritten.
- **Delete file** or **Delete folder** asks for confirmation and moves the item into `.octopus/trash`.
- **Undo** in the deletion notification restores files, binary assets, and empty folders. A restore refuses to overwrite a replacement at the original path.
- **Project trash** beside Files and Search lists recent deletions and restores them after navigation or a browser reload. Trash contents remain in your project until you remove them locally.

Dependency directories, Git internals, secrets, and Octopus metadata are excluded from the explorer. Folder operations refuse private files, dependencies, and symbolic links so a recursive move cannot silently include hidden data. Agent working documents remain available under **Artifacts**.

## Search and navigate

| Shortcut | Action |
| --- | --- |
| Ctrl+K or Ctrl+P, Command on macOS | Find a file or page |
| Ctrl+Shift+F, Command on macOS | Search project file contents |
| Ctrl+S, Command on macOS | Save the selected file |
| Alt+7 | Open Workspace |
| Alt+1 through Alt+6 | Canvas, Chat, Runs, Artifacts, Settings, Guide |

Quick open supports arrow keys, Enter, and Escape. Content search ignores case and opens results at their matching line. Search reports when results are limited. It searches saved files, not unsaved drafts.

## Preview an app

Select an HTML, Markdown, image, or PDF file, then choose **Preview**. HTML uses saved project files. Markdown includes your current edits. The viewport button switches between desktop and phone widths. Use **Refresh preview** after saving HTML or its dependencies.

For an app already running in a development server, enter an address such as `localhost:3000` and choose **Go**. You can also start a server from the Dev server panel below. Some servers and external websites block embedded previews or require permissions unavailable inside a sandboxed frame. Use **Open preview in new tab** for those sites.

The agent-controlled browser remains available in a live run's Browser view.

Drag the dividers to resize the explorer, browser preview, or command panel. You can also focus a divider with Tab and use arrow keys, Home, or End. Octopus remembers these sizes in your browser. The phone layout keeps horizontal dividers out of the way.

## Run a build or test

Choose **Commands**, enter one command, then choose **Run**. Commands execute in the project folder and stream output as it arrives. The exit code appears when they finish. Up and Down recall recent commands entered in the panel.

Examples include `npm ci`, `npm run build`, `python -m pytest`, `flutter test`, `dotnet build`, and `git status`. Commands use the project's permission level. Read-only and plan projects cannot execute commands. Other levels allow common development tools; danger mode permits more commands. Windows supports single commands without shell operators. SDKs must be installed and on PATH; their standard SDK path variables are retained.

One command can run per project, independently of its development server. Commands have a one-hour timeout and keep the latest 24,000 characters of output. **Stop command** cancels an active process. Commands and their latest output stay available when you hide the panel, navigate away, or reload the browser. The header’s **Command running** indicator returns you to its controls. Backend shutdown stops managed commands.

For a program that asks a simple question, type into **Command input** and choose **Send**, or press Enter. This sends one line to the process’s standard input. Use a system terminal for a full terminal session or applications requiring a TTY, such as interactive text editors.

## Start a development server

1. Choose **Commands**, then **Dev server**.
2. Enter your server command, such as `npm run dev -- --host 127.0.0.1`.
3. Choose **Start server**. Its live output appears below the command.
4. Enter the address from your server output, then choose **Open preview**.

One server can run per project. It stays active when you leave Workspace or switch projects. Return to the Dev server panel to see its current output or choose **Stop server**. Octopus stops managed processes when the backend shuts down. This feature uses local subprocess mode; Docker deployments can preview an externally started server.

Managed servers use project command permissions and the project folder. They have no interactive input. The panel keeps the latest 24,000 characters of output and indicates when older output has been removed. Start servers on a loopback address such as `127.0.0.1` for local development.

## Review Git changes

Open **Git changes** beside Files and Search. The panel shows the current branch and changed files in your repository. Open a file's review to compare **Working changes** and **Staged changes**, then use **Stage file** or **Unstage file**. These controls change individual index entries and preserve working file contents. Enter a message to **Commit staged**; the commit rejects a stale review or hidden staged content. UI commits skip hooks and signing, so use Commands or your Git client for those.

Use **Open file** to edit an existing changed file. Deleted files remain reviewable as patches. Untracked files have no patch until staged. Git review requires Git to be installed and the repository's root folder to be opened as the project. Use Commands or your Git client to commit and push. Explicit Workspace commands keep your user home so your Git identity and package configuration work as usual.
