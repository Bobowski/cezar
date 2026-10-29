from pathlib import Path

import pytest
from tests.conftest import init_repo

from app.cli import main, projects_command, run_task
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
    assert "extra" in capsys.readouterr().out
    assert await projects_command("add", str(extra)) == 1
