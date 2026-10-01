---
name: implement-feature
description: Build a deliverable end-to-end in small verified steps - read first, plan, implement, run, fix, and report with evidence.
roles: frontend, backend, developer, fullstack_dev, gameplay_programmer, mobile_dev, data_engineer, ml_engineer, devops, sre, security_engineer, architect, techlead
phases: build
---
# Implement a feature

You own the deliverable end-to-end. Quality comes from small steps that are each checked.

## Steps
1. **Read before writing.** The goal (and images), the spec/design if they exist, and the relevant existing code
   (`search_project`, `read_file`). Follow the project's conventions (style, structure, libraries).
2. **Plan in 3-8 steps** that each leave the project working. Put the plan on the task board if it spans turns.
3. **Implement one step at a time.**
   - Small files/edits; `edit_file` for changes to existing files, `write_file` for new ones.
   - Handle errors and edge cases as you go (empty input, network failure, resize, invalid data).
   - No placeholders, TODO stubs or fake data where real behaviour is required.
4. **Verify each step for real.** Fix every automatic check failure immediately. Run it: tests (`run_code`), the
   script, or open the page in your browser (preview URL), read `browser_console_messages`, click through the flow.
5. **Fix what you find, then re-verify.** Repeat until the acceptance criteria hold.
6. **Report**: what you built (files), how you verified it (commands and what you saw), assumptions, known limits.

## Definition of done
- Every acceptance criterion demonstrably met; no console errors; no failing checks.
- Code is readable: clear names, no dead code, comments only where intent isn't obvious.
- Someone else can run it from your report alone.
