"""One turn against a real backend process.

Each runner uses the argv and the wire format the TypeScript runner uses:
Claude and Cursor speak stream-json, Codex speaks app-server JSON-RPC, Pi speaks
`pi --mode rpc`, OpenCode is `opencode serve` plus `POST /session/:id/message`,
and Junie and Copilot speak ACP JSON-RPC. A turn ends on that protocol's
completion frame, not on a timeout guess. An exit cezar caused (130/137/143
after we signalled) is a cancel, not an agent failure.
"""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from app.engine.agents import AgentEvent, AgentSpec
from app.engine.runners.argv import (
    build_claude_args,
    build_codex_args,
    build_copilot_args,
    build_cursor_args,
    build_junie_args,
    build_opencode_args,
    build_pi_args,
    codex_sandbox,
)

SIGNAL_EXITS = frozenset({130, 137, 143})


@dataclass
class TurnState:
    saw_text: bool = False
    done: bool = False
    failed: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    thread_id: str = ""


def parse_claude_line(line: str, state: TurnState) -> list[AgentEvent]:
    """Assistant frames and the terminal `result`. `stream_event` deltas are display-only in TS."""
    message = _json_object(line)
    if message is None:
        return []
    kind = message.get("type")
    events: list[AgentEvent] = []
    if kind == "assistant":
        content = _nested(message, "message", "content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    state.saw_text = True
                    events.append(AgentEvent("text", block["text"]))
                elif block.get("type") == "tool_use" and block.get("name"):
                    events.append(
                        AgentEvent("tool-call", str(block.get("id", "")), str(block["name"]))
                    )
    elif kind == "user":
        content = _nested(message, "message", "content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    events.append(
                        AgentEvent(
                            "tool-result",
                            _tool_result_text(block.get("content")),
                            str(block.get("tool_use_id", "")),
                        )
                    )
    elif kind == "result":
        if isinstance(message.get("result"), str) and not state.saw_text and message["result"]:
            state.saw_text = True
            events.append(AgentEvent("text", message["result"]))
        usage = _as_dict(message.get("usage"))
        state.input_tokens += _int(usage.get("input_tokens"))
        state.output_tokens += _int(usage.get("output_tokens"))
        if message.get("is_error") is True:
            detail = message.get("result") if isinstance(message.get("result"), str) else ""
            state.failed = detail or "claude reported result error"
        state.done = True
    return events


def parse_codex_line(line: str, state: TurnState) -> list[AgentEvent]:
    message = _json_object(line)
    if message is None:
        return []
    if message.get("id") is not None and isinstance(message.get("result"), dict):
        thread = message["result"].get("thread")
        if isinstance(thread, dict) and isinstance(thread.get("id"), str) and not state.thread_id:
            state.thread_id = thread["id"]
        if isinstance(message["result"].get("error"), dict):
            state.failed = str(message["result"]["error"].get("message", "codex error"))
            state.done = True
    if isinstance(message.get("error"), dict) and message.get("id") is not None:
        state.failed = str(message["error"].get("message", "codex error"))
        state.done = True
        return [AgentEvent("error", state.failed)]
    method = message.get("method")
    params = _as_dict(message.get("params"))
    thread_id = str(params.get("threadId", ""))
    if thread_id and state.thread_id and thread_id != state.thread_id:
        return []
    events: list[AgentEvent] = []
    if method == "item/agentMessage/delta" and isinstance(params.get("delta"), str):
        state.saw_text = True
        events.append(AgentEvent("text", params["delta"]))
    elif method == "item/started":
        item = _as_dict(params.get("item"))
        if item.get("type") == "commandExecution":
            events.append(AgentEvent("tool-call", str(item.get("command", "")), "Bash"))
    elif method == "item/completed":
        item = _as_dict(params.get("item"))
        if item.get("type") == "commandExecution":
            events.append(AgentEvent("tool-result", str(item.get("aggregatedOutput", "")), "Bash"))
        elif (
            item.get("type") == "agentMessage"
            and isinstance(item.get("text"), str)
            and not state.saw_text
        ):
            state.saw_text = True
            events.append(AgentEvent("text", item["text"]))
    elif method == "turn/completed":
        turn = _as_dict(params.get("turn"))
        if str(turn.get("status")) == "failed":
            error = _as_dict(turn.get("error"))
            state.failed = str(error.get("message", "codex turn failed"))
        usage = _as_dict(turn.get("usage"))
        state.input_tokens += _int(usage.get("input_tokens"))
        state.output_tokens += _int(usage.get("output_tokens"))
        state.done = True
    return events


def parse_pi_line(line: str, state: TurnState) -> list[AgentEvent]:
    message = _json_object(line)
    if message is None:
        return []
    kind = message.get("type")
    events: list[AgentEvent] = []
    if kind == "message_update" and isinstance(message.get("assistantMessageEvent"), dict):
        update = message["assistantMessageEvent"]
        if update.get("type") == "text_delta" and isinstance(update.get("delta"), str):
            state.saw_text = True
            events.append(AgentEvent("text", update["delta"]))
    elif kind == "tool_execution_start":
        events.append(
            AgentEvent(
                "tool-call", str(message.get("toolCallId", "")), str(message.get("toolName", ""))
            )
        )
    elif kind == "tool_execution_end":
        events.append(
            AgentEvent(
                "tool-result", str(message.get("result", "")), str(message.get("toolCallId", ""))
            )
        )
    elif kind == "agent_settled":
        state.done = True
    elif kind == "response" and message.get("success") is False:
        state.failed = str(message.get("error", "pi rejected the command"))
        state.done = True
    elif kind == "extension_error":
        state.failed = str(message.get("error", "pi extension error"))
    return events


def parse_acp_line(line: str, state: TurnState, prompt_id: int) -> list[AgentEvent]:
    message = _json_object(line)
    if message is None:
        return []
    events: list[AgentEvent] = []
    if message.get("method") == "session/update":
        params = _as_dict(message.get("params"))
        update = _as_dict(params.get("update"))
        session_update = update.get("sessionUpdate")
        content = _as_dict(update.get("content"))
        if session_update == "agent_message_chunk" and isinstance(content.get("text"), str):
            state.saw_text = True
            events.append(AgentEvent("text", content["text"]))
        elif session_update == "tool_call":
            events.append(
                AgentEvent(
                    "tool-call", str(update.get("toolCallId", "")), str(update.get("title", "tool"))
                )
            )
        elif session_update == "tool_call_update":
            events.append(
                AgentEvent(
                    "tool-result",
                    str(update.get("rawOutput", "")),
                    str(update.get("toolCallId", "")),
                )
            )
    if message.get("id") == prompt_id and "result" in message:
        result = _as_dict(message.get("result"))
        if result.get("stopReason") == "refusal":
            state.failed = "the agent refused the turn"
        usage = _as_dict(result.get("usage"))
        state.input_tokens += _int(usage.get("input_tokens"))
        state.output_tokens += _int(usage.get("output_tokens"))
        state.done = True
    if message.get("id") == prompt_id and isinstance(message.get("error"), dict):
        state.failed = str(message["error"].get("message", "acp error"))
        state.done = True
    return events


class ProtocolRunner:
    def __init__(
        self,
        runner: str,
        binary: str,
        *,
        approval_gate: bool = False,
        codex_network_off: bool = False,
    ) -> None:
        self.runner = runner
        self.binary = binary
        self.approval_gate = approval_gate
        self.codex_network_off = codex_network_off

    async def stream(self, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
        try:
            if self.runner == "opencode":
                async for event in _opencode_turn(self.binary, spec):
                    yield event
                return
            async for event in _process_turn(
                self.runner,
                self.binary,
                spec,
                approval_gate=self.approval_gate,
                codex_network_off=self.codex_network_off,
            ):
                yield event
        except FileNotFoundError:
            yield AgentEvent("error", f"`{self.binary}` not found on PATH")


async def _process_turn(
    runner: str,
    binary: str,
    spec: AgentSpec,
    *,
    approval_gate: bool,
    codex_network_off: bool,
) -> AsyncIterator[AgentEvent]:
    args = _args(runner, spec, approval_gate=approval_gate)
    proc = await asyncio.create_subprocess_exec(
        binary,
        *args,
        cwd=spec.cwd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    state = TurnState()
    prompt = spec.user_prompt
    if runner == "codex" and spec.system_prompt:
        prompt = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
    try:
        if runner == "codex":
            async for event in _rpc_turn(
                proc, spec, state, runner, _codex_frames(prompt, codex_network_off)
            ):
                yield event
        elif runner in ("junie", "copilot"):
            async for event in _rpc_turn(proc, spec, state, runner, _acp_frames(spec)):
                yield event
        else:
            await _write(proc, _opening_lines(runner, spec, codex_network_off=codex_network_off))
            async for event in _read_until_done(proc, spec, state, runner, 0):
                yield event
    finally:
        _close(proc)
    if spec.cancel.is_set():
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        return
    if state.input_tokens or state.output_tokens:
        yield AgentEvent(
            "text", "", input_tokens=state.input_tokens, output_tokens=state.output_tokens
        )
    if state.failed:
        yield AgentEvent("error", state.failed)
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        return
    code = await proc.wait()
    if code not in (0, None) and code not in SIGNAL_EXITS:
        err = b""
        if proc.stderr is not None:
            err = await proc.stderr.read()
        detail = err.decode(errors="replace").strip()
        yield AgentEvent("error", detail or f"{runner} exited {code}")
        return
    if not state.done and code in SIGNAL_EXITS:
        yield AgentEvent("error", "cancelled")
        return
    yield AgentEvent("turn-end")


def _codex_frames(prompt: str, network_off: bool) -> list[dict[str, Any]]:
    return [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "thread/start",
            "params": {
                "sandbox": codex_sandbox(network_off=network_off),
                "approvalPolicy": "never",
            },
        },
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "turn/start",
            "params": {"input": [{"type": "text", "text": prompt}]},
        },
    ]


def _acp_frames(spec: AgentSpec) -> list[dict[str, Any]]:
    prompt = spec.user_prompt
    if spec.system_prompt:
        prompt = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
    return [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": 1, "clientCapabilities": {}},
        },
        {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": {"cwd": spec.cwd, "mcpServers": []},
        },
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/prompt",
            "params": {"sessionId": "pending", "prompt": [{"type": "text", "text": prompt}]},
        },
    ]


async def _rpc_turn(
    proc: asyncio.subprocess.Process,
    spec: AgentSpec,
    state: TurnState,
    runner: str,
    frames: list[dict[str, Any]],
) -> AsyncIterator[AgentEvent]:
    """Send each handshake frame, then the prompt, and stop on the prompt's completion.

    Handshake replies share the parser with the prompt, so the completion id is
    always the last frame. Treating a handshake id as completion ends the turn
    before the prompt is sent.
    """
    prompt_id = int(frames[-1]["id"])
    for index, frame in enumerate(frames):
        await _write(proc, [frame])
        is_prompt = index == len(frames) - 1
        async for event in _read_until_done(
            proc,
            spec,
            state,
            runner,
            prompt_id,
            stop_id=None if is_prompt else int(frame["id"]),
        ):
            yield event
        if state.failed or state.done or spec.cancel.is_set():
            return


def _args(runner: str, spec: AgentSpec, *, approval_gate: bool) -> list[str]:
    tools = spec.allowed_tools or ("Read", "Edit", "Write", "Grep", "Glob", "Bash")
    if runner == "claude":
        return build_claude_args(
            system_prompt=spec.system_prompt,
            model=spec.model,
            allowed_tools=tools,
            bash_allowlist=spec.bash_allowlist,
            session_id=spec.session_id,
            resume=spec.resume,
            approval_gate=approval_gate,
        )
    if runner == "cursor":
        return build_cursor_args(
            user_prompt=spec.user_prompt, system_prompt=spec.system_prompt, model=spec.model
        )
    if runner == "pi":
        return build_pi_args(
            system_prompt=spec.system_prompt,
            model=spec.model,
            allowed_tools=tools,
            bash_allowlist=spec.bash_allowlist,
            session_id=spec.session_id,
            resume=spec.resume,
        )
    if runner == "codex":
        return build_codex_args()
    if runner == "junie":
        return build_junie_args(spec.cwd)
    if runner == "copilot":
        return build_copilot_args(model=spec.model)
    return []


def _opening_lines(
    runner: str, spec: AgentSpec, *, codex_network_off: bool
) -> list[dict[str, Any]]:
    prompt = spec.user_prompt
    if runner in ("codex", "opencode") and spec.system_prompt:
        prompt = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
    if runner == "claude":
        return [
            {
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
            }
        ]
    if runner == "cursor":
        return []
    if runner == "pi":
        return [
            {"id": "cezar-state", "type": "get_state"},
            {"type": "prompt", "message": prompt, "streamingBehavior": "steer"},
        ]
    if runner == "codex":
        return [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "thread/start",
                "params": {
                    "sandbox": codex_sandbox(network_off=codex_network_off),
                    "approvalPolicy": "never",
                },
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "turn/start",
                "params": {"input": [{"type": "text", "text": prompt}]},
            },
        ]
    if runner in ("junie", "copilot"):
        return [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": 1, "clientCapabilities": {}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": spec.cwd, "mcpServers": []},
            },
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {"prompt": [{"type": "text", "text": prompt}]},
            },
        ]
    return []


def _parse(runner: str, line: str, state: TurnState, prompt_id: int) -> list[AgentEvent]:
    if runner in ("claude", "cursor"):
        return parse_claude_line(line, state)
    if runner == "codex":
        return parse_codex_line(line, state)
    if runner == "pi":
        return parse_pi_line(line, state)
    if runner in ("junie", "copilot"):
        return parse_acp_line(line, state, prompt_id)
    return []


async def _read_until_done(
    proc: asyncio.subprocess.Process,
    spec: AgentSpec,
    state: TurnState,
    runner: str,
    prompt_id: int,
    *,
    done: bool = False,
    stop_id: int | None = None,
) -> AsyncIterator[AgentEvent]:
    assert proc.stdout is not None
    seen_stop = False
    while not (state.done or done or seen_stop):
        if spec.cancel.is_set():
            proc.kill()
            yield AgentEvent("error", "cancelled")
            return
        try:
            raw = await asyncio.wait_for(proc.stdout.readline(), timeout=0.2)
        except TimeoutError:
            if proc.returncode is not None:
                break
            continue
        if not raw:
            break
        line = raw.decode(errors="replace").rstrip("\n")
        if stop_id is not None and _response_id(line) == stop_id:
            seen_stop = True
        for event in _parse(runner, line, state, prompt_id):
            if event.type == "error":
                state.failed = event.text
            elif not seen_stop or event.type != "turn-end":
                yield event


async def _opencode_turn(binary: str, spec: AgentSpec) -> AsyncIterator[AgentEvent]:
    port = _free_port()
    proc = await asyncio.create_subprocess_exec(
        binary,
        *build_opencode_args(port),
        cwd=spec.cwd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        await _wait_port(port, spec.cancel)
        if spec.cancel.is_set():
            yield AgentEvent("error", "cancelled")
            return
        prompt = spec.user_prompt
        if spec.system_prompt:
            prompt = f"{spec.system_prompt}\n\n---\n\n{spec.user_prompt}"
        created = await asyncio.to_thread(
            _post, f"http://127.0.0.1:{port}/session", {"title": "cezar task"}
        )
        session_id = str(created.get("id", ""))
        if not session_id:
            yield AgentEvent("error", "opencode did not return a session id")
            return
        body = await asyncio.to_thread(
            _post,
            f"http://127.0.0.1:{port}/session/{session_id}/message",
            {"parts": [{"type": "text", "text": prompt}]},
        )
        parts = _as_list(body.get("parts"))
        saw = False
        for part in parts:
            if (
                isinstance(part, dict)
                and part.get("type") == "text"
                and isinstance(part.get("text"), str)
            ):
                saw = True
                yield AgentEvent("text", part["text"])
            elif isinstance(part, dict) and part.get("type") == "tool":
                yield AgentEvent(
                    "tool-call", str(part.get("id", "")), str(part.get("tool", "tool"))
                )
        if body.get("error"):
            yield AgentEvent("error", str(body["error"]))
            return
        if not saw and isinstance(body.get("text"), str):
            yield AgentEvent("text", body["text"])
        yield AgentEvent("turn-end")
    except (URLError, TimeoutError, OSError) as exc:
        yield AgentEvent("error", f"opencode serve failed: {exc}")
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def _write(proc: asyncio.subprocess.Process, messages: list[dict[str, Any]]) -> None:
    assert proc.stdin is not None
    if not messages:
        return
    payload = "".join(json.dumps(message) + "\n" for message in messages)
    proc.stdin.write(payload.encode())
    await proc.stdin.drain()


def _close(proc: asyncio.subprocess.Process) -> None:
    if proc.stdin is not None and not proc.stdin.is_closing():
        proc.stdin.close()


def _post(url: str, body: dict[str, Any]) -> dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        loaded = json.loads(response.read().decode())
    return loaded if isinstance(loaded, dict) else {}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _wait_port(port: int, cancel: asyncio.Event) -> None:
    for _ in range(50):
        if cancel.is_set():
            return
        try:
            _reader, writer = await asyncio.open_connection("127.0.0.1", port)
        except OSError:
            await asyncio.sleep(0.05)
            continue
        writer.close()
        await writer.wait_closed()
        return
    raise TimeoutError(f"opencode did not listen on {port}")


def _response_id(line: str) -> int | None:
    message = _json_object(line)
    if message is None or not isinstance(message.get("id"), int):
        return None
    if "result" in message or "error" in message:
        return message["id"]
    return None


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _json_object(line: str) -> dict[str, Any] | None:
    if not line.startswith("{"):
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _nested(message: dict[str, Any], *keys: str) -> Any:
    current: Any = message
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _tool_result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        ]
        return "\n".join(part for part in parts if part)
    return ""


def _int(value: Any) -> int:
    return value if type(value) is int else 0
