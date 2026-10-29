import json
from pathlib import Path

from app.features.editors import store
from app.integrations.coordinator import Coordinator
from app.integrations.github_review import merge_pr, review_pr
from app.integrations.outbox import Delivery, Outbox, OutboxError, Owner, deliver_once
from app.integrations.slack_render import render_slack


def test_slack_escapes_markup_and_names_a_test_ping():
    ping = render_slack(json.dumps({"type": "webhook.test"}), receiver_name="Ops <a>")
    assert "&lt;a&gt;" in ping
    assert "Test message" in ping
    failed = render_slack(
        json.dumps(
            {
                "type": "task.failed",
                "task": {
                    "id": "abc",
                    "title": "Ship <it>",
                    "status": "failed",
                    "previousStatus": "running",
                },
                "source": {"projectId": "demo"},
                "data": {"message": "boom & more"},
            }
        )
    )
    assert "Ship &lt;it&gt;" in failed
    assert "boom &amp; more" in failed
    asked = render_slack(
        json.dumps(
            {
                "type": "task.attention_required",
                "occurredAt": "2026-10-19T12:00:00Z",
                "task": {
                    "id": "abcdefgh-task",
                    "title": "Task title",
                    "status": "waiting",
                    "previousStatus": "running",
                },
                "source": {"projectId": "project", "mode": "local"},
                "data": {
                    "questions": [
                        {
                            "question": "Which?",
                            "options": [{"label": "Yes", "description": "Proceed"}],
                        }
                    ]
                },
                "links": {
                    "issue": "https://example.com/issues/1?q=a|b",
                    "cockpit": "https://cockpit.example/task",
                },
            }
        )
    )
    assert "Which?" in asked
    assert "a%7Cb|Issue" in asked
    assert "cockpit.example" not in asked


def test_the_outbox_rejects_a_foreign_installation_and_retries_then_fails(tmp_path: Path):
    box = Outbox(tmp_path, "install-a")
    box.open()
    box.append('{"type":"webhook.test"}')
    assert box.high_water == 1
    other = Outbox(tmp_path, "install-b")
    try:
        other.open()
    except OutboxError as exc:
        assert "mismatch" in str(exc)
    else:
        raise AssertionError("foreign installation was accepted")
    calls: list[str] = []

    def fail(body: str) -> None:
        calls.append(body)
        raise RuntimeError("down")

    fresh = Outbox(tmp_path, "install-a")
    fresh.open()
    assert deliver_once(fresh, dry_run=True, send=fail, now="t") == "delivered"
    assert calls == []
    again = Outbox(tmp_path / "retry", "install-a")
    again.open()
    again.append("payload")
    first = deliver_once(again, dry_run=False, send=fail, now="t")
    waiting = again.peek()
    assert first == "retry"
    assert waiting is not None and waiting.next_attempt_at == "t+5s"
    seen = [first, *[deliver_once(again, dry_run=False, send=fail, now="t") for _ in range(4)]]
    assert seen[:4] == ["retry", "retry", "retry", "retry"]
    assert seen[4] == "failed"
    assert again.peek() is None


def test_one_live_owner_blocks_a_second_token(tmp_path: Path):
    first = Owner(tmp_path, "token-a", pid=10)
    assert first.acquire(alive=True) is True
    second = Owner(tmp_path, "token-b", pid=11)
    assert second.acquire(alive=True) is False
    first.release()
    assert second.acquire(alive=False) is True
    assert second.valid() is True


def test_dry_run_review_and_merge_do_not_need_gh(tmp_path: Path):
    reviewed = review_pr(4, "approve", "looks good", dry_run=True, cwd=tmp_path)
    assert reviewed["dryRun"] is True and reviewed["submitted"] is True
    merged = merge_pr(4, "squash", dry_run=True, cwd=tmp_path)
    assert merged["merged"] is True and merged["dryRun"] is True
    assert str(merged["url"]).endswith("/4")
    refused = merge_pr(4, "force", dry_run=True, cwd=tmp_path)
    assert refused["ok"] is False


def test_instructions_and_agent_config_round_trip(tmp_path: Path):
    assert store.write_instructions(tmp_path, "be brief", "cez/<slug>") is None
    assert store.read_instructions(tmp_path)["branchNaming"] == "cez/<slug>"
    assert store.write_agent_file(tmp_path, "agents-md", "# hi\n", hosted=False) is None
    found = store.read_agent_file(tmp_path, "agents-md")
    assert found is not None and found[1] == "# hi\n"
    assert store.write_agent_file(tmp_path, "agents-md", "nope", hosted=True) == (
        "agent config writes are local-only"
    )
    assert store.read_agent_file(tmp_path, "agents-md")[1] == "# hi\n"  # type: ignore[index]


async def test_the_settings_editors_render_and_save(client, repo: Path):
    page = await client.get("/settings/instructions")
    assert page.status_code == 200
    assert "Instructions" in page.text
    saved = await client.post(
        "/settings/instructions",
        json={"systemPrompt": "be brief", "branchNaming": "cez/<slug>", "tab": "t1"},
        follow_redirects=False,
    )
    assert saved.status_code == 303
    assert store.read_instructions(repo)["systemPrompt"] == "be brief"
    config = await client.get("/settings/agent-config")
    assert "AGENTS.md" in config.text
    accounts = await client.post(
        "/settings/accounts",
        json={"name": "Ada", "runner": "claude", "tab": "t1"},
        follow_redirects=False,
    )
    assert accounts.status_code == 303
    listed = await client.get("/settings/accounts")
    assert "Ada" in listed.text
    notes = await client.post(
        "/settings/notifications",
        json={"browser": True, "tab": "t1"},
        follow_redirects=False,
    )
    assert notes.status_code == 303
    assert "Browser notifications are on." in (await client.get("/settings/notifications")).text
    keys = await client.post(
        "/settings/keyboard",
        json={"submit": "enter", "tab": "t1"},
        follow_redirects=False,
    )
    assert keys.status_code == 303
    assert "enter" in (await client.get("/settings/keyboard")).text
    mark = await client.get("/settings/bookmarklets")
    assert "javascript:" in mark.text
    tools = await client.get("/settings/integrations")
    assert "Test frameworks" in tools.text
    queued = await client.post("/settings/integrations", json={"tab": "t1"}, follow_redirects=False)
    assert queued.status_code == 303
    assert "/tasks/" in queued.headers.get("location", "")
    review = await client.post(
        "/api/v1/github/prs/9/reviews",
        json={"event": "comment", "body": "nit"},
    )
    assert review.status_code == 200
    assert review.json()["dryRun"] is True
    merged = await client.post("/api/v1/github/prs/9/merge", json={"method": "squash"})
    assert merged.json()["dryRun"] is True
    assert merged.json()["merged"] is True


def test_the_coordinator_stays_off_until_enabled_and_dry_run_does_not_send(tmp_path: Path):
    quiet = Coordinator(tmp_path / "off", "install-a", "token-a", 1, dry_run=True, enabled=False)
    assert quiet.open(other_alive=False) == (
        "Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar"
    )
    live = Coordinator(tmp_path / "on", "install-a", "token-a", 1, dry_run=True, enabled=True)
    assert live.open(other_alive=False) is None
    blocked = Coordinator(tmp_path / "on", "install-a", "token-b", 2, dry_run=True, enabled=True)
    assert blocked.open(other_alive=True) == "another owner holds the webhook outbox"
    assert live.enqueue(json.dumps({"type": "webhook.test"}), receiver_name="Ops") is None
    calls: list[str] = []
    assert live.deliver(calls.append, "t") == "delivered"
    assert calls == []
    live.close()


def test_cursor_agent_bin_uses_the_typescript_name(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CEZ_CURSOR_AGENT_BIN", "/opt/cursor-agent")
    monkeypatch.setenv("CEZ_CURSOR_BIN", "/opt/other")
    from app.config import Config

    assert Config.from_env().runner_bins["cursor"] == "/opt/cursor-agent"


def test_delivery_row_shape():
    row = Delivery(sequence=1, body="x")
    assert row.status == "pending"
