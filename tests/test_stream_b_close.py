"""The second Stream B pass: usage, attachments, landing, and the remaining routes."""

from __future__ import annotations

import asyncio
import base64
import os
import socket
import subprocess
import zipfile
from pathlib import Path

from stario.testing import TestClient

from app.cli import main
from app.engine.project_forge import checkout, create_repo, owners
from app.engine.providers import connect_provider
from app.engine.server_install import first_free_port
from app.main import bootstrap

_PNG = base64.b64encode(b"png-bytes").decode()


def _attempts(row: dict[str, object]) -> int:
    value = row.get("autoResumeAttempts")
    return value if isinstance(value, int) else 0


async def _until(client, run_id: str, predicate):
    last: dict[str, object] = {}
    for _ in range(80):
        last = (await client.get(f"/api/v1/runs/{run_id}")).json()
        if predicate(last):
            return last
        await asyncio.sleep(0.05)
    return last


async def test_a_running_check_reports_a_usage_sample(client):
    created = await client.post(
        "/api/v1/runs",
        json={"task": "wait", "steps": [{"id": "wait", "command": "sleep 3"}]},
    )
    run_id = created.json()["id"]
    seen = None
    for _ in range(80):
        rows = (await client.get("/api/v1/runs")).json()
        match = next(row for row in rows if row["id"] == run_id)
        if "usage" in match:
            seen = match["usage"]
            break
        if match["status"] in ("done", "failed", "cancelled"):
            break
        await asyncio.sleep(0.05)
    assert seen is not None
    assert seen["procCount"] >= 1
    assert seen["rssBytes"] >= 0
    assert "cpuPct" in seen


async def test_attachments_add_the_prompt_line(client, monkeypatch):
    monkeypatch.setenv("CEZ_REVIEW_GATE", "1")
    created = await client.post(
        "/api/v1/runs",
        json={
            "task": "look at the picture",
            "workflow": "quick-task",
            "images": [{"mediaType": "image/png", "data": _PNG, "name": "shot.png"}],
        },
    )
    run_id = created.json()["id"]
    body = await _until(
        client,
        run_id,
        lambda row: bool(row.get("worktreePath")) and row["status"] in ("review", "done", "failed"),
    )
    worktree = Path(str(body["worktreePath"]))
    first = (worktree / "CEZAR_DRY_RUN.txt").read_text(encoding="utf-8")
    assert "The user attached:\n" in first
    assert "shot.png" in first
    assert body["status"] == "review"
    sent = await client.post(
        f"/api/v1/runs/{run_id}/messages",
        json={
            "text": "use this",
            "images": [{"mediaType": "image/png", "data": _PNG, "name": "note.png"}],
        },
    )
    assert sent.status_code == 200
    assert sent.json()["delivered"] is True
    follow = ""
    for _ in range(80):
        follow = (worktree / "CEZAR_DRY_RUN.txt").read_text(encoding="utf-8")
        if "note.png" in follow:
            break
        await asyncio.sleep(0.05)
    assert "The user attached:\n" in follow
    assert "note.png" in follow


async def test_an_in_place_checkout_is_committed(client, repo: Path):
    config = repo / ".ai" / "cezar" / "config.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text('{"inPlace": true}\n', encoding="utf-8")
    created = await client.post(
        "/api/v1/runs",
        json={"task": "land me", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    body = await _until(client, run_id, lambda row: row["status"] in ("done", "failed", "review"))
    assert body["status"] == "done"
    assert body.get("worktree") is False
    committed = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", "HEAD"], cwd=repo, text=True
    )
    assert "CEZAR_DRY_RUN.txt" in committed
    (repo / "after.txt").write_text("later\n", encoding="utf-8")
    landed = await client.post(f"/api/v1/runs/{run_id}/land")
    assert landed.json()["result"] == "landed"
    latest = subprocess.check_output(
        ["git", "log", "-1", "--format=%s", "--name-only"], cwd=repo, text=True
    )
    assert "land the task" in latest
    assert "after.txt" in latest
    assert ".ai/cezar" not in latest


async def test_delete_auto_resume_cancels_the_scheduled_retry(client):
    created = await client.post(
        "/api/v1/runs",
        json={
            "task": "limited",
            "steps": [{"id": "limit", "command": "echo usage limit; exit 1"}],
        },
    )
    run_id = created.json()["id"]
    armed = await _until(client, run_id, lambda row: bool(row.get("autoResumeAt")))
    assert armed["status"] == "failed"
    assert armed["autoResumeAt"]
    cleared = await client.delete(f"/api/v1/runs/{run_id}/auto-resume")
    assert cleared.json() == {"cancelled": True}
    await asyncio.sleep(0.7)
    later = (await client.get(f"/api/v1/runs/{run_id}")).json()
    assert later["status"] == "failed"
    assert "autoResumeAt" not in later
    assert later.get("autoResumeAttempts", 0) == 0
    again = await client.delete(f"/api/v1/runs/{run_id}/auto-resume")
    assert again.json()["cancelled"] is False


async def test_a_usage_limit_failure_is_requeued(client):
    created = await client.post(
        "/api/v1/runs",
        json={
            "task": "limited",
            "steps": [{"id": "limit", "command": "echo usage limit; exit 1"}],
        },
    )
    run_id = created.json()["id"]
    resumed = await _until(client, run_id, lambda row: _attempts(row) >= 1)
    assert _attempts(resumed) >= 1
    ready = await _until(
        client,
        run_id,
        lambda row: bool(row.get("autoResumeAt")) or row.get("status") == "queued",
    )
    assert ready.get("autoResumeAt") or ready.get("status") == "queued"
    started = await client.post(f"/api/v1/runs/{run_id}/start-now")
    assert started.status_code == 200
    assert started.json()["started"] is True
    await client.delete(f"/api/v1/runs/{run_id}/auto-resume")


async def test_github_automation_filters_and_stats(client):
    created = await client.post(
        "/api/v1/automations",
        json={
            "name": "prs",
            "task": "look at the pull request",
            "everyMinutes": 60,
            "kind": "github",
            "events": ["pull_request"],
            "filters": {"action": "opened"},
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["kind"] == "github"
    assert body["events"] == ["pull_request"]
    assert body["filters"] == {"action": "opened"}
    listed = (await client.get("/api/v1/automations")).json()
    assert listed["stats"]["total"] >= 1
    assert listed["stats"]["enabled"] == 0
    assert "runsLaunched" in listed["stats"]
    templates = (await client.get("/api/v1/automation-templates")).json()
    assert {row["id"] for row in templates["templates"]} >= {
        "nightly",
        "github-pr",
        "tracker-issue",
    }


async def test_project_tags_forge_checkout_and_owners(client, repo: Path, monkeypatch):
    subprocess.run(
        ["git", "remote", "add", "origin", "https://github.com/acme/cezar.git"],
        cwd=repo,
        check=True,
    )
    listed = (await client.get("/api/v1/projects")).json()
    assert listed["maxParallel"] >= 1
    project = listed["projects"][0]
    assert project["tags"] == []
    assert project["forge"] == {"kind": "github"}
    patched = await client.patch(f"/api/v1/projects/{project['id']}", json={"tags": ["backend"]})
    assert patched.json()["tags"] == ["backend"]

    def explode(_args: list[str]) -> tuple[int, str]:
        raise AssertionError("gh was called")

    monkeypatch.setattr("app.engine.project_forge.gh", explode)
    made = await client.post(
        "/api/v1/projects/checkout",
        json={"url": "https://github.com/acme/widget"},
    )
    assert made.status_code == 201
    assert made.json()["dryRun"] is True
    owners_doc = (await client.get("/api/v1/github/owners")).json()
    assert owners_doc["dryRun"] is True
    assert owners_doc["owners"][0]["login"] == "cezar"
    created = await client.post("/api/v1/projects/github", json={"name": "fresh"})
    assert created.status_code == 201
    assert created.json()["dryRun"] is True
    assert Path(created.json()["root"]).is_dir()


def test_a_live_checkout_calls_the_injected_gh(tmp_path: Path):
    calls: list[list[str]] = []

    def runner(args: list[str]) -> tuple[int, str]:
        calls.append(args)
        target = Path(args[-1])
        target.mkdir(parents=True)
        return 0, "ok"

    dry = checkout(
        "https://github.com/acme/repo",
        tmp_path / "dry",
        dry_run=True,
        runner=runner,
    )
    assert dry["dryRun"] is True
    assert calls == []
    live = checkout(
        "https://github.com/acme/repo",
        tmp_path / "live",
        dry_run=False,
        runner=runner,
    )
    assert live["ok"] is True
    assert calls[0][:2] == ["repo", "clone"]
    quiet = owners(dry_run=True, runner=runner)
    quiet_owners = quiet["owners"]
    assert isinstance(quiet_owners, list)
    first = quiet_owners[0]
    assert isinstance(first, dict)
    assert first["login"] == "cezar"
    made = create_repo("widget", tmp_path / "made", dry_run=True, runner=runner)
    assert made["dryRun"] is True
    assert len(calls) == 1


def test_provider_connect_in_a_dry_run_does_not_probe(tmp_path: Path):
    def probe(_args: list[str]) -> tuple[int, str]:
        raise AssertionError("probed")

    row, reason = connect_provider(
        tmp_path / "providers.json",
        "claude",
        {"claude": "claude"},
        dry_run=True,
        probe=probe,
    )
    assert reason is None
    assert row is not None
    assert row["version"] == "dry-run"
    assert row["connected"] is True


async def test_closeout_routes(client, repo: Path):
    skill = repo / ".agents" / "skills" / "demo" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(
        "---\nname: demo\ndescription: local only\n---\n\nDo the thing.\n",
        encoding="utf-8",
    )
    (repo / "e2e.config.ts").write_text("export default {}\n", encoding="utf-8")
    (repo / "e2e.credentials.json").write_text('{"ada": {"password": "nope"}}\n', encoding="utf-8")
    bad = repo / ".ai" / "cezar" / "workflows" / "bad.yaml"
    bad.parent.mkdir(parents=True, exist_ok=True)
    bad.write_text(":\n  - [\n", encoding="utf-8")

    imported = (await client.get("/api/v1/skills/importable")).json()
    assert imported["network"] is False
    assert any(row["name"] == "demo" for row in imported["skills"])
    refreshed = await client.post("/api/v1/skills/refresh")
    assert refreshed.json()["copied"] == ["demo"]
    assert refreshed.json()["network"] is False
    copied = repo / ".ai" / "cezar" / "skills" / "demo.md"
    assert copied.read_bytes() == skill.read_bytes()
    updated = await client.post("/api/v1/skills/update")
    assert updated.json()["network"] is False
    assert updated.json()["updated"] == []
    again = (await client.get("/api/v1/skills/importable")).json()
    assert all(row["name"] != "demo" for row in again["skills"])

    planned = await client.post("/api/v1/plan", json={"task": "outline the change"})
    assert planned.status_code == 201
    assert planned.json()["callsModel"] is False
    assert planned.json()["run"]["workflow"] == "(plan)"

    status = (await client.get("/api/v1/e2e")).json()
    assert status["configFile"] == "e2e.config.ts"
    assert status["credentials"] == ["ada"]
    assert "nope" not in str(status)
    setup = await client.post("/api/v1/e2e/setup")
    assert setup.status_code == 201
    assert (await client.get("/api/v1/e2e")).json()["latestRunId"] == setup.json()["runId"]

    saved = await client.put("/api/v1/start-app", json={"command": "echo hi"})
    assert saved.json()["command"] == "echo hi"
    assert (await client.get("/api/v1/start-app")).json()["command"] == "echo hi"

    draft = await client.post("/api/v1/drafts", json={"text": "remember this"})
    assert draft.status_code == 201
    assert (await client.get("/api/v1/drafts")).json()["drafts"][0]["text"] == "remember this"
    laid = await client.put("/api/v1/layouts", json={"layouts": {"main": "split"}})
    assert laid.json()["layouts"]["main"] == "split"
    templated = await client.put(
        "/api/v1/prompt-templates",
        json={"templates": [{"name": "fix", "text": "fix {{task}}"}]},
    )
    assert templated.json()["templates"][0]["name"] == "fix"

    profile = await client.post(
        "/api/v1/workspace/profiles", json={"name": "local", "runner": "claude"}
    )
    assert profile.status_code == 201
    assert (await client.get("/api/v1/workspace/profiles")).json()["profiles"][0]["name"] == "local"
    branded = await client.put(
        "/api/v1/workspace/branding", json={"name": "Acme", "accent": "violet"}
    )
    assert branded.json()["accent"] == "violet"
    usage = (await client.get("/api/v1/workspace/host-usage")).json()
    assert usage["disk"]["level"] in ("ok", "low", "critical")

    connected = await client.post("/api/v1/providers/claude/connect")
    assert connected.json()["version"] == "dry-run"
    disabled = await client.put("/api/v1/providers/claude/enabled", json={"enabled": False})
    assert disabled.json()["enabled"] is False
    rows = (await client.get("/api/v1/providers/status")).json()["providers"]
    claude = next(row for row in rows if row["provider"] == "claude")
    assert claude["connected"] is True
    assert claude["enabled"] is False
    retried = await client.post("/api/v1/providers/claude/retry")
    assert retried.json()["connected"] is True

    workflows = (await client.get("/api/v1/workflows")).json()
    assert workflows["issues"]
    assert "bad.yaml" in workflows["issues"][0]["path"]

    created = await client.post(
        "/api/v1/runs",
        json={"task": "hold a note", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    finished = await _until(
        client, run_id, lambda row: row["status"] in ("done", "review", "failed")
    )
    assert finished["status"] in ("done", "review")
    history = (await client.get(f"/api/v1/runs/{run_id}/history")).json()
    assert history["events"]
    written = await client.put(f"/api/v1/runs/{run_id}/handoff", json={"text": "left this"})
    assert written.json()["text"] == "left this"
    assert (await client.get(f"/api/v1/runs/{run_id}/handoff")).json()["text"] == "left this"
    assert (await client.get(f"/api/v1/runs/{run_id}/report")).json()["report"] is None
    refused = await client.post(f"/api/v1/runs/{run_id}/report", json={"summary": "n/a"})
    assert refused.status_code == 404
    if finished.get("worktreePath"):
        pictured = await client.post(
            f"/api/v1/runs/{run_id}/images",
            json={"images": [{"mediaType": "image/png", "data": _PNG, "name": "extra.png"}]},
        )
        assert pictured.status_code == 200
        assert pictured.json()["paths"]
        assert Path(pictured.json()["paths"][0]).is_file()


async def test_open_in_spawns_when_the_cockpit_is_not_a_dry_run(repo, monkeypatch, tmp_path: Path):
    monkeypatch.setenv("CEZ_DRY_RUN", "0")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    editor = bin_dir / "code"
    editor.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    editor.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    spawned: list[list[str]] = []

    def fake_spawn(args: list[str]) -> None:
        spawned.append(list(args))

    monkeypatch.setattr("app.features.api.families._spawn", fake_spawn)
    async with TestClient(bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321") as local:
        opened = await local.post("/api/v1/open-in", json={"target": "code"})
        assert opened.status_code == 200
        assert opened.json()["opened"] is True
        assert opened.json().get("dryRun") is not True
        assert spawned[0][0] == "code"
        assert spawned[0][1] == str(repo)


async def test_hosted_basic_auth_sets_a_session_cookie(repo, monkeypatch):
    monkeypatch.setenv("CEZ_REMOTE", "1")
    monkeypatch.setenv("CEZ_AUTH_USER", "ada")
    monkeypatch.setenv("CEZ_AUTH_PASSWORD", "secret-token")
    token = base64.b64encode(b"ada:secret-token").decode()
    async with TestClient(bootstrap, request_timeout=15, base_url="http://evil.example") as hosted:
        path = repo.parent / "data" / "session-token"
        assert path.is_file()
        assert path.stat().st_mode & 0o777 == 0o600
        denied = await hosted.get("/api/v1/projects")
        assert denied.status_code == 401
        allowed = await hosted.get("/api/v1/projects", headers={"authorization": f"Basic {token}"})
        assert allowed.status_code == 200
        assert "cezar_session" in allowed.cookies
        again = await hosted.get("/api/v1/workspace/config")
        assert again.status_code == 200


def test_server_install_writes_files_and_package_builds_a_wheel(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_REPO", str(tmp_path))
    dest = tmp_path / "unit"
    assert main(["server-install", "--dest", str(dest), "--port", "4321"]) == 0
    unit = (dest / "cezar.service").read_text(encoding="utf-8")
    assert "ExecStart=python -m app.main" in unit
    assert "systemctl" not in unit
    assert "node" not in unit.lower()
    compose = (dest / "compose.yaml").read_text(encoding="utf-8")
    assert "cezar:" in compose
    deploy = tmp_path / "deploy"
    assert main(["deploy", "--dest", str(deploy)]) == 0
    assert (deploy / "compose.yaml").is_file()
    assert not (deploy / "cezar.service").exists()
    assert main(["uninstall", "--dest", str(dest)]) == 0
    assert not (dest / "cezar.service").exists()
    assert not (dest / "compose.yaml").exists()
    assert main(["package", "--dest", str(tmp_path / "dist")]) == 0
    wheels = list((tmp_path / "dist").glob("*.whl"))
    assert len(wheels) == 1
    with zipfile.ZipFile(wheels[0]) as archive:
        assert "app/cli.py" in archive.namelist()
        names = archive.namelist()
        metadata = [name for name in names if name.endswith(".dist-info/METADATA")]
        assert metadata and metadata[0].startswith("cezar-")
    text = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text(encoding="utf-8")
    assert "CEZ_DRY_RUN=1" in text
    assert 'CMD ["python", "-m", "app.main"]' in text
    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    busy = held.getsockname()[1]
    try:
        assert first_free_port("127.0.0.1", busy) != busy
    finally:
        held.close()
