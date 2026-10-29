"""Webhook delivery coordinator for one project directory.

`CEZ_WEBHOOKS=1` is required, matching the TypeScript gate. The owner lock is
a hard link. Dry-run marks the row delivered and does not call the sender.
Retries use `retry_at_ms`. Replay is `replay()` on a finished row.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path

from app.integrations.outbox import Outbox, Owner, deliver_once
from app.integrations.slack_render import render_slack


def webhooks_enabled() -> bool:
    return os.environ.get("CEZ_WEBHOOKS") == "1"


class Coordinator:
    def __init__(
        self,
        directory: Path,
        installation_id: str,
        token: str,
        pid: int,
        *,
        dry_run: bool,
        enabled: bool | None = None,
    ) -> None:
        self.directory = directory
        self.dry_run = dry_run
        self.enabled = webhooks_enabled() if enabled is None else enabled
        self.outbox = Outbox(directory, installation_id)
        self.owner = Owner(directory, token, pid)
        self.opened = False

    def open(self, *, other_alive: bool) -> str | None:
        if not self.enabled:
            return "Enable webhook delivery with CEZ_WEBHOOKS=1 and restart cezar"
        self.outbox.open()
        if not self.owner.acquire(alive=other_alive):
            return "another owner holds the webhook outbox"
        self.opened = True
        return None

    def enqueue(self, event_json: str, *, receiver_name: str = "") -> str | None:
        if not self.opened or not self.owner.valid():
            return "webhook owner is not held"
        body = render_slack(event_json, receiver_name=receiver_name)
        self.outbox.append(body, event_type=_event_type(event_json))
        return None

    def deliver(self, send: Callable[[str], None], now_ms: int) -> str:
        if not self.opened or not self.owner.valid():
            return "idle"
        return deliver_once(self.outbox, dry_run=self.dry_run, send=send, now_ms=now_ms)

    def close(self) -> None:
        if self.owner.held:
            self.owner.release()
        self.opened = False


def _event_type(event_json: str) -> str:
    try:
        loaded = json.loads(event_json)
    except json.JSONDecodeError:
        return ""
    if isinstance(loaded, dict) and isinstance(loaded.get("type"), str):
        return loaded["type"]
    return ""
