---
name: frontend-web-app
description: Build a polished, responsive, accessible web UI and verify it in the browser at phone and laptop sizes.
roles: frontend, fullstack_dev, mobile_dev, developer, designer, ux_designer
phases: build
---
# Frontend web app

## Steps
1. Start from the UX spec / screenshots. Set up the visual system first: CSS custom properties for colours, spacing,
   radius and type; a base layout; then components.
2. Structure: semantic HTML (`header`, `main`, `nav`, `button`, `label` for every input), one responsibility per
   component/module, state in one place, derived values computed, not duplicated.
3. Every state exists: empty, loading (skeleton or spinner after 300 ms), error with a retry, success feedback.
4. Responsive by default: flexbox/grid, `min-width: 0` on flex children with long text, no fixed widths that overflow
   at 375 px, images `max-width: 100%`.
5. Accessibility: visible focus, keyboard operable, `aria-label` on icon-only buttons, colour contrast ≥ 4.5:1,
   `prefers-reduced-motion` respected.
6. Performance: no layout thrash in loops, debounce input handlers, lazy-load heavy assets, avoid huge dependencies for
   small needs.
7. **Verify in the browser** (preview URL): open the page, check `browser_console_messages` (must be clean), go through
   each flow with clicks and typing, resize to 375×800 and 1280×800 (`browser_resize`), check for overflow.

## Done when
No console errors, every flow works by mouse and keyboard, it looks right at both sizes.
