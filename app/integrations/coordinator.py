"""Webhook delivery coordinator for one project directory.

`CEZ_WEBHOOKS=1` is required, matching the TypeScript gate. The owner lock is
taken before a row is sent. Dry-run marks the row delivered and does not call
the sender. Retries use the TypeScript base delay (`5s * 2^(attempt-1)`, cap
one hour) without the random 20% jitter, and stop after five attempts instead
of the 72-hour expiry. There is no transport, replay API, or hard-link
successor chain: a dead owner is replaced only when the caller says it is dead.
"""

from __future__ import annotations

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
        self.outbox.append(body)
        return None

    def deliver(self, send: Callable[[str], None], now: str) -> str:
        if not self.opened or not self.owner.valid():
            return "idle"
        return deliver_once(self.outbox, dry_run=self.dry_run, send=send, now=now)

    def close(self) -> None:
        if self.owner.held:
            self.owner.release()
        self.opened = False
