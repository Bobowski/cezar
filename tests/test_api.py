import asyncio

from stario.testing import TestClient

from app.features.api.urls import API_CANCEL, API_RUNS, API_RUNS_CREATE
from app.http.loopback import is_loopback_host, is_loopback_host_header
from app.main import bootstrap

_REQUIRED = (
    "id",
    "title",
    "workflow",
    "task",
    "status",
    "createdAt",
    "tokensUsed",
    "archived",
    "steps",
)


def test_loopback_host_matches_the_typescript_allowlist():
    assert is_loopback_host(None) is True
    assert is_loopback_host_header(None) is False
    assert is_loopback_host_header("") is False
    for host in ("127.0.0.1", "127.1.2.3", "localhost", "localhost.", "[::1]", "[::1]:4321"):
        assert is_loopback_host_header(host) is True
    for host in ("evil.com", "127.0.0.1.evil.com", "[::1]@evil.com", "8.8.8.8", "0.0.0.0"):
        assert is_loopback_host_header(host) is False


async def test_health_is_the_discovery_document_and_cors_open(client):
    health = await client.get("/api/v1/health")
    assert health.status_code == 200
    body = health.json()
    for key in (
        "version",
        "repoRoot",
        "repo",
        "checks",
        "defaultRunner",
        "forge",
        "capabilities",
        "projects",
        "bootProject",
    ):
        assert key in body
    assert "root" not in body["projects"][0]
    assert body["repo"]["root"]
    assert {row["name"] for row in body["checks"]} >= {"claude", "git", "gh"}
    assert health.headers.get("access-control-allow-origin") == "*"
    runs = await client.get(API_RUNS.href())
    assert "access-control-allow-origin" not in runs.headers


async def test_a_foreign_host_is_forbidden(client):
    denied = await client.get(API_RUNS.href(), headers={"host": "evil.com"})
    assert denied.status_code == 403
    assert "Host" in denied.json()["error"]
    assert (await client.get("/api/v1/health", headers={"host": "evil.com"})).status_code == 403


async def test_hosted_mode_accepts_a_public_host(repo, monkeypatch):
    monkeypatch.setenv("CEZ_REMOTE", "1")
    async with TestClient(bootstrap, request_timeout=15, base_url="http://evil.example") as hosted:
        allowed = await hosted.get("/api/v1/health")
        assert allowed.status_code == 200


async def test_post_runs_rejects_the_same_bodies_the_contract_rejects(client):
    missing = await client.post(API_RUNS_CREATE.href(), json={"runner": "claude"})
    assert missing.status_code == 400
    assert missing.json()["error"] == 'provide either "workflow" or "steps", not both'
    both = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "steps": [{"id": "a", "prompt": "p"}]},
    )
    assert both.status_code == 400
    empty = await client.post(
        API_RUNS_CREATE.href(), json={"task": "   ", "workflow": "quick-task"}
    )
    assert empty.status_code == 400
    assert empty.json()["error"] == "describe the task or attach a file"
    unknown_runner = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "runner": "nope"},
    )
    assert unknown_runner.status_code == 400
    unknown_workflow = await client.post(
        API_RUNS_CREATE.href(), json={"task": "x", "workflow": "no-such-workflow"}
    )
    assert unknown_workflow.status_code == 404
    assert unknown_workflow.json()["error"].startswith("unknown workflow:")
    account = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "agentProfile": "nope"},
    )
    assert account.status_code == 400
    assert "nope" in account.json()["error"]
    variants = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "x", "workflow": "quick-task", "variants": 2},
    )
    assert variants.status_code == 400
    assert "variants" in variants.json()["error"]


async def test_a_created_run_round_trips_with_the_record_shape(client):
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={
            "task": "ship the note",
            "workflow": "quick-task",
            "runner": "claude",
            "agentProfile": "default",
        },
    )
    assert created.status_code == 201
    record = created.json()
    for key in _REQUIRED:
        assert key in record
    assert record["archived"] is False
    assert record["tokensUsed"] == 0
    assert record["workflowDef"]["name"] == "quick-task"
    assert record["steps"][0]["kind"] == "agent"
    assert record["steps"][0]["status"] == "pending"
    listed = (await client.get(API_RUNS.href())).json()
    assert isinstance(listed, list)
    assert "workflowDef" not in listed[0]
    full = (await client.get(API_RUNS.href(), params={"full": "1"})).json()
    assert full[0]["workflowDef"]["source"] == "built-in"
    one = await client.get(f"/api/v1/runs/{record['id']}")
    assert one.status_code == 200
    assert one.json()["task"] == "ship the note"
    scoped = await client.get(f"/api/v1/p/default/runs/{record['id']}")
    assert scoped.status_code == 200
    assert scoped.json() == one.json()
    missing_project = await client.get(f"/api/v1/p/not-a-project/runs/{record['id']}")
    assert missing_project.status_code == 404
    inline = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "inline", "steps": [{"id": "only", "prompt": "do it"}]},
    )
    assert inline.status_code == 201
    assert inline.json()["workflow"] == "(planned)"
    assert inline.json()["workflowDef"]["source"] == "built-in"


async def test_cancel_finish_delete_and_messages_use_the_contract_statuses(client):
    created = await client.post(
        API_RUNS_CREATE.href(),
        json={"task": "mock:ask hold", "workflow": "quick-task"},
    )
    run_id = created.json()["id"]
    early = await client.post(f"/api/v1/runs/{run_id}/finish")
    assert early.status_code == 409
    assert early.json()["error"] == "no open session"
    queued_delete = await client.delete(f"/api/v1/runs/{run_id}")
    assert queued_delete.status_code == 409
    status = ""
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "waiting":
            break
        await asyncio.sleep(0.05)
    assert status == "waiting"
    sent = await client.post(f"/api/v1/runs/{run_id}/messages", json={"text": "the short one"})
    assert sent.status_code == 200
    assert sent.json() == {"delivered": True}
    empty = await client.post(f"/api/v1/runs/{run_id}/messages", json={"text": "  "})
    assert empty.status_code == 400
    for _ in range(40):
        status = (await client.get(f"/api/v1/runs/{run_id}")).json()["status"]
        if status == "review":
            break
        await asyncio.sleep(0.05)
    assert status == "review"
    finished = await client.post(f"/api/v1/runs/{run_id}/finish")
    assert finished.status_code == 200
    assert finished.json() == {"finished": True}
    again = await client.post(API_CANCEL.href(run_id))
    assert again.status_code == 200
    assert again.json()["cancelled"] is False
    removed = await client.delete(f"/api/v1/runs/{run_id}")
    assert removed.status_code == 200
    assert removed.json() == {"deleted": True}
    assert (await client.get(f"/api/v1/runs/{run_id}")).status_code == 404
    resume = await client.delete(f"/api/v1/runs/{created.json()['id']}/auto-resume")
    assert resume.status_code == 404


async def test_projects_list_has_the_registry_keys(client):
    body = (await client.get("/api/v1/projects")).json()
    assert body["bootProject"]
    assert "projectsDir" in body
    project = body["projects"][0]
    for key in ("id", "name", "root", "addedAt", "lastOpenedAt", "source", "status", "branch"):
        assert key in project
    assert project["status"] == "ok"
    assert project["source"] == "local"
