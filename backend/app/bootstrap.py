"""Composition root: the one place that lists every built-in plugin and builds the kernel from them.

Everything else reaches plugins through the kernel's service registry. To add a plugin, add its package to ``builtin_plugins``.
A third-party plugin is passed in as ``extra``.
"""
from __future__ import annotations

from collections.abc import Iterable

from app.kernel.core import Kernel
from app.sdk.plugin import Plugin


def builtin_plugins() -> list[Plugin]:
    from app.channels.api import ApiChannel
    from app.channels.chat_apps import ChatAppsChannel
    from app.channels.cli import CliChannel
    from app.channels.web_shell import WebShellChannel
    from app.channels.ws import WsChannel
    from app.plugins import browser, mcp, memory, observers, providers, roles, sandbox, skills, tools, workflows, workspace

    packages = (sandbox, workspace, skills, memory, mcp, browser, observers, providers, roles, workflows, tools)
    channels: list[Plugin] = [ApiChannel(), WsChannel(), WebShellChannel(), CliChannel(), ChatAppsChannel()]
    return [*(plugin for package in packages for plugin in package.PLUGINS), *channels]


def build_kernel(extra: Iterable[Plugin] = (), *, disabled: Iterable[str] = (), make_current: bool = False) -> Kernel:
    """A kernel with every built-in plugin loaded (registered, not started). ``make_current`` makes it this process's kernel."""
    kernel = Kernel([*builtin_plugins(), *extra])
    kernel.load(disabled)
    if make_current:
        kernel.make_current()
    return kernel
