"""JSON routes whose paths, status codes, and required fields follow the TypeScript contract.

`GET /runs` is a JSON array (workflow definitions omitted unless `full=1`).
`POST /runs` answers 201 with the stored record. Cancel of a settled run is
200 `{cancelled: false}`. Finish of anything other than `review` is
409 `{error: "no open session"}`. The live `text/event-stream` on
`GET /runs/:id/events` is not this route: it returns the stored events as JSON.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Route, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError
from stario.json import JsonValue
from stario.json import dumps as json_dumps

from app.config import RUNNERS, Config
from app.engine.catalog import load_workflows
from app.engine.engine import Engine
from app.engine.model import Project, Run, Workflow
from app.engine.workflows import parse_workflow
from app.features.api.records import public_project, public_run
from app.features.api.urls import API_PROJECTS
from app.integrations.clients import github_issues, jira_issue, linear_issue
from app.secrets.store import SecretsError, SecretStore
from app.store.db import (
    get_project,
    get_run,
    get_settings,
    list_events_since,
    list_projects,
    list_runs,
)

_XOR = 'provide either "workflow" or "steps", not both'
_TASK = "describe the task or attach a file"
_OPEN = "no open session"


class ApiPage:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config

    def register(self, app: App) -> None:
        specs = (
            ("GET", "/runs", self.runs),
            ("POST", "/runs", self.create),
            ("GET", "/runs/{run_id}", self.run),
            ("GET", "/runs/{run_id}/events", self.events),
            ("POST", "/runs/{run_id}/cancel", self.cancel),
            ("POST", "/runs/{run_id}/finish", self.finish),
            ("POST", "/runs/{run_id}/archive", self.archive),
            ("POST", "/runs/{run_id}/pin", self.pin),
            ("DELETE", "/runs/{run_id}", self.delete),
            ("POST", "/runs/{run_id}/messages", self.message),
            ("PATCH", "/runs/{run_id}/queued-messages/{msg_id}", self.edit_queued),
            ("DELETE", "/runs/{run_id}/queued-messages/{msg_id}", self.remove_queued),
            ("DELETE", "/runs/{run_id}/auto-resume", self.cancel_auto_resume),
            ("GET", "/workflows", self.workflows),
        )
        for method, path, handler in specs:
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)
        app.add(API_PROJECTS, self.projects)
        app.add(Route("GET /api/v1/github/issues"), self.github_issues)
        app.add(Route("GET /api/v1/jira/issue/{key}"), self.jira_issue)
        app.add(Route("POST /api/v1/linear/issue"), self.linear_issue)
        app.add(Route("GET /api/v1/secrets"), self.secrets)
        app.add(Route("PUT /api/v1/secrets/{name}"), self.put_secret)
        app.add(Route("DELETE /api/v1/secrets/{name}"), self.delete_secret)
        app.add(Route("GET /api/v1/workspace/secrets"), self.workspace_secrets)
        app.add(Route("PUT /api/v1/workspace/secrets/{name}"), self.put_workspace_secret)
        app.add(Route("DELETE /api/v1/workspace/secrets/{name}"), self.delete_workspace_secret)

    async def runs(self, c: Context, w: Writer) -> None:
        project = self._bound(c, w)
        if project is None:
            return
        full = c.req.query.get("full") == "1"
        rows = list_runs(self.db, project.id, None)
        w.json(cast(JsonValue, [public_run(run, full=full) for run in rows]))

    async def create(self, c: Context, w: Writer) -> None:
        project = self._bound(c, w)
        if project is None:
            return
        body = await _body(c, w)
        if body is None:
            return
        workflow, workflow_name, task, runner, model, autonomous, reason, status = _create_input(
            body, get_settings(self.db).default_runner
        )
        if reason:
            w.json({"error": reason}, status=status)
            return
        run, plan_reason = self.engine.plan_run(
            project=project,
            task=task,
            workflow_name=workflow_name,
            runner=runner,
            model=model,
            autonomous=autonomous,
            workflow=workflow,
        )
        if run is None:
            missing = plan_reason is not None and plan_reason.startswith("unknown workflow:")
            w.json({"error": plan_reason or "invalid task"}, status=404 if missing else 400)
            return
        images = _images(body.get("images"))
        if isinstance(images, str):
            w.json({"error": images}, status=400)
            return
        if images:
            run.images = images
        account_error = _account(self.config, body.get("accountId"), runner, run)
        if account_error:
            w.json({"error": account_error}, status=400)
            return
        count = body.get("variants", 1)
        if isinstance(count, int) and not isinstance(count, bool) and count > 1:
            group = run.id
            made = [run]
            run.group_id = group
            run.variant = "A"
            for letter in "BC"[: count - 1]:
                sibling, sibling_reason = self.engine.plan_run(
                    project=project,
                    task=task,
                    workflow_name=workflow_name,
                    runner=runner,
                    model=model,
                    autonomous=autonomous,
                    workflow=workflow,
                )
                if sibling is None:
                    w.json({"error": sibling_reason or "invalid task"}, status=400)
                    return
                sibling.group_id = group
                sibling.variant = letter
                sibling.account_id = run.account_id
                if images:
                    sibling.images = images
                made.append(sibling)
            w.json(
                cast(JsonValue, {"runs": [public_run(item, full=True) for item in made]}),
                status=201,
            )
            for item in made:
                await self.engine.enqueue(item)
            return
        w.json(cast(JsonValue, public_run(run, full=True)), status=201)
        await self.engine.enqueue(run)

    async def run(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        w.json(cast(JsonValue, public_run(run, full=True)))

    async def events(self, c: Context, w: Writer) -> None:
        """SSE replay then live tail. Dotted types ride `ui-event`; the rest ride `run-event`."""
        run = self._existing(c, w)
        if run is None:
            return
        after = _after_seq(c)
        sse = SSE(w)
        sse.open()
        pending: list[dict[str, object]] = []

        def on_event(payload: dict[str, object]) -> None:
            pending.append(payload)

        off = self.engine.subscribe_events(run.id, on_event)
        seen = after
        try:
            for event in list_events_since(self.db, run.id, after):
                if event.seq <= seen:
                    continue
                seen = event.seq
                _write_sse(
                    w,
                    _event_name(event.type),
                    {
                        "seq": event.seq,
                        "type": event.type,
                        "text": event.text,
                        "stepId": event.step_id,
                        "at": event.at,
                        "runId": event.run_id,
                    },
                    str(event.seq),
                )
            _write_sse(w, "run", public_run(run, full=True), "")
            ping_at = time.monotonic() + 15
            while not c.disconnected:
                while pending:
                    payload = pending.pop(0)
                    seq = payload.get("seq")
                    number = seq if isinstance(seq, int) else 0
                    if number and number <= seen:
                        continue
                    if number:
                        seen = number
                    kind = str(payload.get("type", ""))
                    _write_sse(w, _event_name(kind), payload, str(number) if number else "")
                if time.monotonic() >= ping_at:
                    sse.ping()
                    ping_at = time.monotonic() + 15
                await asyncio.sleep(0.05)
        finally:
            off()

    async def cancel(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        if run.status not in ("queued", "running", "waiting", "review"):
            w.json({"cancelled": False})
            return
        reason = await self.engine.cancel(run.id)
        if reason:
            w.json({"error": reason}, status=409)
            return
        w.json({"cancelled": True})

    async def finish(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        reason = await self.engine.finish(run.id)
        if reason:
            w.json({"error": _OPEN if reason != "not found" else reason}, status=409)
            return
        w.json({"finished": True})

    async def delete(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        reason = await self.engine.delete(run.id)
        if reason:
            w.json({"error": reason}, status=409)
            return
        w.json({"deleted": True})

    async def message(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        body = await _body(c, w)
        if body is None:
            return
        text = body.get("text", "")
        if not isinstance(text, str):
            w.json({"error": "message needs text or at least one attachment"}, status=400)
            return
        if run.status == "running" and isinstance(text, str) and text.strip():
            if self.engine.defer_message(run.id, text):
                w.json({"deferred": True})
                return
        if not text.strip() and not body.get("images"):
            w.json({"error": "message needs text or at least one attachment"}, status=400)
            return
        if run.status == "queued":
            message, reason = await self.engine.queue_message(run.id, text.strip())
            if reason == "not found":
                w.json({"error": reason}, status=404)
                return
            if reason or message is None:
                w.json({"error": reason or "run already started"}, status=409)
                return
            w.json(cast(JsonValue, {"queued": True, "message": message}))
            return
        reason = await self.engine.deliver(run.id, text)
        if reason == "message is empty":
            w.json({"error": "message needs text or at least one attachment"}, status=400)
            return
        if reason:
            w.json({"error": reason}, status=409)
            return
        w.json({"delivered": True})

    async def archive(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        body = await _optional_body(c)
        archived = True if body is None else body.get("archived") is not False
        reason = await self.engine.set_archived(run.id, archived)
        if reason:
            w.json({"error": reason}, status=404)
            return
        updated = get_run(self.db, run.id)
        w.json(cast(JsonValue, public_run(updated or run, full=True)))

    async def pin(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        body = await _optional_body(c)
        pinned = True if body is None else body.get("pinned") is not False
        reason = await self.engine.set_pinned(run.id, pinned)
        if reason:
            w.json({"error": reason}, status=404)
            return
        updated = get_run(self.db, run.id)
        w.json(cast(JsonValue, public_run(updated or run, full=True)))

    async def edit_queued(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        body = await _body(c, w)
        if body is None:
            return
        text = body.get("text", "")
        if not isinstance(text, str):
            w.json({"error": "message needs text"}, status=400)
            return
        message, reason = await self.engine.edit_queued_message(
            run.id, c.match.params.get("msg_id", ""), text
        )
        if reason == "not found":
            w.json({"error": reason}, status=404)
            return
        if reason or message is None:
            w.json({"error": reason or "run already started"}, status=409)
            return
        w.json(cast(JsonValue, {"message": message}))

    async def remove_queued(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        reason = await self.engine.remove_queued_message(run.id, c.match.params.get("msg_id", ""))
        if reason == "not found":
            w.json({"error": reason}, status=404)
            return
        if reason:
            w.json({"error": reason}, status=409)
            return
        w.json({"removed": True})

    async def cancel_auto_resume(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        reason = await self.engine.clear_auto_resume(run.id)
        if reason:
            w.json({"error": reason}, status=404)
            return
        w.json({"cancelled": True})

    async def workflows(self, c: Context, w: Writer) -> None:
        project = self._bound(c, w)
        if project is None:
            return
        workflows, issues = load_workflows(Path(project.root))
        w.json(
            cast(
                JsonValue,
                {
                    "workflows": [item.to_json() for item in workflows],
                    "issues": [{"path": issue.path, "message": issue.message} for issue in issues],
                },
            )
        )

    async def secrets(self, c: Context, w: Writer) -> None:
        await self._list_secrets(w, workspace=False)

    async def workspace_secrets(self, c: Context, w: Writer) -> None:
        await self._list_secrets(w, workspace=True)

    async def put_secret(self, c: Context, w: Writer) -> None:
        await self._put_secret(c, w, workspace=False)

    async def put_workspace_secret(self, c: Context, w: Writer) -> None:
        await self._put_secret(c, w, workspace=True)

    async def delete_secret(self, c: Context, w: Writer) -> None:
        await self._delete_secret(c, w, workspace=False)

    async def delete_workspace_secret(self, c: Context, w: Writer) -> None:
        await self._delete_secret(c, w, workspace=True)

    async def _list_secrets(self, w: Writer, *, workspace: bool) -> None:
        scope, root = self._secret_scope(workspace)
        if scope is None:
            w.json({"error": "not found"}, status=404)
            return
        rows, skipped = self._secret_store().list(scope, root=root)
        body: dict[str, object] = {
            "secrets": [
                {"name": row.name, "audiences": list(row.audiences), "updatedAt": row.updated_at}
                for row in rows
            ],
            "keyBackend": self._secret_store().key_backend(),
        }
        if skipped:
            body["skipped"] = skipped
        w.json(cast(JsonValue, body))

    async def _put_secret(self, c: Context, w: Writer, *, workspace: bool) -> None:
        scope, root = self._secret_scope(workspace)
        if scope is None:
            w.json({"error": "not found"}, status=404)
            return
        body = await _body(c, w)
        if body is None:
            return
        value = body.get("value", "")
        if not isinstance(value, str):
            w.json({"error": "a value is one line, without NUL"}, status=400)
            return
        audiences = body.get("audiences", ["checks"])
        if not isinstance(audiences, list) or not all(isinstance(item, str) for item in audiences):
            w.json({"error": "a secret names at least one audience (checks, cezar)"}, status=400)
            return
        try:
            self._secret_store().set(
                scope,
                c.match.params.get("name", ""),
                value,
                root=root,
                audiences=tuple(item for item in audiences if isinstance(item, str)),
            )
        except SecretsError as exc:
            w.json({"error": str(exc)}, status=400)
            return
        w.json({"stored": True})

    async def _delete_secret(self, c: Context, w: Writer, *, workspace: bool) -> None:
        scope, root = self._secret_scope(workspace)
        if scope is None:
            w.json({"error": "not found"}, status=404)
            return
        removed = self._secret_store().unset(scope, c.match.params.get("name", ""), root=root)
        if not removed:
            w.json({"error": "not found"}, status=404)
            return
        w.json({"deleted": True})

    def _secret_store(self) -> SecretStore:
        return SecretStore(self.config.data_dir / "secrets")

    def _secret_scope(self, workspace: bool) -> tuple[str | None, str]:
        if workspace:
            return "workspace", ""
        from app.store.db import get_project

        project = get_project(self.db, self.engine.boot_project_id)
        if project is None:
            return None, ""
        return project.id, project.root

    async def github_issues(self, c: Context, w: Writer) -> None:
        owner = c.req.query.get("owner", "")
        repo = c.req.query.get("repo", "")
        w.json(cast(JsonValue, github_issues(self.config, owner, repo)))

    async def jira_issue(self, c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, jira_issue(self.config, c.match.params.get("key", ""))))

    async def linear_issue(self, c: Context, w: Writer) -> None:
        body = await _optional_body(c) or {}
        issue_id = body.get("id", "")
        ident = issue_id if isinstance(issue_id, str) else ""
        w.json(cast(JsonValue, linear_issue(self.config, ident)))

    async def projects(self, c: Context, w: Writer) -> None:
        w.json(
            cast(
                JsonValue,
                {
                    "projects": [
                        public_project(project.id, project.name, project.root, project.created_at)
                        for project in list_projects(self.db)
                    ],
                    "bootProject": self.engine.boot_project_id,
                    "projectsDir": str(self.config.data_dir),
                },
            )
        )

    def _bound(self, c: Context, w: Writer) -> Project | None:
        raw = c.match.params.get("project_id", "")
        project_id = self.engine.boot_project_id if raw in ("", "default") else raw
        project = get_project(self.db, project_id)
        if project is None:
            w.json({"error": "not found"}, status=404)
            return None
        return project

    def _existing(self, c: Context, w: Writer) -> Run | None:
        if self._bound(c, w) is None:
            return None
        run_id = c.match.params.get("run_id", "")
        if not _ok_id(run_id):
            w.json({"error": "not found"}, status=404)
            return None
        run = get_run(self.db, run_id)
        if run is None:
            w.json({"error": "not found"}, status=404)
            return None
        return run


def _account(config: Config, raw: object, runner: str, run: Run) -> str | None:
    if raw in (None, ""):
        return None
    if not isinstance(raw, str):
        return "unknown account"
    from app.integrations.accounts import profile_home_for

    home = profile_home_for(config, raw, runner)
    if home is None:
        return "unknown account"
    run.account_id = raw
    return None


def _create_input(
    body: dict[str, object], default_runner: str
) -> tuple[Workflow | None, str, str, str, str, bool, str, int]:
    workflow_name = body.get("workflow")
    steps = body.get("steps")
    has_workflow = isinstance(workflow_name, str) and bool(workflow_name.strip())
    has_steps = isinstance(steps, list) and len(steps) > 0
    if isinstance(workflow_name, str) and not workflow_name.strip() and not has_steps:
        has_workflow = False
    if (workflow_name is not None and not isinstance(workflow_name, str)) or (
        steps is not None and not isinstance(steps, list)
    ):
        return None, "", "", "", "", False, _XOR, 400
    if has_workflow == has_steps:
        return None, "", "", "", "", False, _XOR, 400
    if isinstance(steps, list) and len(steps) > 8:
        return None, "", "", "", "", False, "steps must be at most 8", 400
    task = body.get("task", "")
    if not isinstance(task, str) or len(task) > 100_000:
        return None, "", "", "", "", False, "must be at most 100000 characters", 400
    has_images = isinstance(body.get("images"), list) and bool(body.get("images"))
    if not task.strip() and not has_images:
        return None, "", "", "", "", False, _TASK, 400
    if not task.strip():
        task = "(see attachments)"
    profile = body.get("agentProfile")
    if profile is not None:
        if not isinstance(profile, str) or not profile.strip():
            return None, "", "", "", "", False, "unknown agent account", 400
        if profile != "default":
            return None, "", "", "", "", False, f'unknown agent account "{profile}"', 400
    variants = body.get("variants", 1)
    if variants is None:
        variants = 1
    if not isinstance(variants, int) or isinstance(variants, bool) or not 1 <= variants <= 3:
        return None, "", "", "", "", False, "variants must be 1, 2, or 3", 400
    runner = body.get("runner", default_runner)
    if runner is None or runner == "":
        runner = default_runner
    if not isinstance(runner, str) or runner not in RUNNERS:
        return None, "", "", "", "", False, "unknown runner", 400
    model = body.get("model", "")
    if model is None:
        model = ""
    if not isinstance(model, str):
        return None, "", "", "", "", False, "model must be a string", 400
    autonomous = body.get("autonomous") is True
    if has_steps:
        parsed, issue = parse_workflow({"name": "(planned)", "steps": steps}, source="built-in")
        if issue or parsed is None:
            return None, "", "", "", "", False, issue or "invalid step", 400
        return parsed, parsed.name, task, runner, model, autonomous, "", 200
    assert isinstance(workflow_name, str)
    return None, workflow_name.strip(), task, runner, model, autonomous, "", 200


async def _body(c: Context, w: Writer) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        w.json({"error": "invalid json"}, status=400)
        return None
    if not isinstance(loaded, dict):
        w.json({"error": "invalid json"}, status=400)
        return None
    return cast(dict[str, object], loaded)


def _ok_id(value: str) -> bool:
    return len(value) == 32 and all(ch in "0123456789abcdef" for ch in value)


def _event_name(kind: str) -> str:
    return "ui-event" if "." in kind else "run-event"


def _after_seq(c: Context) -> int:
    found: list[int] = []
    for raw in (c.req.query.get("afterSeq", ""), c.req.headers.get("last-event-id") or ""):
        try:
            number = int(raw)
        except ValueError:
            continue
        if number >= 0:
            found.append(number)
    return max(found) if found else 0


def _write_sse(w: Writer, event: str, data: object, event_id: str) -> None:
    raw = json_dumps(cast(JsonValue, data))
    lines: list[str] = []
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event}")
    lines.extend(f"data: {line}" for line in raw.split("\n"))
    w.write(("\n".join(lines) + "\n\n").encode())


async def _optional_body(c: Context) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        return None
    if isinstance(loaded, dict):
        return cast(dict[str, object], loaded)
    return None


def _images(raw: object) -> list[dict[str, object]] | str | None:
    if raw in (None, []):
        return None
    if not isinstance(raw, list):
        return "images must be a list"
    if len(raw) > 8:
        return "too many attachments"
    out: list[dict[str, object]] = []
    for item in raw:
        if not isinstance(item, dict):
            return "invalid attachment"
        upload_id = item.get("uploadId")
        if isinstance(upload_id, str) and upload_id:
            name = item.get("name")
            entry: dict[str, object] = {"uploadId": upload_id}
            if isinstance(name, str) and name:
                entry["name"] = name
            out.append(entry)
            continue
        data = item.get("data")
        if not isinstance(data, str) or not data:
            return "attachment needs data"
        if len(data) > 200_000:
            return "attachment is too large"
        media = item.get("mediaType") or item.get("media_type") or "image/png"
        if not isinstance(media, str):
            return "invalid attachment"
        out.append({"mediaType": media, "data": data})
    return out or None
