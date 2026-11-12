## Risk

<!-- Tier from plan.md section 8 (P8). Unknown paths count as tier 2. Tier 2 needs a human approval. -->

- [ ] Tier 0: documentation, comments, or test additions only
- [ ] Tier 1: a change inside one plugin package, with no contract or permission change
- [ ] Tier 2: kernel, SDK, storage or migrations, sandbox, browser, MCP, providers, secrets, CI or gate files, dependency files, golden or manifest changes, or more than one plugin package

## Summary

<!-- What changed, and why? Link the relevant issue if there is one. -->

Closes #

## Verification

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] User-facing docs were updated, or not applicable.
- [ ] No secrets, personal data, or unrelated generated files are included.

### Evidence

<!-- Commands, test results, screenshots, or demo steps. If any check was skipped, explain why. -->

## Security and compatibility

<!-- Note any impacts on permissions, folder isolation, MCP tools, data formats, model integrations, or backward compatibility. -->
