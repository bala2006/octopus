#!/usr/bin/env python3
"""Capture the screenshot baseline for every Octopus screen.

What it does:
1. Builds nothing. The frontend must already be built (``cd frontend && npm ci && npm run build``).
2. Seeds a fresh OCTOPUS_HOME with ``seed.py`` (deterministic projects, runs, and chats).
3. Starts the backend (``uvicorn app.main:app``) on a free localhost port. It serves the built UI.
4. Opens each screen in headless Chromium at each viewport. The browser clock is frozen, the locale is en-US, the
   timezone is UTC, animations are off, and the page must settle (fonts loaded, network idle, DOM quiet) first.
5. Writes ``<out>/<viewport>/<screen>.png`` and ``<out>/run.json``. With ``--write-manifest`` it also updates
   ``scripts/visual/manifest.json`` (sha256 per screen and viewport, capture settings, and seed version).

Usage (from the repository root, after ``backend/requirements-dev.txt`` is installed and Chromium is installed):
    backend/.venv/bin/python scripts/visual/capture.py --out ./visual-baseline --write-manifest
    backend/.venv/bin/python scripts/visual/capture.py --out ./visual-run-2

The PNG files are not committed. Keep the output directory as a CI artifact or outside the repository.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BACKEND = REPO / "backend"
DIST = REPO / "frontend" / "dist"
MANIFEST = HERE / "manifest.json"
sys.path.insert(0, str(HERE))

import seed  # noqa: E402  (constants and app_env; seed.py imports the app only inside its functions)

CLOCK_DT = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
LOCALE = "en-US"
TIMEZONE = "UTC"
COLOR_SCHEME = "dark"
VIEWPORTS = {"1440x900": (1440, 900), "1024x768": (1024, 768)}

# Injected into every page before the app runs, and passed to each screenshot call.
FREEZE_CSS = """
*, *::before, *::after {
  animation: none !important;
  animation-delay: 0s !important;
  transition: none !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
"""
INIT_JS = """
(() => {
  const css = %(css)s;
  const install = () => {
    if (document.getElementById("visual-freeze")) return;
    const style = document.createElement("style");
    style.id = "visual-freeze";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  install();
  document.addEventListener("DOMContentLoaded", install);
  try {
    localStorage.setItem("octopus-theme", "dark");
    localStorage.setItem("octopus-app", JSON.stringify({
      state: { onboarded: true, theme: "dark", currency: "USD", companyByWorkspace: {}, chatFilter: "all" },
      version: 0,
    }));
  } catch (_) {}
})();
""" % {"css": json.dumps(FREEZE_CSS)}

FONTS_JS = """() => Promise.all([
  '400 14px "Inter Variable"', '500 14px "Inter Variable"', '600 14px "Inter Variable"', '700 14px "Inter Variable"',
  '400 12px "JetBrains Mono Variable"', '500 12px "JetBrains Mono Variable"',
].map((face) => document.fonts.load(face))).then(() => document.fonts.ready).then(() => true)"""

# Elements that mean a view is still loading, or a transient popup is open. A screen is captured only when none is present.
TRANSIENT = ".skeleton, [aria-busy='true'], .animate-spin, [role='tooltip']"
BLUR_JS = "() => { const el = document.activeElement; if (el && el !== document.body) el.blur(); }"


class HarnessError(RuntimeError):
    pass


@dataclass
class Screen:
    name: str
    route: str  # placeholders: {acme} {notes} {empty} {scope} {complete} {approval} {question}
    ready: str  # selector that must be visible before capture
    before: Callable[[object], None] | None = None  # runs after the page settles (e.g. open a menu)
    masks: list[str] = field(default_factory=list)  # elements painted over before the capture
    run_stream: bool = False  # the view opens a run WebSocket that replays the run's events into the UI


def open_floating_thread(page) -> None:
    """Open the chat window's thread picker and choose the finished landing-page run. That expands the window."""
    page.get_by_role("button", name="Chat window view").click()
    page.get_by_role("menuitem", name="Build the Acme landing page").click()


SCREENS: list[Screen] = [
    Screen("welcome", "/", ready=".welcome-page"),
    Screen("agent", "/w/{acme}/agent", ready="#conversation-canvas .react-flow__node", run_stream=True),
    Screen("floating-chat", "/w/{acme}/agent", ready="#conversation-canvas .react-flow__node", before=open_floating_thread,
           run_stream=True),
    Screen("canvas", "/w/{acme}/canvas", ready=".react-flow__node"),
    Screen("workspace", "/w/{acme}/workspace", ready=".view-toolbar"),
    Screen("chat", "/w/{acme}/chat", ready="[data-testid='chat-agents-list']"),
    Screen("chat-session", "/w/{acme}/chat/{scope}", ready="[data-testid='chat-agents-list']"),
    Screen("runs-list", "/w/{acme}/runs", ready="[data-testid='runs-list']"),
    Screen("run-timeline", "/w/{acme}/runs/{complete}", ready=".view-toolbar h1", run_stream=True),
    Screen("run-approval", "/w/{acme}/runs/{approval}", ready=".view-toolbar h1", run_stream=True),
    Screen("run-question", "/w/{acme}/runs/{question}", ready=".view-toolbar h1", run_stream=True),
    Screen("artifacts-list", "/w/{acme}/artifacts", ready=".artifacts-layout"),
    Screen("artifacts-detail", "/w/{acme}/artifacts/{complete}", ready=".artifacts-layout"),
    Screen("activity", "/activity", ready=".personal-activity .activity-page-inner"),
    Screen("settings", "/settings", ready="nav[aria-label='Settings sections']"),
    Screen("guide", "/w/{acme}/guide", ready="nav.guide-navigation"),
    Screen("empty-runs", "/w/{notes}/runs", ready="text=No team activity yet"),
    Screen("empty-agents", "/w/{empty}/canvas", ready="text=No agents yet"),
]

CHROMIUM_ARGS = [
    "--font-render-hinting=none",
    "--disable-lcd-text",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--disable-gpu",
    # partial raster re-rasterizes only some tiles per frame, so back-to-back captures of one settled page differed
    "--disable-partial-raster",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wait_for_health(base: str, proc: subprocess.Popen, log: Path, timeout: float = 90) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise HarnessError(f"backend exited with {proc.returncode}; see {log}")
        try:
            with urllib.request.urlopen(f"{base}/api/health", timeout=2) as resp:
                if resp.status == 200:
                    return
        except OSError:
            time.sleep(0.25)
    raise HarnessError(f"backend did not become healthy within {timeout}s; see {log}")


def track_run_streams(page) -> list[dict]:
    """Record every run WebSocket (``/ws/w/<workspace>/runs/<run>``). Each entry turns ``done`` when the server has sent
    ``replay_done`` for that stream, or when the socket closes. The events are applied to the UI after that point."""
    streams: list[dict] = []

    def on_socket(ws) -> None:
        if "/runs/" not in ws.url:
            return
        entry = {"url": ws.url, "done": False}
        streams.append(entry)

        def on_frame(payload) -> None:
            text = payload if isinstance(payload, str) else payload.decode("utf-8", "ignore")
            if '"replay_done"' in text:
                entry["done"] = True

        ws.on("framereceived", on_frame)
        ws.on("close", lambda *_: entry.__setitem__("done", True))

    page.on("websocket", on_socket)
    return streams


def wait_replay(page, streams: list[dict], expected: bool, timeout_ms: int = 30_000) -> None:
    """Wait until the run stream has replayed. ``expected`` views must open one, so an empty list is not a pass."""
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        if streams and all(entry["done"] for entry in streams):
            return
        page.wait_for_timeout(100)
    if expected:
        raise HarnessError(f"run stream did not replay within {timeout_ms} ms: {streams}")


def wait_settled(page, quiet_ms: int = 800, timeout_ms: int = 30_000) -> None:
    """Wait until no DOM mutation has happened for ``quiet_ms`` and no loading or transient element is left.

    On timeout the error names the elements that kept changing, so the cause can be masked or waited out."""
    page.evaluate("""() => {
        if (window.__visualMutations === undefined) {
          window.__visualMutations = 0;
          window.__visualTargets = {};
          new MutationObserver((records) => {
            window.__visualMutations += records.length;
            for (const r of records.slice(0, 50)) {
              const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
              if (!el) continue;
              const cls = typeof el.className === "string" ? el.className : "";
              const key = `${el.tagName.toLowerCase()}.${cls.split(" ").slice(0, 3).join(".")}${r.attributeName ? " @" + r.attributeName : ""}`;
              window.__visualTargets[key] = (window.__visualTargets[key] || 0) + 1;
            }
          }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        }
    }""")
    deadline = time.monotonic() + timeout_ms / 1000
    last, stable_since = None, time.monotonic()
    while time.monotonic() < deadline:
        count = page.evaluate("window.__visualMutations")
        if count != last:
            last, stable_since = count, time.monotonic()
        elif (time.monotonic() - stable_since) * 1000 >= quiet_ms and page.locator(TRANSIENT).count() == 0:
            return
        if page.locator(TRANSIENT).count():
            # Radix returns focus to the menu trigger a tick after a menu closes; the hover hint shows on that focus.
            page.evaluate(BLUR_JS)
        page.wait_for_timeout(100)
    top = page.evaluate("""() => Object.entries(window.__visualTargets).sort((a, b) => b[1] - a[1]).slice(0, 6)""")
    left = page.locator(TRANSIENT)
    where = [left.nth(i).evaluate("e => e.outerHTML.slice(0, 160)") for i in range(min(left.count(), 3))]
    raise HarnessError(f"page did not settle; transient elements left: {where}; most-changed elements: {top}")


def capture_one(browser, base: str, screen: Screen, route: str, size: tuple[int, int], out_png: Path) -> None:
    context = browser.new_context(
        viewport={"width": size[0], "height": size[1]}, device_scale_factor=1, locale=LOCALE, timezone_id=TIMEZONE,
        color_scheme=COLOR_SCHEME, reduced_motion="no-preference", service_workers="block", has_touch=False,
        is_mobile=False, accept_downloads=False,
    )
    try:
        context.clock.set_fixed_time(CLOCK_DT)
        context.add_init_script(INIT_JS)
        page = context.new_page()
        streams = track_run_streams(page)
        page.goto(base + route, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_load_state("networkidle", timeout=60_000)
        page.wait_for_selector(screen.ready, state="visible", timeout=45_000)
        # Fonts load lazily, so a plain fonts.ready check can pass before the UI faces are requested. Load them explicitly;
        # text measured in the wrong face moves canvas edges.
        page.evaluate(FONTS_JS)
        if screen.run_stream:
            wait_replay(page, streams, expected=True)
        if screen.before:
            screen.before(page)
            if screen.run_stream:  # choosing another thread opens and replays a second stream
                wait_replay(page, streams, expected=True)
        # no focus ring, tooltip, or hover left over from setup; the pointer rests in the corner
        page.mouse.move(0, 0)
        page.evaluate(BLUR_JS)
        wait_settled(page)
        masks = [page.locator(selector) for selector in screen.masks]
        page.screenshot(path=str(out_png), animations="disabled", caret="hide", style=FREEZE_CSS, mask=masks or None,
                        type="png", timeout=60_000)
    finally:
        context.close()


def resolve_route(template: str, ids: dict[str, str]) -> str:
    return template.format(**ids)


def write_manifest(path: Path, results: list[dict], settings: dict) -> None:
    previous: dict[tuple[str, str], dict] = {}
    if path.exists():
        for entry in json.loads(path.read_text(encoding="utf-8")).get("screens", []):
            previous[(entry["screen"], entry["viewport"])] = entry
    screens = []
    for r in results:
        old = previous.get((r["screen"], r["viewport"]), {})
        screens.append({
            "screen": r["screen"], "viewport": r["viewport"], "route": r["route"], "sha256": r["sha256"],
            "masks": r["masks"],
            # per-screen threshold, preserved across regenerations; the defaults are 0 changed pixels and no tolerance
            "max_changed_pixels": old.get("max_changed_pixels", 0),
            "channel_tolerance": old.get("channel_tolerance", 0),
        })
    manifest = {"format": 1, "seed_version": seed.SEED_VERSION, "capture": settings, "screens": screens}
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> int:
    from playwright.sync_api import sync_playwright

    if not (DIST / "index.html").is_file():
        raise HarnessError(f"frontend is not built: {DIST} is missing. Run `cd frontend && npm ci && npm run build` first.")
    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="octopus-visual-work-"))
    home = work / "home"
    home.mkdir()
    # Each run gets its own projects directory, so two captures on one machine cannot delete each other's data.
    # The project paths are not shown on any captured screen; compare.py would catch it if they were.
    projects = args.projects_root.resolve() if args.projects_root else Path(tempfile.mkdtemp(prefix="octopus-visual-projects-"))
    env = seed.app_env(home, projects)
    proc: subprocess.Popen | None = None
    try:
        info_path = work / "seed-info.json"
        subprocess.run([sys.executable, str(HERE / "seed.py"), "--home", str(home), "--projects-root", str(projects),
                        "--info", str(info_path)], check=True, cwd=home, env=env, stdout=subprocess.DEVNULL)
        info = json.loads(info_path.read_text(encoding="utf-8"))["projects"]
        ids = {
            "acme": info["acme-web"]["workspace_id"], "notes": info["notes-app"]["workspace_id"],
            "empty": info["empty-team"]["workspace_id"], "scope": info["acme-web"]["sessions"]["scope"],
            "complete": info["acme-web"]["complete"], "approval": info["acme-web"]["approval"],
            "question": info["acme-web"]["question"],
        }

        port = free_port()
        base = f"http://127.0.0.1:{port}"
        log = work / "backend.log"
        cmd = [sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", str(BACKEND), "--host", "127.0.0.1",
               "--port", str(port), "--log-level", "warning", "--no-access-log"]
        with open(log, "w", encoding="utf-8") as log_fh:
            proc = subprocess.Popen(cmd, cwd=home, env=env, stdout=log_fh, stderr=subprocess.STDOUT)
        wait_for_health(base, proc, log)

        selected = [s for s in SCREENS if not args.only or s.name in args.only]
        results: list[dict] = []
        with sync_playwright() as pw:
            launch_options = {"executable_path": str(args.chromium)} if args.chromium else {}
            browser = pw.chromium.launch(args=CHROMIUM_ARGS, **launch_options)
            try:
                for vp_name, size in VIEWPORTS.items():
                    (out / vp_name).mkdir(parents=True, exist_ok=True)
                    for screen in selected:
                        route_template = screen.route
                        png = out / vp_name / f"{screen.name}.png"
                        print(f"capturing {vp_name} {screen.name}", flush=True)
                        capture_one(browser, base, screen, resolve_route(route_template, ids), size, png)
                        results.append({"screen": screen.name, "viewport": vp_name, "route": route_template,
                                        "sha256": sha256_file(png), "masks": screen.masks})
                version = browser.version
            finally:
                browser.close()

        settings = {
            "viewports": {k: {"width": w, "height": h} for k, (w, h) in VIEWPORTS.items()},
            "device_scale_factor": 1, "locale": LOCALE, "timezone": TIMEZONE, "color_scheme": COLOR_SCHEME,
            "clock": CLOCK_DT.strftime("%Y-%m-%dT%H:%M:%SZ"), "animations": "disabled", "image_format": "png",
            "browser": "chromium", "browser_version": version, "playwright": pkg_version("playwright"),
            "platform": f"{platform.system()} {platform.machine()}", "chromium_args": CHROMIUM_ARGS,
        }
        (out / "run.json").write_text(json.dumps({"seed_version": seed.SEED_VERSION, "settings": settings,
                                                  "screens": results}, indent=2) + "\n", encoding="utf-8")
        if args.write_manifest and not args.only:
            write_manifest(Path(args.manifest), results, settings)
            print(f"wrote manifest {args.manifest}")
        print(f"captured {len(results)} screenshots into {out}")
        return 0
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        if args.keep_work:
            print(f"kept work directory {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
            if args.projects_root is None:
                shutil.rmtree(projects, ignore_errors=True)


def pkg_version(name: str) -> str:
    from importlib.metadata import version
    return version(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path("visual-baseline"), help="output directory for the PNG files")
    parser.add_argument("--manifest", type=Path, default=MANIFEST, help="manifest path used with --write-manifest")
    parser.add_argument("--write-manifest", action="store_true", help="write sha256 hashes and settings into the manifest")
    parser.add_argument("--projects-root", type=Path, default=None,
                        help="directory for the seeded projects (default: a new temporary directory per run)")
    parser.add_argument("--only", nargs="+", metavar="SCREEN", help="capture only these screens (debugging)")
    parser.add_argument("--chromium", type=Path, default=os.environ.get("OCTOPUS_VISUAL_CHROMIUM") or None,
                        help="Chromium executable to use. The baseline was made with Chromium 156.0.8078.4 "
                             "(Playwright cache: chromium-1248). Default: Playwright's own build.")
    parser.add_argument("--keep-work", action="store_true", help="keep the temporary OCTOPUS_HOME for inspection")
    args = parser.parse_args()
    try:
        sys.exit(run(args))
    except HarnessError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
