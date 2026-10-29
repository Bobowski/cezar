"""Shell commands that talk to a running cockpit, or to the local secret store.

`task`, `automation`, and `runs` need `CEZ_API_URL`. They do not guess a port.
`secrets` writes the same store as the HTTP API. `telemetry` does not send.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from stario.json import JsonValue
from stario.json import dumps as json_dumps

from app.config import RUNNERS
from app.secrets.store import SecretsError, SecretStore

Fetch = Callable[..., object]

_TASK_USAGE = """cez task — dispatch cezar tasks from inside a task

  cez task create "<objective>" [--title "…"] [--kind implement|review]
  cez task report --status done|partial|failed|blocked --result "…"
  cez task list
"""

_RUNS_USAGE = """cez runs — read the tasks of a running cockpit

  cez runs list [--status <status>[,<status>]] [--all] [--json]
"""

_AUTO_USAGE = """cez automation — create and manage schedule automations

  cez automation schema
  cez automation list
  cez automation create --json '<json>'
  cez automation cron --json '<json>'
  cez automation tracker --json '<json>'
  cez automation check <id>
"""


def run_task_command(
    args: list[str],
    env: dict[str, str],
    log: Callable[[str], None],
    error: Callable[[str], None],
    fetch: Fetch | None = None,
) -> int:
    command = args[0] if args else ""
    if command in ("", "help", "--help"):
        log(_TASK_USAGE.strip())
        return 0 if command else 2
    base = _scope(env)
    if base is None:
        error(_missing("cez task"))
        return 2
    try:
        if command == "create":
            return _task_create(args[1:], env, base, log, error, fetch or _fetch)
        if command == "report":
            return _task_report(args[1:], env, base, log, error, fetch or _fetch)
        if command in ("list", "tree"):
            return _task_list(args[1:], env, command, base, log, error, fetch or _fetch)
    except ValueError as exc:
        error(f"cez task: {exc}")
        return 1
    error(f'cez task: unknown command "{command}"')
    return 2


def run_runs_command(
    args: list[str],
    env: dict[str, str],
    log: Callable[[str], None],
    error: Callable[[str], None],
    fetch: Fetch | None = None,
) -> int:
    command = args[0] if args else ""
    if command in ("", "help", "--help"):
        log(_RUNS_USAGE.strip())
        return 0 if command else 2
    if command != "list":
        error(f'cez runs: unknown command "{command}"')
        return 2
    base = _scope(env)
    if base is None:
        error(_missing("cez runs"))
        return 2
    flags, _positionals = _split(args[1:])
    status, response = _call(fetch or _fetch, "GET", f"{base}/runs")
    if status != 200 or not isinstance(response, list):
        error(f"cez runs: could not list runs — {_error_text(response, status)}")
        return 1
    wanted = set(flags.get("status", "").split(",")) - {""} if "status" in flags else None
    rows = []
    for item in response:
        if not isinstance(item, dict):
            continue
        if wanted is not None and item.get("status") not in wanted:
            continue
        if "all" not in flags and item.get("archived") is True:
            continue
        rows.append(item)
    if "json" in flags:
        log(json_dumps(cast(JsonValue, rows)))
        return 0
    for item in rows:
        log(f"{item.get('id', '')}\t{item.get('status', '')}\t{item.get('title', '')}")
    return 0


def run_automation_command(
    args: list[str],
    env: dict[str, str],
    log: Callable[[str], None],
    error: Callable[[str], None],
    fetch: Fetch | None = None,
) -> int:
    command = args[0] if args else ""
    if command in ("", "help", "--help"):
        log(_AUTO_USAGE.strip())
        return 0 if command else 2
    if command == "schema":
        log(
            "schedule automation: name, task, everyMinutes, workflow, runner, enable, "
            "kind (schedule|github|tracker), events, filters. "
            "GET /automations includes stats total, enabled, runsLaunched."
        )
        return 0
    base = _scope(env)
    if base is None:
        error(_missing("cez automation"))
        return 2
    caller = fetch or _fetch
    if command == "list":
        status, response = _call(caller, "GET", f"{base}/automations")
        if status != 200 or not isinstance(response, dict):
            error(f"cez automation: {_error_text(response, status)}")
            return 1
        rows = response.get("automations")
        if isinstance(rows, list):
            for item in rows:
                if isinstance(item, dict):
                    log(f"{item.get('id', '')}\t{item.get('name', '')}")
        return 0
    if command in ("create", "cron", "tracker"):
        flags, _positionals = _split(args[1:])
        raw = flags.get("json")
        if not raw:
            error("cez automation: pass --json '<definition>'")
            return 1
        try:
            body = json.loads(raw)
        except json.JSONDecodeError as exc:
            error(f"cez automation: the definition is not valid JSON — {exc}")
            return 1
        if not isinstance(body, dict):
            error("cez automation: the definition must be an object")
            return 1
        if command == "cron":
            body.setdefault("kind", "schedule")
        if command == "tracker":
            body.setdefault("kind", "tracker")
        status, response = _call(caller, "POST", f"{base}/automations", body)
        if status not in (200, 201) or not isinstance(response, dict):
            error(f"cez automation: {_error_text(response, status)}")
            return 1
        log(str(response.get("id", "")))
        return 0
    if command == "check":
        flags, positionals = _split(args[1:])
        ident = flags.get("id") or (positionals[0] if positionals else "")
        if not ident:
            error("cez automation: check needs an id")
            return 1
        status, response = _call(
            caller, "POST", f"{base}/automations/{ident}/check", {"execute": "execute" in flags}
        )
        if status != 200 or not isinstance(response, dict):
            error(f"cez automation: {_error_text(response, status)}")
            return 1
        log(str(response.get("id", "")))
        return 0
    error(f'cez automation: unknown command "{command}"')
    return 2


def run_telemetry_command(
    args: list[str], log: Callable[[str], None], error: Callable[[str], None]
) -> int:
    command = args[0] if args else "status"
    if command in ("status", "help", "--help"):
        log("telemetry is intentionally not ported and does not send")
        return 0
    error("telemetry is intentionally not ported and does not send")
    return 1


async def run_secrets_command(
    args: list[str],
    *,
    read_value: Callable[[], str],
    log: Callable[[str], None],
    error: Callable[[str], None],
) -> int:
    flags, positionals = _split(args)
    if not positionals:
        error("Usage: cezar secrets list | set <NAME> | unset <NAME>   [--workspace]")
        return 1
    verb = positionals[0]
    name = positionals[1] if len(positionals) > 1 else ""
    if verb not in ("list", "set", "unset"):
        error("Usage: cezar secrets list | set <NAME> | unset <NAME>   [--workspace]")
        return 1
    from litewriter import ClaimBusy, LiteWriter
    from stario import Relay

    from app.config import Config
    from app.engine.engine import Engine
    from app.store.db import find_project_by_root, schema

    config = Config.from_env()
    try:
        async with LiteWriter(config.db_path, schema=schema, claim=30) as db:
            engine = Engine(db, Relay(), config)
            await engine.startup()
            if "workspace" in flags:
                scope, root = "workspace", ""
            else:
                project = find_project_by_root(db, str(config.repo_root))
                if project is None:
                    error("cezar secrets: this folder is not a registered cezar project")
                    return 1
                scope, root = project.id, project.root
            store = SecretStore(config.data_dir / "secrets")
            try:
                if verb == "list":
                    rows, skipped = store.list(scope, root=root)
                    for row in rows:
                        log(f"{row.name}\t{','.join(row.audiences)}")
                    if skipped:
                        error(f"cezar secrets: store skipped — {skipped}")
                    error("# encrypted with a data key in the data directory (no OS keychain)")
                    return 0
                if not name:
                    error("cezar secrets: a name is required")
                    return 1
                if verb == "set":
                    value = read_value()
                    if value == "":
                        error("cezar secrets: empty value — nothing saved")
                        return 1
                    store.set(scope, name, value, root=root)
                    log(name)
                    return 0
                if not store.unset(scope, name, root=root):
                    error(f"cezar secrets: no secret named {name}")
                    return 1
                log(name)
                return 0
            except SecretsError as exc:
                error(f"cezar secrets: {name} — {exc}" if name else f"cezar secrets: {exc}")
                return 1
    except ClaimBusy:
        error("the database is in use by a running cockpit")
        return 1


def _task_create(
    args: list[str],
    env: dict[str, str],
    base: str,
    log: Callable[[str], None],
    error: Callable[[str], None],
    fetch: Fetch,
) -> int:
    task_id = env.get("CEZ_TASK_ID", "")
    if not task_id:
        raise ValueError("CEZ_TASK_ID is not set — only a running task can dispatch")
    flags, positionals = _split(args)
    objective = " ".join(positionals).strip()
    if not objective:
        raise ValueError('an objective is required: cez task create "<objective>"')
    kind = flags.get("kind", "implement")
    if kind not in ("implement", "review"):
        raise ValueError("kind must be implement or review")
    runner = flags.get("runner")
    if runner and runner not in RUNNERS:
        raise ValueError(f"unknown runner {runner}")
    body: dict[str, object] = {"objective": objective, "kind": kind}
    if flags.get("title"):
        body["title"] = flags["title"]
    if runner:
        body["runner"] = runner
    status, response = _call(fetch, "POST", f"{base}/runs/{task_id}/dispatch", body)
    if status not in (200, 201) or not isinstance(response, dict):
        raise ValueError(f"dispatch refused — {_error_text(response, status)}")
    ident = str(response.get("id", ""))
    branch = response.get("branch")
    log(
        f"dispatched {ident}"
        + (f" on branch {branch}" if isinstance(branch, str) and branch else "")
    )
    return 0


def _task_report(
    args: list[str],
    env: dict[str, str],
    base: str,
    log: Callable[[str], None],
    error: Callable[[str], None],
    fetch: Fetch,
) -> int:
    task_id = env.get("CEZ_TASK_ID", "")
    if not task_id:
        raise ValueError("CEZ_TASK_ID is not set — only a running task can report")
    flags, _positionals = _split(args)
    status_name = flags.get("status", "")
    result = flags.get("result", "")
    if not status_name or not result:
        raise ValueError("--status and --result are required")
    body: dict[str, object] = {"status": status_name, "result": result}
    if flags.get("verdict"):
        body["verdict"] = flags["verdict"]
    code, response = _call(fetch, "POST", f"{base}/runs/{task_id}/report", body)
    if code not in (200, 201):
        raise ValueError(f"report refused — {_error_text(response, code)}")
    log(f"report recorded — status {status_name}")
    return 0


def _task_list(
    args: list[str],
    env: dict[str, str],
    command: str,
    base: str,
    log: Callable[[str], None],
    error: Callable[[str], None],
    fetch: Fetch,
) -> int:
    anchor = args[0] if command == "tree" and args else env.get("CEZ_TASK_ID", "")
    if not anchor:
        raise ValueError("a run id is required" if command == "tree" else "CEZ_TASK_ID is not set")
    status, response = _call(fetch, "GET", f"{base}/runs")
    if status != 200 or not isinstance(response, list):
        raise ValueError(f"could not list runs — {_error_text(response, status)}")
    runs = [item for item in response if isinstance(item, dict)]
    me = next((item for item in runs if str(item.get("id", "")).startswith(anchor)), None)
    if me is None:
        raise ValueError(f"no run {anchor}")
    dispatch = me.get("dispatch")
    root_id = dispatch.get("rootRunId") if isinstance(dispatch, dict) else me.get("id")
    children: dict[str, list[dict[str, object]]] = {}
    for item in runs:
        info = item.get("dispatch")
        if not isinstance(info, dict) or info.get("rootRunId") != root_id:
            continue
        parent = str(info.get("parentRunId", ""))
        children.setdefault(parent, []).append(item)

    def print_run(item: dict[str, object], depth: int) -> None:
        log(
            f"{'  ' * depth}{item.get('id', '')}\t{item.get('status', '')}\t{item.get('title', '')}"
        )
        for child in children.get(str(item.get("id", "")), []):
            print_run(child, depth + 1)

    root = next((item for item in runs if item.get("id") == root_id), None)
    if root is not None:
        print_run(root, 0)
    return 0


def _scope(env: dict[str, str]) -> str | None:
    url = env.get("CEZ_API_URL", "").rstrip("/")
    if not url:
        return None
    project = env.get("CEZ_PROJECT_ID", "")
    if project:
        return f"{url}/api/v1/p/{project}"
    return f"{url}/api/v1"


def _missing(command: str) -> str:
    return (
        f"{command} needs CEZ_API_URL pointing at a running cockpit. "
        "Inside a task the cockpit sets it. Do not guess an address."
    )


_BOOLEANS = frozenset({"workspace", "all", "enable"})


def _split(args: list[str]) -> tuple[dict[str, str], list[str]]:
    found: dict[str, str] = {}
    positionals: list[str] = []
    index = 0
    while index < len(args):
        item = args[index]
        if item.startswith("--"):
            name = item[2:]
            nxt = args[index + 1] if index + 1 < len(args) else ""
            if name in _BOOLEANS or not nxt or nxt.startswith("--"):
                found[name] = ""
                index += 1
                continue
            found[name] = nxt
            index += 2
            continue
        positionals.append(item)
        index += 1
    return found, positionals


def _call(fetch: Fetch, method: str, url: str, body: object | None = None) -> tuple[int, object]:
    result = fetch(url, method=method, body=body)
    if isinstance(result, tuple) and len(result) == 2:
        status, payload = result
        if isinstance(status, int):
            return status, payload
    raise ValueError("the cockpit did not answer")


def _error_text(payload: object, status: int) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
        return payload["error"]
    return str(status)


def _fetch(url: str, method: str = "GET", body: object | None = None) -> tuple[int, object]:
    data = None if body is None else json_dumps(cast(JsonValue, body)).encode()
    request = Request(url, data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json")
    try:
        with urlopen(request, timeout=10) as response:  # noqa: S310 — the operator named this cockpit
            raw = response.read().decode()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as exc:
        raw = exc.read().decode()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {}
        return exc.code, payload
    except URLError as exc:
        return 0, {"error": str(exc.reason)}
    except json.JSONDecodeError:
        return 0, {"error": "the cockpit did not return json"}
