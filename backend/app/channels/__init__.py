"""Channels: how a user or an outside client reaches Octopus.

A channel is a plugin (slot ``channel``) with an ``HttpChannel.mount(app)`` method when it serves HTTP or WebSocket traffic.
It turns a transport into calls on the application layer and the kernel, and holds no business logic of its own.
Channels are mounted once, when the app is built, so enabling or disabling one takes effect at the next start.
"""
from __future__ import annotations

from typing import Protocol

from fastapi import FastAPI

from app.sdk.plugin import HostApi, PluginBase


class HttpChannel(Protocol):
    def mount(self, app: FastAPI) -> None: ...


class Channel(PluginBase):
    """Base of the channel plugins: it provides itself under its first capability, so other plugins can require it."""

    def register(self, host: HostApi) -> None:
        host.provide(self.manifest.provides[0], self)
