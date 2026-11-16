---
name: web-game
description: Build a polished browser game (Canvas or Three.js) with a fixed-step loop, responsive input, clear game states, visuals that match the brief, and a test hook so it can be verified by playing it.
roles: gameplay_programmer, game_director, game_designer, fullstack_dev, frontend, developer, playtester
---
# Web game

## Structure
- **Structure**: when the brief asks for several files, split them by concern (rules, rendering, input, UI). When it asks for one file, keep the same concerns as sections in that file.
- **Game states**: title, playing, paused, game over, restart, plus any transition the brief asks for (for example
  travel between levels). Every state has a screen and a key or click path; pausing works in every state.
- **Loop**: `requestAnimationFrame` with a fixed simulation step (60 Hz accumulator); clamp `dt` after tab switches;
  pause when `document.hidden`.
- **Input**: keyboard state map, mouse, touch. For first-person controls, use Pointer Lock behind a "click to play" overlay;
  losing the lock pauses; menus release the lock and focus their main button.
- **Test hook**: a small hook the game exposes, so browser automation can play what pointer lock and real-time input prevent.
  Use the name the brief gives, or `window.__app` when it gives none. It has `state()` (the phase and the values a test checks),
  `step(ms)`, and one action per control the game has.

## Visual fidelity (Three.js, when the brief asks for a realistic look)
Match the brief's words, element by element. Primitives are a starting point, never the finish.
- **Materials**: `MeshStandardMaterial`/`MeshPhysicalMaterial` with procedural `CanvasTexture` maps (noise, cracks,
  grime, rust, wetness as roughness variation), normal or bump maps, tiling per surface.
- **Lighting**: several typed sources (flickering, pulsing, coloured) with a few shadow casters, `PCFSoftShadowMap`,
  tone mapping (`ACESFilmicToneMapping`) and sRGB output.
- **Atmosphere**: `FogExp2`, instanced dust particles lit by the scene, additive light-shaft cones for volumetric looks.
- **Post-processing**: `EffectComposer` with bloom; motion blur or an afterimage pass where the brief asks for it.
- **Reflections**: a reflector or cube camera for wet floors and puddles, or low roughness with an environment map.
- **Characters**: several parts with silhouettes that read (limbs, torn cloth, decay colours), animated gait and
  hit reactions; instancing for crowds.
- **Destruction**: break meshes into debris pieces with velocity, gravity and floor collision (or `cannon-es`, if the brief allows a dependency), decals
  for impacts. Pool debris and particles.
- One renderer, `setPixelRatio(Math.min(devicePixelRatio, 2))`, resize handler, reuse geometries and materials, dispose on
  restart. Load Three.js the way the brief allows: inline or bundled for a one-file deliverable, otherwise the project's bundler or a pinned import map.

## Verify by playing
1. `start_dev_server`, open the URL, read the console: it must be clean.
2. Drive every state and transition through the test hook with `browser_evaluate`, checking `state()` after each step.
3. Screenshot the key moments and compare them with the brief's description, element by element.
4. Frame budget: sample 5 s of rAF timings; average frame under 33 ms.

## Done when
Every state and transition works through the hook, the console is clean, and the screenshots show what the brief
describes: no placeholder boxes.
