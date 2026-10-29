from pathlib import Path

import pytest
from stario.http.config import ServerConfig
from tests.conftest import init_repo

from app.cli import main, projects_command, run_task
from app.cli_commands import (
    run_automation_command,
    run_runs_command,
    run_secrets_command,
    run_task_command,
    run_telemetry_command,
)
from app.config import apply_overrides


def test_init_does_not_overwrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    assert main(["init", "--repo", str(repo)]) == 0
    target = repo / ".ai" / "cezar" / "workflows" / "fix-and-verify.yaml"
    target.write_text("name: mine\nsteps:\n  - id: a\n    prompt: kept\n", encoding="utf-8")
    assert main(["init"]) == 0
    assert "kept" in target.read_text(encoding="utf-8")
    assert "left untouched" in capsys.readouterr().out
    assert "worktrees/" in (repo / ".ai" / "cezar" / ".gitignore").read_text(encoding="utf-8")


async def test_headless_run_treats_review_as_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    code = await run_task("ship the note", workflow="quick-task", runner="", model="")
    assert code == 0
    out = capsys.readouterr().out
    assert "done" in out
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    gated = await run_task("park the note", workflow="quick-task", runner="", model="")
    assert gated == 0
    assert "review" in capsys.readouterr().out
    failed = await run_task("mock:fail this", workflow="quick-task", runner="claude", model="")
    assert failed == 1


async def test_projects_list_and_add(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    repo = tmp_path / "repo"
    init_repo(repo)
    extra = tmp_path / "extra"
    extra.mkdir()
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    apply_overrides(repo=str(repo))
    assert await projects_command("list", None) == 0
    listed = capsys.readouterr().out
    assert str(repo) in listed
    assert await projects_command("add", str(extra)) == 0
    added = capsys.readouterr().out
    assert "extra" in added
    project_id = added.split("\t", 1)[0].strip()
    assert await projects_command("remove", project_id) == 0
    assert "removed" in capsys.readouterr().out
    assert await projects_command("remove", project_id) == 1
    assert await projects_command("add", str(extra)) == 0
    capsys.readouterr()
    assert await projects_command("add", str(extra)) == 1
    monkeypatch.setenv("CEZ_SINGLE_PROJECT", "1")
    refused = await projects_command("remove", project_id)
    assert refused == 1
    assert "CEZ_SINGLE_PROJECT=1" in capsys.readouterr().err


def test_serve_is_the_default_command(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, object] = {}

    async def fake(_bootstrap: object, config: ServerConfig | None = None) -> None:
        assert config is not None
        seen["host"] = config.host
        seen["port"] = config.port

    monkeypatch.setattr("app.cli.serve", fake)
    assert main([]) == 0
    assert seen["host"] == "127.0.0.1"
    assert seen["port"] == 4321
    assert main(["serve", "--host", "127.0.0.1", "--port", "9"]) == 0
    assert seen["port"] == 9


def test_task_runs_and_automation_commands_need_a_cockpit():
    assert run_task_command([], {}, print, print) == 2
    assert run_runs_command(["list"], {}, print, print) == 2
    assert run_automation_command(["schema"], {}, print, print) == 0

    calls: list[tuple[str, str, object]] = []

    def fetch(url: str, method: str = "GET", body: object = None) -> tuple[int, object]:
        calls.append((method, url, body))
        if url.endswith("/dispatch"):
            return 201, {"id": "child-1", "branch": "cez/child"}
        if url.endswith("/runs"):
            return 200, [{"id": "parent", "title": "Parent", "status": "running"}]
        if url.endswith("/automations"):
            return 201, {"id": "auto-1", "name": "nightly"}
        return 500, {"error": "nope"}

    env = {"CEZ_API_URL": "http://127.0.0.1:9", "CEZ_TASK_ID": "parent"}
    lines: list[str] = []
    assert (
        run_task_command(
            ["create", "review it", "--title", "Child"], env, lines.append, lines.append, fetch
        )
        == 0
    )
    assert "child-1" in lines[-1]
    assert calls[0][0] == "POST"
    posted = calls[0][2]
    assert isinstance(posted, dict)
    assert posted["objective"] == "review it"
    assert posted["title"] == "Child"
    listed: list[str] = []
    assert run_runs_command(["list", "--json"], env, listed.append, listed.append, fetch) == 0
    assert "parent" in listed[-1]
    created: list[str] = []
    assert (
        run_automation_command(
            ["create", "--json", '{"name":"nightly","task":"tidy"}'],
            env,
            created.append,
            created.append,
            fetch,
        )
        == 0
    )
    assert created[-1] == "auto-1"


def test_telemetry_command_does_not_enable_sending():
    lines: list[str] = []
    errors: list[str] = []
    assert run_telemetry_command(["status"], lines.append, errors.append) == 0
    assert "does not send" in lines[-1]
    assert run_telemetry_command(["enable"], lines.append, errors.append) == 1
    assert errors[-1]


async def test_secrets_cli_never_prints_the_value(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    repo = tmp_path / "repo"
    init_repo(repo)
    monkeypatch.setenv("CEZ_REPO", str(repo))
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    lines: list[str] = []
    errors: list[str] = []
    code = await run_secrets_command(
        ["set", "API_TOKEN"],
        read_value=lambda: "super-secret-value",
        log=lines.append,
        error=errors.append,
    )
    assert code == 0
    assert lines == ["API_TOKEN"]
    assert "super-secret-value" not in "\n".join([*lines, *errors])
    assert (
        await run_secrets_command(
            ["list"], read_value=lambda: "", log=lines.append, error=errors.append
        )
        == 0
    )
    assert any(line.startswith("API_TOKEN\t") for line in lines)
    assert (
        await run_secrets_command(
            ["unset", "API_TOKEN"], read_value=lambda: "", log=lines.append, error=errors.append
        )
        == 0
    )
