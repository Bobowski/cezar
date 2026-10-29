"""JSON routes whose paths, status codes, and required fields follow the TypeScript contract.

`GET /runs` is a JSON array (workflow definitions omitted unless `full=1`).
`POST /runs` answers 201 with the stored record. Cancel of a settled run is
200 `{cancelled: false}`. Finish of anything other than `review` is
409 `{error: "no open session"}`. The live `text/event-stream` on
`GET /runs/:id/events` is not this route: it returns the stored events as JSON.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Route, Writer
from stario.datastar import read_signals
from stario.exceptions import RequestBodyError
from stario.json import JsonValue

from app.config import RUNNERS, Config
from app.engine.catalog import load_workflows
from app.engine.engine import Engine
from app.engine.model import Project, Run, Workflow
from app.engine.workflows import parse_workflow
from app.features.api.records import public_project, public_run
from app.features.api.urls import API_PROJECTS
from app.store.db import get_project, get_run, get_settings, list_events, list_projects, list_runs

_XOR = 'provide either "workflow" or "steps", not both'
_TASK = "describe the task or attach a file"
_VARIANTS = "parallel variants are not available in the Python port yet"
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
            ("DELETE", "/runs/{run_id}", self.delete),
            ("POST", "/runs/{run_id}/messages", self.message),
            ("DELETE", "/runs/{run_id}/auto-resume", self.cancel_auto_resume),
            ("GET", "/workflows", self.workflows),
        )
        for method, path, handler in specs:
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)
        app.add(API_PROJECTS, self.projects)

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
        w.json(cast(JsonValue, public_run(run, full=True)), status=201)
        await self.engine.enqueue(run)

    async def run(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        w.json(cast(JsonValue, public_run(run, full=True)))

    async def events(self, c: Context, w: Writer) -> None:
        run = self._existing(c, w)
        if run is None:
            return
        w.json(
            {
                "events": [
                    {
                        "seq": event.seq,
                        "type": event.type,
                        "text": event.text,
                        "stepId": event.step_id,
                        "at": event.at,
                    }
                    for event in list_events(self.db, run.id)
                ]
            }
        )

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
        if body.get("images"):
            w.json({"error": "attachments are not supported by the Python port"}, status=400)
            return
        reason = await self.engine.deliver(run.id, text)
        if reason == "message is empty":
            w.json({"error": "message needs text or at least one attachment"}, status=400)
            return
        if reason:
            w.json({"error": reason}, status=409)
            return
        w.json({"delivered": True})

    async def cancel_auto_resume(self, c: Context, w: Writer) -> None:
        """Nothing here schedules a usage-limit resume, so the off switch is a no-op."""
        run = self._existing(c, w)
        if run is None:
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
    if body.get("images"):
        return None, "", "", "", "", False, "attachments are not supported by the Python port", 400
    if not task.strip():
        return None, "", "", "", "", False, _TASK, 400
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
    if variants > 1:
        return None, "", "", "", "", False, _VARIANTS, 400
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
