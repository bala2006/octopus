"""The plugin host: the built-in plugin set, lifecycle, enabling and disabling with dependents, persisted state, and a run that
keeps going while a plugin is switched off."""
from __future__ import annotations

import re
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from conftest import NativeScriptedProvider, agent, make_company, start_run, wait_status
from app.bootstrap import build_kernel
from app.kernel.current import current
from app.kernel.host import HostError
from app.plugins.providers.router import set_provider_override
from app.sdk.manifest import Manifest
from app.sdk.plugin import Health, PluginBase, ServicePlugin
from app.storage.migrate import upgrade_registry
from app.storage.models import PluginState
from app.storage.session import make_engine

APP_DIR = Path(__file__).resolve().parents[1] / "app"


@pytest.fixture
def kernel():
    return build_kernel()


@pytest_asyncio.fixture
async def registry_sf(tmp_path) -> AsyncIterator:
    url = f"sqlite+aiosqlite:///{tmp_path / 'registry.db'}"
    upgrade_registry(url)
    engine = make_engine(url)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


def states(kernel) -> dict[str, str]:
    return {row["id"]: row["state"] for row in kernel.host.describe()}


# --- the built-in set -----------------------------------------------------------------------------------------------

def test_every_builtin_plugin_registers_and_provides_what_its_manifest_promises(kernel) -> None:
    rows = kernel.host.describe()
    assert len(rows) >= 39 and len({r["id"] for r in rows}) == len(rows)
    assert {r["state"] for r in rows} == {"registered"}
    missing = [(r["id"], cap) for r in rows for cap in r["provides"] if not kernel.services.has(cap)]
    assert not missing, f"capabilities listed in a manifest but never provided: {missing}"


def test_the_builtin_set_covers_every_slot_the_architecture_names() -> None:
    slots = {row["slot"] for row in build_kernel().host.describe()}
    assert slots == {"kernel", "channel", "provider", "tool", "workflow", "role", "knowledge", "runner", "workspace", "observer", "service"}


def test_start_order_puts_providers_before_the_plugins_that_need_them(kernel) -> None:
    order = [row["id"] for row in kernel.host.describe()]
    for row in kernel.host.describe():
        for need in row["requires"]:
            provider = next(r["id"] for r in kernel.host.describe() if need in r["provides"])
            assert order.index(provider) < order.index(row["id"]), f"{row['id']} starts before {provider}"


def test_the_run_loop_parts_are_required_and_cannot_be_switched_off(kernel) -> None:
    required = {row["id"] for row in kernel.host.describe() if row["required"]}
    assert {"kernel.runs", "kernel.eventlog", "provider.router", "tool.messaging", "workflow.task_board", "workspace.local"} <= required
    assert not required & {"tool.web", "tool.mcp", "service.browser", "workflow.company", "provider.opencode"}


def _service_literals(root: Path) -> set[str]:
    pattern = re.compile(r'(?:services|deps)\.(?:require|get)\(\s*"([a-z_]+\.[a-z_.]+)"')
    found: set[str] = set()
    for path in root.rglob("*.py"):
        found |= set(pattern.findall(path.read_text(encoding="utf-8")))
    return found


def test_manifests_declare_every_capability_the_plugin_code_looks_up(kernel) -> None:
    """A plugin package may only look up capabilities that one of its manifests lists in requires or optional (or provides)."""
    by_package: dict[str, set[str]] = {}
    for plugin in kernel.host.plugins():
        module = type(plugin).__module__
        package = module.split(".")[2] if module.startswith("app.plugins.") else None
        if package is None:  # kernel components and channels have no plugin package
            continue
        manifest = plugin.manifest
        by_package.setdefault(package, set()).update((*manifest.requires, *manifest.optional, *manifest.provides))
    # a package's plugins live in its __init__, but ServicePlugin is defined in the SDK: find packages by directory instead
    for package_dir in sorted((APP_DIR / "plugins").iterdir()):
        if not package_dir.is_dir() or package_dir.name == "__pycache__":
            continue
        declared: set[str] = set()
        init = package_dir / "__init__.py"
        declared_ids = re.findall(r'id="([a-z_.]+)"', init.read_text(encoding="utf-8"))
        for plugin in kernel.host.plugins():
            if plugin.manifest.id in declared_ids:
                declared |= {*plugin.manifest.requires, *plugin.manifest.optional, *plugin.manifest.provides}
        unknown = _service_literals(package_dir) - declared
        assert not unknown, f"app/plugins/{package_dir.name} looks up {sorted(unknown)} without declaring it in a manifest"


def test_the_kernel_only_looks_up_capabilities_some_builtin_plugin_provides(kernel) -> None:
    provided = {cap for row in kernel.host.describe() for cap in row["provides"]}
    unknown = _service_literals(APP_DIR / "kernel") - provided
    assert not unknown, f"the kernel asks for capabilities nothing provides: {sorted(unknown)}"
    dynamic = {f"models.turn_{name}" for name in ("opencode",)}  # looked up by provider name
    assert dynamic <= provided


# --- enabling and disabling -----------------------------------------------------------------------------------------

async def test_disabling_a_tool_plugin_removes_its_actions_and_enabling_restores_them(kernel) -> None:
    assert kernel.tools.has("web_search") and kernel.services.has("tools.web")
    assert await kernel.host.set_enabled(None, "tool.web", False) == ["tool.web"]
    assert not kernel.tools.has("web_search") and not kernel.tools.has("calculate") and not kernel.services.has("tools.web")
    assert states(kernel)["tool.web"] == "disabled"
    assert await kernel.host.set_enabled(None, "tool.web", True) == ["tool.web"]
    assert kernel.tools.has("web_search") and states(kernel)["tool.web"] == "registered"


async def test_a_plugin_that_others_need_is_not_disabled_without_cascade(kernel) -> None:
    assert kernel.host.dependents_of("workflow.org") == ["tool.team"]
    with pytest.raises(HostError, match="tool.team"):
        await kernel.host.set_enabled(None, "workflow.org", False)
    assert states(kernel)["workflow.org"] == "registered"
    changed = await kernel.host.set_enabled(None, "workflow.org", False, cascade=True)
    assert changed == ["tool.team", "workflow.org"]  # dependents stop first
    assert not kernel.tools.has("create_agent") and not kernel.services.has("workflow.org")


async def test_enabling_a_plugin_whose_requirement_is_off_needs_cascade(kernel) -> None:
    await kernel.host.set_enabled(None, "workflow.org", False, cascade=True)
    with pytest.raises(HostError, match="workflow.org"):
        await kernel.host.set_enabled(None, "tool.team", True)
    changed = await kernel.host.set_enabled(None, "tool.team", True, cascade=True)
    assert changed == ["workflow.org", "tool.team"]  # providers first
    assert kernel.tools.has("list_agents") and kernel.services.has("workflow.org")


async def test_required_plugins_and_unknown_ids_are_refused(kernel) -> None:
    for pid in ("kernel.runs", "provider.router", "tool.messaging", "workflow.task_board"):
        with pytest.raises(HostError, match="cannot be disabled"):
            await kernel.host.set_enabled(None, pid, False)
    with pytest.raises(HostError, match="unknown plugin"):
        await kernel.host.set_enabled(None, "tool.nope", False)


async def test_run_methods_follow_their_plugin(kernel) -> None:
    assert kernel.run_methods.get("delegate") is not None and kernel.run_methods.get("open_tasks") is not None
    await kernel.host.set_enabled(None, "tool.delegation", False)
    assert kernel.run_methods.get("delegate") is None and kernel.run_methods.get("open_tasks") is not None
    await kernel.host.set_enabled(None, "tool.delegation", True)
    assert kernel.run_methods.get("delegate") is not None


async def test_the_company_workflow_takes_its_tool_with_it(kernel) -> None:
    assert kernel.tools.has("set_track")
    assert await kernel.host.set_enabled(None, "workflow.company", False, cascade=True) == ["tool.workflow", "workflow.company"]
    assert not kernel.tools.has("set_track") and not kernel.services.has("workflow.company")


# --- persisted state ------------------------------------------------------------------------------------------------

async def test_toggling_is_saved_and_applied_by_the_next_kernel(registry_sf) -> None:
    first = build_kernel()
    await first.host.set_enabled(registry_sf, "tool.web", False)
    async with registry_sf() as db:
        saved = {row.id: row.enabled for row in (await db.execute(select(PluginState))).scalars()}
    assert saved == {"tool.web": False}

    second = build_kernel()
    await second.host.apply_persisted(registry_sf)
    assert states(second)["tool.web"] == "disabled" and not second.tools.has("web_search")
    async with registry_sf() as db:  # every plugin is now recorded with its version
        rows = {row.id: row for row in (await db.execute(select(PluginState))).scalars()}
    assert {r["id"] for r in second.host.describe()} == set(rows) and rows["tool.web"].enabled is False


def test_a_plugin_whose_requirement_was_disabled_starts_blocked_instead_of_failing_the_boot() -> None:
    kernel = build_kernel(disabled=("workflow.org",))
    state = states(kernel)
    assert state["workflow.org"] == "disabled" and state["tool.team"] == "blocked"
    assert not kernel.tools.has("create_agent")
    row = next(r for r in kernel.host.describe() if r["id"] == "tool.team")
    assert "workflow.org" in row["error"]


def test_a_required_plugin_cannot_be_disabled_by_saved_state() -> None:
    kernel = build_kernel(disabled=("tool.messaging", "kernel.runs"))
    assert states(kernel)["tool.messaging"] == "registered" and states(kernel)["kernel.runs"] == "registered"


# --- lifecycle ------------------------------------------------------------------------------------------------------

class Recorder(PluginBase):
    def __init__(self, pid: str, log: list[str], *, requires: tuple[str, ...] = (), provides: tuple[str, ...] = (), start: str = "eager",
                 fail_in: str = "", sdk: str = ">=1.0,<2", required: bool = False, health: Health | None = None) -> None:
        self.manifest = Manifest(id=pid, slot="service", kind="test", version="1.0.0", provides=provides, requires=requires,
                                 start=start, sdk=sdk, required=required)  # type: ignore[arg-type]
        self.log, self.fail_in, self._health = log, fail_in, health or Health()
        self.events: list[str] = []

    def register(self, host) -> None:
        self.log.append(f"register {self.manifest.id}")
        if self.fail_in == "register":
            raise RuntimeError("boom")
        for cap in self.manifest.provides:
            host.provide(cap, self)
        self.cancel = host.subscribe(lambda event: self.events.append(event["type"]), topics=frozenset({"error"}))

    async def start(self, host) -> None:
        self.log.append(f"start {self.manifest.id}")
        if self.fail_in == "start":
            raise RuntimeError("cannot start")

    async def stop(self) -> None:
        self.log.append(f"stop {self.manifest.id}")

    async def health(self) -> Health:
        return self._health


def test_a_plugin_is_started_after_what_it_needs_and_stopped_before_it() -> None:
    import asyncio

    log: list[str] = []
    kernel = build_kernel([Recorder("service.zeta", log, requires=("test.alpha",)), Recorder("service.alpha", log, provides=("test.alpha",)),
                           Recorder("service.lazy", log, start="lazy")])

    async def run() -> None:
        await kernel.host.start()
        await kernel.host.stop()

    asyncio.run(run())
    assert log.index("start service.alpha") < log.index("start service.zeta")
    assert "start service.lazy" not in log and "stop service.lazy" in log  # lazy plugins start themselves but are still stopped
    assert log.index("stop service.zeta") < log.index("stop service.alpha")


def test_a_failing_plugin_is_marked_failed_and_the_others_keep_working() -> None:
    import asyncio

    log: list[str] = []
    kernel = build_kernel([Recorder("service.bad_register", log, fail_in="register"), Recorder("service.bad_start", log, fail_in="start"),
                           Recorder("service.fine", log)])
    asyncio.run(kernel.host.start())
    state = states(kernel)
    assert state["service.bad_register"] == "failed" and state["service.bad_start"] == "failed" and state["service.fine"] == "started"
    assert "RuntimeError" in next(r["error"] for r in kernel.host.describe() if r["id"] == "service.bad_register")
    assert kernel.tools.has("send_message")  # the built-in plugins are unaffected


def test_a_required_plugin_that_fails_stops_the_boot() -> None:
    with pytest.raises(HostError, match="failed to register"):
        build_kernel([Recorder("service.must", [], fail_in="register", required=True)])


def test_a_plugin_for_another_sdk_version_is_refused() -> None:
    with pytest.raises(HostError, match="needs octopus-sdk"):
        build_kernel([Recorder("service.future", [], sdk=">=2.0")])


def test_two_plugins_cannot_provide_the_same_capability() -> None:
    kernel = build_kernel([Recorder("service.one", [], provides=("test.same",)), Recorder("service.two", [], provides=("test.same",))])
    assert states(kernel)["service.two"] == "failed" and "already provided by service.one" in next(
        r["error"] for r in kernel.host.describe() if r["id"] == "service.two")


async def test_health_reports_degraded_plugins(kernel) -> None:
    recorder = Recorder("service.shaky", [], health=Health("degraded", "slow disk"))
    k = build_kernel([recorder])
    report = await k.host.check_health()
    assert report["service.shaky"] == Health("degraded", "slow disk") and report["kernel.runs"].state == "ok"


async def test_event_subscriptions_end_when_the_plugin_is_disabled() -> None:
    recorder = Recorder("service.listener", [])
    kernel = build_kernel([recorder])
    kernel.eventlog.relay({"type": "error", "run_id": "r", "data": {}, "seq": 1})
    kernel.eventlog.relay({"type": "turn_started", "run_id": "r", "data": {}, "seq": 2})
    assert recorder.events == ["error"]  # only the topics it asked for
    await kernel.host.set_enabled(None, "service.listener", False)
    kernel.eventlog.relay({"type": "error", "run_id": "r", "data": {}, "seq": 3})
    assert recorder.events == ["error"]


# --- a run keeps going while a plugin is off ------------------------------------------------------------------------

async def test_a_run_survives_a_disabled_tool_plugin(client, workspace) -> None:
    kernel = current()
    scripted = NativeScriptedProvider({"Wes": [[("calculate", {"expression": "1+1"})], [("finish", {"summary": "done without the calculator"})]]})
    await kernel.host.set_enabled(None, "tool.web", False)
    try:
        cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
        set_provider_override(scripted)
        run = await start_run(client, workspace, cid)
        done = await wait_status(client, workspace, run["id"])
        assert done["status"] == "completed"
        offered = {tool["name"] for tool in scripted.requests[0].tools}
        assert "calculate" not in offered and "finish" in offered  # the model is never offered a tool that is switched off
        events = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/events")).json()
        assert any(e["type"] == "error" and "disabled" in e["payload"].get("message", "") for e in events)
    finally:
        set_provider_override(None)
        await kernel.host.set_enabled(None, "tool.web", True)
    assert kernel.tools.has("web_search")


async def test_a_run_without_the_company_workflow_is_free_form(client, workspace) -> None:
    kernel = current()
    await kernel.host.set_enabled(None, "workflow.company", False, cascade=True)
    try:
        scripted = NativeScriptedProvider({"Wes": [[("finish", {"summary": "all done"})]]})
        cid = await make_company(client, workspace, [agent("w", "Wes", entry=True)], [])
        set_provider_override(scripted)
        run = await start_run(client, workspace, cid)
        done = await wait_status(client, workspace, run["id"])
        assert done["status"] == "completed"
        assert "calculate" in {tool["name"] for tool in scripted.requests[0].tools} and "set_track" not in {t["name"] for t in scripted.requests[0].tools}
    finally:
        set_provider_override(None)
        await kernel.host.set_enabled(None, "workflow.company", True, cascade=True)
        await kernel.host.set_enabled(None, "tool.workflow", True)
    assert kernel.tools.has("set_track") and kernel.services.has("workflow.company")


def test_a_service_plugin_registers_what_it_is_given_and_nothing_else() -> None:
    plugin = ServicePlugin(Manifest(id="service.data", slot="service", kind="test", version="1.0.0", provides=("test.data",), requires=()),
                           services={"test.data": lambda: {"answer": 42}})
    kernel = build_kernel([plugin])
    assert kernel.services.require("test.data") == {"answer": 42} and kernel.services.owner_of("test.data") == "service.data"
