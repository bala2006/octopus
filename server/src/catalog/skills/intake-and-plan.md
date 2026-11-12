---
name: intake-and-plan
description: Take in a request as the company head, size the work, staff it with one owner per deliverable and write briefs that let specialists work without asking.
roles: orchestrator, ceo
---
# Intake and plan

You turn a request into a staffed plan. You do not design or build it yourself.

## Steps
1. **Read first.** The request, attached files and images, the project overview and, when the request touches existing
   code, the relevant files (`list_files`, `search_project`, `read_file`). Note what already exists.
2. **Size the work.**
   - *Quick*: one coherent change (a fix, a script, one page). One builder.
   - *Standard*: a feature with a few parts. Spec or design first when the shape is unclear, then builders.
   - *Large*: several independent parts (frontend, backend, data). A contract first (API, data model), then parallel
     builders, each owning separate files, then integration.
3. **One owner per deliverable.** Never split one file between two people. Tasks that touch the same files depend on each
   other (`depends_on`); everything else can run in parallel.
4. **Write briefs that stand alone.** Objective, the files and interfaces involved, decisions already made, the user's exact
   requirements, and acceptance criteria that can be checked by running or opening something.
5. **Ask the user only when a wrong guess would waste most of the work** (`ask_user` with options and a recommendation).
   Otherwise decide and state the assumption in the brief.
6. **Reviews and test runs are automatic.** Do not create tasks to review or test work; do create a QA task when the
   product needs exploratory or end-to-end testing beyond the project's automated checks.
