# Conversation layout

## Design

The supplied Codex screenshot guides the visual hierarchy: a narrow activity rail, a project sidebar, a quiet header, a wide conversation, and a rounded composer at the bottom. The shared frame uses neutral charcoal colors and a blue action color. Octopus keeps its own brand.

## Usage

Opening a project enters `/w/:wid/agent`. The activity rail opens the editor, team canvas, runs, artifacts, settings, and guide. The sidebar lists projects and the selected company's run conversations. Direct agent sessions keep their existing `/chat` route.

On Home, choose a project and enter a prompt. **Continue** opens a new conversation with that prompt. The prompt waits until a company is available. If the selected company already has a draft, a dialog asks before replacing it. Opening or carrying a prompt does not start an AI run.

## Ownership

`DesktopLayout({ header, children })` owns the frame, project navigation, mobile drawer, and theme control. `AppShell` owns project route context and the existing company switcher and status indicators. `AgentPage` adapts the project file list and navigation callbacks to `AgentPanel`.

`AgentPanel` retains run creation, interjections, streaming, approvals, questions, and its composer. Its `presentation` value selects either the compact editor panel or the full conversation layout. `WorkspacePage` retains editor tabs, drafts, file operations, preview, commands, and its optional agent panel.

`workbenchStore` retains workspace/company keys for drafts and selected runs. Home prompts are staged per workspace, then imported atomically after company selection. Importing selects a new conversation, preserves other projects and companies, and consumes the staged prompt once.

## Synthesis decision

Three designs were compared. A stable project shell preserved the existing route owners. An editor-first design made conversation central inside `WorkspacePage`. A shared home/project shell added a prompt handoff.

The chosen design uses the stable shell, adds the shared home frame, and introduces a dedicated conversation route. The independent judge recommended the same combination. Reworking the editor into a conversation layout would add pane coordination and risk its draft and selection behavior. Moving direct sessions into the shell would mix the separate session and run models.

The configured alternate model names were unavailable. The design candidates and judge used the available GPT-6 Luna model. A temporary grounding file was inaccessible to the candidates; they inspected the repository and used the supplied source summary.

## Responsive behavior

The project sidebar becomes a drawer below 768 pixels. The drawer supports Escape, keyboard focus containment, and focus return. The optional project details pane opens by default on wide desktops and overlays the conversation at smaller widths. The composer remains below the independently scrollable content. Short desktop windows use a more compact home layout.

## Validation

- [x] Trace the existing layout and conversation flow.
- [x] Compare distinct designs and screen their interfaces and state ownership.
- [x] Implement the shared shell, home, sidebar, and conversation page.
- [x] Pass TypeScript checking and 13 focused draft, context, and component tests.
- [x] Complete the production build and browser inspection at 1322 x 734 and 390 x 844.

The browser inspection covers the home page, project navigation, conversation page, editor access, project details, and the mobile drawer. It does not submit an AI request or change the user's project files.

Browser results: no horizontal overflow at either width; the bottom composer remains visible. The home prompt appears in the selected project before a company exists, and the preview draft was cleared after inspection. Review changes opens the Git panel. The mobile drawer moves focus to its close button, closes on Escape, and returns focus to the sidebar toggle. The sidebar also exposes company selection on mobile.
