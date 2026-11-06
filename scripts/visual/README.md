# Visual baseline

Screenshot harness for the 18 Octopus screens at 1440x900 and 1024x768. It is outside the test suite: pytest does not
collect it, and nothing in CI runs it yet (decision D5).

| File | Purpose |
|---|---|
| `seed.py` | Creates three deterministic projects through the API and writes runs, events, messages, artifacts, tasks, and chats directly into each project database. Fixed ids, fixed timestamps, no model calls. |
| `capture.py` | Seeds a fresh `OCTOPUS_HOME`, starts the backend on a free port, and captures every screen in headless Chromium. Writes PNGs and `run.json`. `--write-manifest` also updates `manifest.json`. |
| `compare.py` | Compares a capture directory with the baseline PNGs and the manifest. Reports changed pixels per screen. |
| `manifest.json` | Committed. sha256 per screen and viewport, capture settings, seed version, and per-screen thresholds. |

## Setup

```bash
cd backend && uv venv -p 3.11 .venv && VIRTUAL_ENV=$PWD/.venv uv pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m playwright install chromium
cd ../frontend && npm ci --no-audit --no-fund && npm run build
```

## Run

```bash
backend/.venv/bin/python scripts/visual/capture.py --out ./visual-baseline --write-manifest
backend/.venv/bin/python scripts/visual/capture.py --out ./visual-run-2
backend/.venv/bin/python scripts/visual/compare.py --captures ./visual-run-2 --baseline ./visual-baseline
```

Run captures one after another, not in parallel, and do not run the harness while another instance is writing the
same output directory. Each run uses its own projects directory.

## Determinism rules

- The browser clock is frozen at `2026-01-15T12:00:00Z` (`CLOCK` in `seed.py`). Every seeded timestamp is earlier.
- Locale `en-US`, timezone `UTC`, dark colour scheme, device scale factor 1, no animations or transitions, hidden
  scrollbars, and `--disable-partial-raster`, which made back-to-back screenshots of one page identical.
- A screen is captured only when fonts are loaded, the network is idle, the DOM has not changed for 800 ms, and no
  loading indicator or tooltip is showing. Views that replay a run wait for the run WebSocket to send `replay_done`.
- Edge ids in the seeded company come from the remapped agent ids. Canvas edge anchors break ties by edge id, so random
  ids produced different edge geometry on every run.
- The backend runs from an empty working directory, and provider keys and other machine variables are removed from its
  environment (`seed.app_env`).

## Thresholds

`max_changed_pixels` defaults to 0 and `channel_tolerance` defaults to 0 for every screen. Change them per screen in
`manifest.json` only with a reviewed reason. Do not raise them to make a flaky screen pass.

## Known limits

- Baselines depend on the Chromium build and the OS font rendering. Regenerate them on the CI image, not on a laptop.
- `run-question` at 1024x768 still differs between some runs (see the commit message for the last measurement).

## Browser used for the baseline

The baseline was captured with Chromium 156.0.8078.4, the headless shell in Playwright's cache (`chromium_headless_shell-1248`). Playwright's default build in the sandbox is 157, and it renders the run screens differently. Pass the 156 build with `--chromium` or `OCTOPUS_VISUAL_CHROMIUM`:

```bash
OCTOPUS_VISUAL_CHROMIUM=/root/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell \
  backend/.venv/bin/python scripts/visual/capture.py --out <dir>
```

With that build, 33 of 36 captures match the baseline. The three that differ are listed in the plan's status section (section 9).
