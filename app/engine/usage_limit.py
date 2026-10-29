"""When a provider usage limit lifts.

The shapes match `packages/cezar/src/core/usage-limit.ts`: Claude's
`usage limit reached|<epoch>` envelope, an explicit timestamp, and a relative
delay. A limit with no recoverable instant is not a schedule. A reset more
than seven days out is ignored. A stale instant clamps to now.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

MAX_USAGE_LIMIT_WAIT = timedelta(days=7)

_CLAUDE_MARKER = re.compile(
    r"claude(?:\s+ai)?\s+usage\s+limit\s+reached\s*\|\s*(\d{9,16})",
    re.IGNORECASE,
)
_LIMIT_PHRASE = re.compile(
    r"\b(?:usage|rate|session|weekly|hourly)[\s-]?limit\b"
    r"|\brate[_-]?limit(?:_error|ed)?\b"
    r"|\bquota\s+(?:exceeded|reached)\b"
    r"|\bout\s+of\s+(?:credits|quota)\b",
    re.IGNORECASE,
)
_RESET_AT = re.compile(
    r"(?:resets?|resets?\s+at|try\s+again|retry|available\s+again|unlocks?)\b"
    r"[^\n]{0,24}?\b(\d{4}-\d{2}-\d{2}"
    r"(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)",
    re.IGNORECASE,
)
_RESET_IN = re.compile(
    r"(?:try\s+again|retry|resets?|available\s+again)\b[^\n]{0,16}?\b(?:in|after)\s+"
    r"(\d{1,7})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b",
    re.IGNORECASE,
)
_RETRY_AFTER = re.compile(r"\bretry[-_\s]?after\b\s*[:=]?\s*(\d{1,7})\b", re.IGNORECASE)

_UNIT_SECONDS = {
    "s": 1,
    "sec": 1,
    "secs": 1,
    "second": 1,
    "seconds": 1,
    "m": 60,
    "min": 60,
    "mins": 60,
    "minute": 60,
    "minutes": 60,
    "h": 3600,
    "hr": 3600,
    "hrs": 3600,
    "hour": 3600,
    "hours": 3600,
}


@dataclass(frozen=True, slots=True)
class UsageLimitHit:
    reset_at: datetime
    evidence: str


def parse_usage_limit(message: str, moment: datetime) -> UsageLimitHit | None:
    if not message.strip():
        return None
    marker = _CLAUDE_MARKER.search(message)
    if marker:
        return _accept(_from_epoch(int(marker.group(1))), "claude-marker", moment)
    if _LIMIT_PHRASE.search(message) is None:
        return None
    stamped = _RESET_AT.search(message)
    if stamped:
        parsed = _parse_instant(stamped.group(1))
        if parsed is not None:
            return _accept(parsed, "timestamp", moment)
    delay = _RESET_IN.search(message)
    if delay:
        seconds = _seconds(int(delay.group(1)), delay.group(2))
        if seconds is not None:
            return _accept(moment + timedelta(seconds=seconds), "delay", moment)
    header = _RETRY_AFTER.search(message)
    if header:
        return _accept(moment + timedelta(seconds=int(header.group(1))), "delay", moment)
    return None


def _accept(when: datetime, evidence: str, moment: datetime) -> UsageLimitHit | None:
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    if when < moment:
        when = moment
    if when - moment > MAX_USAGE_LIMIT_WAIT:
        return None
    return UsageLimitHit(when, evidence)


def _from_epoch(value: int) -> datetime:
    seconds = value / 1000 if value >= 10**12 else value
    return datetime.fromtimestamp(seconds, UTC)


def _parse_instant(raw: str) -> datetime | None:
    text = raw.strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _seconds(amount: int, unit: str) -> int | None:
    scale = _UNIT_SECONDS.get(unit.lower())
    if scale is None:
        return None
    return amount * scale
