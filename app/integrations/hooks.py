"""Inbound tracker hooks and outbound webhook receivers.

GitHub checks `X-Hub-Signature-256` when `CEZ_GITHUB_WEBHOOK_SECRET` is set.
Jira and Linear check `X-Cezar-Webhook-Secret` the same way. An unset secret
refuses the request. A matching enabled automation starts one run. Receipts
are appended locally.

Outbound receivers keep a `whsec_` signing key. A test delivery is recorded.
Dry-run does not open a socket. Any other delivery may only target public
https or loopback http.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from base64 import b64encode
from pathlib import Path
from secrets import token_bytes
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from app.clock import stamp
from app.integrations.clients import forge_base_issue

_RECEIVERS = "webhook-receivers.json"
_RECEIPTS = "hook-receipts.ndjson"
_DELIVERIES = "webhook-deliveries.ndjson"


def github_signature_ok(secret: str, body: bytes, header: str) -> bool:
    if not secret or not header:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    expected = f"sha256={digest}"
    return hmac.compare_digest(expected, header.strip())


def shared_secret_ok(secret: str, header: str) -> bool:
    if not secret or not header:
        return False
    return hmac.compare_digest(secret, header.strip())


def sign_webhook(secret: str, delivery_id: str, timestamp: int, body: str) -> str:
    key = _decode_key(secret)
    mac = hmac.new(key, f"{delivery_id}.{timestamp}.{body}".encode(), hashlib.sha256).digest()
    return "v1," + b64encode(mac).decode()


def new_secret() -> str:
    return "whsec_" + b64encode(token_bytes(32)).decode()


def load_receivers(directory: Path) -> list[dict[str, object]]:
    path = directory / _RECEIVERS
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except OSError, UnicodeError, json.JSONDecodeError:
        return []
    if not isinstance(loaded, list):
        return []
    return [item for item in loaded if isinstance(item, dict)]


def save_receiver(
    directory: Path, name: str, url: str
) -> tuple[dict[str, object] | None, str | None]:
    issue = delivery_url_issue(url, allow_loopback=True)
    if issue:
        return None, issue
    if not name.strip() or len(name) > 80:
        return None, "name must be 1 to 80 characters"
    rows = load_receivers(directory)
    secret = new_secret()
    row: dict[str, object] = {
        "id": uuid.uuid4().hex,
        "name": name.strip(),
        "url": url,
        "secret": secret,
        "revision": 1,
    }
    rows.append(row)
    _write_json(directory / _RECEIVERS, rows)
    return row, None


def delete_receiver(directory: Path, receiver_id: str) -> bool:
    rows = load_receivers(directory)
    kept = [row for row in rows if row.get("id") != receiver_id]
    if len(kept) == len(rows):
        return False
    _write_json(directory / _RECEIVERS, kept)
    return True


def public_receiver(row: dict[str, object]) -> dict[str, object]:
    return {
        "id": row.get("id", ""),
        "name": row.get("name", ""),
        "url": row.get("url", ""),
        "revision": row.get("revision", 1),
    }


def append_receipt(directory: Path, receipt: dict[str, object]) -> None:
    _append(directory / _RECEIPTS, receipt)


def recent_receipts(directory: Path, limit: int = 50) -> list[dict[str, object]]:
    return _tail(directory / _RECEIPTS, limit)


def record_delivery(
    directory: Path, receiver: dict[str, object], *, dry_run: bool
) -> dict[str, object]:
    body = json.dumps({"type": "cezar.test", "at": stamp()})
    delivery_id = uuid.uuid4().hex
    signature = ""
    secret = receiver.get("secret")
    if isinstance(secret, str) and secret:
        signature = sign_webhook(secret, delivery_id, 0, body)
    url = str(receiver.get("url", ""))
    if dry_run:
        result: dict[str, object] = {
            "id": delivery_id,
            "receiverId": receiver.get("id", ""),
            "status": "delivered",
            "httpStatus": 204,
            "reason": "dry-run",
            "at": stamp(),
        }
    else:
        issue = delivery_url_issue(url, allow_loopback=True)
        if issue:
            result = {
                "id": delivery_id,
                "receiverId": receiver.get("id", ""),
                "status": "failed",
                "reason": issue,
                "at": stamp(),
            }
        else:
            status = _post(url, body, delivery_id, signature)
            result = {
                "id": delivery_id,
                "receiverId": receiver.get("id", ""),
                "status": "delivered" if status is not None and status < 400 else "failed",
                "httpStatus": status,
                "at": stamp(),
            }
    _append(directory / _DELIVERIES, result)
    return result


def recent_deliveries(
    directory: Path, receiver_id: str, limit: int = 50
) -> list[dict[str, object]]:
    rows = [
        row for row in _tail(directory / _DELIVERIES, 200) if row.get("receiverId") == receiver_id
    ]
    return rows[-limit:]


def delivery_url_issue(url: str, *, allow_loopback: bool) -> str | None:
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "webhook URL must be an http(s) address"
    if parsed.username or parsed.password:
        return "webhook URL must not carry credentials"
    host = parsed.hostname
    loopback = host in ("localhost", "127.0.0.1", "::1")
    if loopback:
        return None if allow_loopback and parsed.scheme == "http" else "webhook URL must be https"
    if parsed.scheme != "https":
        return "webhook URL must be https"
    return forge_base_issue(url, "jira")


def _post(url: str, body: str, delivery_id: str, signature: str) -> int | None:
    headers = {"content-type": "application/json", "webhook-id": delivery_id}
    if signature:
        headers["webhook-signature"] = signature
    try:
        request = Request(url, data=body.encode(), headers=headers, method="POST")
        with urlopen(request, timeout=3) as response:
            return int(response.status)
    except URLError, TimeoutError, OSError, ValueError:
        return None


def _decode_key(secret: str) -> bytes:
    if not secret.startswith("whsec_"):
        raise ValueError("invalid signing key")
    from base64 import b64decode

    raw = b64decode(secret[6:], validate=True)
    if len(raw) != 32:
        raise ValueError("invalid signing key")
    return raw


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _append(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value) + "\n")


def _tail(path: Path, limit: int) -> list[dict[str, object]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    rows: list[dict[str, object]] = []
    for line in lines[-limit:]:
        try:
            loaded = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(loaded, dict):
            rows.append(loaded)
    return rows
