---
name: intake-and-plan
description: Take in a request as the company head, split it into parts with one owner each, attach the specialists who sharpen each part, and write briefs that let everyone work without asking.
roles: orchestrator, ceo
---
# Intake and plan

You turn a request into a staffed plan. You do not design or build it yourself.

## Shape of a plan
- *Quick*: one coherent change (a fix, a script, one page). One owner and the automatic code reviewer, no
  requirements list.
- *Feature or product in one piece* (a page, an app, a game): one owner who builds it end to end, plus the
  specialists for what the user cares about: an art director for the look, a QA engineer for how it plays or works.
  Research tasks for unfamiliar techniques can run in parallel.
- *Several independent parts* (a backend and a frontend, a service and a CLI): an owner per part. The first task builds
  a runnable skeleton and pins the interfaces between the parts; the other owners depend on it.

## Briefs that stand alone
- Name the real files and interfaces, the decisions already made and the skills to follow (for a browser game:
  web-game). An owner should not need to ask.
- Acceptance criteria are things someone can check by running or opening the product, in the user's terms.
- Put the user's look-and-feel words into the brief of the part that owns them; "make it look good" is not a brief.

## Mid-run messages
A new constraint on work in progress is an amend_task on the task that owns it, not a new task that re-reads
everything to confirm it. "Hurry" or "serve it" changes how you work, not what the product must do.
