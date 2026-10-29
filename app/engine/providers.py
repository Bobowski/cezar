"""Which agent CLIs are on PATH, and the model ids the cockpit can name.

A missing binary is `{available: false}`. A present binary is probed the way
`packages/cezar/src/core/*-model-catalog.ts` probes it: Claude answers a
`list_models` control request, Cursor prints `agent models`. A probe that
fails falls back to the static ids. Login is `auth status` JSON.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path

MODELS: dict[str, tuple[str, ...]] = {
    "claude": ("claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"),
    "codex": ("gpt-5.1-codex",),
    "opencode": ("opencode",),
    "cursor": ("auto",),
    "junie": ("junie",),
    "pi": ("pi",),
    "copilot": ("gpt-4.1",),
}

DISCOVERY = frozenset({"claude", "codex", "opencode", "cursor", "junie"})


def provider_status(bins: dict[str, str]) -> dict[str, object]:
    providers = []
    for name, binary in bins.items():
        found = shutil.which(binary) is not None
        providers.append({"provider": name, "installed": found, "enabled": found, "binary": binary})
    return {"providers": providers}


_CLAUDE_PROBE = (
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--no-session-persistence",
)
_REQUEST_ID = "cez-list-models-1"


def model_catalog(
    runner: str,
    bins: dict[str, str],
    *,
    cwd: str = ".",
    env: Mapping[str, str] | None = None,
) -> dict[str, object]:
    if runner not in DISCOVERY and runner not in MODELS:
        return {
            "available": False,
            "reason": "runner must be claude, codex, opencode, cursor, or junie",
        }
    binary = bins.get(runner, runner)
    resolved = shutil.which(binary)
    if resolved is None and Path(binary).is_file():
        resolved = binary
    if resolved is None:
        return {"available": False, "reason": f"`{binary}` not found on PATH"}
    probed = _probe(runner, resolved, cwd=cwd, env=env)
    login = login_status(runner, resolved, env=env)
    if probed:
        return {
            "available": True,
            "runner": runner,
            "models": probed,
            "source": "live",
            "loggedIn": login["loggedIn"],
        }
    return {
        "available": True,
        "runner": runner,
        "models": list(MODELS.get(runner, ())),
        "source": "static",
        "loggedIn": login["loggedIn"],
    }


def login_status(
    runner: str, binary: str, *, env: Mapping[str, str] | None = None
) -> dict[str, object]:
    """`auth status` JSON. A CLI that does not answer is logged out."""
    try:
        proc = subprocess.run(
            [binary, "auth", "status"],
            cwd=".",
            env=None if env is None else dict(env),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return {"runner": runner, "loggedIn": False, "status": "unknown"}
    try:
        body = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"runner": runner, "loggedIn": False, "status": "unknown"}
    logged = isinstance(body, dict) and body.get("loggedIn") is True
    return {"runner": runner, "loggedIn": logged, "status": "logged-in" if logged else "logged-out"}


def parse_cursor_models(text: str) -> list[dict[str, str]]:
    models: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.lower() == "available models" or line.lower().startswith("tip:"):
            continue
        if " - " not in line:
            continue
        ident, label = line.split(" - ", 1)
        ident, label = ident.strip(), label.strip()
        if not ident or ident == "auto" or ident in seen:
            continue
        seen.add(ident)
        models.append({"id": ident, "label": label or ident, "description": ""})
        if len(models) >= 500:
            break
    return models


def parse_claude_catalog(message: object) -> list[dict[str, str]] | None:
    if not isinstance(message, dict) or message.get("type") != "control_response":
        return None
    response = message.get("response")
    if not isinstance(response, dict) or response.get("subtype") != "success":
        return None
    if response.get("request_id") not in (None, _REQUEST_ID):
        return None
    payload = response.get("response")
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        return None
    models: list[dict[str, str]] = []
    for item in payload["models"]:
        if not isinstance(item, dict) or not isinstance(item.get("value"), str):
            continue
        if item["value"] == "default":
            continue
        label = item.get("displayName")
        description = item.get("description")
        models.append(
            {
                "id": item["value"],
                "label": label if isinstance(label, str) else item["value"],
                "description": description if isinstance(description, str) else "",
            }
        )
    return models


def _probe(
    runner: str, binary: str, *, cwd: str, env: Mapping[str, str] | None
) -> list[dict[str, str]]:
    child_env = None if env is None else dict(env)
    try:
        if runner == "cursor":
            proc = subprocess.run(
                [binary, "models"],
                cwd=cwd,
                env=child_env,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            return parse_cursor_models(proc.stdout + "\n" + proc.stderr)
        if runner != "claude":
            return []
        proc = subprocess.run(
            [binary, *_CLAUDE_PROBE],
            cwd=cwd,
            env=child_env,
            input=json.dumps(
                {
                    "type": "control_request",
                    "request_id": _REQUEST_ID,
                    "request": {"subtype": "list_models"},
                }
            )
            + "\n",
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return []
    for line in proc.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed = parse_claude_catalog(message)
        if parsed:
            return parsed
    return []
