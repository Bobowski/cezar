import uuid
from dataclasses import dataclass, replace

from litewriter import LiteWriter
from stario import App, Context, Relay, Writer
from stario.datastar import SSE, read_signals
from stario.exceptions import RequestBodyError

from app.common.shell import load_chrome
from app.config import RUNNERS, Config
from app.engine.catalog import load_workflows
from app.engine.engine import CHANGED, Engine
from app.features.task.urls import TASK
from app.features.tasks.urls import (
    HOME,
    TASKS,
    TASKS_ARCHIVE,
    TASKS_CREATE,
    TASKS_LIVE,
    TASKS_NEW,
    TASKS_READ,
    TasksView,
)
from app.features.tasks.views import render_list, render_new
from app.store.db import get_project, get_settings, list_runs


@dataclass(frozen=True, slots=True)
class TasksPage:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    engine: Engine
    config: Config

    def register(self, app: App) -> None:
        app.add(HOME, self.home)
        app.add(TASKS, self.show)
        app.add(TASKS_LIVE, self.live)
        app.add(TASKS_NEW, self.new)
        app.add(TASKS_CREATE, self.create)
        app.add(TASKS_ARCHIVE, self.archive_finished)
        app.add(TASKS_READ, self.mark_read)

    def _view(self, query: object) -> TasksView:
        view = TasksView.from_query(query)  # type: ignore[arg-type]
        if not view.project:
            view = replace(view, project=self.engine.boot_project_id)
        return view

    async def home(self, c: Context, w: Writer) -> None:
        w.redirect(
            TASKS.href(query={"project": self.engine.boot_project_id, "status": "all"}),
            303,
        )

    async def show(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        w.html(render_list(self._runs(view), view, self._chrome(view.project), uuid.uuid7().hex))

    async def new(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        project = get_project(self.db, view.project)
        workflows = load_workflows(project_root(project))[0] if project else []
        settings = get_settings(self.db)
        w.html(
            render_new(
                workflows,
                view,
                self._chrome(view.project),
                uuid.uuid7().hex,
                settings.default_runner,
            )
        )

    async def live(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("tab must be a short id", 400)
            return
        tab = str(signals.get("tab", ""))
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        async with self.relay.subscribe(CHANGED, f"tab.{tab}", latest=True) as events:
            sse = SSE(w)
            sse.patch_elements(render_list(self._runs(view), view, self._chrome(view.project), tab))
            async for subject, payload in c.alive(events):
                if subject == CHANGED:
                    sse.patch_elements(
                        render_list(self._runs(view), view, self._chrome(view.project), tab)
                    )
                else:
                    sse.patch_signals(payload)

    async def create(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        try:
            signals = await read_signals(c.req)
        except RequestBodyError:
            w.text("invalid input", 400)
            return
        tab = str(signals.get("tab", ""))
        task = str(signals.get("task", "")).strip()
        workflow = str(signals.get("workflow", "quick-task")).strip()
        runner = str(signals.get("runner", "")).strip()
        model = str(signals.get("model", "")).strip()
        autonomous = signals.get("autonomous") is True
        if not (tab.isalnum() and len(tab) <= 32):
            w.text("tab must be a short id", 400)
            return
        if not task or len(task) > 20_000:
            w.text("task must be 1 to 20000 characters", 400)
            return
        if runner not in RUNNERS:
            w.text("unknown runner", 400)
            return
        if len(model) > 120:
            w.text("model is too long", 400)
            return
        project = get_project(self.db, view.project)
        if project is None:
            w.text("unknown project", 400)
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
            self.relay.publish(f"tab.{tab}", {"_error": reason or "could not start"})
            SSE(w).patch_signals({"_error": reason or "could not start"})
            return
        SSE(w).navigate(TASK.href(run.id))
        await self.engine.enqueue(run)

    async def archive_finished(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        await self.engine.archive_finished(view.project)
        w.empty()

    async def mark_read(self, c: Context, w: Writer) -> None:
        view = self._view(c.req.query)
        await self.engine.mark_all_read(view.project)
        w.empty()

    def _runs(self, view: TasksView) -> list:
        project = view.project or None
        status = None if view.status in ("all", "archived") else view.status
        rows = list_runs(self.db, project, status)
        if view.status == "archived":
            return [run for run in rows if run.archived]
        if view.status == "all":
            return [run for run in rows if not run.archived]
        return rows

    def _chrome(self, project_id: str):
        return load_chrome(self.db, self.config, "Tasks", "tasks", project_id)


def project_root(project: object):
    from pathlib import Path

    root = getattr(project, "root", "")
    return Path(root) if root else Path(".")
