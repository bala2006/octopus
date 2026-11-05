"""Plugin core: manifests, registry ordering and state, the builtin catalog, typed run topics, and the plugins migration."""
from __future__ import annotations

import dataclasses
import re
from collections import Counter
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text

import app
from app.api import ws as ws_module
from app.core.builtin import BUILTIN_MANIFESTS
from app.core.bus import EPHEMERAL_TOPICS, RunTopic, TypedRunBus
from app.core.context import PluginContext
from app.core.manifest import LAYERS, Manifest, ManifestError
from app.core.registry import DependencyCycleError, MissingDependencyError, PluginRegistry, RegistryError
from app.db.migrate import _config, upgrade_registry
from app.orchestrator.bus import EPHEMERAL, EventBus


def make(plugin_id: str, *, layer: str = "capability", kind: str = "test", version: str = "1.0.0",
         provides: tuple = (), requires: tuple = (), status: str = "built") -> Manifest:
    return Manifest(id=plugin_id, layer=layer, kind=kind, version=version,
                    provides=provides, requires=requires, status=status)


def ids(manifests) -> list[str]:
    return [m.id for m in manifests]


# --- manifest validation ---------------------------------------------------------------------------------------------

def test_manifest_accepts_valid_fields_and_is_frozen():
    m = make("capability.sandbox", provides=("sandbox.exec",), requires=("policy.gate",))
    assert (m.layer, m.status, m.provides) == ("capability", "built", ("sandbox.exec",))
    with pytest.raises(dataclasses.FrozenInstanceError):
        m.id = "capability.other"


@pytest.mark.parametrize("bad_id", ["sandbox", "Capability.sandbox", "capability..sandbox", "capability.sandbox ",
                                    "", "capability-sandbox", ".sandbox", "capability.Sandbox", None])
def test_manifest_rejects_ids_that_are_not_dotted_lowercase(bad_id):
    with pytest.raises(ManifestError):
        make(bad_id)


def test_manifest_rejects_unknown_layer_and_status():
    with pytest.raises(ManifestError, match="layer"):
        make("capability.x", layer="plugin")
    with pytest.raises(ManifestError, match="status"):
        make("capability.x", status="done")


def test_manifest_accepts_every_layer_and_status():
    for layer in LAYERS:
        for status in ("built", "partly", "planned"):
            make("core.x", layer=layer, status=status)


@pytest.mark.parametrize("field_name", ["provides", "requires"])
def test_provides_and_requires_must_be_tuples_of_dotted_names(field_name):
    with pytest.raises(ManifestError, match="tuple"):
        make("capability.x", **{field_name: ["sandbox.exec"]})
    with pytest.raises(ManifestError, match="tuple"):
        make("capability.x", **{field_name: "sandbox.exec"})
    with pytest.raises(ManifestError, match="dotted"):
        make("capability.x", **{field_name: ("sandbox",)})
    with pytest.raises(ManifestError, match="dotted"):
        make("capability.x", **{field_name: ("sandbox.exec", 3)})
    with pytest.raises(ManifestError, match="twice"):
        make("capability.x", **{field_name: ("sandbox.exec", "sandbox.exec")})


def test_manifest_rejects_empty_kind_and_overlong_version():
    with pytest.raises(ManifestError, match="kind"):
        make("capability.x", kind=" ")
    with pytest.raises(ManifestError, match="version"):
        make("capability.x", version="")
    with pytest.raises(ManifestError, match="version"):
        make("capability.x", version="1" * 41)


# --- registry: validation and ordering -------------------------------------------------------------------------------

def test_ordered_for_start_puts_providers_first_and_keeps_registration_order_for_ties():
    a = make("capability.a", requires=("b.x",), provides=("a.x",))
    b = make("capability.b", requires=("c.x",), provides=("b.x",))
    c = make("capability.c", provides=("c.x",))
    d = make("capability.d", provides=("d.x",))  # unrelated, registered last
    reg = PluginRegistry([a, b, c, d])
    assert ids(reg.ordered_for_start()) == ["capability.c", "capability.b", "capability.a", "capability.d"]


def test_unrelated_plugins_start_in_registration_order():
    x = make("capability.x", provides=("x.v",))
    y = make("capability.y", provides=("y.v",))
    assert ids(PluginRegistry([x, y]).ordered_for_start()) == ["capability.x", "capability.y"]
    assert ids(PluginRegistry([y, x]).ordered_for_start()) == ["capability.y", "capability.x"]


def test_requirement_with_two_providers_starts_after_both():
    user = make("capability.user", requires=("shared.cap",))
    first = make("capability.first", provides=("shared.cap",))
    second = make("capability.second", provides=("shared.cap",))
    order = ids(PluginRegistry([user, first, second]).ordered_for_start())
    assert order[-1] == "capability.user"
    assert set(order[:2]) == {"capability.first", "capability.second"}


def test_missing_requirement_is_rejected_at_construction():
    with pytest.raises(MissingDependencyError, match="capability.a.*nothing.here"):
        PluginRegistry([make("capability.a", requires=("nothing.here",))])


def test_plugin_cannot_satisfy_its_own_requirement():
    with pytest.raises(MissingDependencyError):
        PluginRegistry([make("capability.a", provides=("a.x",), requires=("a.x",))])


def test_two_plugin_cycle_is_rejected_and_the_loop_is_named():
    a = make("capability.a", provides=("a.x",), requires=("b.x",))
    b = make("capability.b", provides=("b.x",), requires=("a.x",))
    with pytest.raises(DependencyCycleError) as exc:
        PluginRegistry([a, b])
    assert "capability.a requires capability.b requires capability.a" in str(exc.value)


def test_cycle_is_named_even_when_a_dependent_is_registered_first():
    dependent = make("capability.d", requires=("a.x",))
    a = make("capability.a", provides=("a.x",), requires=("b.x",))
    b = make("capability.b", provides=("b.x",), requires=("a.x",))
    with pytest.raises(DependencyCycleError) as exc:
        PluginRegistry([dependent, a, b])
    assert "capability.a requires capability.b requires capability.a" in str(exc.value)


def test_three_plugin_cycle_is_rejected():
    a = make("capability.a", provides=("a.x",), requires=("c.x",))
    b = make("capability.b", provides=("b.x",), requires=("a.x",))
    c = make("capability.c", provides=("c.x",), requires=("b.x",))
    with pytest.raises(DependencyCycleError):
        PluginRegistry([a, b, c])


def test_duplicate_ids_and_non_manifests_are_rejected():
    with pytest.raises(RegistryError, match="duplicate plugin id: capability.a"):
        PluginRegistry([make("capability.a"), make("capability.a")])
    with pytest.raises(RegistryError, match="expected a Manifest"):
        PluginRegistry([{"id": "capability.a"}])


# --- registry: enable and disable ------------------------------------------------------------------------------------

def test_disable_removes_a_plugin_from_start_order_and_enable_restores_it():
    reg = PluginRegistry([make("capability.a", provides=("a.x",)), make("capability.b")])
    reg.disable("capability.b")
    assert reg.is_enabled("capability.b") is False
    assert ids(reg.ordered_for_start()) == ["capability.a"]
    reg.enable("capability.b")
    assert reg.is_enabled("capability.b") is True
    assert ids(reg.ordered_for_start()) == ["capability.a", "capability.b"]


def test_enabled_plugin_that_needs_a_disabled_provider_cannot_start():
    reg = PluginRegistry([make("capability.a", requires=("b.x",)), make("capability.b", provides=("b.x",))])
    reg.disable("capability.b")
    with pytest.raises(MissingDependencyError, match="no other enabled plugin"):
        reg.ordered_for_start()
    reg.enable("capability.b")
    assert ids(reg.ordered_for_start()) == ["capability.b", "capability.a"]


def test_disabling_a_plugin_does_not_change_the_manifest_set():
    reg = PluginRegistry([make("capability.a", provides=("a.x",))])
    reg.disable("capability.a")
    assert ids(reg.manifests()) == ["capability.a"]
    assert reg.get("capability.a").provides == ("a.x",)


def test_state_calls_reject_unknown_plugin_ids():
    reg = PluginRegistry([make("capability.a")])
    for call in (reg.enable, reg.disable, reg.is_enabled, reg.get):
        with pytest.raises(RegistryError, match="unknown plugin id"):
            call("capability.nope")


def test_plugin_context_holds_explicit_handles_and_none_placeholders():
    reg = PluginRegistry([])
    bus = TypedRunBus(EventBus())
    ctx = PluginContext(bus=bus, registry=reg)
    assert ctx.bus is bus and ctx.registry is reg
    for placeholder in ("policy", "run_manager", "storage", "models", "tools", "sandbox"):
        assert getattr(ctx, placeholder) is None
    with pytest.raises(dataclasses.FrozenInstanceError):
        ctx.policy = object()
    with pytest.raises(TypeError):
        PluginContext()  # bus and registry are required


# --- builtin catalog -------------------------------------------------------------------------------------------------

def test_builtin_ids_are_unique():
    assert len(set(ids(BUILTIN_MANIFESTS))) == len(BUILTIN_MANIFESTS)


def test_every_builtin_entry_is_a_valid_manifest():
    for m in BUILTIN_MANIFESTS:
        assert isinstance(m, Manifest)
        dataclasses.replace(m)  # re-runs __post_init__ validation
        assert m.layer in LAYERS


def test_builtin_catalog_forms_a_valid_registry_with_every_entry_startable():
    reg = PluginRegistry(BUILTIN_MANIFESTS)
    assert sorted(ids(reg.ordered_for_start())) == sorted(ids(BUILTIN_MANIFESTS))


def test_builtin_layer_counts_match_the_plan_mapping_table():
    # One entry per row of section 4 in docs/architecture/refactor-plan.md.
    assert Counter(m.layer for m in BUILTIN_MANIFESTS) == {
        "channel": 4, "agent": 6, "workflow": 5, "capability": 12, "core": 6}


def test_planned_and_partly_entries_are_declared_explicitly():
    not_built = {m.id: m.status for m in BUILTIN_MANIFESTS if m.status != "built"}
    assert not_built == {
        "channel.cli": "partly",
        "channel.chat_apps": "planned",
        "core.plugin_contract": "planned",
        "core.plugin_registry": "planned",
    }


def test_builtin_requirements_point_only_to_the_same_or_a_lower_layer():
    rank = {"channel": 4, "agent": 3, "workflow": 2, "capability": 1, "core": 0}
    providers: dict[str, list[Manifest]] = {}
    for m in BUILTIN_MANIFESTS:
        for name in m.provides:
            providers.setdefault(name, []).append(m)
    for m in BUILTIN_MANIFESTS:
        for need in m.requires:
            for provider in providers[need]:
                assert rank[provider.layer] <= rank[m.layer], (
                    f"{m.id} ({m.layer}) requires {need} from {provider.id} ({provider.layer})")


# --- typed run topics ------------------------------------------------------------------------------------------------

def _ws_docstring_run_events() -> set[str]:
    doc = ws_module.__doc__ or ""
    label = "server → client:"
    start = doc.index(label) + len(label)
    end = doc.index("client → server:", start)
    names: set[str] = set()
    for item in doc[start:end].split(","):
        match = re.match(r"\s*([a-z_]+)", item)
        if match:
            names.add(match.group(1))
    return names


def test_run_topics_cover_every_run_event_named_in_the_ws_docstring():
    documented = _ws_docstring_run_events()
    assert "browser_action" in documented and "thinking_stream" in documented  # parser sanity check
    assert documented <= {t.value for t in RunTopic}


def test_run_topics_cover_every_literal_event_name_the_backend_sends():
    root = Path(app.__file__).parent
    pattern = re.compile(r'\b(?:emit|publish)\(\s*(?:[\w.]+,\s*)?"([a-z_]+)"')
    sources = [*sorted((root / "orchestrator").glob("*.py")), root / "api" / "ws.py"]
    emitted: set[str] = set()
    for path in sources:
        emitted |= set(pattern.findall(path.read_text(encoding="utf-8")))
    assert len(emitted) > 20  # sanity check that the scan found the emit sites
    assert emitted <= {t.value for t in RunTopic}


def test_ephemeral_topics_match_the_live_event_bus():
    assert {t.value for t in EPHEMERAL_TOPICS} == set(EPHEMERAL)


async def test_typed_bus_forwards_publish_and_subscribe_to_the_existing_bus():
    inner = EventBus()
    typed = TypedRunBus(inner)
    queue = typed.subscribe("run-1")
    # token_stream is ephemeral, so publish never touches the session factory.
    event = await typed.publish("run-1", RunTopic.TOKEN_STREAM, {"text": "hi"}, sf=None)
    assert event == {"type": "token_stream", "run_id": "run-1", "data": {"text": "hi"}, "ts": event["ts"]}
    assert queue.get_nowait() == event
    typed.unsubscribe("run-1", queue)
    await typed.publish("run-1", RunTopic.TOKEN_STREAM, {"text": "after"}, sf=None)
    assert queue.empty()


async def test_typed_bus_rejects_unknown_topics_before_sending():
    typed = TypedRunBus(EventBus())
    with pytest.raises(ValueError):
        await typed.publish("run-1", "not_a_topic", {}, sf=None)


# --- registry migration ----------------------------------------------------------------------------------------------

def test_registry_migration_adds_plugins_table_and_downgrade_drops_it(tmp_path):
    db_file = tmp_path / "registry.db"
    url = f"sqlite+aiosqlite:///{db_file}"
    engine = create_engine(f"sqlite:///{db_file}")
    try:
        upgrade_registry(url)
        assert "plugins" in inspect(engine).get_table_names()
        columns = {c["name"]: c for c in inspect(engine).get_columns("plugins")}
        assert set(columns) == {"id", "enabled", "version", "updated_at"}
        assert columns["enabled"]["nullable"] is False
        assert columns["version"]["nullable"] is False
        assert inspect(engine).get_pk_constraint("plugins")["constrained_columns"] == ["id"]

        with engine.begin() as conn:
            conn.execute(text("INSERT INTO plugins (id, version) VALUES ('core.bus', '1.0.0')"))
            enabled = conn.execute(text("SELECT enabled FROM plugins WHERE id = 'core.bus'")).scalar_one()
        assert enabled == 1  # server default: enabled is true

        command.downgrade(_config("registry", url), "0005_registry")
        tables = inspect(engine).get_table_names()
        assert "plugins" not in tables
        assert "users" in tables  # earlier registry tables are untouched

        upgrade_registry(url)
        assert "plugins" in inspect(engine).get_table_names()
    finally:
        engine.dispose()
