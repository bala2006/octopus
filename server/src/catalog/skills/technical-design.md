---
name: technical-design
description: Design the solution before code - files/modules, interfaces, data, states and risks - and map every acceptance criterion to where it is built.
roles: architect, techlead, eng_manager, data_science_lead, security_lead
---
# Technical design

Give the design in your reply, or in the file the brief names. It must be concrete enough to build from without asking questions.

## Steps
1. Read the spec (and research). List the acceptance criteria; each must map to a module below.
2. Choose the simplest architecture that meets the constraints. Respect explicit constraints exactly ("single HTML
   file", "no build step", a given framework). Prefer the standard library and widely used, well-documented packages.
3. Write the design:
   ```markdown
   # Design
   ## Overview (one paragraph + a small diagram if useful)
   ## Files / modules (path, responsibility)
   ## Interfaces (function signatures, HTTP endpoints with request/response, events, data shapes)
   ## State and data flow (what lives where, lifecycle, persistence)
   ## Error handling and edge cases
   ## Acceptance criteria → module map
   ## How to run and test (exact commands / URL)
   ## Risks and how we de-risk them
   ```
4. Split code only along clean interfaces. If the parts are tightly coupled, keep them together.
5. Call out what must be tested and how (unit tests for logic, a browser check for UI, a load check for performance).

## Quality bar
- Every interface is concrete enough to code against (names, types, status codes).
- No acceptance criterion without a module.
