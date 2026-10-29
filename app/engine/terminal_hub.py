"""A shell in the task worktree.

There is no PTY: the session is `bash --noprofile --norc -s` with pipes, and
the cockpit reads it as SSE. Resize is refused. The working directory is the
worktree the run already owns.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ShellSession:
    proc: asyncio.subprocess.Process
    chunks: list[str] = field(default_factory=list)
    changed: asyncio.Event = field(default_factory=asyncio.Event)


class TerminalHub:
    def __init__(self) -> None:
        self.sessions: dict[str, ShellSession] = {}

    async def open(self, cwd: Path) -> str:
        proc = await asyncio.create_subprocess_exec(
            "bash",
            "--noprofile",
            "--norc",
            "-s",
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        session_id = uuid.uuid4().hex[:16]
        session = ShellSession(proc)
        self.sessions[session_id] = session
        asyncio.create_task(self._read(session), name=f"term-{session_id}")
        return session_id

    async def write(self, session_id: str, data: str) -> bool:
        session = self.sessions.get(session_id)
        if session is None or session.proc.stdin is None or session.proc.returncode is not None:
            return False
        session.proc.stdin.write(data.encode())
        await session.proc.stdin.drain()
        return True

    def output(self, session_id: str) -> str | None:
        session = self.sessions.get(session_id)
        if session is None:
            return None
        return "".join(session.chunks)

    async def close(self, session_id: str) -> bool:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return False
        if session.proc.returncode is None:
            session.proc.terminate()
            try:
                await asyncio.wait_for(session.proc.wait(), 1)
            except TimeoutError:
                session.proc.kill()
                await session.proc.wait()
        return True

    async def _read(self, session: ShellSession) -> None:
        stdout = session.proc.stdout
        if stdout is None:
            return
        while True:
            raw = await stdout.read(1024)
            if not raw:
                session.changed.set()
                return
            session.chunks.append(raw.decode(errors="replace"))
            session.changed.set()
