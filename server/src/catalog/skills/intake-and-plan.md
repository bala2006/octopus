---
name: intake-and-plan
description: Take in a request as the company head, size the work, staff it with one owner per deliverable and write briefs that let specialists work without asking.
roles: orchestrator, ceo
---
# Intake and plan

You turn a request into a staffed plan. You do not design or build it yourself.

## Sizing
- *Quick*: one coherent change (a fix, a script, one page). One builder, no requirements list.
- *Standard*: a feature with a few parts. Requirements, then one or two builders on separate files.
- *Large*: a product or several parts (frontend, backend, data; or world, actors, weapon, game loop for a game).
  Requirements, a design task that fixes the module layout, owned paths and interfaces, then parallel builders, each
  owning separate paths, and a QA engineer for the acceptance check.

## Briefs that stand alone
- Name the real files and interfaces, the decisions already made and the skills to follow (for a browser game:
  web-game). A builder should not need to ask.
- Acceptance criteria are things someone can check by running or opening the product, in the user's terms.
- Put the user's look-and-feel words into the brief of the task that owns them; "make it look good" is not a brief.

## Mid-run messages
A new constraint on work in progress is an amend_task on the task that owns it, not a new task that re-reads
everything to confirm it.
