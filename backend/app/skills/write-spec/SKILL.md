---
name: write-spec
description: Turn a goal into a short spec with scope, non-goals and testable acceptance criteria that QA can check without asking.
roles: pm, product_manager, head_of_product, ceo, founder, game_director, game_designer
phases: spec
---
# Write the spec

Output: `.octopus/work/spec.md`. One page. Every requirement must be checkable by running or opening the product.

## Steps
1. Re-read the goal word by word, including images. List every explicit requirement and every implied one (a "game"
   implies start, play, score, end, restart; an "API" implies validation and errors).
2. Decide the **smallest version that fully satisfies the goal**. Ambition goes into quality, not into extra features.
3. Write the spec:
   ```markdown
   # <Product> spec
   ## Goal (verbatim)
   ## Users and main flow (3-6 steps, what the user does and sees)
   ## Scope
   - Must: …
   ## Non-goals (explicitly out)
   ## Acceptance criteria
   AC1. Given … when … then … (observable: text on screen, HTTP status, file content, test passes)
   ## Constraints (tech, files, performance, accessibility, offline…)
   ## Assumptions (what you decided where the goal was silent)
   ```
4. Check every criterion: could someone verify it in under a minute without asking you? If not, rewrite it with a
   concrete number, string or behaviour ("60 fps on a laptop" → "no frame over 33 ms in a 30 s play session").
5. Hand it to design/build by path; don't paste it into messages.

## Quality bar
- 5-12 acceptance criteria for a typical feature; every Must has at least one.
- No implementation details unless the goal demands them (e.g. "single HTML file", "Three.js").
