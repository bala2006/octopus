"""Explicitly started project commands and servers, owned by the API lifetime."""
from __future__ import annotations

import asyncio
import codecs
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.core.config import get_settings
from app.tools.sandbox import SandboxError, _resolve_exe, command_environment, parse_command, stop_process
from app.tools.workspace import ProjectFS, WorkspaceError

MAX_LOG_CHARS = 24_000
MAX_SERVERS = 8


@dataclass
class ManagedProcess:
    command: str
    process: asyncio.subprocess.Process
    reader: asyncio.Task | None = None
    output: str = ""
    truncated: bool = False
    deadline: asyncio.Task | None = None
    timed_out: bool = False
    directory: str = "."

    def snapshot(self) -> dict:
        return {"command": self.command, "status": "running" if self.process.returncode is None else "exited",
                "exit_code": self.process.returncode, "output": self.output, "truncated": self.truncated, "timed_out": self.timed_out,
                "directory": self.directory}


class ManagedProcesses:
    def __init__(self, kind: Literal["server", "command"] = "server") -> None:
        self.kind = kind
        self.records: dict[str, ManagedProcess] = {}
        self._starting: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}

    def status(self, key: str) -> dict:
        record = self.records.get(key)
        return record.snapshot() if record else {"command": "", "status": "idle", "exit_code": None, "output": "", "truncated": False, "timed_out": False, "directory": "."}

    async def start(self, key: str, root: Path, command: str, *, danger: bool, timeout: int = 3600, directory: str = ".") -> dict:
        try:
            if directory == ".":
                cwd, relative = root, "."
            else:
                relative, cwd = ProjectFS(root).resolve(directory)
                if not cwd.is_dir():
                    raise WorkspaceError("Select an existing project folder as the command working directory.")
        except WorkspaceError as exc:
            raise SandboxError(str(exc)) from exc
        async with self._locks.setdefault(key, asyncio.Lock()):
            result = await self._start(key, cwd, command, danger=danger, timeout=timeout)
            self.records[key].directory = relative
            return {**result, "directory": relative}

    async def _start(self, key: str, root: Path, command: str, *, danger: bool, timeout: int) -> dict:
        if get_settings().sandbox_mode == "docker":
            raise SandboxError("Managed processes are available in local subprocess mode. Use an external terminal or server with Docker.")
        if key in self._starting or (key in self.records and self.records[key].process.returncode is None):
            raise SandboxError(f"A {self.kind} is already running for this project. Stop it before starting another.")
        if len(self._starting) + sum(r.process.returncode is None for r in self.records.values()) >= MAX_SERVERS:
            raise SandboxError(f"Eight {self.kind} processes are already running. Stop one before starting another.")
        argv = _resolve_exe(parse_command(command, danger=danger))
        self._starting.add(key)
        try:
            process = await asyncio.create_subprocess_exec(
                *argv, cwd=root, env=command_environment(root, developer=True), stdin=asyncio.subprocess.PIPE if self.kind == "command" else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                start_new_session=os.name == "posix",
            )
            record = ManagedProcess(command, process)
            self.records[key] = record
            record.reader = asyncio.create_task(self._read(record))
            if self.kind == "command":
                record.deadline = asyncio.create_task(self._timeout(key, record, timeout))
            return record.snapshot()
        finally:
            self._starting.discard(key)

    async def _read(self, record: ManagedProcess) -> None:
        stream = record.process.stdout
        if stream is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while chunk := await stream.read(4096):
            output = record.output + decoder.decode(chunk)
            record.truncated |= len(output) > MAX_LOG_CHARS
            record.output = output[-MAX_LOG_CHARS:]
        record.output = (record.output + decoder.decode(b"", final=True))[-MAX_LOG_CHARS:]
        await record.process.wait()
        if record.deadline and not record.timed_out:
            record.deadline.cancel()

    async def _timeout(self, key: str, record: ManagedProcess, timeout: int) -> None:
        await asyncio.sleep(timeout)
        async with self._locks.setdefault(key, asyncio.Lock()):
            if self.records.get(key) is record and record.process.returncode is None:
                record.timed_out = True
                await self._stop(key)

    async def send(self, key: str, text: str) -> dict:
        async with self._locks.setdefault(key, asyncio.Lock()):
            record = self.records.get(key)
            if self.kind != "command" or not record or record.process.returncode is not None or record.process.stdin is None:
                raise SandboxError("No command is running to receive input.")
            record.process.stdin.write((text + "\n").encode("utf-8"))
            try:
                await asyncio.wait_for(record.process.stdin.drain(), timeout=3)
            except (BrokenPipeError, ConnectionError, TimeoutError) as exc:
                raise SandboxError("This command is no longer accepting input.") from exc
            return record.snapshot()

    def clear(self, key: str) -> dict:
        record = self.records.get(key)
        if record and record.process.returncode is None:
            raise SandboxError("Stop the command before clearing its output.")
        self.records.pop(key, None)
        return self.status(key)

    async def stop(self, key: str) -> dict:
        async with self._locks.setdefault(key, asyncio.Lock()):
            return await self._stop(key)

    async def _stop(self, key: str) -> dict:
        record = self.records.get(key)
        if record:
            await stop_process(record.process)
            if record.reader:
                try:
                    await asyncio.wait_for(asyncio.shield(record.reader), timeout=5)
                except asyncio.TimeoutError:
                    record.reader.cancel()
            return record.snapshot()
        return self.status(key)

    async def shutdown(self) -> None:
        await asyncio.gather(*(self.stop(key) for key in list(self.records)))
        self.records.clear()


servers = ManagedProcesses("server")
commands = ManagedProcesses("command")
