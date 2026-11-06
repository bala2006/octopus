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
from app.channels.ws import endpoints as ws_module
from app.sdk.topics import EPHEMERAL_TOPICS, RunTopic
from app.sdk.manifest import SDK_VERSION, SLOTS, Manifest, ManifestError, sdk_range_allows
from app.kernel.registry import DependencyCycleError, MissingDependencyError, PluginRegistry, RegistryError
from app.storage.migrate import _config, upgrade_registry
from app.kernel.eventlog import EPHEMERAL


def make(plugin_id: str, *, slot: str = "service", kind: str = "test", version: str = "1.0.0",
         provides: tuple = (), requires: tuple = (), status: str = "built", **extra) -> Manifest:
    return Manifest(id=plugin_id, slot=slot, kind=kind, version=version,
                    provides=provides, requires=requires, status=status, **extra)


def ids(manifests) -> list[str]:
    return [m.id for m in manifests]


# --- manifest validation ---------------------------------------------------------------------------------------------

def test_manifest_accepts_valid_fields_and_is_frozen():
    m = make("service.sandbox", provides=("sandbox.exec",), requires=("policy.gate",))
    assert (m.slot, m.status, m.provides) == ("service", "built", ("sandbox.exec",))
    with pytest.raises(dataclasses.FrozenInstanceError):
        m.id = "service.other"


@pytest.mark.parametrize("bad_id", ["sandbox", "Capability.sandbox", "service..sandbox", "service.sandbox ",
                                    "", "capability-sandbox", ".sandbox", "service.Sandbox", None])
def test_manifest_rejects_ids_that_are_not_dotted_lowercase(bad_id):
    with pytest.raises(ManifestError):
        make(bad_id)


def test_manifest_rejects_unknown_slot_and_status():
    with pytest.raises(ManifestError, match="slot"):
        make("service.x", slot="plugin")
    with pytest.raises(ManifestError, match="status"):
        make("service.x", status="done")


def test_manifest_accepts_every_slot_and_status():
    for slot in SLOTS:
        for status in ("built", "partly", "planned"):
            make("core.x", slot=slot, status=status)


@pytest.mark.parametrize("field_name", ["provides", "requires"])
def test_provides_and_requires_must_be_tuples_of_dotted_names(field_name):
    with pytest.raises(ManifestError, match="tuple"):
        make("service.x", **{field_name: ["sandbox.exec"]})
    with pytest.raises(ManifestError, match="tuple"):
        make("service.x", **{field_name: "sandbox.exec"})
    with pytest.raises(ManifestError, match="dotted"):
        make("service.x", **{field_name: ("sandbox",)})
    with pytest.raises(ManifestError, match="dotted"):
        make("service.x", **{field_name: ("sandbox.exec", 3)})
    with pytest.raises(ManifestError, match="twice"):
        make("service.x", **{field_name: ("sandbox.exec", "sandbox.exec")})


def test_manifest_rejects_empty_kind_and_overlong_version():
    with pytest.raises(ManifestError, match="kind"):
        make("service.x", kind=" ")
    with pytest.raises(ManifestError, match="version"):
        make("service.x", version="")
    with pytest.raises(ManifestError, match="version"):
        make("service.x", version="1" * 41)


# --- manifest v2 ----------------------------------------------------------------------------------------------------

def test_manifest_v2_fields_default_to_a_plain_eager_plugin():
    m = make("service.x")
    assert (m.sdk, m.start, m.required, m.optional, m.permissions, m.emits, m.ui) == (">=1.0,<2", "eager", False, (), (), (), ())
    assert m.compatible() and m.label == "service.x"


def test_sdk_range_is_checked_against_the_sdk_version():
    assert sdk_range_allows(">=1.0,<2", "1.0.0") and sdk_range_allows(">=1.0,<2", "1.9.3")
    assert not sdk_range_allows(">=1.0,<2", "2.0.0") and not sdk_range_allows(">=1.1", "1.0.0")
    assert not make("service.x", sdk=">=2.0").compatible(SDK_VERSION)
    for bad in ("", "1.0", ">=one", ">=1.0;<2"):
        with pytest.raises(ManifestError):
            sdk_range_allows(bad)
    with pytest.raises(ManifestError, match="sdk range"):
        make("service.x", sdk="latest")


def test_manifest_v2_validates_permissions_emits_start_and_optional():
    with pytest.raises(ManifestError, match="permission"):
        make("service.x", permissions=("root",))
    with pytest.raises(ManifestError, match="not a run topic"):
        make("service.x", emits=("made_up_topic",))
    with pytest.raises(ManifestError, match="start"):
        make("service.x", start="sometimes")
    with pytest.raises(ManifestError, match="both required and optional"):
        make("service.x", requires=("a.b",), optional=("a.b",))
    ok = make("service.x", permissions=("network", "exec"), emits=("browser_action",), optional=("a.b",), start="lazy", required=True)
    assert ok.permissions == ("network", "exec") and ok.start == "lazy" and ok.required


# --- registry: validation and ordering -------------------------------------------------------------------------------

def test_ordered_for_start_puts_providers_first_and_keeps_registration_order_for_ties():
    a = make("service.a", requires=("b.x",), provides=("a.x",))
    b = make("service.b", requires=("c.x",), provides=("b.x",))
    c = make("service.c", provides=("c.x",))
    d = make("service.d", provides=("d.x",))  # unrelated, registered last
    reg = PluginRegistry([a, b, c, d])
    assert ids(reg.ordered_for_start()) == ["service.c", "service.b", "service.a", "service.d"]


def test_unrelated_plugins_start_in_registration_order():
    x = make("service.x", provides=("x.v",))
    y = make("service.y", provides=("y.v",))
    assert ids(PluginRegistry([x, y]).ordered_for_start()) == ["service.x", "service.y"]
    assert ids(PluginRegistry([y, x]).ordered_for_start()) == ["service.y", "service.x"]


def test_requirement_with_two_providers_starts_after_both():
    user = make("service.user", requires=("shared.cap",))
    first = make("service.first", provides=("shared.cap",))
    second = make("service.second", provides=("shared.cap",))
    order = ids(PluginRegistry([user, first, second]).ordered_for_start())
    assert order[-1] == "service.user"
    assert set(order[:2]) == {"service.first", "service.second"}


def test_missing_requirement_is_rejected_at_construction():
    with pytest.raises(MissingDependencyError, match="service.a.*nothing.here"):
        PluginRegistry([make("service.a", requires=("nothing.here",))])


def test_plugin_cannot_satisfy_its_own_requirement():
    with pytest.raises(MissingDependencyError):
        PluginRegistry([make("service.a", provides=("a.x",), requires=("a.x",))])


def test_two_plugin_cycle_is_rejected_and_the_loop_is_named():
    a = make("service.a", provides=("a.x",), requires=("b.x",))
    b = make("service.b", provides=("b.x",), requires=("a.x",))
    with pytest.raises(DependencyCycleError) as exc:
        PluginRegistry([a, b])
    assert "service.a requires service.b requires service.a" in str(exc.value)


def test_cycle_is_named_even_when_a_dependent_is_registered_first():
    dependent = make("service.d", requires=("a.x",))
    a = make("service.a", provides=("a.x",), requires=("b.x",))
    b = make("service.b", provides=("b.x",), requires=("a.x",))
    with pytest.raises(DependencyCycleError) as exc:
        PluginRegistry([dependent, a, b])
    assert "service.a requires service.b requires service.a" in str(exc.value)


def test_three_plugin_cycle_is_rejected():
    a = make("service.a", provides=("a.x",), requires=("c.x",))
    b = make("service.b", provides=("b.x",), requires=("a.x",))
    c = make("service.c", provides=("c.x",), requires=("b.x",))
    with pytest.raises(DependencyCycleError):
        PluginRegistry([a, b, c])


def test_duplicate_ids_and_non_manifests_are_rejected():
    with pytest.raises(RegistryError, match="duplicate plugin id: service.a"):
        PluginRegistry([make("service.a"), make("service.a")])
    with pytest.raises(RegistryError, match="expected a Manifest"):
        PluginRegistry([{"id": "service.a"}])


# --- registry: enable and disable ------------------------------------------------------------------------------------

def test_disable_removes_a_plugin_from_start_order_and_enable_restores_it():
    reg = PluginRegistry([make("service.a", provides=("a.x",)), make("service.b")])
    reg.disable("service.b")
    assert reg.is_enabled("service.b") is False
    assert ids(reg.ordered_for_start()) == ["service.a"]
    reg.enable("service.b")
    assert reg.is_enabled("service.b") is True
    assert ids(reg.ordered_for_start()) == ["service.a", "service.b"]


def test_enabled_plugin_that_needs_a_disabled_provider_cannot_start():
    reg = PluginRegistry([make("service.a", requires=("b.x",)), make("service.b", provides=("b.x",))])
    reg.disable("service.b")
    with pytest.raises(MissingDependencyError, match="no other enabled plugin"):
        reg.ordered_for_start()
    reg.enable("service.b")
    assert ids(reg.ordered_for_start()) == ["service.b", "service.a"]


def test_disabling_a_plugin_does_not_change_the_manifest_set():
    reg = PluginRegistry([make("service.a", provides=("a.x",))])
    reg.disable("service.a")
    assert ids(reg.manifests()) == ["service.a"]
    assert reg.get("service.a").provides == ("a.x",)


def test_state_calls_reject_unknown_plugin_ids():
    reg = PluginRegistry([make("service.a")])
    for call in (reg.enable, reg.disable, reg.is_enabled, reg.get):
        with pytest.raises(RegistryError, match="unknown plugin id"):
            call("service.nope")


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
    sources = [*sorted((root / "kernel").rglob("*.py")), *sorted((root / "plugins").rglob("*.py")), root / "channels" / "ws" / "endpoints.py"]
    emitted: set[str] = set()
    for path in sources:
        emitted |= set(pattern.findall(path.read_text(encoding="utf-8")))
    assert len(emitted) > 20  # sanity check that the scan found the emit sites
    assert emitted <= {t.value for t in RunTopic}


def test_ephemeral_topics_match_the_event_log():
    assert {t.value for t in EPHEMERAL_TOPICS} == set(EPHEMERAL)


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
