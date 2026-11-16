---
name: write-tests-from-spec
description: As independent QA, derive tests from the acceptance criteria (not from the code), cover edge cases, run them, and report failures with exact repro steps.
roles: qa, qa_engineer, qa_lead, e2e_tester, playtester, security
---
# Tests from the spec

Independent tests catch blind spots that tests written alongside the code share. Write them from the spec and the
user's goal; read the code only to learn how to call it.

## Steps
1. For every acceptance criterion write at least one test: happy path, boundary values, invalid input, empty state,
   and the error path. Name tests after the criterion (`test_ac3_rejects_duplicate_email`).
2. Pick the right level: unit tests for logic, API tests with a client for services, browser checks for UI (see the
   `browser_navigate`, `browser_evaluate` and screenshots for the page), a smoke test that the app starts.
3. Run everything (`shell`). Record exact commands and outputs.
4. For each failure write a bug: criterion, steps to reproduce, expected, actual (copy the error), severity.
   Fix the bug, then re-run the test. Stop after 3 rounds of fixes and report the bugs still open.
5. Report a table of criteria and results, the commands run, and the bugs open or fixed.

## Rules
- Never weaken a test to make it pass. Never mark a criterion passed without having run something that proves it.
