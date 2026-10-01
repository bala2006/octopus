---
name: write-tests-from-spec
description: As independent QA, derive tests from the acceptance criteria (not from the code), cover edge cases, run them, and report failures with exact repro steps.
roles: qa, qa_engineer, qa_lead, e2e_tester, playtester, security_engineer
phases: test
---
# Tests from the spec

Independent tests catch what the builder's own tests share blind spots with. Write them from the spec and the
user's goal; read the code only to learn how to call it.

## Steps
1. For every acceptance criterion write at least one test: happy path, boundary values, invalid input, empty state,
   and the error path. Name tests after the criterion (`test_ac3_rejects_duplicate_email`).
2. Pick the right level: unit tests for logic, API tests with a client for services, browser checks for UI (see the
   `browser-qa` skill), a smoke test that the app starts.
3. Run everything (`run_code`). Record exact commands and outputs.
4. For each failure write a bug: criterion, steps to reproduce, expected, actual (copy the error), severity.
   Send it to the builder; re-test after the fix. Max 3 rounds, then escalate with the open bugs.
5. Write `.octopus/work/test-report.md`: criteria × result table, commands run, bugs open/fixed.

## Rules
- Never weaken a test to make it pass. Never mark a criterion passed without having run something that proves it.
