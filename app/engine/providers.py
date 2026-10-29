"""Which agent CLIs are on PATH, and the model ids the cockpit can name.

This is not the TypeScript catalog probe: that spawns each CLI. A missing
binary is `{available: false}`. A present binary lists the ids this port knows
how to pass as `--model`, not whatever the CLI would print today.

Connect, retry, and enabled are a local marker. A dry run does not spawn the
binary. There is no network login.
"""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path
from typing import cast

from stario.json import JsonValue
from stario.json import dumps as json_dumps
from stario.json import loads as json_loads

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


Probe = Callable[[list[str]], tuple[int, str]]


def provider_status(bins: dict[str, str], store: Path | None = None) -> dict[str, object]:
    saved = _read(store) if store is not None else {}
    providers = []
    for name, binary in bins.items():
        found = shutil.which(binary) is not None
        row = saved.get(name, {})
        enabled = row["enabled"] if isinstance(row.get("enabled"), bool) else found
        version = row.get("version") if isinstance(row.get("version"), str) else ""
        providers.append(
            {
                "provider": name,
                "installed": found,
                "enabled": enabled,
                "binary": binary,
                "connected": row.get("connected") is True,
                "version": version,
            }
        )
    return {"providers": providers}


def connect_provider(
    store: Path,
    name: str,
    bins: dict[str, str],
    *,
    dry_run: bool,
    probe: Probe | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    if name not in bins:
        return None, "unknown provider"
    binary = bins[name]
    if dry_run:
        return _remember(store, name, connected=True, enabled=True, version="dry-run"), None
    if shutil.which(binary) is None:
        return None, f"`{binary}` not found on PATH"
    version = ""
    if probe is not None:
        code, text = probe([binary, "--version"])
        if code != 0:
            return None, text or f"`{binary} --version` failed"
        version = text.splitlines()[0].strip() if text else ""
    return _remember(store, name, connected=True, enabled=True, version=version), None


def set_provider_enabled(
    store: Path, name: str, bins: dict[str, str], enabled: bool
) -> tuple[dict[str, object] | None, str | None]:
    if name not in bins:
        return None, "unknown provider"
    current = _read(store).get(name, {})
    connected = current.get("connected") is True
    raw_version = current.get("version")
    version = raw_version if isinstance(raw_version, str) else ""
    return _remember(store, name, connected=connected, enabled=enabled, version=version), None


def _remember(
    store: Path, name: str, *, connected: bool, enabled: bool, version: str
) -> dict[str, object]:
    saved = _read(store)
    row: dict[str, object] = {"connected": connected, "enabled": enabled, "version": version}
    saved[name] = row
    store.parent.mkdir(parents=True, exist_ok=True)
    store.write_text(json_dumps(cast(JsonValue, saved)), encoding="utf-8")
    return row


def _read(store: Path) -> dict[str, dict[str, object]]:
    try:
        loaded = json_loads(store.read_text(encoding="utf-8"))
    except OSError, ValueError, TypeError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    out: dict[str, dict[str, object]] = {}
    for key, value in loaded.items():
        if isinstance(key, str) and isinstance(value, dict):
            out[key] = cast(dict[str, object], value)
    return out


def model_catalog(runner: str, bins: dict[str, str]) -> dict[str, object]:
    if runner not in DISCOVERY and runner not in MODELS:
        return {
            "available": False,
            "reason": "runner must be claude, codex, opencode, cursor, or junie",
        }
    binary = bins.get(runner, runner)
    if shutil.which(binary) is None:
        return {"available": False, "reason": f"`{binary}` not found on PATH"}
    return {"available": True, "runner": runner, "models": list(MODELS.get(runner, ()))}
