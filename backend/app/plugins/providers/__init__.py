"""Model provider plugins: the router that picks a provider and resolves credentials, Azure OpenAI, LiteLLM, and OpenCode."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.plugins.providers.deps import deps
from app.sdk.llm import LLMRequest
from app.sdk.manifest import Manifest
from app.sdk.plugin import HostApi, PluginBase, ServicePlugin


def _router():
    from app.plugins.providers import router
    return router


class _ProviderPlugin(PluginBase):
    """A provider the router can pick. It registers with the router when it loads and leaves it when it is switched off."""

    def __init__(self, manifest: Manifest, *, name: str, accepts: Callable[[str, LLMRequest | None], bool],
                 factory: Callable[[], Any], priority: int, service: Callable[[], Any]) -> None:
        self.manifest = manifest
        self._name, self._accepts, self._factory, self._priority, self._service = name, accepts, factory, priority, service

    def register(self, host: HostApi) -> None:
        deps.bind(host.services, replace=False)
        host.services.require("models.router").register_provider(self._name, self._accepts, self._factory, priority=self._priority)
        host.provide(self.manifest.provides[0], self._service())

    def bind_deps(self, services: Any) -> None:
        deps.bind(services)

    async def stop(self) -> None:
        router = deps.get("models.router")
        if router is not None:
            router.unregister_provider(self._name)


def _azure_accepts(name: str, req: LLMRequest | None) -> bool:
    from app.plugins.providers.azure_v1 import azure_v1_target
    return name == "azure" and req is not None and azure_v1_target(req.base_url, req.extra) is not None


def _azure_provider():
    from app.plugins.providers.azure_v1 import AzureV1Provider
    return AzureV1Provider()


def _azure_module():
    from app.plugins.providers import azure_v1
    return azure_v1


def _litellm_provider():
    from app.plugins.providers.litellm_provider import LiteLLMProvider
    return LiteLLMProvider()


def _litellm_module():
    from app.plugins.providers import litellm_provider
    return litellm_provider


def _opencode():
    from app.plugins.providers import opencode
    return opencode


def _opencode_turn():
    from app.plugins.providers.opencode_turn import opencode_turn
    return opencode_turn


PLUGINS = (
    ServicePlugin(
        Manifest(id="provider.router", slot="provider", kind="router", version="1.0.0", title="Model router",
                 description="Chooses the model provider for a request, resolves the user's credentials and retries transient failures.",
                 provides=("models.router",), requires=(), permissions=("network", "db", "secrets"), ui=("settings/model",), required=True),
        services={"models.router": _router}, deps=deps),
    _ProviderPlugin(
        Manifest(id="provider.azure", slot="provider", kind="model", version="1.0.0", title="Azure OpenAI (v1 API)",
                 description="Azure OpenAI over the v1 Responses and Chat Completions APIs, with exact usage and pricing.",
                 provides=("models.azure",), requires=("models.router",), permissions=("network", "secrets")),
        name="azure_v1", accepts=_azure_accepts, factory=_azure_provider, priority=10, service=_azure_module),
    _ProviderPlugin(
        Manifest(id="provider.litellm", slot="provider", kind="model", version="1.0.0", title="OpenAI-compatible (LiteLLM)",
                 description="Any other OpenAI-compatible endpoint, and legacy Azure deployment URLs.",
                 provides=("models.litellm",), requires=("models.router",), permissions=("network", "secrets")),
        name="litellm", accepts=lambda name, req: True, factory=_litellm_provider, priority=90, service=_litellm_module),
    ServicePlugin(
        Manifest(id="provider.opencode", slot="provider", kind="agent backend", version="1.0.0", title="OpenCode (local CLI)",
                 description="Runs an agent turn through the OpenCode installed on this computer over the Agent Client Protocol.",
                 provides=("models.opencode", "models.turn_opencode"), requires=("sandbox.exec", "mcp.bridge"),
                 permissions=("exec", "fs_read", "fs_write", "network"), start="lazy"),
        services={"models.opencode": _opencode, "models.turn_opencode": _opencode_turn}, deps=deps),
)
