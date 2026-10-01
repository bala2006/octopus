---
name: refactor-safely
description: Restructure existing code without changing behaviour - pin behaviour with tests first, change in small steps, keep everything green.
roles: developer, fullstack_dev, frontend, backend, techlead, architect
phases: build
---
# Refactor safely

## Steps
1. State the goal of the refactor (readability, duplication, performance, a new seam) and what must NOT change.
2. **Pin behaviour first**: run the existing tests; if coverage of the area is thin, add characterisation tests that
   capture current outputs.
3. Change in small, mechanical steps (rename, extract function, move module, inline), running tests after each.
4. Keep public interfaces stable, or update every caller in the same step (`search_project` for usages).
5. Delete dead code you made obsolete; don't leave both versions.
6. Report the before/after structure and the test runs that prove behaviour is unchanged.
