---
name: browser-qa
description: Test a web page or game in the real browser - console clean, every flow clicked through, responsive sizes, keyboard - and report what you observed.
roles: qa, qa_engineer, qa_lead, e2e_tester, playtester, designer, ux_designer, frontend, gameplay_programmer
phases: test, review
---
# Browser QA

## Steps
1. `browser_navigate` to the preview URL of the page. Then `browser_console_messages`: any error is a bug (copy it).
2. `browser_snapshot` to see the page structure and get element refs.
3. Walk every flow from the spec: click (`browser_click`), type (`browser_type`), press keys (`browser_press_key`),
   wait for results (`browser_wait_for`). After each step check the visible result in a new snapshot.
4. Edge cases: empty submit, very long text, double click, rapid key presses, reload mid-flow, back button.
5. Sizes: `browser_resize` to 375×800 and 1280×800; look for overflow, cut-off text, overlapping elements.
6. Keyboard only: Tab through controls, Enter/Space activate, Esc closes dialogs; focus is visible.
7. Take a screenshot (`browser_take_screenshot`) of anything wrong and of the final state.
8. Report: each flow ✓/✗ with what you saw, console output, and bugs with exact repro steps.
