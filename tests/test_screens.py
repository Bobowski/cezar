"""Stream C: each screen's primary action, asserted on the HTML or the next reply."""

from __future__ import annotations

import asyncio
import re
import subprocess
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from stario.testing import TestClient
from tests.conftest import init_repo

from app.features.health.urls import API_HEALTH
from app.features.places.urls import (
    COMPARE,
    GITHUB,
    INBOX,
    INBOX_READ,
    REPO,
    SETTINGS_AGENTS,
    SETTINGS_WEBHOOKS,
    SETTINGS_WEBHOOKS_SAVE,
    SETTINGS_WORKTREES,
    TRACKER,
    WORKFLOW,
)
from app.features.projects.urls import PROJECTS, PROJECTS_BASE
from app.features.projects.views import branch_signal
from app.features.secrets.urls import SECRETS, SECRETS_SAVE
from app.features.settings.urls import (
    GLOBAL_INSTRUCTIONS,
    GLOBAL_INSTRUCTIONS_SAVE,
    GLOBAL_SKILLS,
    GLOBAL_SKILLS_REMOVE,
    GLOBAL_SKILLS_SAVE,
    RESOURCES,
    RESOURCES_SAVE,
    TASKS_SETTINGS,
    TASKS_SETTINGS_SAVE,
    TRACKER_SETTINGS,
    TRACKER_SETTINGS_SAVE,
)
from app.features.task.urls import TASK, TASK_DELETE, TASK_SHELL
from app.features.tasks.urls import TASKS, TASKS_CREATE, TASKS_NEW
from app.features.workflows.urls import WORKFLOWS
from app.main import bootstrap


@asynccontextmanager
async def _open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, label: str = "repo", **env: str
) -> AsyncIterator[TestClient]:
    root = tmp_path / label
    init_repo(root)
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / f"{label}-data"))
    monkeypatch.setenv("CEZ_REPO", str(root))
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    monkeypatch.setenv("CEZ_HIDE_TOKEN_USAGE", "0")
    monkeypatch.setenv("CEZ_HIDE_COST", "0")
    monkeypatch.setenv("CEZ_HIDE_TOKEN_METRICS", "0")
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    async with TestClient(
        bootstrap, request_timeout=30, base_url="http://127.0.0.1:4321"
    ) as client:
        yield client


async def _settle(client: TestClient, run_id: str) -> str:
    status = ""
    for _ in range(50):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status in ("done", "failed", "review", "cancelled"):
            return status
        await asyncio.sleep(0.05)
    return status


async def _start(client: TestClient, task: str) -> str:
    created = await client.post(
        TASKS_CREATE.href(),
        json={"tab": "t1", "task": task, "workflow": "quick-task", "runner": "claude"},
    )
    assert created.status_code == 200
    runs = (await client.get("/api/v1/runs")).json()
    return str(runs[0]["id"])


async def test_a_finished_task_shows_transcript_shell_inbox_and_counts(client):
    run_id = await _start(client, "write a note from the session")
    assert await _settle(client, run_id) == "done"
    session = await client.get(TASK.href(run_id))
    assert 'id="transcript"' in session.text
    assert "Dry run finished" in session.text
    assert "Delete" in session.text
    board = await client.get("/dashboard")
    assert 'id="count-done"' in board.text
    assert "tokens reported" in board.text
    assert "cost reported" in board.text
    assert "are hidden" not in board.text
    shell = await client.post(
        TASK_SHELL.href(run_id),
        json={"tab": "t1", "command": "echo cezar-pane-ok"},
    )
    assert shell.status_code == 200
    assert "cezar-pane-ok" in shell.text
    inbox = await client.get(INBOX.href())
    assert "write a note from the session" in inbox.text
    marked = await client.post(INBOX_READ.href(), follow_redirects=False)
    assert marked.status_code == 303
    assert "Nothing unread." in (await client.get(INBOX.href())).text
    deleted = await client.post(TASK_DELETE.href(run_id), json={"tab": "t1"})
    assert "window.location" in deleted.text
    assert "Task not found" in (await client.get(TASK.href(run_id))).text


async def test_variants_land_on_compare(client):
    page = await client.get(TASKS_NEW.href())
    assert "×2" in page.text and "×3" in page.text
    created = await client.post(
        TASKS_CREATE.href(),
        json={
            "tab": "t1",
            "task": "try two ways",
            "workflow": "quick-task",
            "runner": "claude",
            "variants": 2,
        },
    )
    assert created.status_code == 200
    found = re.search(r"/tasks/([0-9a-f]{32})/compare", created.text)
    assert found is not None
    compared = await client.get(COMPARE.href(found.group(1)))
    assert ">A<" in compared.text and ">B<" in compared.text
    third = await client.post(
        TASKS_CREATE.href(),
        json={
            "tab": "t1",
            "task": "try three ways",
            "workflow": "quick-task",
            "runner": "claude",
            "variants": "3",
        },
    )
    found = re.search(r"/tasks/([0-9a-f]{32})/compare", third.text)
    assert found is not None
    assert ">C<" in (await client.get(COMPARE.href(found.group(1)))).text
    rejected = await client.post(
        TASKS_CREATE.href(),
        json={
            "tab": "t1",
            "task": "too many",
            "workflow": "quick-task",
            "runner": "claude",
            "variants": 4,
        },
    )
    assert rejected.status_code == 400


async def test_the_automations_page_and_its_calendar(client):
    created = await client.post(
        "/automations",
        json={
            "tab": "t1",
            "name": "Nightly",
            "task": "sweep the logs",
            "every": 60,
            "workflow": "quick-task",
        },
    )
    assert created.status_code == 200
    page = await client.get("/automations")
    assert "min · paused ·" in page.text
    calendar = page.text.split('id="calendar"', 1)[1]
    assert "Nightly" in calendar
    found = re.search(r"/automations/([0-9a-f]{32})/enable", page.text)
    assert found is not None
    automation_id = found.group(1)
    assert (
        await client.post(f"/automations/{automation_id}/enable", json={"tab": "t1"})
    ).status_code == 204
    assert "min · enabled ·" in (await client.get("/automations")).text
    assert (
        await client.post(f"/automations/{automation_id}/pause", json={"tab": "t1"})
    ).status_code == 204
    assert "min · paused ·" in (await client.get("/automations")).text
    ran = await client.post(f"/automations/{automation_id}/run", json={"tab": "t1"})
    assert ran.status_code == 204
    assert "sweep the logs" in (await client.get(TASKS.href())).text
    assert (
        await client.post(f"/automations/{automation_id}/delete", json={"tab": "t1"})
    ).status_code == 204
    assert "Nightly" not in (await client.get("/automations")).text


async def test_git_panes_list_the_repository(client):
    commits = await client.get(REPO.href(query={"pane": "commits"}))
    assert "init" in commits.text
    assert 'class="on"' in commits.text
    files = await client.get(REPO.href(query={"pane": "files"}))
    assert "README.md" in files.text
    branches = await client.get(REPO.href(query={"pane": "branches"}))
    assert "main" in branches.text
    changes = await client.get(REPO.href(query={"pane": "changes"}))
    assert "<h2>changes</h2>" in changes.text


async def test_github_and_tracker_pages_look_up(client, monkeypatch):
    missing = await client.get(GITHUB.href(query={"owner": "acme", "repo": "app"}))
    assert "gh is not authenticated" in missing.text

    def issues(_config, owner, repo):
        return {"available": True, "issues": [{"number": 7, "title": f"{owner}/{repo} pane"}]}

    monkeypatch.setattr("app.features.places.handlers.github_issues", issues)
    found = await client.get(GITHUB.href(query={"owner": "acme", "repo": "app"}))
    assert "acme/app pane" in found.text
    bare = await client.get(TRACKER.href())
    assert "Enter an issue key." in bare.text
    unconfigured = await client.get(TRACKER.href(query={"key": "CEZ-1", "kind": "jira"}))
    assert "jira is not configured" in unconfigured.text

    def jira(_config, key):
        return {"available": True, "key": key, "summary": "Fix the door", "status": "Open"}

    monkeypatch.setattr("app.features.places.handlers.jira_issue", jira)
    looked = await client.get(TRACKER.href(query={"key": "CEZ-1", "kind": "jira"}))
    assert "Fix the door" in looked.text


async def test_the_secrets_form_omits_the_value(client):
    saved = await client.post(
        SECRETS_SAVE.href(),
        json={"tab": "t1", "name": "BUILD_TOKEN", "value": "super-secret-value"},
    )
    assert saved.status_code == 200
    page = await client.get(SECRETS.href())
    assert "BUILD_TOKEN" in page.text
    assert "super-secret-value" not in page.text


async def test_agents_page_marks_installed_and_missing(tmp_path, monkeypatch):
    async with _open(
        tmp_path,
        monkeypatch,
        label="agents",
        CEZ_CLAUDE_BIN="/bin/echo",
        CEZ_JUNIE_BIN="/no/such/junie",
    ) as client:
        page = await client.get(SETTINGS_AGENTS.href())
        assert "claude: installed" in page.text
        assert "junie: missing" in page.text


async def test_a_webhook_name_is_on_the_page(client):
    refused = await client.post(
        SETTINGS_WEBHOOKS_SAVE.href(),
        json={"tab": "t1", "name": "nope", "url": "http://example.com/hook"},
    )
    assert "https" in refused.text
    saved = await client.post(
        SETTINGS_WEBHOOKS_SAVE.href(),
        json={"tab": "t1", "name": "Ship", "url": "http://127.0.0.1:9/hook"},
    )
    assert saved.status_code == 200
    assert "Ship" in saved.text
    assert "Ship" in (await client.get(SETTINGS_WEBHOOKS.href())).text


async def test_worktrees_page_states_the_retention_count(client):
    page = await client.get(SETTINGS_WORKTREES.href())
    assert "The 10 newest" in page.text
    assert 'id="worktree-keep"' in page.text
    assert ">10<" in page.text


async def test_worktrees_page_reads_a_smaller_retention_count(tmp_path, monkeypatch):
    async with _open(tmp_path, monkeypatch, label="keep", CEZ_WORKTREE_RETENTION="3") as client:
        kept = await client.get(SETTINGS_WORKTREES.href())
        assert "The 3 newest" in kept.text
        assert ">3<" in kept.text


async def test_agent_config_save_writes_the_file_and_hosted_refuses(client, repo, monkeypatch):
    editor = await client.get("/settings/agent-config/agents-md")
    assert "AGENTS.md" in editor.text
    saved = await client.post(
        "/settings/agent-config/agents-md",
        json={"tab": "t1", "text": "# house rules\n"},
        follow_redirects=False,
    )
    assert saved.status_code == 303
    assert (repo / "AGENTS.md").read_text(encoding="utf-8") == "# house rules\n"
    monkeypatch.setenv("CEZ_REMOTE", "1")
    refused = await client.post(
        "/settings/agent-config/agents-md",
        json={"tab": "t1", "text": "nope"},
        follow_redirects=False,
    )
    assert refused.status_code == 409
    assert "local-only" in refused.text
    assert (repo / "AGENTS.md").read_text(encoding="utf-8") == "# house rules\n"


async def test_accounts_page_adds_a_name(client):
    page = await client.get("/settings/accounts")
    assert "Add account" in page.text
    saved = await client.post(
        "/settings/accounts",
        json={"tab": "t1", "name": "Ada", "runner": "codex"},
        follow_redirects=False,
    )
    assert saved.status_code == 303
    assert "Ada · codex" in (await client.get("/settings/accounts")).text


async def test_bookmarklet_launch_key_is_private_and_opens_new_task(client, tmp_path):
    page = await client.get("/settings/bookmarklets")
    key_path = tmp_path / "data" / "launch-key"
    assert key_path.stat().st_mode & 0o777 == 0o600
    key = key_path.read_text(encoding="utf-8").strip()
    assert f"launch={key}" in page.text
    assert "javascript:" in page.text
    opened = await client.get(TASKS_NEW.href(query={"launch": key}))
    assert opened.status_code == 200
    assert "Opened from the bookmarklet." in opened.text
    refused = await client.get(TASKS_NEW.href(query={"launch": "not-the-key"}))
    assert refused.status_code == 403


async def test_integrations_queues_a_reviewable_task_and_stores_the_key(client):
    page = await client.get("/settings/integrations")
    assert "Set up e2e" in page.text
    assert "https://github.com/tester-army/e2e" in page.text
    short = await client.post(
        "/settings/integrations", json={"tab": "t1", "credential": "too-short"}
    )
    assert short.status_code == 400
    queued = await client.post(
        "/settings/integrations",
        json={"tab": "t1", "credential": "super-secret-value"},
        follow_redirects=False,
    )
    assert queued.status_code == 303
    location = queued.headers.get("location") or ""
    assert "/tasks/" in location
    task = await client.get(location)
    assert "Tester Army" in task.text
    assert "super-secret-value" not in task.text
    secrets = await client.get(SECRETS.href())
    assert "AI_GATEWAY_API_KEY" in secrets.text
    assert "super-secret-value" not in secrets.text


async def test_base_branch_and_the_remaining_settings_editors(client, repo):
    subprocess.run(["git", "branch", "release"], cwd=repo, check=True, capture_output=True)
    project_id = (await client.get(API_HEALTH.href())).json()["bootProject"]
    saved = await client.post(
        PROJECTS_BASE.href(project_id),
        json={"tab": "t1", branch_signal(project_id): "release"},
    )
    assert saved.status_code == 200
    assert "base release" in (await client.get(PROJECTS.href())).text
    checks = await client.post(
        TASKS_SETTINGS_SAVE.href(),
        json={"tab": "t1", "branch": "release", "checks": "lint, unit"},
        follow_redirects=False,
    )
    assert checks.status_code == 303
    tasks = await client.get(TASKS_SETTINGS.href())
    assert "lint" in tasks.text and "unit" in tasks.text
    assert "Landing branch: release" in tasks.text
    bad = await client.post(
        TASKS_SETTINGS_SAVE.href(),
        json={"tab": "t1", "branch": "release", "checks": "../etc"},
        follow_redirects=False,
    )
    assert bad.status_code == 400
    run_id = await _start(client, "branch from release")
    assert await _settle(client, run_id) == "done"
    assert (await client.get(f"/api/v1/runs/{run_id}")).json()["baseBranch"] == "release"

    prompt = await client.post(
        GLOBAL_INSTRUCTIONS_SAVE.href(),
        json={"tab": "t1", "prompt": "be boring"},
        follow_redirects=False,
    )
    assert prompt.status_code == 303
    assert "be boring" in (await client.get(GLOBAL_INSTRUCTIONS.href())).text
    huge = await client.post(
        GLOBAL_INSTRUCTIONS_SAVE.href(),
        json={"tab": "t1", "prompt": "x" * 20_001},
        follow_redirects=False,
    )
    assert huge.status_code == 400

    added = await client.post(
        GLOBAL_SKILLS_SAVE.href(),
        json={"tab": "t1", "repo": "https://github.com/acme/skills", "ref": "main"},
        follow_redirects=False,
    )
    assert added.status_code == 303
    listed = await client.get(GLOBAL_SKILLS.href())
    assert "https://github.com/acme/skills @ main" in listed.text
    assert 'id="skill-repos"' in listed.text
    refused = await client.post(
        GLOBAL_SKILLS_SAVE.href(),
        json={"tab": "t1", "repo": "http://github.com/acme/skills", "ref": "main"},
        follow_redirects=False,
    )
    assert refused.status_code == 400
    removed = await client.post(
        GLOBAL_SKILLS_REMOVE.href(),
        json={"tab": "t1", "repo": "https://github.com/acme/skills"},
        follow_redirects=False,
    )
    assert removed.status_code == 303
    assert "acme/skills" not in (await client.get(GLOBAL_SKILLS.href())).text

    low = await client.post(
        RESOURCES_SAVE.href(), json={"tab": "t1", "memory": 10}, follow_redirects=False
    )
    assert low.status_code == 400
    capped = await client.post(
        RESOURCES_SAVE.href(), json={"tab": "t1", "memory": 512}, follow_redirects=False
    )
    assert capped.status_code == 303
    assert "Memory cap: 512 MB." in (await client.get(RESOURCES.href())).text

    connected = await client.post(
        TRACKER_SETTINGS_SAVE.href(),
        json={
            "tab": "t1",
            "kind": "jira",
            "site": "https://acme.atlassian.net",
            "email": "a@b.co",
            "token": "secretsecretsecret",
        },
        follow_redirects=False,
    )
    assert connected.status_code == 303
    tracker = await client.get(TRACKER_SETTINGS.href())
    assert "A token is saved." in tracker.text
    assert "secretsecretsecret" not in tracker.text
    assert "https://acme.atlassian.net" in tracker.text


async def test_dashboard_hides_token_totals_when_the_flags_are_set(tmp_path, monkeypatch):
    async with _open(tmp_path, monkeypatch, label="usage", CEZ_HIDE_TOKEN_USAGE="1") as client:
        page = await client.get("/dashboard")
        assert "tokens reported" not in page.text
        assert "cost reported" in page.text
        assert "Token totals are hidden." in page.text
        health = (await client.get(API_HEALTH.href())).json()["capabilities"]
        assert health["tokenUsageMetrics"] is False
        assert health["costMetrics"] is True
    async with _open(tmp_path, monkeypatch, label="cost", CEZ_HIDE_COST="1") as client:
        page = await client.get("/dashboard")
        assert "tokens reported" in page.text
        assert "cost reported" not in page.text
        assert "Cost totals are hidden." in page.text
        health = (await client.get(API_HEALTH.href())).json()["capabilities"]
        assert health["costMetrics"] is False
        assert health["tokenUsageMetrics"] is True
    async with _open(tmp_path, monkeypatch, label="metrics", CEZ_HIDE_TOKEN_METRICS="1") as client:
        page = await client.get("/dashboard")
        assert "tokens reported" not in page.text
        assert "cost reported" not in page.text
        assert "Token and cost totals are hidden." in page.text
        health = (await client.get(API_HEALTH.href())).json()["capabilities"]
        assert health["tokenMetrics"] is False
        assert health["tokenUsageMetrics"] is False
        assert health["costMetrics"] is False


async def test_a_workflow_page_lists_its_steps(client):
    listed = await client.get(WORKFLOWS.href())
    assert "/workflows/quick-task" in listed.text
    page = await client.get(WORKFLOW.href("quick-task"))
    assert "Do the task" in page.text
    assert "Start a task" in page.text
    opened = await client.get(TASKS_NEW.href(query={"workflow": "quick-task"}))
    assert "quick-task" in opened.text


def test_the_stylesheet_has_light_violet_tokens_and_a_phone_layout():
    css = Path("static/css/style.css").read_text(encoding="utf-8")
    assert "--violet:" in css
    assert '.light[data-accent="violet"]' in css
    assert "@media (max-width: 800px)" in css
    assert "grid-template-columns: 1fr" in css
