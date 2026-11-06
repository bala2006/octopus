---
name: ux-spec
description: Specify screens, states and interactions (empty, loading, error, success), layout, visual style and accessibility so the UI can be built and checked.
roles: designer, ux_designer, creative_director, game_designer, ux_researcher
phases: design
---
# UX spec

Output: `.octopus/work/ux.md` (add it to the design). If the user attached screenshots or mock-ups, they are the
reference: match them and note every deliberate difference.

## Steps
1. List the user flows from the spec as numbered steps.
2. For each screen: purpose, layout (top → bottom), components, and **every state**: empty, loading, error, success,
   disabled, and for games: start, playing, paused, game over.
3. Define the visual system once: colour tokens (with contrast ≥ 4.5:1 for text), type scale, spacing scale (4/8 px),
   radius, shadows, motion (durations ≤ 200 ms for UI feedback; respect `prefers-reduced-motion`).
4. Interactions: what every control does, keyboard support (Tab order, Enter/Escape, shortcuts), focus states, touch
   targets ≥ 44 px, responsive breakpoints (phone 375 px, laptop 1280 px).
5. Copy: real labels and messages, not lorem ipsum. Errors say what happened and what to do.
6. Write checks QA can run in the browser: "At 375 px the board fits without horizontal scroll", "Esc pauses".

## Quality bar (Nielsen's heuristics)
Visibility of system status, recognition over recall, error prevention, consistency, minimalist design, clear
recovery from errors.
