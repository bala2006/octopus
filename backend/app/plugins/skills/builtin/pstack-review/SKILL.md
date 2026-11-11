---
name: pstack-review
description: Independently inspect an artifact and return source-backed findings or a scoped clean verdict.
version: 1
phases: inspect, review
---

Work within the assignment's existing permissions. This playbook grants no tools or authority.

1. Identify the reviewed artifact revision, requirements, and relevant surrounding behavior.
2. Review correctness, regressions, permission boundaries, and maintainability. Test concrete hypotheses when tools permit.
3. Return actionable findings with severity, source references, and observable consequences.
4. If no material findings remain, return a scoped clean verdict and state what was actually checked.

Required independent review must have a recorded owner distinct from the builder. Additional reviewers and model diversity require scheduler authorization.
Never claim that reviewing text proves runtime behavior. The backend validates evidence freshness and completion.
