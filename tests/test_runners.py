import asyncio
import json
import shutil
from pathlib import Path

from app.engine.agents import AgentEvent, AgentSpec
from app.engine.runners.argv import (
    build_allowed_tools,
    build_claude_args,
    build_copilot_args,
    build_cursor_args,
    build_junie_args,
    build_pi_args,
    codex_sandbox,
)
from app.engine.runners.protocol import (
    ProtocolRunner,
    TurnState,
    parse_claude_line,
    parse_codex_line,
)

FAKES = Path(__file__).parent / "fakes"


def install(name: str, dest: Path) -> None:
    source = (FAKES / f"{name}.py").read_text(encoding="utf-8")
    dest.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    dest.chmod(0o755)


def spec(tmp_path: Path, runner: str, prompt: str = "ship it", **kwargs: object) -> AgentSpec:
    values: dict[str, object] = {
        "user_prompt": prompt,
        "system_prompt": "",
        "cwd": str(tmp_path),
        "runner": runner,
        "model": "",
        "cancel": asyncio.Event(),
    }
    values.update(kwargs)
    return AgentSpec(**values)  # type: ignore[arg-type]


async def collect(runner: ProtocolRunner, item: AgentSpec) -> list[AgentEvent]:
    return [event async for event in runner.stream(item)]


def test_claude_allowlist_and_permission_mode_match_the_cli():
    plain = build_allowed_tools(["Read", "Bash"], [])
    assert plain == ["Read", "Bash"]
    restricted = build_allowed_tools(["Bash", "Read"], ["npm", " git"])
    assert restricted == ["Bash(npm:*)", "Bash(git:*)", "Read"]
    args = build_claude_args(
        system_prompt="be brief",
        model="opus",
        allowed_tools=["Bash"],
        bash_allowlist=["npm"],
        session_id="sess-1",
        approval_gate=False,
    )
    assert args[:6] == [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    mode = args[args.index("--permission-mode") + 1]
    assert mode == "dontAsk"
    assert "Bash(npm:*)" in args[args.index("--allowedTools") + 1]
    assert args[args.index("--session-id") + 1] == "sess-1"
    resumed = build_claude_args(
        system_prompt="",
        model="",
        allowed_tools=[],
        bash_allowlist=[],
        session_id="sess-1",
        resume=True,
    )
    assert "--resume" in resumed and "--session-id" not in resumed


def test_cursor_pi_junie_and_copilot_argv():
    cursor = build_cursor_args(user_prompt="fix it", system_prompt="sys", model="gpt")
    assert cursor[:4] == ["-p", "--force", "--trust", "--output-format"]
    assert cursor[-1].startswith("sys")
    pi = build_pi_args(
        system_prompt="",
        model="",
        allowed_tools=["Read", "Bash"],
        bash_allowlist=["npm"],
    )
    assert pi[:2] == ["--mode", "rpc"]
    assert "bash" not in pi[pi.index("--tools") + 1]
    assert build_junie_args("/work") == ["--acp=true", "-p", "/work"]
    copilot = build_copilot_args(model="gpt-4")
    assert copilot[:3] == ["--acp", "--allow-all-tools", "--no-auto-update"]
    assert codex_sandbox(network_off=False) == "danger-full-access"
    assert codex_sandbox(network_off=True) == "workspace-write"


def test_a_child_codex_turn_does_not_finish_the_parent():
    state = TurnState(thread_id="parent")
    child = json.dumps(
        {
            "method": "turn/completed",
            "params": {"threadId": "child", "turn": {"status": "completed"}},
        }
    )
    assert parse_codex_line(child, state) == []
    assert state.done is False
    parent = json.dumps(
        {
            "method": "turn/completed",
            "params": {
                "threadId": "parent",
                "turn": {"id": "t", "status": "completed"},
            },
        }
    )
    parse_codex_line(parent, state)
    assert state.done is True


def test_claude_result_usage_is_not_also_taken_from_assistant_frames():
    state = TurnState()
    events = parse_claude_line(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [{"type": "text", "text": "hello"}],
                    "usage": {"input_tokens": 99, "output_tokens": 99},
                },
            }
        ),
        state,
    )
    assert events == [AgentEvent("text", "hello")]
    assert state.input_tokens == 0
    parse_claude_line(
        json.dumps(
            {
                "type": "result",
                "result": "hello",
                "usage": {"input_tokens": 2, "output_tokens": 3},
            }
        ),
        state,
    )
    assert state.done is True
    assert (state.input_tokens, state.output_tokens) == (2, 3)


async def test_claude_fake_speaks_stream_json(tmp_path: Path):
    binary = tmp_path / "claude"
    install("claude", binary)
    events = await collect(
        ProtocolRunner("claude", str(binary)),
        spec(
            tmp_path,
            "claude",
            allowed_tools=("Bash",),
            bash_allowlist=("npm",),
            session_id="sess-9",
        ),
    )
    assert any(event.type == "text" and event.text == "did ship it" for event in events)
    assert any(event.type == "tool-call" and event.name == "Write" for event in events)
    assert any(event.type == "tool-result" and event.text == "wrote" for event in events)
    assert events[-1].type == "turn-end"
    assert sum(event.input_tokens for event in events) == 2
    argv = (tmp_path / "claude.args").read_text(encoding="utf-8")
    assert "--permission-mode\ndontAsk" in argv
    assert "Bash(npm:*)" in argv
    assert "--session-id\nsess-9" in argv


async def test_codex_fake_requires_the_sandbox_and_ignores_a_child_thread(tmp_path: Path):
    binary = tmp_path / "codex"
    install("codex", binary)
    events = await collect(
        ProtocolRunner("codex", str(binary)),
        spec(tmp_path, "codex", "refactor"),
    )
    assert any(event.text == "codex refactor" for event in events)
    assert events[-1].type == "turn-end"


async def test_pi_cursor_and_acp_fakes(tmp_path: Path):
    pi = tmp_path / "pi"
    install("pi", pi)
    events = await collect(
        ProtocolRunner("pi", str(pi)),
        spec(tmp_path, "pi", allowed_tools=("Read", "Bash"), bash_allowlist=("npm",)),
    )
    assert any(event.text == "pi ship it" for event in events)
    assert any(event.type == "tool-call" and event.name == "read" for event in events)
    assert "bash" not in (tmp_path / "pi.args").read_text(encoding="utf-8")

    cursor = tmp_path / "cursor"
    install("cursor", cursor)
    events = await collect(
        ProtocolRunner("cursor", str(cursor)),
        spec(tmp_path, "cursor", "format"),
    )
    assert any(event.text == "cursor format" for event in events)
    assert events[-1].type == "turn-end"
    argv = (tmp_path / "cursor.args").read_text(encoding="utf-8")
    assert argv.split("\n")[:3] == ["-p", "--force", "--trust"]

    acp = tmp_path / "junie"
    install("acp", acp)
    events = await collect(ProtocolRunner("junie", str(acp)), spec(tmp_path, "junie", "review"))
    assert any(event.text == "junie review" for event in events)
    assert events[-1].type == "turn-end"
    copy = tmp_path / "copilot"
    shutil.copy(acp, copy)
    copy.chmod(0o755)
    events = await collect(
        ProtocolRunner("copilot", str(copy)),
        spec(tmp_path, "copilot", "review"),
    )
    assert any(event.text == "junie review" for event in events)


async def test_opencode_fake_holds_the_message_post(tmp_path: Path):
    binary = tmp_path / "opencode"
    install("opencode", binary)
    events = await collect(
        ProtocolRunner("opencode", str(binary)),
        spec(tmp_path, "opencode", "serve"),
    )
    assert any(event.text == "oc serve" for event in events)
    assert events[-1].type == "turn-end"


async def test_a_missing_binary_is_an_error_not_a_crash(tmp_path: Path):
    events = await collect(
        ProtocolRunner("claude", str(tmp_path / "missing")),
        spec(tmp_path, "claude"),
    )
    assert events[-1].type == "error"
    assert "not found" in events[-1].text
