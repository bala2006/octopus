---
name: web-game
description: Build a polished browser game (Canvas or Three.js, single file if asked) with a fixed-step loop, responsive input, clear game states and smooth performance, verified by playing it.
roles: gameplay_programmer, game_director, game_designer, fullstack_dev, frontend, developer, playtester
phases: build, test
---
# Web game

## Core architecture
- **Game states**: title → playing → paused → game over → restart. Every state has a screen and a key/click path.
- **Loop**: `requestAnimationFrame` with a fixed timestep for simulation (e.g. 60 Hz accumulator) and interpolated
  rendering; clamp `dt` after tab switches; pause when `document.hidden`.
- **Input**: keyboard state map (keydown/keyup), mouse/pointer, touch for mobile. For first-person controls use
  Pointer Lock with a clear "click to play" overlay and a fallback message when it is denied; Esc pauses.
- **Entities**: plain objects or small classes with `update(dt)`; object pools for bullets/particles (no allocation per
  frame); simple spatial checks (AABB/sphere) before anything fancy.
- **Three.js** (when asked): load from a pinned CDN ES module (`https://unpkg.com/three@<version>/build/three.module.js`
  via an import map), one renderer, `setPixelRatio(Math.min(devicePixelRatio, 2))`, resize handler, lights + fog for
  depth, `MeshStandardMaterial`, reuse geometries/materials, dispose on restart.

## Feel and polish
Hit feedback (flash, sound or particles), score popups, crosshair, HUD (score, time/health, ammo), difficulty ramp,
audio via WebAudio started on first input, a high score in `localStorage`.

## Verify by playing
1. Open the preview in your browser; `browser_console_messages` must be clean.
2. Start the game, play for 30 s with keys/mouse (`browser_press_key`, `browser_click`), check the score changes, pause and
   resume, lose, restart.
3. Check a frame budget: `browser_evaluate` a 5 s rAF timing sample; no frame > 33 ms on average hardware.

## Done when
Every state works, the controls feel immediate, no console errors, it looks finished (not placeholder boxes).
