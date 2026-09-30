# Octopus pitch artifacts

A ready-to-present pitch for **Vivek** about [Octopus](https://github.com/bala2006/octopus) —
*your AI company, in one folder*.

| File | What it is |
|---|---|
| `octopus-pitch-for-vivek.pptx` | 12-slide deck (16:9, dark brand theme) with **speaker notes on every slide** |
| `octopus-pitch-for-vivek.mp4` | 71.5 s pitch video — 1920×1080 @ 60 fps, H.264 + AAC, with an original synthesized soundtrack |
| `scripts/` | The generators used to produce both files |

## Deck outline

1. Title — Octopus, *Your AI company, in one folder* (prepared for Vivek)
2. The problem — AI tooling forgot that software is a team sport
3. The idea — a small company of AI agents in your folder
4. How a run works — goal → debate → build → review → ship
5. Product — org canvas, live run, runs-as-chats, artifacts
6. Control & safety — permission matrix, budgets, sandbox
7. The model layer — Azure OpenAI `gpt-6-luna`, exact cost, Demo Mode
8. Engineering — stack, generated types, tests, CI/CD
9. Proof — 216 files, 23k+ lines, 14 templates, real demo footage
10. Where this goes — beyond code, marketplace, hosted control plane
11. The ask for Vivek — power user, intros, advice
12. Closing

## Video

* 11 scenes, 71.5 s, 4290 frames at 60 fps
* Frame-accurate motion design: parallax backgrounds (gradient + glow + org-graph
  decoration + dither), staggered eased text entrances, wipe-in accent rules
* Alternating push / cross-fade transitions with smoother-step easing
* Persistent chrome: progress bar, brand line, scene counter; opening/closing fades
* Original soundtrack: chord pads, sub bass, FM-bell arpeggio with echo, soft shaker
  (pure numpy synthesis — no samples, no network), 48 kHz stereo AAC

## Regenerating

```bash
pip install -r scripts/requirements.txt

python scripts/build_pptx.py                       # -> octopus-pitch-for-vivek.pptx
python scripts/build_audio.py                      # -> build/audio.wav (length matches video)
python scripts/render_video.py render --segment 0 --segments 4   # repeat for segments 1..3
python scripts/render_video.py concat              # -> build/video_silent.mp4
python scripts/render_video.py mux                 # -> octopus-pitch-for-vivek.mp4
```

Scene copy and the shared timeline live in `scripts/content.py` — edit the scenes there
and both the audio length and video timeline follow automatically. Fonts (Poppins, Lato,
both OFL) are downloaded to `scripts/fonts/` on first run.
