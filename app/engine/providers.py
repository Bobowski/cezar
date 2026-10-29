"""Which agent CLIs are on PATH, and the model ids the cockpit can name.

Connect spawns that CLI's login command. A dry run returns the command and
does not spawn it. Enabled is the workspace disabled-provider list.
"""

from __future__ import annotations

import shutil
import subprocess
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


Runner = Callable[[list[str]], tuple[int, str]]

_LOGIN: dict[str, tuple[str, ...]] = {
    "claude": ("auth", "login"),
    "codex": ("login",),
    "opencode": ("auth", "login"),
    "cursor": ("login",),
    "pi": ("/login",),
    "junie": (),
    "copilot": ("login",),
}
_STATUS: dict[str, tuple[str, ...]] = {
    "claude": ("auth", "status"),
    "codex": ("login", "status"),
    "opencode": ("auth", "list"),
    "cursor": ("status",),
    "pi": ("--list-models",),
    "copilot": ("--version",),
}
_UPDATE: dict[str, tuple[str, ...]] = {
    "claude": ("update",),
    "opencode": ("upgrade",),
    "cursor": ("update",),
}


def command_runner(args: list[str]) -> tuple[int, str]:
    try:
        result = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)
    return result.returncode, (result.stdout or result.stderr).strip()


def provider_status(bins: dict[str, str], store: Path | None = None) -> dict[str, object]:
    off = _disabled(store) if store is not None else set()
    providers = []
    for name, binary in bins.items():
        found = shutil.which(binary) is not None
        providers.append(
            {
                "provider": name,
                "installed": found,
                "enabled": name not in off,
                "binary": binary,
            }
        )
    return {"providers": providers}


def connect_provider(
    name: str,
    bins: dict[str, str],
    *,
    dry_run: bool,
    runner: Runner | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    return _spawn(name, bins, _LOGIN, dry_run=dry_run, runner=runner, verb="opened")


def retry_provider(
    name: str,
    bins: dict[str, str],
    *,
    dry_run: bool,
    runner: Runner | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    return _spawn(name, bins, _STATUS, dry_run=dry_run, runner=runner, verb="retried")


def update_provider(
    name: str,
    bins: dict[str, str],
    *,
    dry_run: bool,
    runner: Runner | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    if name not in _UPDATE:
        return None, "this provider has no update command"
    return _spawn(name, bins, _UPDATE, dry_run=dry_run, runner=runner, verb="updated")


def set_provider_enabled(
    store: Path, name: str, bins: dict[str, str], enabled: bool
) -> tuple[dict[str, object] | None, str | None]:
    if name not in bins:
        return None, "unknown provider"
    off = _disabled(store)
    if enabled:
        off.discard(name)
    else:
        off.add(name)
    store.parent.mkdir(parents=True, exist_ok=True)
    store.write_text(json_dumps(cast(JsonValue, sorted(off))), encoding="utf-8")
    return {"provider": name, "enabled": enabled}, None


def _spawn(
    name: str,
    bins: dict[str, str],
    table: dict[str, tuple[str, ...]],
    *,
    dry_run: bool,
    runner: Runner | None,
    verb: str,
) -> tuple[dict[str, object] | None, str | None]:
    if name not in bins or name not in table:
        return None, "unknown provider"
    argv = [bins[name], *table[name]]
    command = " ".join(argv)
    if dry_run:
        return {"dryRun": True, verb: False, "command": command}, None
    actor = runner or command_runner
    if runner is None and shutil.which(argv[0]) is None:
        return None, f"`{argv[0]}` not found on PATH"
    code, text = actor(argv)
    return {verb: code == 0, "command": command, "exitCode": code, "output": text[:500]}, None


def _disabled(store: Path) -> set[str]:
    try:
        loaded = json_loads(store.read_text(encoding="utf-8"))
    except OSError, ValueError, TypeError:
        return set()
    if not isinstance(loaded, list):
        return set()
    return {item for item in loaded if isinstance(item, str)}


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
