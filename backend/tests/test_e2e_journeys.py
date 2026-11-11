"""Browser journeys against the real backend and built UI.

Runs only when OCTOPUS_E2E=1 (it needs the built frontend and Chromium for Playwright). The data comes from the visual
harness's seed (scripts/visual/seed.py), so no model is called and every run sees the same projects.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]
VISUAL = REPO / "scripts" / "visual"

pytestmark = pytest.mark.skipif(os.environ.get("OCTOPUS_E2E") != "1", reason="browser e2e (OCTOPUS_E2E=1)")


@pytest.fixture(scope="module")
def app():
    if str(VISUAL) not in sys.path:
        sys.path.insert(0, str(VISUAL))
    import capture
    import seed
    from playwright.sync_api import sync_playwright

    if not (capture.DIST / "index.html").is_file():
        pytest.fail(f"frontend is not built ({capture.DIST} is missing). Run `npm run build` in frontend/.")

    work = Path(tempfile.mkdtemp(prefix="octopus-e2e-"))
    home = work / "home"
    home.mkdir()
    projects = work / "projects"
    env = seed.app_env(home, projects)
    info_path = work / "seed.json"
    subprocess.run(
        [sys.executable, str(VISUAL / "seed.py"), "--home", str(home), "--projects-root", str(projects), "--info", str(info_path)],
        check=True,
        cwd=home,
        env=env,
        stdout=subprocess.DEVNULL,
    )
    projects_info = json.loads(info_path.read_text(encoding="utf-8"))["projects"]
    acme = projects_info["acme-web"]
    ids = {
        "acme": acme["workspace_id"],
        "complete": acme["complete"],
    }

    port = capture.free_port()
    base = f"http://127.0.0.1:{port}"
    log = work / "backend.log"
    cmd = [
        sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", str(capture.BACKEND),
        "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning", "--no-access-log",
    ]
    proc = None
    try:
        with open(log, "w", encoding="utf-8") as log_fh:
            proc = subprocess.Popen(cmd, cwd=home, env=env, stdout=log_fh, stderr=subprocess.STDOUT)
        capture.wait_for_health(base, proc, log)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=capture.CHROMIUM_ARGS)
            try:
                yield SimpleNamespace(base=base, ids=ids, browser=browser)
            finally:
                browser.close()
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(work, ignore_errors=True)


def _open(app, route: str):
    """Open a route in a fresh context and collect errors the page reports."""
    context = app.browser.new_context(viewport={"width": 1440, "height": 900}, locale="en-US", timezone_id="UTC")
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.on("console", lambda msg: errors.append(f"console: {msg.text}") if msg.type == "error" else None)
    page.goto(app.base + route)
    return context, page, errors


def test_welcome_lists_the_seeded_projects(app) -> None:
    context, page, errors = _open(app, "/")
    try:
        page.wait_for_selector(".welcome-page")
        expect(page.get_by_text("Acme Web", exact=True).first).to_be_visible()
        assert errors == []
    finally:
        context.close()


def test_canvas_draws_the_company(app) -> None:
    context, page, errors = _open(app, f"/w/{app.ids['acme']}/canvas")
    try:
        # Two nodes must be drawn, not just the first. Counting once would race the layout.
        expect(page.locator(".react-flow__node").nth(1)).to_be_visible()
        assert errors == []
    finally:
        context.close()


def test_artifact_detail_shows_the_file_and_its_preview(app) -> None:
    context, page, errors = _open(app, f"/w/{app.ids['acme']}/artifacts/{app.ids['complete']}")
    try:
        page.wait_for_selector(".artifacts-layout")
        expect(page.locator(".artifacts-layout").get_by_text("index.html").first).to_be_visible()
        page.get_by_text("Preview", exact=True).first.click()
        expect(page.locator("iframe").first).to_be_visible()
        assert errors == []
    finally:
        context.close()
