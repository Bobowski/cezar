"""Enqueue one Slack delivery when a task changes state.

`CEZ_WEBHOOKS=1` and at least one saved receiver are required. Dry-run marks
the row delivered and does not open a socket. A failure here never fails the run.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from app.clock import stamp
from app.integrations.coordinator import Coordinator
from app.integrations.hooks import _post as post_webhook
from app.integrations.hooks import delivery_url_issue, load_receivers, sign_webhook

_KINDS = {
    "review": "task.review_ready",
    "done": "task.finished",
    "failed": "task.failed",
    "cancelled": "task.cancelled",
    "waiting": "task.attention_required",
}


def notify_task(
    data_dir: Path,
    *,
    run_id: str,
    title: str,
    status: str,
    previous: str,
    project_id: str,
    error: str,
    dry_run: bool,
) -> None:
    if os.environ.get("CEZ_WEBHOOKS") != "1":
        return
    kind = _KINDS.get(status)
    receivers = load_receivers(data_dir)
    if kind is None or not receivers:
        return
    event = json.dumps(
        {
            "type": kind,
            "occurredAt": stamp(),
            "task": {
                "id": run_id,
                "title": title,
                "status": status,
                "previousStatus": previous,
            },
            "source": {"projectId": project_id, "mode": "local"},
            "data": {"message": error} if error else {},
        }
    )
    directory = data_dir / "webhook-outbox"
    try:
        coordinator = Coordinator(
            directory,
            _installation(directory),
            "cezar-engine",
            os.getpid(),
            dry_run=dry_run,
            enabled=True,
        )
        if coordinator.open(other_alive=False):
            return
        try:
            for row in receivers:
                name = str(row.get("name", ""))
                url = str(row.get("url", ""))
                secret = row.get("secret")
                if coordinator.enqueue(event, receiver_name=name):
                    continue
                coordinator.deliver(
                    lambda body, url=url, secret=secret: _send(url, body, secret),
                    int(time.time() * 1000),
                )
        finally:
            coordinator.close()
    except OSError, ValueError:
        return


def _send(url: str, body: str, secret: object) -> None:
    issue = delivery_url_issue(url, allow_loopback=True)
    if issue:
        raise RuntimeError(issue)
    signature = ""
    if isinstance(secret, str) and secret:
        signature = sign_webhook(secret, "lifecycle", 0, body)
    status = post_webhook(url, body, "lifecycle", signature)
    if status is None or status >= 400:
        raise RuntimeError(f"webhook delivery failed ({status})")


def _installation(directory: Path) -> str:
    path = directory / "installation"
    try:
        current = path.read_text(encoding="utf-8").strip()
    except OSError:
        current = ""
    if current:
        return current
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text("install-local\n", encoding="utf-8")
    return "install-local"
