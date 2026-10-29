"""Webhook outbox, single-owner lock, and delivery retries.

The outbox is an NDJSON file. Sequence numbers must increase by one. The owner
file is created exclusively; a live other token keeps it, and a caller that
reports the holder dead can replace it. That is not the TypeScript hard-link
successor chain. Dry-run marks a delivery delivered and does not call the
sender. A failure waits `5s * 2^(attempt-1)` (capped at one hour, no jitter)
and becomes failed after five attempts.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

_MAX_ATTEMPTS = 5


def retry_delay_seconds(attempts: int) -> int:
    """TypeScript `retryAt` base: 5s * 2^(attempt-1), capped at one hour. No jitter."""
    return min(3600, 5 * 2 ** min(max(0, attempts - 1), 20))


class OutboxError(Exception):
    pass


@dataclass
class Delivery:
    sequence: int
    body: str
    attempts: int = 0
    status: str = "pending"
    next_attempt_at: str = ""


class Outbox:
    def __init__(self, directory: Path, installation_id: str) -> None:
        self.directory = directory
        self.installation_id = installation_id
        self.path = directory / "outbox.ndjson"
        self.cursor_path = directory / "cursor.json"
        self.high_water = 0
        self._rows: list[Delivery] = []
        self._offset = 0

    def open(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(self._header(0), encoding="utf-8")
            os.chmod(self.path, 0o600)
        lines = self.path.read_text(encoding="utf-8").splitlines()
        if not lines:
            raise OutboxError("Invalid webhook outbox header")
        header = json.loads(lines[0])
        if (
            not isinstance(header, dict)
            or header.get("version") != 1
            or header.get("installationId") != self.installation_id
        ):
            raise OutboxError("Webhook outbox installation mismatch")
        high = header.get("highWater")
        self.high_water = high if isinstance(high, int) else 0
        previous = 0
        rows: list[Delivery] = []
        for line in lines[1:]:
            loaded = json.loads(line)
            if not isinstance(loaded, dict):
                raise OutboxError("Invalid webhook outbox record")
            sequence = loaded.get("sequence")
            if not isinstance(sequence, int) or sequence <= previous:
                raise OutboxError("Invalid webhook outbox order")
            previous = sequence
            self.high_water = max(self.high_water, sequence)
            rows.append(
                Delivery(
                    sequence=sequence,
                    body=str(loaded.get("body", "")),
                    attempts=int(loaded.get("attempts", 0)),
                    status=str(loaded.get("status", "pending")),
                    next_attempt_at=str(loaded.get("nextAttemptAt", "")),
                )
            )
        self._rows = rows
        self._offset = self._read_cursor()

    def append(self, body: str) -> Delivery:
        sequence = self.high_water + 1
        row = Delivery(sequence=sequence, body=body)
        self._rows.append(row)
        self.high_water = sequence
        self._rewrite()
        return row

    def peek(self) -> Delivery | None:
        for index, row in enumerate(self._rows):
            if index < self._offset:
                continue
            if row.status == "pending":
                return row
        return None

    def mark(self, sequence: int, *, status: str, attempts: int, next_attempt_at: str = "") -> None:
        for row in self._rows:
            if row.sequence == sequence:
                row.status = status
                row.attempts = attempts
                row.next_attempt_at = next_attempt_at
                self._rewrite()
                return
        raise OutboxError("Invalid webhook outbox cursor")

    def advance(self) -> None:
        pending = self.peek()
        if pending is None:
            self._offset = len(self._rows)
        else:
            self._offset = self._rows.index(pending)
        self.cursor_path.write_text(
            json.dumps({"offset": self._offset}),
            encoding="utf-8",
        )

    def _read_cursor(self) -> int:
        try:
            loaded = json.loads(self.cursor_path.read_text(encoding="utf-8"))
        except OSError, json.JSONDecodeError:
            return 0
        offset = loaded.get("offset") if isinstance(loaded, dict) else 0
        if isinstance(offset, int) and 0 <= offset <= len(self._rows):
            return offset
        return 0

    def _rewrite(self) -> None:
        lines = [self._header(self.high_water).rstrip("\n")]
        for row in self._rows:
            lines.append(
                json.dumps(
                    {
                        "sequence": row.sequence,
                        "body": row.body,
                        "attempts": row.attempts,
                        "status": row.status,
                        "nextAttemptAt": row.next_attempt_at,
                    }
                )
            )
        self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _header(self, high_water: int) -> str:
        return (
            json.dumps(
                {"version": 1, "installationId": self.installation_id, "highWater": high_water}
            )
            + "\n"
        )


class Owner:
    def __init__(self, directory: Path, token: str, pid: int) -> None:
        self.path = directory / "owner.lock"
        self.token = token
        self.pid = pid
        self.held = False

    def acquire(self, *, alive: bool) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            current = _read_owner(self.path)
            if current is None:
                raise OutboxError("Invalid webhook owner metadata")
            if current["token"] == self.token:
                self.held = True
                return True
            if alive:
                return False
            self.path.unlink()
        payload = json.dumps({"token": self.token, "pid": self.pid})
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(self.path, flags, 0o600)
        os.write(fd, payload.encode())
        os.close(fd)
        self.held = True
        return True

    def valid(self) -> bool:
        current = _read_owner(self.path)
        return current is not None and current["token"] == self.token

    def release(self) -> None:
        if self.valid():
            self.path.unlink(missing_ok=True)
        self.held = False


def deliver_once(
    outbox: Outbox,
    *,
    dry_run: bool,
    send: Callable[[str], None],
    now: str,
) -> str:
    """Try the next pending row. Returns delivered, retry, failed, or idle."""
    row = outbox.peek()
    if row is None:
        return "idle"
    if dry_run:
        outbox.mark(row.sequence, status="delivered", attempts=row.attempts + 1)
        outbox.advance()
        return "delivered"
    try:
        send(row.body)
    except Exception:
        attempts = row.attempts + 1
        if attempts >= _MAX_ATTEMPTS:
            outbox.mark(row.sequence, status="failed", attempts=attempts)
            outbox.advance()
            return "failed"
        outbox.mark(
            row.sequence,
            status="pending",
            attempts=attempts,
            next_attempt_at=f"{now}+{retry_delay_seconds(attempts)}s",
        )
        return "retry"
    outbox.mark(row.sequence, status="delivered", attempts=row.attempts + 1)
    outbox.advance()
    return "delivered"


def _read_owner(path: Path) -> dict[str, object] | None:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict) or not isinstance(loaded.get("token"), str):
        return None
    return loaded
