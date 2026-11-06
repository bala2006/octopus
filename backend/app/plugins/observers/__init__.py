"""Observer plugins: read run data and publish nothing. Currency rates and the run report."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin
from app.plugins.observers.deps import deps


def _fx():
    from app.plugins.observers import fx
    return fx


def _report():
    from app.plugins.observers import report
    return report


PLUGINS = (
    ServicePlugin(
        Manifest(id="observer.fx", slot="observer", kind="currency", version="1.0.0", title="Currency rates",
                 description="Converts USD costs to the user's currency with cached daily rates.",
                 provides=("observers.fx",), requires=(), permissions=("network",), ui=("settings/appearance",), start="lazy"),
        services={"observers.fx": _fx}),
    ServicePlugin(
        Manifest(id="observer.report", slot="observer", kind="report", version="1.0.0", title="Run report",
                 description="Builds the Markdown report of a finished run from its events and state.",
                 provides=("reports.build",), requires=(), optional=("workflow.company",), permissions=("db",)),
        services={"reports.build": _report}, deps=deps),
)
