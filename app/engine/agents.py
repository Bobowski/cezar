"""Agent sessions.

`DryRunAgent` is what `CEZ_DRY_RUN=1` and `docker compose up` exercise. A real
runner is `ProtocolRunner` in `app.engine.runners`: the same argv and wire
format as the TypeScript backend, one turn per process.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

_WRITE = re.compile(r"mock:write\s+([A-Za-z0-9_./-]+)")


@dataclass(frozen=True, slots=True)
class AgentSpec:
    user_prompt: str
    system_prompt: str
    cwd: str
    runner: str
    model: str
    cancel: asyncio.Event
    allowed_tools: tuple[str, ...] = ()
    bash_allowlist: tuple[str, ...] = ()
    session_id: str = ""
    resume: bool = False
    # 0 disables the inactivity watchdog. The engine passes 15 minutes.
    timeout_ms: int = 0
    images: tuple[dict[str, str], ...] = ()
    mcp_servers: tuple[dict[str, object], ...] = ()
    codex_thread: str = ""
    # A Claude or Codex profile home. Empty keeps the user's default login.
    profile_home: str = ""


@dataclass(frozen=True, slots=True)
class AgentEvent:
    type: str
    text: str = ""
    name: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    session_id: str = ""


def usage_from_line(line: str) -> tuple[int, int] | None:
    """Best-effort read of a stream-json result frame. Anything else is ordinary text."""
    if not line.startswith("{"):
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return None
    incoming = usage.get("input_tokens")
    outgoing = usage.get("output_tokens")
    if type(incoming) is int and type(outgoing) is int:
        return incoming, outgoing
    return None


def result_is_error(line: str) -> bool:
    if not line.startswith("{"):
        return False
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return False
    return isinstance(obj, dict) and obj.get("type") == "result" and obj.get("is_error") is True


class Runner(Protocol):
    def stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]: ...


class DryRunAgent:
    """A stand-in for `scripts/mock-claude.mjs`. Markers in the prompt script the turn.

    `mock:fail` ends the turn as an error. `mock:ask` emits `CEZ:ASK` once, and a later
    turn whose prompt already contains the user's answer completes. `mock:write <path>`
    writes that file inside the worktree. Otherwise the mock writes `CEZAR_DRY_RUN.txt`.
    """

    async def stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
        if spec.cancel.is_set():
            yield AgentEvent("error", "cancelled")
            return
        answered = "The user answered:" in spec.user_prompt
        if "mock:fail" in spec.user_prompt and not answered:
            yield AgentEvent("error", "dry-run was asked to fail")
            return
        if "mock:ask" in spec.user_prompt and not answered:
            yield AgentEvent("text", "CEZ:ASK: Which name should I use?")
            yield AgentEvent("turn-end")
            return
        target = _mock_target(spec.user_prompt)
        path = Path(spec.cwd) / target
        if not _inside(Path(spec.cwd), path):
            yield AgentEvent("error", "dry-run refused a path outside the worktree")
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = spec.user_prompt
        if spec.system_prompt:
            payload = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
        path.write_text(payload + "\n", encoding="utf-8")
        yield AgentEvent("tool-call", target, "Write")
        yield AgentEvent("tool-result", f"wrote {target}")
        yield AgentEvent("text", f"Dry run finished in {spec.cwd}.")
        yield AgentEvent("turn-end")


class StdinAgent:
    """Run `binary` with the prompt on stdin. No protocol flags, no auto-approve."""

    def __init__(self, binary: str) -> None:
        self.binary = binary

    async def stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
        if spec.cancel.is_set():
            yield AgentEvent("error", "cancelled")
            return
        payload = spec.user_prompt
        if spec.system_prompt:
            payload = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
        try:
            proc = await asyncio.create_subprocess_exec(
                self.binary,
                cwd=spec.cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            yield AgentEvent("error", f"{spec.runner} executable not found: {self.binary}")
            return
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write(payload.encode())
        await proc.stdin.drain()
        proc.stdin.close()
        while True:
            if spec.cancel.is_set():
                proc.kill()
                await proc.wait()
                yield AgentEvent("error", "cancelled")
                return
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=0.2)
            except TimeoutError:
                if proc.returncode is not None:
                    break
                continue
            if not line:
                break
            text = line.decode(errors="replace").rstrip("\n")
            if result_is_error(text):
                yield AgentEvent("error", text)
                await proc.wait()
                return
            yield AgentEvent("text", text)
        code = await proc.wait()
        if code not in (0, None):
            err = b""
            if proc.stderr is not None:
                err = await proc.stderr.read()
            message = err.decode(errors="replace").strip() or f"exit {code}"
            yield AgentEvent("error", message[:4_000])
            return
        yield AgentEvent("turn-end")


class MissingAgent:
    async def stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(
            "error",
            f"No ported backend for {spec.runner}. Set CEZ_DRY_RUN=1 for the mock, "
            "or CEZ_REAL_AGENTS=1 for the experimental stdin subprocess. "
            "The TypeScript runners still live in packages/cezar.",
        )


def _mock_target(prompt: str) -> str:
    match = _WRITE.search(prompt)
    if not match:
        return "CEZAR_DRY_RUN.txt"
    rel = match.group(1)
    if rel.startswith("/") or ".." in Path(rel).parts:
        return "CEZAR_DRY_RUN.txt"
    return rel


def _inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True
