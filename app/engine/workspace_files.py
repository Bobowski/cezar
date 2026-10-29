"""File-backed workspace documents that are not the run database.

Profiles, branding, drafts, layouts, prompt templates, and the start-app
command live as JSON under the data directory. Branding here does not rewrite
the cockpit theme.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import cast

from stario.json import JsonValue
from stario.json import dumps as json_dumps
from stario.json import loads as json_loads

_ACCENTS = frozenset({"lime", "violet"})


def read_json(path: Path, default: JsonValue) -> JsonValue:
    try:
        loaded = json_loads(path.read_text(encoding="utf-8"))
    except OSError, ValueError, TypeError:
        return default
    return cast(JsonValue, loaded)


def write_json(path: Path, body: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json_dumps(cast(JsonValue, body)), encoding="utf-8")


def profiles(path: Path) -> list[dict[str, str]]:
    loaded = read_json(path, [])
    if not isinstance(loaded, list):
        return []
    rows: list[dict[str, str]] = []
    for item in loaded:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        runner = item.get("runner")
        ident = item.get("id")
        if isinstance(name, str) and isinstance(runner, str) and isinstance(ident, str):
            rows.append({"id": ident, "name": name, "runner": runner})
    return rows


def add_profile(path: Path, name: str, runner: str) -> dict[str, str]:
    rows = profiles(path)
    row = {"id": uuid.uuid4().hex, "name": name, "runner": runner}
    rows.append(row)
    write_json(path, cast(JsonValue, rows))
    return row


def branding(path: Path) -> dict[str, str]:
    loaded = read_json(path, {"name": "cezar", "accent": "lime"})
    if not isinstance(loaded, dict):
        return {"name": "cezar", "accent": "lime"}
    name = loaded.get("name")
    accent = loaded.get("accent")
    return {
        "name": name if isinstance(name, str) and name else "cezar",
        "accent": accent if isinstance(accent, str) and accent in _ACCENTS else "lime",
    }


def write_branding(path: Path, name: str, accent: str) -> dict[str, str]:
    body = {"name": name, "accent": accent if accent in _ACCENTS else "lime"}
    write_json(path, body)
    return body


def drafts(path: Path) -> list[dict[str, str]]:
    loaded = read_json(path, [])
    if not isinstance(loaded, list):
        return []
    rows: list[dict[str, str]] = []
    for item in loaded:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            rows.append(
                {
                    "id": str(item.get("id")),
                    "text": str(item.get("text", "")),
                    "createdAt": str(item.get("createdAt", "")),
                }
            )
    return rows


def add_draft(path: Path, text: str, created_at: str) -> dict[str, str]:
    rows = drafts(path)
    row = {"id": uuid.uuid4().hex, "text": text, "createdAt": created_at}
    rows.append(row)
    write_json(path, cast(JsonValue, rows))
    return row


def layouts(path: Path) -> dict[str, JsonValue]:
    loaded = read_json(path, {})
    if not isinstance(loaded, dict):
        return {}
    return cast(dict[str, JsonValue], loaded)


def write_layouts(path: Path, body: dict[str, JsonValue]) -> dict[str, JsonValue] | str:
    if len(body) > 50:
        return "layouts are capped at 50 keys"
    write_json(path, body)
    return body


def templates(path: Path) -> list[dict[str, str]]:
    loaded = read_json(path, [])
    if not isinstance(loaded, list):
        return []
    rows: list[dict[str, str]] = []
    for item in loaded:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            rows.append(
                {
                    "id": str(item["id"]),
                    "name": str(item.get("name", "")),
                    "text": str(item.get("text", "")),
                }
            )
    return rows


def write_templates(path: Path, rows: list[dict[str, str]]) -> None:
    write_json(path, cast(JsonValue, rows))


def start_app(path: Path, cwd: str) -> dict[str, str]:
    loaded = read_json(path, {"command": "", "cwd": cwd})
    if not isinstance(loaded, dict):
        return {"command": "", "cwd": cwd}
    command = loaded.get("command")
    stored_cwd = loaded.get("cwd")
    return {
        "command": command if isinstance(command, str) else "",
        "cwd": stored_cwd if isinstance(stored_cwd, str) and stored_cwd else cwd,
    }


def write_start_app(path: Path, command: str, cwd: str) -> dict[str, str]:
    body = {"command": command, "cwd": cwd}
    write_json(path, body)
    return body
