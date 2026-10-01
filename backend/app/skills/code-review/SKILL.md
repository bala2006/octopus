---
name: code-review
description: Review a change with a fresh pair of eyes against the goal, spec and a correctness/security/performance/readability checklist; approve or request specific changes.
roles: techlead, architect, eng_manager, qa_lead, security_lead
phases: review
---
# Code review

Review the result, not the conversation. Start from the goal and spec, then read the changed files.

## Checklist
1. **Does it do what was asked?** Every acceptance criterion; nothing important missing; no unrequested scope.
2. **Correctness**: edge cases, error paths, off-by-one, null/empty, concurrency, resource cleanup.
3. **Security**: input validation, injection, secrets in code, authz checks, unsafe HTML.
4. **Performance**: obvious N², work in hot loops, unbounded growth, huge payloads.
5. **Readability**: names, function size, duplication, dead code, comments explaining *why*.
6. **Tests**: present, meaningful, passing (run them).
7. **Run it yourself**: start it / open it; trust what you observe over what the report says.

## Verdict
- `approve` when it meets the goal with no blocking issues (nits can be listed but don't block).
- `request_changes` with numbered, concrete comments: file, what's wrong, what to do. Blocking first.
