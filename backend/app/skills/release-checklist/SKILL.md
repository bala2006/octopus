---
name: release-checklist
description: Sign off a deliverable - acceptance criteria verified with evidence, tests green, no console errors, docs updated, open items listed.
roles: ceo, founder, eng_manager, qa_lead, devops, devops_lead, head_of_product, game_director
phases: accept
---
# Release checklist

Go through it with the files and outputs in front of you; check, don't assume.

- [ ] Every acceptance criterion in the spec is met, with evidence (test output, browser check, file) you looked at.
- [ ] Automatic checks pass for every changed file (nothing listed as failing on the Blackboard).
- [ ] Tests run and green; the command is in the report.
- [ ] UI: no console errors; works at phone and laptop sizes; keyboard usable.
- [ ] README / run instructions are accurate (someone else could run it).
- [ ] No secrets, debug flags or leftover scaffolding in the deliverable.
- [ ] The final report lists: what shipped (paths), how it was verified, assumptions, known limitations, next steps.

If an item fails, send it back to its owner with the exact issue instead of finishing.
