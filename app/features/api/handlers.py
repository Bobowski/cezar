"""A small JSON surface for the headless CLI and for tests.

It is not the TypeScript `/api/v1` contract. Shapes are listed in MIGRATION.md.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Writer
from stario.datastar import read_signals
from stario.exceptions import RequestBodyError
from stario.json import JsonValue

from app.config import RUNNERS, Config
from app.engine.catalog import load_workflows
from app.engine.engine import Engine
from app.engine.model import Run
from app.features.api.urls import (
    API_CANCEL,
    API_EVENTS,
    API_FINISH,
    API_PROJECTS,
    API_RUN,
    API_RUNS,
    API_RUNS_CREATE,
    API_WORKFLOWS,
)
from app.store.db import get_project, get_run, get_settings, list_events, list_projects, list_runs


@dataclass(frozen=True, slots=True)
class ApiPage:
    db: LiteWriter
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(API_RUNS, self.runs)
        app.add(API_RUNS_CREATE, self.create)
        app.add(API_RUN, self.run)
        app.add(API_EVENTS, self.events)
        app.add(API_CANCEL, self.cancel)
        app.add(API_FINISH, self.finish)
        app.add(API_WORKFLOWS, self.workflows)
        app.add(API_PROJECTS, self.projects)

    async def runs(self, c: Context, w: Writer) -> None:
        project = c.req.query.get("projectId", "")
        status = c.req.query.get("status", "")
        rows = list_runs(self.db, project or None, status or None)
        w.json({"runs": [public_run(run) for run in rows]})

    async def create(self, c: Context, w: Writer) -> None:
        try:
            body = await read_signals(c.req)
        except RequestBodyError:
            w.json({"error": "invalid json"}, status=400)
            return
        task = str(body.get("task", "")).strip()
        workflow = str(body.get("workflow", "quick-task")).strip()
        runner = str(body.get("runner", "")).strip() or get_settings(self.db).default_runner
        project_id = str(body.get("projectId", "")).strip() or self.engine.boot_project_id
        model = str(body.get("model", "")).strip()
        autonomous = body.get("autonomous") is True
        if runner not in RUNNERS:
            w.json({"error": "unknown runner"}, status=400)
            return
        project = get_project(self.db, project_id)
        if project is None:
            w.json({"error": "unknown project"}, status=400)
            return
        run, reason = self.engine.plan_run(
            project=project,
            task=task,
            workflow_name=workflow,
            runner=runner,
            model=model,
            autonomous=autonomous,
        )
        if run is None:
            w.json({"error": reason or "invalid task"}, status=400)
            return
        w.json({"id": run.id, "status": run.status}, status=201)
        await self.engine.enqueue(run)

    async def run(self, c: Context, w: Writer) -> None:
        run = _existing(self.db, c, w)
        if run is None:
            return
        w.json(public_run(run))

    async def events(self, c: Context, w: Writer) -> None:
        run = _existing(self.db, c, w)
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
        await self._act(c, w, self.engine.cancel)

    async def finish(self, c: Context, w: Writer) -> None:
        await self._act(c, w, self.engine.finish)

    async def workflows(self, c: Context, w: Writer) -> None:
        project_id = c.req.query.get("projectId", "") or self.engine.boot_project_id
        project = get_project(self.db, project_id)
        if project is None:
            w.json({"error": "unknown project"}, status=404)
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
            {
                "projects": [
                    {
                        "id": project.id,
                        "name": project.name,
                        "root": project.root,
                        "baseBranch": project.base_branch,
                    }
                    for project in list_projects(self.db)
                ]
            }
        )

    async def _act(self, c: Context, w: Writer, fn) -> None:
        run_id = c.match.params["run_id"]
        if not _ok_id(run_id):
            w.json({"error": "not found"}, status=404)
            return
        reason = await fn(run_id)
        if reason:
            status = 404 if reason == "not found" else 409
            w.json({"error": reason}, status=status)
            return
        w.empty()


def _existing(db: LiteWriter, c: Context, w: Writer) -> Run | None:
    run_id = c.match.params["run_id"]
    if not _ok_id(run_id):
        w.json({"error": "not found"}, status=404)
        return None
    run = get_run(db, run_id)
    if run is None:
        w.json({"error": "not found"}, status=404)
        return None
    return run


def _ok_id(value: str) -> bool:
    return len(value) == 32 and all(ch in "0123456789abcdef" for ch in value)


def public_run(run: Run) -> dict[str, JsonValue]:
    return {
        "id": run.id,
        "projectId": run.project_id,
        "title": run.title,
        "task": run.task,
        "status": run.status,
        "workflow": run.workflow,
        "runner": run.runner,
        "createdAt": run.created_at,
        "startedAt": run.started_at,
        "finishedAt": run.finished_at,
        "error": run.error,
        "branch": run.branch,
        "baseBranch": run.base_branch,
        "worktreePath": run.worktree_path,
        "tokensUsed": run.tokens_used,
        "costUsd": run.cost_usd,
        "parentId": run.parent_id,
        "autonomous": run.autonomous,
        "model": run.model,
        "ask": run.ask,
    }
