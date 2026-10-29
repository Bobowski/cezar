"""JSON families that sit beside the run lifecycle.

Automations, deferred start, agent config, the follow-up inbox, project
registry edits, variant groups, dispatch, open targets, workspace config,
and the static `/icon.svg` and `/assets` files.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import uuid
from dataclasses import replace
from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Route, Writer
from stario.datastar import read_signals
from stario.exceptions import RequestBodyError
from stario.json import JsonValue

from app.clock import after, stamp
from app.config import (
    RUNNERS,
    Config,
    automations_enabled,
    followups_enabled,
    single_project,
    todos_path,
)
from app.engine.catalog import load_workflows
from app.engine.deferred_start import (
    load_creations,
    options_document,
    preview_start,
    request_digest,
    save_creations,
    task_text,
    task_workflow,
)
from app.engine.dispatch_logic import DispatchOrder
from app.engine.engine import Engine
from app.engine.gitwork import drop_worktree_dir
from app.engine.model import Automation, Project, Run, Settings
from app.engine.todos import mark_started, read_todos, remove_todo
from app.features.api.records import public_run
from app.features.editors.store import CATALOG, read_agent_file, write_agent_file
from app.http.loopback import hosted_mode
from app.store.db import (
    get_automation,
    get_project,
    get_run,
    get_settings,
    list_automations,
    list_projects,
    list_runs,
    save_automation,
    save_project,
)

_OFF = "Automations are off — this cockpit was started with CEZ_AUTOMATIONS=0"
_FOLLOWUPS = "the follow-up inbox is disabled — set CEZ_FOLLOWUPS=1 to enable it"
_STATIC = Path(__file__).resolve().parents[3] / "static"
_META = {
    "agents-md": ("memory", "project", "markdown", "tracked", False, "https://agents.md"),
    "claude-project": (
        "settings",
        "project",
        "json",
        "tracked",
        False,
        "https://code.claude.com/docs/en/settings",
    ),
    "claude-local": (
        "settings",
        "local",
        "json",
        "gitignored",
        False,
        "https://code.claude.com/docs/en/settings",
    ),
}
_OPEN = (
    ("cursor", "Cursor"),
    ("code", "Visual Studio Code"),
    ("idea", "IntelliJ IDEA"),
)


class RouteFamilies:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config

    def register(self, app: App) -> None:
        scoped = (
            ("GET", "/automations", self.automations),
            ("POST", "/automations", self.create_automation),
            ("GET", "/automations/{automation_id}", self.automation),
            ("PUT", "/automations/{automation_id}", self.update_automation),
            ("DELETE", "/automations/{automation_id}", self.delete_automation),
            ("POST", "/automations/{automation_id}/enable", self.enable_automation),
            ("POST", "/automations/{automation_id}/pause", self.pause_automation),
            ("POST", "/automations/{automation_id}/run", self.run_automation),
            ("POST", "/automations/{automation_id}/check", self.check_automation),
            ("GET", "/automation-log", self.automation_log),
            ("POST", "/deferred-start/options", self.deferred_options),
            ("POST", "/deferred-start/preview", self.deferred_preview),
            ("POST", "/deferred-start", self.deferred_create),
            ("GET", "/agent-config", self.agent_config),
            ("GET", "/agent-config/{file_id}", self.agent_config_file),
            ("PUT", "/agent-config/{file_id}", self.put_agent_config),
            ("GET", "/todos", self.todos),
            ("DELETE", "/todos/{todo_id}", self.delete_todo),
            ("POST", "/todos/{todo_id}/start", self.start_todo),
            ("GET", "/groups/{group_id}", self.group),
            ("POST", "/groups/{group_id}/pick", self.pick_group),
            ("POST", "/runs/{run_id}/dispatch", self.dispatch),
            ("POST", "/runs/{run_id}/report", self.report),
            ("GET", "/open-targets", self.open_targets),
            ("POST", "/open-in", self.open_in),
        )
        for method, path, handler in scoped:
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)
        app.add(Route("POST /api/v1/projects"), self.add_project)
        app.add(Route("PATCH /api/v1/projects/{project_id}"), self.patch_project)
        app.add(Route("DELETE /api/v1/projects/{project_id}"), self.delete_project)
        app.add(Route("GET /api/v1/workspace/config"), self.workspace_config)
        app.add(Route("PUT /api/v1/workspace/config"), self.put_workspace_config)
        app.add(Route("GET /api/v1/workspace/runs-index"), self.runs_index)
        app.add(Route("GET /icon.svg"), self.icon)
        app.add(Route("GET /assets/{name}"), self.asset)

    async def automations(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None or not self._automations(w):
            return
        rows = list_automations(self.db, project.id)
        w.json(cast(JsonValue, {"automations": [_automation(item) for item in rows]}))

    async def create_automation(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None or not self._automations(w):
            return
        body = await _object(c, w)
        if body is None:
            return
        item, reason = self._new_automation(project, body)
        if item is None:
            w.json({"error": reason or "invalid automation"}, status=400)
            return
        await self.engine.create_automation(item)
        if item.enabled:
            await self.engine.set_automation_enabled(item.id, True)
            stored = get_automation(self.db, item.id) or item
        else:
            stored = item
        w.json(cast(JsonValue, _automation(stored)), status=201)

    async def automation(self, c: Context, w: Writer) -> None:
        item = self._known_automation(c, w)
        if item is None:
            return
        w.json(cast(JsonValue, _automation(item)))

    async def update_automation(self, c: Context, w: Writer) -> None:
        item = self._known_automation(c, w)
        if item is None:
            return
        body = await _object(c, w)
        if body is None:
            return
        expected = body.get("expectedRevision")
        if not isinstance(expected, int) or isinstance(expected, bool):
            w.json({"error": "expectedRevision is required"}, status=400)
            return
        if expected != item.revision:
            w.json({"error": "revision conflict"}, status=409)
            return
        updated, reason = _apply_update(item, body)
        if updated is None:
            w.json({"error": reason or "invalid automation"}, status=400)
            return
        await self.db.write(save_automation, updated)
        self.engine.publish()
        w.json(cast(JsonValue, _automation(updated)))

    async def delete_automation(self, c: Context, w: Writer) -> None:
        item = self._known_automation(c, w)
        if item is None:
            return
        reason = await self.engine.remove_automation(item.id)
        if reason:
            w.json({"error": reason}, status=404)
            return
        w.json({"deleted": True})

    async def enable_automation(self, c: Context, w: Writer) -> None:
        await self._toggle(c, w, True)

    async def pause_automation(self, c: Context, w: Writer) -> None:
        await self._toggle(c, w, False)

    async def _toggle(self, c: Context, w: Writer, enabled: bool) -> None:
        item = self._known_automation(c, w)
        if item is None:
            return
        reason = await self.engine.set_automation_enabled(item.id, enabled)
        if reason:
            w.json({"error": reason}, status=404)
            return
        stored = get_automation(self.db, item.id) or item
        w.json(cast(JsonValue, _automation(stored)))

    async def run_automation(self, c: Context, w: Writer) -> None:
        item = self._known_automation(c, w)
        if item is None:
            return
        run_id, reason = await self.engine.run_automation_now(item.id)
        if reason or run_id is None:
            w.json({"error": reason or "could not start a run"}, status=404)
            return
        w.json({"runId": run_id}, status=201)

    async def check_automation(self, c: Context, w: Writer) -> None:
        item = self._known_automation(c, w)
        if item is None:
            return
        body = await _object(c, w)
        if body is None:
            return
        execute = body.get("execute") is True
        w.json(
            {
                "id": uuid.uuid4().hex,
                "automationId": item.id,
                "mode": "execute" if execute else "preview",
                "status": "complete",
                "matches": 0,
                "launched": False,
                "message": "a schedule has no event filter; use run to launch it",
            }
        )

    async def automation_log(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None or not self._automations(w):
            return
        entries = [
            {
                "id": item.id,
                "automationId": item.id,
                "runId": item.last_run_id,
                "name": item.name,
                "at": item.created_at,
            }
            for item in list_automations(self.db, project.id)
            if item.last_run_id
        ]
        w.json(cast(JsonValue, {"entries": entries}))

    async def deferred_options(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None or not self._automations(w):
            return
        body = await _object(c, w)
        if body is None:
            return
        if not task_text(body.get("task")):
            w.json({"error": "describe the task"}, status=400)
            return
        w.json(cast(JsonValue, options_document()))

    async def deferred_preview(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None or not self._automations(w):
            return
        body = await _object(c, w)
        if body is None:
            return
        if not task_text(body.get("task")):
            w.json({"error": "describe the task"}, status=400)
            return
        w.json(cast(JsonValue, preview_start(body.get("start"))))

    async def deferred_create(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None or not self._automations(w):
            return
        body = await _object(c, w)
        if body is None:
            return
        text = task_text(body.get("task"))
        key = body.get("idempotencyKey")
        revision = body.get("previewRevision")
        if not text:
            w.json({"error": "describe the task"}, status=400)
            return
        if not isinstance(key, str) or not 8 <= len(key) <= 80:
            w.json({"error": "idempotencyKey is required"}, status=400)
            return
        preview = preview_start(body.get("start"))
        if preview.get("available") is not True:
            w.json(
                {"error": str(preview.get("message") or "that start is not available")}, status=400
            )
            return
        if revision != preview.get("previewRevision"):
            w.json({"error": "preview is stale; check the preview again"}, status=409)
            return
        not_before = str(preview["notBefore"])
        digest = request_digest(text, not_before)
        path = self.config.data_dir / "deferred-creations.json"
        stored = load_creations(path)
        previous = stored.get(key)
        if previous:
            if previous.get("digest") != digest:
                w.json({"error": "This creation key belongs to a different request."}, status=409)
                return
            w.json(cast(JsonValue, _scheduled(previous)), status=201)
            return
        workflow = task_workflow(body.get("task"))
        if not any(item.name == workflow for item in load_workflows(Path(project.root))[0]):
            w.json({"error": "unknown workflow"}, status=400)
            return
        item = Automation(
            id=uuid.uuid4().hex,
            project_id=project.id,
            name=text[:100],
            task=text,
            workflow=workflow,
            runner=get_settings(self.db).default_runner,
            every_minutes=60,
            enabled=True,
            next_at=not_before,
            created_at=stamp(),
            once=True,
            creation_key=key,
        )
        await self.engine.create_automation(item)
        row = {
            "digest": digest,
            "automationId": item.id,
            "notBefore": not_before,
            "idempotencyKey": key,
        }
        stored[key] = row
        save_creations(path, stored)
        w.json(cast(JsonValue, _scheduled(row)), status=201)

    async def agent_config(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        editable = not hosted_mode(self.config)
        files = [
            _config_file(Path(project.root), file_id, relative, editable)
            for file_id, relative in CATALOG.items()
        ]
        w.json(
            cast(
                JsonValue,
                {
                    "editable": editable,
                    "files": files,
                    "userMcp": None if not editable else _user_mcp(),
                },
            )
        )

    async def agent_config_file(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        found = read_agent_file(Path(project.root), c.match.params.get("file_id", ""))
        if found is None:
            w.json({"error": "unknown config file"}, status=404)
            return
        relative, _text = found
        content, version = _bytes(Path(project.root) / relative)
        w.json(
            {
                "id": c.match.params.get("file_id", ""),
                "path": relative,
                "exists": version is not None,
                "content": content,
                "version": version,
            }
        )

    async def put_agent_config(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        if hosted_mode(self.config):
            w.json(
                {
                    "error": (
                        "editing agent config is disabled in hosted mode (CEZ_REMOTE) — "
                        "edit it from the machine that owns the checkout"
                    )
                },
                status=409,
            )
            return
        file_id = c.match.params.get("file_id", "")
        found = read_agent_file(Path(project.root), file_id)
        if found is None:
            w.json({"error": "unknown config file"}, status=404)
            return
        body = await _object(c, w)
        if body is None:
            return
        content = body.get("content")
        if "version" not in body or not isinstance(content, str) or len(content) > 2_000_000:
            w.json({"error": "content and version are required"}, status=400)
            return
        relative, _existing = found
        _current, version = _bytes(Path(project.root) / relative)
        if body.get("version") != version:
            w.json({"error": "the file changed since you read it"}, status=409)
            return
        reason = write_agent_file(Path(project.root), file_id, content, hosted=False)
        if reason:
            w.json({"error": reason}, status=400)
            return
        written, new_version = _bytes(Path(project.root) / relative)
        w.json(
            {
                "id": file_id,
                "path": relative,
                "exists": True,
                "content": written,
                "version": new_version,
            }
        )

    async def todos(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        if not followups_enabled():
            w.json([])
            return
        w.json(cast(JsonValue, read_todos(todos_path(Path(project.root)))))

    async def delete_todo(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        if not followups_enabled():
            w.json({"error": _FOLLOWUPS}, status=409)
            return
        if not remove_todo(todos_path(Path(project.root)), c.match.params.get("todo_id", "")):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"removed": True})

    async def start_todo(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        if not followups_enabled():
            w.json({"error": _FOLLOWUPS}, status=409)
            return
        path = todos_path(Path(project.root))
        todo_id = c.match.params.get("todo_id", "")
        row = next((item for item in read_todos(path) if item.get("id") == todo_id), None)
        if row is None:
            w.json({"error": "not found"}, status=404)
            return
        if row.get("startedTaskId"):
            w.json({"error": "already started"}, status=409)
            return
        body = await _optional(c)
        extra = ""
        prompt = body.get("prompt") if isinstance(body, dict) else None
        if isinstance(prompt, str) and prompt:
            extra = "\n\n" + prompt
        run, reason = self.engine.plan_run(
            project=project,
            task=str(row["summary"]) + extra,
            workflow_name="quick-task",
            runner=get_settings(self.db).default_runner,
        )
        if run is None:
            w.json({"error": reason or "invalid task"}, status=400)
            return
        if not mark_started(path, todo_id, run.id):
            w.json({"error": "already started"}, status=409)
            return
        await self.engine.enqueue(run)
        w.json(cast(JsonValue, {"run": public_run(run, full=True)}), status=201)

    async def group(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        runs = _group(self.db, c.match.params.get("group_id", ""))
        if not runs:
            w.json({"error": "not found"}, status=404)
            return
        w.json(
            cast(
                JsonValue,
                {
                    "groupId": c.match.params.get("group_id", ""),
                    "runs": [_variant(run) for run in runs],
                },
            )
        )

    async def pick_group(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        group_id = c.match.params.get("group_id", "")
        runs = _group(self.db, group_id)
        if not runs:
            w.json({"error": "not found"}, status=404)
            return
        body = await _object(c, w)
        if body is None:
            return
        run_id = body.get("runId")
        winner = next((run for run in runs if run.id == run_id), None)
        if winner is None:
            w.json({"error": "runId is not part of this group"}, status=404)
            return
        if winner.status in ("queued", "running", "waiting"):
            w.json(
                {"error": "this variant is still active — wait for it to finish first"}, status=409
            )
            return
        archived: list[str] = []
        for loser in runs:
            if loser.id == winner.id:
                continue
            if loser.status in ("queued", "running", "waiting", "review"):
                await self.engine.cancel(loser.id)
            await self.engine.set_archived(loser.id, True)
            _drop(self.db, loser)
            archived.append(loser.id)
        await self.engine._note(
            winner.id,
            "lifecycle",
            f"picked from {len(runs)} variants — {len(archived)} other variant(s) archived",
        )
        w.json({"picked": winner.id, "archived": archived})

    async def dispatch(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if not self.config.dispatch_enabled:
            w.json({"error": "dispatch is disabled on this cockpit (CEZ_DISPATCH=0)"}, status=409)
            return
        body = await _object(c, w)
        if body is None:
            return
        order, reason = _order(body)
        if order is None:
            w.json({"error": reason or "invalid dispatch"}, status=400)
            return
        child_id, refused = await self.engine.dispatch(run.id, order)
        if refused == "not found" or child_id is None:
            code = 404 if refused == "not found" else 409
            w.json({"error": refused or "dispatch refused"}, status=code)
            return
        child = get_run(self.db, child_id)
        w.json(
            {"id": child_id, "branch": child.branch if child else ""},
            status=201,
        )

    async def report(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await _object(c, w)
        if body is None:
            return
        reason = await self.engine.record_report(run.id, body)
        if reason in ("not found", "run is not part of a dispatch tree"):
            w.json({"error": reason}, status=404)
            return
        if reason:
            code = 409 if "disabled" in reason else 400
            w.json({"error": reason}, status=code)
            return
        w.json({"ok": True})

    async def open_targets(self, c: Context, w: Writer) -> None:
        if self._project(c, w) is None:
            return
        if hosted_mode(self.config):
            w.json({"targets": []})
            return
        w.json(
            {
                "targets": [
                    {"id": binary, "label": label}
                    for binary, label in _OPEN
                    if shutil.which(binary)
                ]
            }
        )

    async def open_in(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        if hosted_mode(self.config):
            w.json(
                {
                    "error": (
                        "local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)"
                    )
                },
                status=409,
            )
            return
        body = await _object(c, w)
        if body is None:
            return
        target = body.get("target")
        known = {binary for binary, _label in _OPEN}
        if not isinstance(target, str) or target not in known or shutil.which(target) is None:
            w.json({"error": f"no such app on this machine: {target}"}, status=400)
            return
        if self.config.dry_run:
            w.json({"opened": True, "path": project.root, "dryRun": True})
            return
        subprocess.Popen(  # noqa: S603 — the binary is one of the fixed editor names
            [target, project.root],
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        w.json({"opened": True, "path": project.root})

    async def add_project(self, c: Context, w: Writer) -> None:
        body = await _object(c, w)
        if body is None:
            return
        root = body.get("root")
        if not isinstance(root, str) or not root.strip():
            w.json({"error": "root must be a non-empty path"}, status=400)
            return
        project, reason = await self.engine.add_project(Path(root))
        if project is None:
            text = reason or "could not add"
            conflict = "single-project" in text or "already" in text
            w.json({"error": text}, status=409 if conflict else 400)
            return
        w.json({"id": project.id, "name": project.name, "root": project.root}, status=200)

    async def patch_project(self, c: Context, w: Writer) -> None:
        if single_project():
            w.json(
                {"error": "single-project mode is enabled; editing projects is disabled"},
                status=409,
            )
            return
        project = get_project(self.db, c.match.params.get("project_id", ""))
        if project is None:
            w.json({"error": "not found"}, status=404)
            return
        body = await _object(c, w)
        if body is None:
            return
        name = body.get("name", project.name)
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            w.json({"error": "name must be 1 to 80 characters"}, status=400)
            return
        if "baseBranch" in body:
            branch = body.get("baseBranch")
            if not isinstance(branch, str):
                w.json({"error": "base branch must be a plain git ref"}, status=400)
                return
            reason = await self.engine.set_base_branch(project.id, branch)
            if reason:
                w.json({"error": reason}, status=400)
                return
            project = get_project(self.db, project.id) or project
        if name != project.name:
            await self.db.write(save_project, replace(project, name=name.strip()))
            self.engine.publish()
            project = get_project(self.db, project.id) or project
        w.json({"id": project.id, "name": project.name, "baseBranch": project.base_branch})

    async def delete_project(self, c: Context, w: Writer) -> None:
        if single_project():
            w.json(
                {"error": "single-project mode is enabled; removing projects is disabled"},
                status=409,
            )
            return
        project_id = c.match.params.get("project_id", "")
        if project_id == "default":
            project_id = self.engine.boot_project_id
        project = get_project(self.db, project_id)
        if project is None:
            w.json({"error": f"unknown project: {project_id}"}, status=404)
            return
        if project.id == self.engine.boot_project_id:
            w.json(
                {
                    "error": (
                        f"cezar is serving {project.name} right now — stop it and run "
                        f"`cezar projects remove {project.id}` to drop the registry entry"
                    )
                },
                status=409,
            )
            return
        active = [
            run
            for run in list_runs(self.db, project.id, None)
            if run.status in ("queued", "running", "waiting")
        ]
        if active:
            w.json(
                {"error": f"{project.name} has running tasks", "runningTasks": len(active)},
                status=409,
            )
            return
        from app.store.db import delete_project as drop_project

        await self.db.write(drop_project, project.id)
        self.engine.publish()
        w.json({"deleted": True})

    async def workspace_config(self, _c: Context, w: Writer) -> None:
        settings = get_settings(self.db)
        w.json(
            {
                "maxParallel": settings.max_parallel,
                "defaultRunner": settings.default_runner,
                "theme": settings.theme,
                "accent": settings.accent,
            }
        )

    async def put_workspace_config(self, c: Context, w: Writer) -> None:
        body = await _object(c, w)
        if body is None:
            return
        raw = body.get("maxParallel")
        if not isinstance(raw, int) or isinstance(raw, bool) or not 1 <= raw <= 16:
            w.json({"error": "maxParallel must be from 1 to 16"}, status=400)
            return
        settings = get_settings(self.db)
        await self.engine.save_workspace(
            Settings(raw, settings.default_runner, settings.theme, settings.accent)
        )
        w.json({"maxParallel": raw})

    async def runs_index(self, _c: Context, w: Writer) -> None:
        projects = {project.id: project.name for project in list_projects(self.db)}
        rows = [
            {
                "id": run.id,
                "title": run.title,
                "status": run.status,
                "projectId": run.project_id,
                "projectName": projects.get(run.project_id, ""),
                "createdAt": run.created_at,
            }
            for run in list_runs(self.db, None, None)
        ]
        w.json(cast(JsonValue, {"runs": rows}))

    async def icon(self, _c: Context, w: Writer) -> None:
        w.text((_STATIC / "icon.svg").read_text(encoding="utf-8"))

    async def asset(self, c: Context, w: Writer) -> None:
        name = c.match.params.get("name", "")
        if not name or "/" in name or name.startswith(".") or ".." in name:
            w.json({"error": "not found"}, status=404)
            return
        path = _STATIC / "assets" / name
        if not path.is_file():
            w.json({"error": "not found"}, status=404)
            return
        w.text(path.read_text(encoding="utf-8"))

    def _project(self, c: Context, w: Writer) -> Project | None:
        raw = c.match.params.get("project_id", "")
        project_id = self.engine.boot_project_id if raw in ("", "default") else raw
        project = get_project(self.db, project_id)
        if project is None:
            w.json({"error": "not found"}, status=404)
            return None
        return project

    def _automations(self, w: Writer) -> bool:
        if automations_enabled():
            return True
        w.json({"error": _OFF}, status=409)
        return False

    def _known_automation(self, c: Context, w: Writer) -> Automation | None:
        if self._project(c, w) is None or not self._automations(w):
            return None
        item = get_automation(self.db, c.match.params.get("automation_id", ""))
        if item is None:
            w.json({"error": "not found"}, status=404)
            return None
        return item

    def _run(self, c: Context, w: Writer) -> Run | None:
        if self._project(c, w) is None:
            return None
        run = get_run(self.db, c.match.params.get("run_id", ""))
        if run is None:
            w.json({"error": "not found"}, status=404)
            return None
        return run

    def _new_automation(
        self, project: Project, body: dict[str, object]
    ) -> tuple[Automation | None, str | None]:
        name = body.get("name")
        task = body.get("task")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            return None, "name must be 1 to 80 characters"
        if not isinstance(task, str) or not task.strip() or len(task) > 20_000:
            return None, "task is required"
        every = body.get("everyMinutes", body.get("every_minutes", 60))
        if isinstance(every, str) and every.isdecimal():
            every = int(every)
        if isinstance(every, bool) or not isinstance(every, int) or not 1 <= every <= 10080:
            return None, "everyMinutes must be between 1 and 10080"
        workflow = body.get("workflow", "quick-task")
        if not isinstance(workflow, str) or not workflow.strip():
            return None, "unknown workflow"
        if not any(item.name == workflow for item in load_workflows(Path(project.root))[0]):
            return None, "unknown workflow"
        runner = body.get("runner", get_settings(self.db).default_runner)
        if not isinstance(runner, str) or runner not in RUNNERS:
            return None, "unknown runner"
        return (
            Automation(
                id=uuid.uuid4().hex,
                project_id=project.id,
                name=name.strip(),
                task=task.strip(),
                workflow=workflow,
                runner=runner,
                every_minutes=every,
                enabled=body.get("enable") is True,
                next_at=after(every),
                created_at=stamp(),
            ),
            None,
        )


def _automation(item: Automation) -> dict[str, object]:
    return {
        "id": item.id,
        "revision": item.revision,
        "name": item.name,
        "enabled": item.enabled,
        "kind": "schedule",
        "everyMinutes": item.every_minutes,
        "workflow": item.workflow,
        "runner": item.runner,
        "task": item.task,
        "nextAt": item.next_at,
        "lastRunId": item.last_run_id,
        "createdAt": item.created_at,
        "once": item.once,
    }


def _apply_update(
    item: Automation, body: dict[str, object]
) -> tuple[Automation | None, str | None]:
    name = body.get("name", item.name)
    task = body.get("task", item.task)
    every = body.get("everyMinutes", item.every_minutes)
    workflow = body.get("workflow", item.workflow)
    runner = body.get("runner", item.runner)
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        return None, "name must be 1 to 80 characters"
    if not isinstance(task, str) or not task.strip():
        return None, "task is required"
    if isinstance(every, bool) or not isinstance(every, int) or not 1 <= every <= 10080:
        return None, "everyMinutes must be between 1 and 10080"
    if not isinstance(workflow, str) or not isinstance(runner, str):
        return None, "unknown workflow"
    if runner not in RUNNERS:
        return None, "unknown runner"
    return (
        replace(
            item,
            name=name.strip(),
            task=task.strip(),
            every_minutes=every,
            workflow=workflow,
            runner=runner,
            revision=item.revision + 1,
        ),
        None,
    )


def _config_file(root: Path, file_id: str, relative: str, editable: bool) -> dict[str, object]:
    kind, scope, fmt, tracked, private, docs = _META[file_id]
    content, version = _bytes(root / relative)
    return {
        "id": file_id,
        "runners": ["claude"] if file_id != "agents-md" else ["claude", "codex", "cursor"],
        "kind": kind,
        "scope": scope,
        "label": relative,
        "path": relative,
        "format": fmt,
        "tracked": tracked,
        "seeded": False,
        "holdsMcp": False,
        "private": private,
        "precedence": f"{relative} in the project checkout",
        "docsUrl": docs,
        "exists": version is not None,
        "size": len(content.encode()),
        "version": version,
        "writable": editable,
    }


def _bytes(path: Path) -> tuple[str, str | None]:
    if not path.is_file():
        return "", None
    raw = path.read_bytes()
    return raw.decode("utf-8", errors="replace"), hashlib.sha256(raw).hexdigest()


def _user_mcp() -> dict[str, object]:
    path = Path.home() / ".claude.json"
    return {"path": str(path), "servers": [], "readable": path.is_file()}


def _group(db: LiteWriter, group_id: str) -> list[Run]:
    if not group_id:
        return []
    return [run for run in list_runs(db, None, None, limit=500) if run.group_id == group_id]


def _variant(run: Run) -> dict[str, object]:
    return {
        "id": run.id,
        "variant": run.variant or "?",
        "title": run.title,
        "status": run.status,
        "archived": run.archived,
        "tokensUsed": run.tokens_used,
        "diffStat": "",
    }


def _drop(db: LiteWriter, run: Run) -> None:
    if not run.worktree_path or run.in_place:
        return
    project = get_project(db, run.project_id)
    if project is None:
        return
    drop_worktree_dir(Path(project.root), Path(run.worktree_path))


def _order(body: dict[str, object]) -> tuple[DispatchOrder | None, str | None]:
    objective = body.get("objective")
    if not isinstance(objective, str) or not objective.strip() or len(objective) > 4000:
        return None, "an objective is required"
    title = body.get("title", "")
    kind = body.get("kind", "implement")
    if (
        not isinstance(title, str)
        or not isinstance(kind, str)
        or kind not in ("implement", "review")
    ):
        return None, "kind must be implement or review"
    review_of = body.get("review_of") or []
    if not isinstance(review_of, list) or not all(isinstance(item, str) for item in review_of):
        return None, "review_of must be a list of strings"
    tools = body.get("allowed_tools") or []
    if not isinstance(tools, list) or not all(isinstance(item, str) for item in tools):
        return None, "allowed_tools must be a list of strings"
    max_cost = body.get("max_cost")
    if max_cost is not None and (
        isinstance(max_cost, bool) or not isinstance(max_cost, int | float)
    ):
        return None, "max_cost must be a number"
    scope = body.get("scope", "")
    success = body.get("success_criteria", "")
    evidence = body.get("required_evidence", "")
    retry = body.get("retry_limit")
    if not isinstance(scope, str) or not isinstance(success, str) or not isinstance(evidence, str):
        return None, "invalid dispatch"
    if retry is not None and (
        isinstance(retry, bool) or not isinstance(retry, int) or not 0 <= retry <= 3
    ):
        return None, "retry_limit must be from 0 to 3"
    return (
        DispatchOrder(
            objective=objective.strip(),
            title=title.strip(),
            kind=kind,
            review_of=tuple(item for item in review_of if isinstance(item, str)),
            scope=scope,
            allowed_tools=tuple(item for item in tools if isinstance(item, str)),
            max_cost=float(max_cost)
            if isinstance(max_cost, int | float) and not isinstance(max_cost, bool)
            else None,
            success_criteria=success,
            required_evidence=evidence,
            retry_limit=retry if isinstance(retry, int) else None,
        ),
        None,
    )


def _scheduled(row: dict[str, str]) -> dict[str, object]:
    return {
        "scheduled": {
            "automationId": row.get("automationId", ""),
            "idempotencyKey": row.get("idempotencyKey", ""),
            "notBefore": row.get("notBefore", ""),
            "status": "pending",
        }
    }


async def _object(c: Context, w: Writer) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        w.json({"error": "invalid json"}, status=400)
        return None
    if not isinstance(loaded, dict):
        w.json({"error": "invalid json"}, status=400)
        return None
    return cast(dict[str, object], loaded)


async def _optional(c: Context) -> dict[str, object] | None:
    try:
        loaded = await read_signals(c.req)
    except RequestBodyError:
        return None
    if isinstance(loaded, dict):
        return cast(dict[str, object], loaded)
    return None
