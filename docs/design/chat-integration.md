# Chat integration

Octopus is a local coding workspace. The primary flow is to open a folder, choose a model and working mode, send a goal, review approvals and changes, and continue the same conversation. Existing teams and project files must remain intact.

The interface keeps the charcoal theme, blue actions, project sidebar and quiet conversation layout. Settings are available before opening a project. The folder picker uses a bounded browser with an always-visible footer, recent projects and laptop paths. Advanced permissions stay behind disclosure. New projects can start with a coding agent directly from the composer; custom teams remain available.

Model choice and reasoning effort belong to the composer and persist per project. A run records the selected model in its budget. Existing conversations show their recorded settings and explain how to change them for a new conversation. No provider keys are added automatically. Offline demo remains an explicit option.

| Problem | Change | Acceptance |
| --- | --- | --- |
| Folder dialog obscures the action | Compact browser, recent projects, sticky footer, concise Docker explanation | Open and create folders at desktop and phone sizes |
| Model label cannot select a model | Real provider/deployment picker and reasoning control | Selected values reach model requests and survive reload |
| Home has no model setup | Global settings route and Home model selector | Configure providers without creating a project |
| Empty project cannot send | Create a coding agent on the first explicit send | Prompt survives setup failures and starts exactly one run |
| History and settings mix old and new state | Lock recorded run settings; new conversation uses chosen defaults | Continue a run with its original settings; start another independently |

Validation covers real API model routing, project entry, draft preservation, composer actions, history, editor and changes navigation, settings, keyboard use, and mobile overflow. Live Azure generation requires a configured account and is reported separately from offline verification.

## Verification on 25 October 2026

- The backend suite passed 273 tests with 2 optional checks skipped. After the last message-display change, all 12 model, attachment and continuation checks passed again.
- All 73 frontend tests passed. TypeScript checking and the production build passed.
- Git review passed 11 focused checks, including two new cases for Docker ownership and rejecting an ancestor repository. The running editor displayed the mounted repository's changes after the fix.
- Browser checks covered folder creation and opening, Windows paths, Home prompt handoff, automatic coding-agent creation, model and mode selection, file upload and removal, follow-ups, restored history, editor file opening, Git changes, team canvas, activity, artifacts and global settings.
- At 390 x 720, the folder picker's Open action remained visible and document width stayed at 390 pixels. Desktop checks used 1366 x 900.
- The chat composer also fit at 390 x 844 with no horizontal overflow. The sidebar closed on Escape and returned focus to its toggle. Reasoning selection survived a reload.
- A stepped run advanced through the chat's Next turn button. The Stop button cancelled a separate paused run and showed confirmation.
- Azure request selection was verified with the test provider. A live Azure generation was not run because no provider is connected.

Git trust is scoped to the selected directory for each Git invocation. No global Git configuration is changed. Git review requires the selected folder itself to be a repository root.
