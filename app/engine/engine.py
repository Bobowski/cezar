"""Queue, worktrees, and the workflow walk.

A successful workflow stops at `review`. Finish records `done`. Neither merges.
`waiting` does not hold a parallelism slot: the agent process has already exited.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path

from litewriter import LiteWriter, Tx
from stario import App, Relay

from app.clock import after, now, parse_stamp, stamp
from app.config import RUNNERS, Config
from app.engine.agents import AgentSpec, Runner, usage_from_line
from app.engine.catalog import find_workflow, load_workflows
from app.engine.dispatch_logic import (
    BudgetChild,
    DispatchOrder,
    append_report,
    carve_child_budget,
    child_report_text,
    child_task_envelope,
    in_flight_refusal,
)
from app.engine.gitignore_data import ensure_data_gitignore
from app.engine.gitwork import (
    WorktreeError,
    create_worktree,
    diff_against,
    head_branch,
    is_git_repo,
    prune_orphans,
    remove_worktree,
)
from app.engine.model import TERMINAL, Automation, Project, Run, Settings, Step, Workflow
from app.engine.prompts import build_user_prompt
from app.engine.skills import find_skill
from app.engine.workflows import newer_catalog_workflow, retryable_exit
from app.store.db import (
    add_event,
    count_in_flight_children,
    delete_run_row,
    find_project_by_root,
    get_project,
    get_run,
    get_run_tx,
    get_settings,
    insert_project,
    insert_run,
    list_children,
    list_enabled_automations,
    list_projects,
    list_queued,
    list_run_ids,
    save_automation,
    save_project,
    save_run,
)

CHANGED = "cezar.changed"


def _ask_line(text: str) -> str:
    for line in text.splitlines():
        if "CEZ:ASK" not in line:
            continue
        _prefix, _sep, rest = line.partition("CEZ:ASK")
        return rest.lstrip(": ").strip() or line.strip()
    return text.strip()


def title_from(task: str) -> str:
    line = task.strip().splitlines()[0].strip() if task.strip() else "task"
    if len(line) > 80:
        return line[:79] + "…"
    return line


def slug_for(name: str, taken: set[str]) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in name).strip("-")
    base = cleaned[:40] or "project"
    if base == "default":
        base = "default-repo"
    candidate = base
    number = 2
    while candidate in taken:
        candidate = f"{base}-{number}"
        number += 1
    return candidate


@dataclass
class Engine:
    db: LiteWriter
    relay: Relay[dict[str, str]]
    config: Config
    agent: Runner | None = None
    app: App | None = None
    boot_project_id: str = ""
    _tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    _cancel: dict[str, asyncio.Event] = field(default_factory=dict)
    _wake: asyncio.Event = field(default_factory=asyncio.Event)

    def kick(self) -> None:
        self._wake.set()

    def publish(self) -> None:
        self.relay.publish(CHANGED, {})

    async def startup(self) -> None:
        repo = self.config.repo_root
        if repo.is_dir() and repo.resolve() != Path.home().resolve():
            await asyncio.to_thread(ensure_data_gitignore, repo)
            await self._ensure_boot_project()
            if is_git_repo(repo):
                await asyncio.to_thread(prune_orphans, repo, list_run_ids(self.db))
        await self.db.write(rebaseline_automations)

    async def serve(self) -> None:
        while self.app is not None and not self.app.shutting_down:
            await self.tick()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), self.config.tick_seconds)
            except TimeoutError:
                pass

    async def tick(self) -> None:
        if self.app is None:
            return
        await self._launch_due()
        settings = get_settings(self.db)
        alive = [run_id for run_id, task in self._tasks.items() if not task.done()]
        slots = settings.max_parallel - len(alive)
        for run in list_queued(self.db):
            if slots <= 0:
                return
            if run.id in alive or run.id in self._tasks:
                continue
            self._tasks[run.id] = self.app.create_task(
                self.execute(run.id), name=f"run-{run.id[:8]}"
            )
            slots -= 1

    async def execute(self, run_id: str) -> None:
        cancel = self._cancel.setdefault(run_id, asyncio.Event())
        try:
            run = get_run(self.db, run_id)
            if run is None or run.status != "queued":
                return
            run.status = "running"
            if not run.started_at:
                run.started_at = stamp()
            await self._save(run)
            await self._note(run.id, "lifecycle", "running")
            if run.mode == "followup":
                await self._followup(run, cancel)
                return
            await self._workflow(run, cancel)
        except asyncio.CancelledError:
            current = get_run(self.db, run_id)
            if current is not None and current.status == "running":
                current.status = "failed"
                current.error = "interrupted by shutdown"
                current.finished_at = stamp()
                await self.db.write(save_run, current)
            raise
        finally:
            await self._report_child(run_id)
            self._tasks.pop(run_id, None)
            self._cancel.pop(run_id, None)
            self.kick()

    async def _workflow(self, run: Run, cancel: asyncio.Event) -> None:
        run = await self._prepare(run)
        if run.status == "failed":
            return
        if run.step_index == 0 and not run.pending_note:
            run = await self._refresh_workflow(run)
        while True:
            run = get_run(self.db, run.id) or run
            if run.status in ("cancelled", "failed", "waiting"):
                return
            if cancel.is_set():
                await self._mark_cancelled(run)
                return
            steps = run.definition().steps
            if run.step_index >= len(steps):
                await self._enter_review(run)
                return
            step = steps[run.step_index]
            await self._note(run.id, "step-start", step.name or step.id, step.id)
            if step.kind == "check":
                action = await self._check(run, step, cancel)
            else:
                action = await self._agent_step(run, cancel)
            if action == "stop":
                return
            if action == "jump":
                continue
            current = get_run(self.db, run.id) or run
            current.step_index += 1
            current.pending_note = ""
            current.check_failure = ""
            await self._save(current)

    async def _followup(self, run: Run, cancel: asyncio.Event) -> None:
        if not run.worktree_path:
            await self._fail(run, "no worktree to continue in")
            return
        message = run.continuation or run.pending_note
        run.continuation = ""
        run.mode = "workflow"
        run.ask = ""
        run.pending_note = ""
        await self._save(run)
        action = await self._agent_step(run, cancel, followup=message)
        if action == "stop":
            return
        current = get_run(self.db, run.id)
        if current is None or current.status in ("cancelled", "failed", "waiting"):
            return
        await self._enter_review(current)

    async def _prepare(self, run: Run) -> Run:
        if run.worktree_path:
            return run
        project = get_project(self.db, run.project_id)
        if project is None:
            return await self._fail(run, "project is gone")
        root = Path(project.root)
        base = run.base_branch or project.base_branch or "main"
        if not is_git_repo(root):
            run.in_place = True
            run.worktree_path = str(root)
            run.base_branch = base
            await self._save(run)
            await self._note(run.id, "note", "not a git repository; ran in place")
            return run
        try:
            path, branch, sha = await asyncio.to_thread(
                create_worktree,
                root,
                run.id,
                base,
                fetch=not self.config.dry_run,
            )
        except WorktreeError as exc:
            return await self._fail(run, str(exc))
        run.worktree_path = str(path)
        run.branch = branch
        run.base_sha = sha
        run.base_branch = base
        await self._save(run)
        return run

    async def _refresh_workflow(self, run: Run) -> Run:
        project = get_project(self.db, run.project_id)
        if project is None:
            return run
        catalog, _issues = load_workflows(Path(project.root))
        fresh = newer_catalog_workflow(run.definition(), catalog)
        if fresh is None:
            return run
        run.workflow = fresh.name
        run.workflow_def = fresh.to_json()
        await self._save(run)
        await self._note(run.id, "note", f'workflow "{fresh.name}" was re-read from the catalog')
        return run

    async def _agent_step(self, run: Run, cancel: asyncio.Event, followup: str = "") -> str:
        steps = run.definition().steps
        index = run.step_index if not followup else 0
        if followup:
            steps = (Step(id="followup", name="Follow up", prompt=followup),)
            index = 0
        elif index >= len(steps):
            return "stop"
        step = steps[index]
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        system_parts: list[str] = []
        if step.skill:
            skill = find_skill(root, step.skill)
            if skill is None:
                await self._note(run.id, "note", f'skill "{step.skill}" was not found', step.id)
            else:
                system_parts.append(skill.body)
        if run.autonomous:
            system_parts.append(
                "Work autonomously. Do not stop to ask the user. "
                "When this step's own goal is achieved, end your turn with CEZ:DONE."
            )
        if self.config.dry_run and step.bash_allowlist:
            await self._note(
                run.id,
                "note",
                "bashAllowlist is not applied by the dry-run mock",
                step.id,
            )
        reports = list(run.pending_reports)
        prompt = build_user_prompt(
            steps,
            index,
            run.task,
            check_failure=run.check_failure,
            pending_note=run.pending_note,
            reports=reports,
        )
        spec = AgentSpec(
            user_prompt=prompt,
            system_prompt="\n\n".join(system_parts),
            cwd=run.worktree_path or str(root),
            runner=step.runner or run.runner,
            model=step.model or run.model,
            cancel=cancel,
            allowed_tools=step.allowed_tools,
            bash_allowlist=step.bash_allowlist,
            session_id=run.id,
            resume=bool(followup) or run.step_index > 0,
        )
        texts: list[str] = []
        gained = 0
        async for event in self._agent_for(spec.runner).stream(spec):
            gained += event.input_tokens + event.output_tokens
            if event.type == "text" and event.text:
                parsed = usage_from_line(event.text)
                if parsed is not None:
                    gained += parsed[0] + parsed[1]
                texts.append(event.text)
            await self._note(run.id, event.type, event.text or event.name, step.id)
            if event.type == "error":
                if cancel.is_set() or event.text == "cancelled":
                    await self._mark_cancelled(get_run(self.db, run.id) or run)
                    return "stop"
                await self._fail(get_run(self.db, run.id) or run, event.text or "agent failed")
                return "stop"
        current = get_run(self.db, run.id) or run
        current.tokens_used += gained
        if reports:
            current.pending_reports = []
        joined = "\n".join(texts)
        if "CEZ:ASK" in joined and not followup:
            current.status = "waiting"
            current.ask = _ask_line(joined)
            await self._save(current)
            await self._note(current.id, "lifecycle", "waiting")
            return "stop"
        current.pending_note = ""
        current.check_failure = ""
        await self._save(current)
        return "ok"

    async def _check(self, run: Run, step: Step, cancel: asyncio.Event) -> str:
        if step.has_secrets:
            await self._fail(
                run,
                "this check names project secrets, and the Python port has no secrets vault",
            )
            return "stop"
        code, output = await run_shell(
            step.command,
            Path(run.worktree_path or "."),
            cancel,
            self.config.check_timeout_seconds,
        )
        await self._note(run.id, "check-output", output or f"exit {code}", step.id)
        if cancel.is_set() or code < 0:
            await self._mark_cancelled(get_run(self.db, run.id) or run)
            return "stop"
        if code == 0:
            return "ok"
        current = get_run(self.db, run.id) or run
        if step.retry and retryable_exit(step.retry_on, code):
            used = current.retries.get(step.id, 0)
            target = next(
                (i for i, item in enumerate(current.definition().steps) if item.id == step.retry),
                -1,
            )
            if target >= 0 and used < step.retry_max:
                current.retries[step.id] = used + 1
                current.check_failure = output[-8_000:] or "(no output)"
                current.pending_note = ""
                current.step_index = target
                await self._save(current)
                await self._note(
                    current.id,
                    "note",
                    (
                        f'check "{step.id}" failed; retrying "{step.retry}" '
                        f"({used + 1}/{step.retry_max})"
                    ),
                    step.id,
                )
                return "jump"
        if step.retry:
            message = f'check "{step.id}" failed after {step.retry_max + 1} attempts'
        else:
            message = f'check "{step.id}" failed (exit {code})'
        await self._fail(current, message)
        return "stop"

    async def _enter_review(self, run: Run) -> None:
        current = get_run(self.db, run.id) or run
        if current.status in ("cancelled", "failed"):
            return
        current.status = "review"
        current.finished_at = stamp()
        current.ask = ""
        current.mode = "workflow"
        await self._save(current)
        if current.worktree_path and current.base_sha and not current.in_place:
            diff = await asyncio.to_thread(
                diff_against, Path(current.worktree_path), current.base_sha
            )
            await self._note(
                current.id,
                "note",
                f"{diff.files} files, +{diff.adds} −{diff.dels}",
            )
        await self._note(current.id, "lifecycle", "review")

    async def _fail(self, run: Run, message: str) -> Run:
        run.status = "failed"
        run.error = message
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "error", message)
        await self._note(run.id, "lifecycle", "failed")
        return run

    async def _mark_cancelled(self, run: Run) -> None:
        if run.status == "cancelled":
            return
        run.status = "cancelled"
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "lifecycle", "cancelled")

    async def _save(self, run: Run) -> None:
        await self.db.write(save_run, run)
        self.publish()

    async def _note(self, run_id: str, type: str, text: str, step_id: str = "") -> None:
        await self.db.write(add_event, run_id, type, text, step_id, stamp())
        self.publish()

    def _agent_for(self, runner: str) -> Runner:
        if self.agent is not None:
            return self.agent
        if self.config.dry_run:
            from app.engine.agents import DryRunAgent

            return DryRunAgent()
        from app.engine.runners.protocol import ProtocolRunner

        return ProtocolRunner(
            runner,
            self.config.runner_bins.get(runner, runner),
            approval_gate=self.config.approval_gate,
            codex_network_off=self.config.codex_network_off,
        )

    def plan_run(
        self,
        *,
        project: Project,
        task: str,
        workflow_name: str,
        runner: str,
        model: str = "",
        autonomous: bool = False,
        parent: Run | None = None,
        budget_usd: float | None = None,
        base_branch: str = "",
        kind: str = "implement",
    ) -> tuple[Run | None, str | None]:
        text = task.strip()
        if not text:
            return None, "task is empty"
        if len(text) > 20_000:
            return None, "task is too long"
        if runner not in RUNNERS:
            return None, f"unknown runner {runner}"
        workflow = find_workflow(Path(project.root), workflow_name)
        if workflow is None:
            return None, f'unknown workflow "{workflow_name}"'
        run = Run(
            id=uuid.uuid4().hex,
            project_id=project.id,
            title=title_from(text),
            task=text,
            workflow=workflow.name,
            status="queued",
            runner=runner,
            created_at=stamp(),
            workflow_def=workflow.to_json(),
            autonomous=autonomous,
            model=model.strip(),
            parent_id=parent.id if parent else "",
            root_id=(parent.root_id or parent.id) if parent else "",
            budget_usd=budget_usd,
            base_branch=base_branch,
            kind=kind,
        )
        return run, None

    async def enqueue(self, run: Run) -> None:
        await self.db.write(insert_run, run)
        self.publish()
        self.kick()

    async def cancel(self, run_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status not in ("queued", "running", "waiting", "review"):
            return "cannot cancel a settled run"
        self._cancel.setdefault(run_id, asyncio.Event()).set()
        await self._mark_cancelled(run)
        await self._report_child(run_id)
        self.kick()
        return None

    async def finish(self, run_id: str) -> str | None:
        """Accept the review gate. The branch stays where the agent left it."""
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status != "review":
            return "only a run in review can be finished"
        run.status = "done"
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "lifecycle", "done")
        await self._report_child(run_id)
        return None

    async def delete(self, run_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status in ("queued", "running", "waiting"):
            return "cancel the run before deleting it"
        project = get_project(self.db, run.project_id)
        if project and run.worktree_path and not run.in_place:
            await asyncio.to_thread(
                remove_worktree,
                Path(project.root),
                Path(run.worktree_path),
                run.branch,
            )
        await self.db.write(delete_run_row, run_id)
        self.publish()
        return None

    async def deliver(self, run_id: str, message: str) -> str | None:
        text = message.strip()
        if not text:
            return "message is empty"
        if len(text) > 20_000:
            return "message is too long"
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status == "waiting":
            run.pending_note = f"The user answered:\n{text}"
            run.ask = ""
            run.status = "queued"
            await self._save(run)
            self.kick()
            return None
        if run.status == "review":
            run.mode = "followup"
            run.continuation = text
            run.status = "queued"
            run.finished_at = ""
            await self._save(run)
            self.kick()
            return None
        return "a message can be sent to a run that is waiting or in review"

    async def dispatch(self, parent_id: str, order: DispatchOrder) -> tuple[str | None, str | None]:
        if not self.config.dispatch_enabled:
            return None, "dispatch is disabled on this cockpit (CEZ_DISPATCH=0)"
        parent = get_run(self.db, parent_id)
        if parent is None:
            return None, "not found"
        if parent.status in TERMINAL:
            return None, f"run {parent_id} has already settled ({parent.status})"
        if parent.in_place or not parent.branch:
            reason = "the parent has no branch yet"
            await self._note(parent.id, "note", f"dispatch refused — {reason}")
            return None, reason
        project = get_project(self.db, parent.project_id)
        if project is None:
            return None, "project is gone"
        in_flight = count_in_flight_children(self.db, parent.id)
        refusal = in_flight_refusal(in_flight)
        if refusal:
            await self._note(parent.id, "note", f"dispatch refused — {refusal}")
            return None, refusal
        children = list_children(self.db, parent.id)
        budget, reason = carve_child_budget(
            parent.budget_usd,
            parent.cost_usd,
            [BudgetChild(child.status, child.cost_usd, child.budget_usd) for child in children],
            order.max_cost,
        )
        if reason:
            await self._note(parent.id, "note", f"dispatch refused — {reason}")
            return None, reason
        objective = order.objective.strip()
        if not objective:
            return None, "objective is empty"
        envelope = child_task_envelope(order, parent.id, parent.branch)
        workflow = Workflow(
            name="(planned)",
            description="",
            source="built-in",
            steps=(Step(id="task", name=title_from(objective), prompt="{{task}}"),),
        )
        child = Run(
            id=uuid.uuid4().hex,
            project_id=parent.project_id,
            title=order.title.strip() or title_from(objective),
            task=envelope,
            workflow=workflow.name,
            status="queued",
            runner=parent.runner,
            created_at=stamp(),
            workflow_def=workflow.to_json(),
            autonomous=True,
            model=parent.model,
            parent_id=parent.id,
            root_id=parent.root_id or parent.id,
            budget_usd=budget,
            base_branch=parent.branch,
            kind=order.kind or "implement",
        )
        await self.enqueue(child)
        await self._note(parent.id, "note", f'dispatched "{child.title}" ({child.id})')
        return child.id, None

    async def _report_child(self, run_id: str) -> None:
        run = get_run(self.db, run_id)
        if run is None or not run.parent_id or run.reported or run.status not in TERMINAL:
            return
        text, mapped = child_report_text(
            title=run.title,
            run_id=run.id,
            status=run.status,
            branch=run.branch,
            base_branch=run.base_branch,
            error=run.error,
            cost_usd=run.cost_usd,
        )
        entry: dict[str, object] = {
            "title": run.title,
            "text": text,
            "status": mapped,
            "from_id": run.id,
            "at": stamp(),
        }
        await self.db.write(_persist_report, run.id, run.parent_id, entry)
        self.publish()

    async def _ensure_boot_project(self) -> None:
        root = str(self.config.repo_root)
        existing = find_project_by_root(self.db, root)
        if existing is not None:
            self.boot_project_id = existing.id
            return
        taken = {project.id for project in list_projects(self.db)}
        branch = (
            head_branch(self.config.repo_root) if is_git_repo(self.config.repo_root) else "main"
        )
        project = Project(
            id=slug_for(self.config.repo_root.name, taken),
            name=self.config.repo_root.name,
            root=root,
            base_branch=branch,
            created_at=stamp(),
        )
        await self.db.write(insert_project, project)
        self.boot_project_id = project.id

    async def add_project(self, path: Path) -> tuple[Project | None, str | None]:
        root = path.expanduser().resolve()
        if not root.is_dir():
            return None, "that path is not a directory"
        if root == Path.home().resolve():
            return None, "refusing to register the home directory"
        existing = find_project_by_root(self.db, str(root))
        if existing is not None:
            return None, "that directory is already a project"
        taken = {project.id for project in list_projects(self.db)}
        branch = head_branch(root) if is_git_repo(root) else "main"
        project = Project(
            id=slug_for(root.name, taken),
            name=root.name,
            root=str(root),
            base_branch=branch,
            created_at=stamp(),
        )
        await self.db.write(insert_project, project)
        self.publish()
        return project, None

    async def set_base_branch(self, project_id: str, branch: str) -> str | None:
        from app.engine.gitwork import is_safe_git_ref

        if not is_safe_git_ref(branch) or len(branch) > 200 or any(ch.isspace() for ch in branch):
            return "base branch must be a plain git ref"
        project = get_project(self.db, project_id)
        if project is None:
            return "not found"
        await self.db.write(save_project, replace(project, base_branch=branch))
        self.publish()
        return None

    async def save_workspace(self, settings: Settings) -> None:
        from app.store.db import save_settings

        await self.db.write(save_settings, settings)
        self.publish()

    async def create_automation(self, item: Automation) -> None:
        from app.store.db import insert_automation

        await self.db.write(insert_automation, item)
        self.publish()

    async def set_automation_enabled(self, automation_id: str, enabled: bool) -> str | None:
        item = await self._automation(automation_id)
        if item is None:
            return "not found"
        moment = now()
        nxt = item.next_at
        due = parse_stamp(item.next_at)
        if enabled and (due is None or due < moment):
            nxt = after(item.every_minutes, moment)
        await self.db.write(save_automation, replace(item, enabled=enabled, next_at=nxt))
        self.publish()
        return None

    async def run_automation_now(self, automation_id: str) -> tuple[str | None, str | None]:
        item = await self._automation(automation_id)
        if item is None:
            return None, "not found"
        run_id = await self._spawn_automation(item, move_schedule=False)
        if run_id is None:
            return None, "could not start a run"
        return run_id, None

    async def remove_automation(self, automation_id: str) -> str | None:
        from app.store.db import delete_automation

        if await self._automation(automation_id) is None:
            return "not found"
        await self.db.write(delete_automation, automation_id)
        self.publish()
        return None

    async def _automation(self, automation_id: str) -> Automation | None:
        from app.store.db import get_automation

        return get_automation(self.db, automation_id)

    async def _launch_due(self) -> None:
        moment = now()
        for item in list_enabled_automations(self.db):
            due = parse_stamp(item.next_at)
            if due is not None and due <= moment:
                await self._spawn_automation(item, move_schedule=True)

    async def _spawn_automation(self, item: Automation, *, move_schedule: bool) -> str | None:
        project = get_project(self.db, item.project_id)
        if project is None:
            return None
        settings = get_settings(self.db)
        run, _error = self.plan_run(
            project=project,
            task=item.task,
            workflow_name=item.workflow,
            runner=item.runner or settings.default_runner,
            autonomous=True,
        )
        if run is None:
            return None
        await self.enqueue(run)
        updated = replace(item, last_run_id=run.id)
        if move_schedule:
            updated = replace(updated, next_at=after(item.every_minutes))
        await self.db.write(save_automation, updated)
        self.publish()
        return run.id


def rebaseline_automations(tx: Tx) -> None:
    """An idle schedule does not launch a backlog when it wakes."""
    from app.store.db import IdData, _automation

    moment = now()
    rows = tx.query("SELECT id, data FROM automations WHERE enabled = 1", IdData)
    for row in rows:
        item = _automation(row)
        due = parse_stamp(item.next_at)
        if due is None:
            continue
        from datetime import timedelta

        if due < moment - timedelta(minutes=item.every_minutes):
            save_automation(tx, replace(item, next_at=after(item.every_minutes, moment)))


def _persist_report(tx: Tx, child_id: str, parent_id: str, entry: dict[str, object]) -> None:
    child = get_run_tx(tx, child_id)
    if child is None or child.reported or child.status not in TERMINAL:
        return
    child.reported = True
    save_run(tx, child)
    parent = get_run_tx(tx, parent_id)
    if parent is None:
        return
    parent.pending_reports = append_report(parent.pending_reports, entry)
    save_run(tx, parent)
    add_event(tx, parent.id, "note", str(entry.get("text", "")), "", stamp())


async def run_shell(
    command: str, cwd: Path, cancel: asyncio.Event, timeout: float
) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        "sh",
        "-c",
        command,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    communicate = asyncio.create_task(proc.communicate())
    stopper = asyncio.create_task(cancel.wait())
    timer = asyncio.create_task(asyncio.sleep(timeout))
    done, pending = await asyncio.wait(
        {communicate, stopper, timer},
        return_when=asyncio.FIRST_COMPLETED,
    )
    if communicate not in done:
        proc.kill()
        await proc.wait()
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending)
    if communicate not in done:
        if cancel.is_set():
            return -1, "cancelled"
        return 124, "check timed out"
    out, _err = communicate.result()
    text = out.decode(errors="replace")
    if len(text) > 16_000:
        text = text[:16_000] + "\n… truncated\n"
    code = proc.returncode if proc.returncode is not None else 1
    return code, text
