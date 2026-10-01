---
name: debug-failure
description: Fix a bug or failing check systematically - reproduce, read the evidence, form one hypothesis at a time, isolate, fix the root cause and add a regression test.
roles: frontend, backend, developer, fullstack_dev, gameplay_programmer, mobile_dev, data_engineer, ml_engineer, devops, sre, qa, qa_engineer, techlead
phases: build, test
---
# Debug a failure

## Steps
1. **Reproduce** with the smallest command, test or browser flow. Write down the exact symptom (error text, line,
   expected vs actual). No reproduction, no fix.
2. **Read the evidence fully**: the whole stack trace, console messages, logs, the failing test's assertion. The first
   error is usually the cause; later ones are fallout.
3. **Locate**: `search_project` for the error text / function; read the code path from input to failure.
4. **One hypothesis at a time**: state it, predict what you'd see if it's true, check it (print, assert, a tiny script,
   `browser_evaluate`). Discard and move on if wrong; don't stack speculative changes.
5. **Fix the root cause**, not the symptom (no swallowing exceptions, no special-casing the test input).
6. **Prove it**: the reproduction now passes; add a regression test (or a scripted browser check) that failed before.
   Run the related tests too.
7. **Report**: cause, fix, proof, and anything similar elsewhere worth checking.
