"""Queue, worktrees, and the workflow walk.

A successful workflow stops at `done` unless the review gate is on.
Finish records `done`. Neither merges.
`waiting` does not hold a parallelism slot: the agent process has already exited.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, cast

from litewriter import LiteWriter, Tx
from litewriter.errors import StateError
from stario import App, Relay

from app.clock import after, now, parse_stamp, stamp
from app.config import RUNNERS, Config
from app.engine.agents import AgentSpec, Runner, usage_from_line
from app.engine.catalog import find_workflow, load_workflows
from app.engine.deferred import DeferredBuffer
from app.engine.deltas import DeltaCoalescer
from app.engine.dispatch_logic import (
    BudgetChild,
    DispatchOrder,
    append_report,
    carve_child_budget,
    child_report_text,
    child_task_envelope,
    in_flight_refusal,
)
from app.engine.git_actions import (
    commit_all,
    create_draft_pr,
    push_branch,
    sync_base,
    worktree_git_status,
)
from app.engine.gitignore_data import ensure_data_gitignore
from app.engine.gitwork import (
    WorktreeError,
    create_worktree,
    diff_against,
    drop_worktree_dir,
    head_branch,
    is_git_repo,
    prune_orphans,
    remove_worktree,
)
from app.engine.graph import advance, compare_values, enter_graph, fork_shape, render_refs
from app.engine.instructions import run_instructions
from app.engine.model import TERMINAL, Automation, Project, Run, Settings, Step, Workflow
from app.engine.namer import propose_name
from app.engine.prompts import build_user_prompt
from app.engine.receipts import archive_finished as sweep_archive
from app.engine.receipts import mark_all_read as sweep_read
from app.engine.retention import select_index_prune, select_reclaimable
from app.engine.review_gate import review_gate_enabled
from app.engine.session_extras import load_project_mcp, prompt_task, v2_snapshots
from app.engine.skills import find_skill
from app.engine.terminal_hub import TerminalHub
from app.engine.uploads import materialize
from app.engine.workflows import newer_catalog_workflow, retryable_exit
from app.secrets.store import SecretStore, redact
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
    list_runs,
    save_automation,
    save_project,
    save_run,
)

CHANGED = "cezar.changed"


def _pr_number(url: str) -> str:
    if "/pull/" not in url:
        return ""
    number = url.rstrip("/").rsplit("/", 1)[-1]
    return number if number.isdigit() else ""


def _gh_checks(cwd: Path, number: str) -> str:
    import json
    import subprocess

    try:
        proc = subprocess.run(
            ["gh", "pr", "checks", number, "--json", "state"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return ""
    if proc.returncode != 0:
        return ""
    try:
        loaded = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return ""
    if not isinstance(loaded, list) or not loaded:
        return "pending"
    states = [str(item.get("state", "")).upper() for item in loaded if isinstance(item, dict)]
    if any(state in ("FAILURE", "ERROR", "CANCELLED") for state in states):
        return "failing"
    if states and all(state == "SUCCESS" for state in states):
        return "passing"
    return "pending"


def _usage_event(total: int, gained: int) -> str:
    import json

    return json.dumps({"type": "usage.updated", "usage": {"total": total, "delta": gained}})


def _delta_snapshot(text: str) -> str:
    import json

    item = {"id": "message", "type": "message", "text": text}
    return json.dumps({"type": "item.completed", "item": item}, separators=(",", ":"))


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
    _finish: set[str] = field(default_factory=set)
    _live: dict[str, list[Callable[[dict[str, object]], None]]] = field(default_factory=dict)
    _wake: asyncio.Event = field(default_factory=asyncio.Event)
    _runners: dict[str, Runner] = field(default_factory=dict)
    _deferred_buf: DeferredBuffer | None = None
    _coalescer: DeltaCoalescer = field(default_factory=DeltaCoalescer)
    _terminals: TerminalHub = field(default_factory=TerminalHub)

    def subscribe_events(
        self, run_id: str, listener: Callable[[dict[str, object]], None]
    ) -> Callable[[], None]:
        bucket = self._live.setdefault(run_id, [])
        bucket.append(listener)

        def off() -> None:
            current = self._live.get(run_id, [])
            if listener in current:
                current.remove(listener)

        return off

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
                await self.retain()
        for run_id, message in self._buffer().lost_on_startup():
            if get_run(self.db, run_id) is not None:
                await self._note(run_id, "lifecycle", message)
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
        await self._launch_due()
        settings = get_settings(self.db)
        alive = [run_id for run_id, task in self._tasks.items() if not task.done()]
        slots = settings.max_parallel - len(alive)
        for run in list_queued(self.db):
            if slots <= 0:
                return
            if run.id in alive or run.id in self._tasks:
                continue
            self._tasks[run.id] = self._spawn(run.id)
            slots -= 1

    def _spawn(self, run_id: str) -> asyncio.Task[None]:
        name = f"run-{run_id[:8]}"
        if self.app is not None:
            return self.app.create_task(self.execute(run_id), name=name)
        return asyncio.create_task(self.execute(run_id), name=name)

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
            try:
                current = get_run(self.db, run_id)
                if current is not None and current.status == "running":
                    current.status = "failed"
                    current.error = "interrupted by shutdown"
                    current.finished_at = stamp()
                    await self.db.write(save_run, current)
            except StateError:
                pass
            raise
        except StateError:
            return
        finally:
            try:
                await self._report_child(run_id)
            except StateError:
                pass
            self._tasks.pop(run_id, None)
            self._cancel.pop(run_id, None)
            self.kick()

    async def _workflow(self, run: Run, cancel: asyncio.Event) -> None:
        run = await self._prepare(run)
        if run.status == "failed":
            return
        if run.definition().graph:
            await self._graph_walk(run, cancel)
            return
        if run.step_index == 0 and not run.pending_note:
            run = await self._refresh_workflow(run)
        while True:
            run = get_run(self.db, run.id) or run
            if run.status in ("cancelled", "failed", "waiting"):
                return
            if cancel.is_set():
                if run.id in self._finish:
                    await self._mark_done(run)
                else:
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
            upcoming = current.definition().steps
            nxt = upcoming[current.step_index] if current.step_index < len(upcoming) else None
            if nxt is not None and nxt.kind == "agent":
                held = self._buffer().take(current.id)
                if held:
                    current.pending_note = "\n\n".join(held)
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
            await self._lay_down_attachments(run)
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
            await self._lay_down_attachments(run)
            await self._save(run)
            await self._note(run.id, "note", "not a git repository; ran in place")
            return run
        _prompt, naming = run_instructions(root)
        named = await propose_name(
            run.task,
            naming,
            dry_run=self.config.dry_run,
            cwd=root,
            binary=self.config.runner_bins.get("claude", "claude"),
        )
        wanted = named.branch if named and named.branch else None
        if named and named.title:
            run.title = named.title
        try:
            path, branch, sha = await asyncio.to_thread(
                create_worktree,
                root,
                run.id,
                base,
                fetch=not self.config.dry_run,
                branch=wanted,
            )
        except WorktreeError as exc:
            return await self._fail(run, str(exc))
        run.worktree_path = str(path)
        run.branch = branch
        run.base_sha = sha
        run.base_branch = base
        await self._lay_down_attachments(run)
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

    async def _graph_walk(self, run: Run, cancel: asyncio.Event) -> None:
        graph = run.definition().graph
        if not isinstance(graph, dict):
            await self._fail(run, "graph workflow has no graph")
            return
        body = cast(dict[str, Any], graph)
        loops: dict[str, int] = {}
        outputs: dict[str, dict[str, str]] = {}
        cursor = enter_graph(body, loops)
        for _guard in range(50):
            if cancel.is_set():
                if run.id in self._finish:
                    await self._mark_done(get_run(self.db, run.id) or run)
                else:
                    await self._mark_cancelled(get_run(self.db, run.id) or run)
                return
            if cursor.kind != "node" or cursor.node is None:
                current = get_run(self.db, run.id) or run
                if cursor.status == "failed":
                    await self._fail(current, "the graph ended on a failure port")
                else:
                    await self._enter_review(current)
                return
            node = cursor.node
            node_id = str(node.get("id", ""))
            kind = str(node.get("type", ""))
            await self._note(run.id, "step-start", str(node.get("name") or node_id), node_id)
            if kind == "agent":
                prompt = render_refs(str(node.get("prompt") or "{{task}}"), outputs)
                step = Step(
                    id=node_id,
                    name=str(node.get("name") or node_id),
                    prompt=prompt,
                    skill=str(node.get("skill") or ""),
                    runner=str(node.get("runner") or ""),
                    model=str(node.get("model") or ""),
                )
                action = await self._agent_step(run, cancel, graph_step=step)
                if action == "stop":
                    return
                outputs[node_id] = {"summary": "done"}
                port = "done"
            elif kind == "check":
                command = render_refs(str(node.get("command") or ""), outputs)
                raw_allow = node.get("bashAllowlist")
                allow = (
                    tuple(item for item in raw_allow if isinstance(item, str))
                    if isinstance(raw_allow, list)
                    else ()
                )
                step = Step(id=node_id, name=node_id, command=command, bash_allowlist=allow)
                code, output = await self._run_check(run, step, cancel)
                await self._note(run.id, "check-output", output or f"exit {code}", node_id)
                if cancel.is_set() or code < 0:
                    await self._mark_cancelled(get_run(self.db, run.id) or run)
                    return
                outputs[node_id] = {"exitCode": str(code), "output": output[-2_000:]}
                port = "pass" if code == 0 else "fail"
            elif kind == "if":
                port = _if_port(run, node, outputs)
            else:
                outcome = await self._graph_system(run, cancel, body, node, outputs)
                if outcome is None:
                    return
                port, node_id = outcome
            cursor = advance(body, node_id, port, loops)
        await self._fail(run, "graph walk did not end")

    async def _graph_system(
        self,
        run: Run,
        cancel: asyncio.Event,
        graph: dict[str, Any],
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        kind = str(node.get("type", ""))
        if kind == "join":
            await self._fail(run, "a join can only be reached from a fork")
            return None
        if kind == "fork":
            return await self._run_fork(run, cancel, graph, node, outputs)
        if kind == "dispatch":
            return await self._run_dispatch(run, cancel, node, outputs)
        if kind == "git.commit":
            return await self._run_git_commit(run, node, outputs)
        if kind == "git.push":
            return await self._run_git_push(run, node_id)
        if kind == "git.sync-base":
            return await self._run_git_sync(run, node_id)
        if kind == "github.draft-pr":
            return await self._run_draft_pr(run, node, outputs)
        if kind == "github.wait-ci":
            return await self._run_wait_ci(run, node, outputs)
        if kind in ("github.pr-comment", "github.issue-comment", "github.pr-update"):
            return await self._run_github_note(run, node)
        await self._fail(run, f'graph node "{node_id}" ({kind}) is not executed by the Python port')
        return None

    async def _run_fork(
        self,
        run: Run,
        cancel: asyncio.Event,
        graph: dict[str, Any],
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        shape = fork_shape(graph, node_id)
        if isinstance(shape, str):
            await self._fail(run, shape)
            return None
        child_ids: list[str] = []
        for branch in shape.branches:
            prompt = render_refs(str(branch.agent.get("prompt") or "{{task}}"), outputs)
            title = str(branch.agent.get("name") or branch.agent.get("id") or "branch")
            child_id, reason = await self.dispatch(
                run.id,
                DispatchOrder(objective=prompt[:4_000], title=title),
            )
            if reason or not child_id:
                await self._note(run.id, "note", f'branch "{title}" refused — {reason}', node_id)
                continue
            child_ids.append(child_id)
            outputs[str(branch.agent.get("id", ""))] = {"runId": child_id, "status": "running"}
        outputs[node_id] = {"runIds": ",".join(child_ids)}
        if not child_ids:
            return "failed", shape.join
        settled = await self._await_children(child_ids, shape.wait, cancel)
        if settled is None:
            await self._mark_cancelled(get_run(self.db, run.id) or run)
            return None
        succeeded = [item for item in settled.values() if item in ("done", "review")]
        if shape.wait == "any":
            port = "done" if succeeded else "failed"
        else:
            port = "done" if len(succeeded) == len(child_ids) else "failed"
        await self._note(
            run.id,
            "note",
            f"fork {node_id}: {len(succeeded)} succeeded, {len(settled) - len(succeeded)} failed",
            node_id,
        )
        return port, shape.join

    async def _run_dispatch(
        self,
        run: Run,
        cancel: asyncio.Event,
        node: dict[str, Any],
        outputs: dict[str, dict[str, str]],
    ) -> tuple[str, str] | None:
        node_id = str(node.get("id", ""))
        prompt = render_refs(str(node.get("prompt") or "{{task}}"), outputs)
        child_id, reason = await self.dispatch(
            run.id,
            DispatchOrder(
                objective=prompt[:4_000],
                title=str(node.get("name") or node_id),
            ),
        )
        if reason or not child_id:
            await self._note(run.id, "note", f"dispatch refused — {reason}", node_id)
            return "failed", node_id
        outputs[node_id] = {"runId": child_id, "status": "running", "summary": ""}
        settled = await self._await_children([child_id], "all", cancel)
        if settled is None:
            await self._mark_cancelled(get_run(self.db, run.id) or run)
            return None
        status = settled.get(child_id, "failed")
        outputs[node_id] = {"runId": child_id, "status": status, "summary": ""}
        return ("done" if status in ("done", "review") else "failed"), node_id

    async def _await_children(
        self, child_ids: list[str], mode: str, cancel: asyncio.Event
    ) -> dict[str, str] | None:
        pending = list(child_ids)
        settled: dict[str, str] = {}
        while pending:
            if cancel.is_set():
                return None
            await self.tick()
            still: list[str] = []
            for child_id in pending:
                child = get_run(self.db, child_id)
                if child is None:
                    settled[child_id] = "failed"
                    continue
                if child.status in ("done", "review", "failed", "cancelled"):
                    settled[child_id] = child.status
                    continue
                still.append(child_id)
            pending = still
            if mode == "any" and any(status in ("done", "review") for status in settled.values()):
                for child_id in pending:
                    await self.cancel(child_id)
                break
            if pending:
                await asyncio.sleep(0.05)
        return settled

    async def _run_git_commit(
        self, run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        cwd = Path(run.worktree_path or ".")
        message = render_refs(str(node.get("message") or "cezar graph commit"), outputs)
        result = await asyncio.to_thread(commit_all, cwd, message)
        if result.get("ok") != "true":
            await self._note(run.id, "note", str(result.get("error", "commit failed")), node_id)
            return "failed", node_id
        if result.get("result") == "nothing":
            await self._note(run.id, "note", "nothing to commit", node_id)
            return "nothing", node_id
        sha = str(result.get("sha", ""))
        outputs[node_id] = {"sha": sha}
        await self._note(run.id, "note", f"committed {sha[:8]}", node_id)
        return "done", node_id

    async def _run_git_push(self, run: Run, node_id: str) -> tuple[str, str]:
        if not run.branch or run.in_place:
            await self._note(run.id, "note", "this task has no branch of its own to push", node_id)
            return "failed", node_id
        result = await asyncio.to_thread(
            push_branch, Path(run.worktree_path or "."), run.branch, dry_run=self.config.dry_run
        )
        if not result.get("ok"):
            await self._note(run.id, "note", str(result.get("error", "push failed")), node_id)
            return "failed", node_id
        await self._note(run.id, "note", f"pushed {run.branch}", node_id)
        return "done", node_id

    async def _run_git_sync(self, run: Run, node_id: str) -> tuple[str, str]:
        result = await asyncio.to_thread(sync_base, Path(run.worktree_path or "."), run.base_branch)
        if result.get("ok") != "true":
            await self._note(run.id, "note", str(result.get("error", "sync failed")), node_id)
            return "failed", node_id
        port = str(result.get("port", "failed"))
        await self._note(run.id, "note", f"sync with {run.base_branch}: {port}", node_id)
        return port, node_id

    async def _run_draft_pr(
        self, run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        if run.pull_request_url:
            outputs[node_id] = {"url": run.pull_request_url}
            await self._note(
                run.id, "note", f"draft PR already open: {run.pull_request_url}", node_id
            )
            return "created", node_id
        title = render_refs(str(node.get("title") or run.title), outputs)
        result = await asyncio.to_thread(
            create_draft_pr,
            Path(run.worktree_path or "."),
            run.branch,
            title,
            dry_run=self.config.dry_run,
        )
        if not result.get("ok"):
            await self._note(run.id, "note", str(result.get("error", "draft PR failed")), node_id)
            return "failed", node_id
        url = str(result.get("url", ""))
        run.pull_request_url = url
        await self._save(run)
        outputs[node_id] = {"url": url}
        note = f"draft PR opened: {url}"
        if result.get("dryRun"):
            note += " (dry run — no real PR)"
        await self._note(run.id, "note", note, node_id)
        return "created", node_id

    async def _run_wait_ci(
        self, run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]
    ) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        number = _pr_number(run.pull_request_url)
        if not number:
            await self._note(run.id, "note", "no PR on this task — nothing to wait for", node_id)
            outputs[node_id] = {"status": "no-pr"}
            return "failed", node_id
        if self.config.dry_run:
            await self._note(
                run.id, "note", f"dry run — CI on PR #{number} reported green", node_id
            )
            outputs[node_id] = {"status": "passing"}
            return "green", node_id
        glyph = await asyncio.to_thread(_gh_checks, Path(run.worktree_path or "."), number)
        port = "green" if glyph == "passing" else "red" if glyph == "failing" else "timeout"
        outputs[node_id] = {"status": glyph or "timeout"}
        await self._note(run.id, "note", f"CI on PR #{number}: {glyph or 'timeout'}", node_id)
        return port, node_id

    async def _run_github_note(self, run: Run, node: dict[str, Any]) -> tuple[str, str]:
        node_id = str(node.get("id", ""))
        kind = str(node.get("type", ""))
        if self.config.dry_run:
            await self._note(run.id, "note", f"{kind} skipped in dry run", node_id)
            return "done", node_id
        await self._note(
            run.id, "note", f"{kind} is not executed against GitHub by this port", node_id
        )
        return "failed", node_id

    async def _agent_step(
        self,
        run: Run,
        cancel: asyncio.Event,
        followup: str = "",
        graph_step: Step | None = None,
    ) -> str:
        steps = run.definition().steps
        index = run.step_index if not followup else 0
        if graph_step is not None:
            steps = (graph_step,)
            index = 0
        elif followup:
            steps = (Step(id="followup", name="Follow up", prompt=followup),)
            index = 0
        elif index >= len(steps):
            return "stop"
        step = steps[index]
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        system_parts: list[str] = []
        # Global rules first; the project's own prompt follows and wins on conflict.
        from app.features.settings.store import read_prompt

        global_prompt = read_prompt(self.config.data_dir).strip()
        if global_prompt:
            system_parts.append(global_prompt)
        instructions, _naming = run_instructions(root)
        if instructions:
            system_parts.append(instructions)
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
            prompt_task(run),
            check_failure=run.check_failure,
            pending_note=run.pending_note,
            reports=reports,
        )
        if run.attachment_paths:
            prompt += "\n\nThe user attached:\n" + "\n".join(run.attachment_paths)
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
            timeout_ms=15 * 60 * 1000,
            images=tuple(
                {"mediaType": str(image.get("mediaType", "")), "data": str(image.get("data", ""))}
                for image in run.images
                if index == 0 and not followup
            ),
            mcp_servers=load_project_mcp(root),
            codex_thread=run.codex_thread,
        )
        texts: list[str] = []
        gained = 0
        saw_text = False
        try:
            async for event in self._agent_for(spec.runner).stream(spec):
                gained += event.input_tokens + event.output_tokens
                if event.type == "delta" and event.text:
                    self._coalescer.push(run.id, "message", "text", event.text, self._live_delta)
                    continue
                if event.type == "plan" and event.text:
                    await self._note(run.id, "plan.updated", event.text, step.id)
                    continue
                if event.type == "text" and event.text:
                    saw_text = True
                    parsed = usage_from_line(event.text)
                    if parsed is not None:
                        gained += parsed[0] + parsed[1]
                    texts.append(event.text)
                if event.type == "session" and event.text:
                    current_run = get_run(self.db, run.id) or run
                    current_run.codex_thread = event.text
                    await self._save(current_run)
                    continue
                if event.type == "text" and event.text:
                    await self._emit_live(run.id, "item.delta", event.text, step.id)
                await self._note(run.id, event.type, event.text or event.name, step.id)
                for v2_type, v2_text in v2_snapshots(event.type, event.text, event.name, step.id):
                    await self._note(run.id, v2_type, v2_text, step.id)
                if event.type == "error":
                    if cancel.is_set() or event.text == "cancelled":
                        if run.id in self._finish:
                            await self._mark_done(get_run(self.db, run.id) or run)
                        else:
                            await self._mark_cancelled(get_run(self.db, run.id) or run)
                        return "stop"
                    await self._fail(get_run(self.db, run.id) or run, event.text or "agent failed")
                    return "stop"
        finally:
            self._coalescer.flush()
        if not saw_text:
            full = self._coalescer.take_full(run.id, "message")
            if full:
                await self._note(
                    run.id,
                    "item.completed",
                    _delta_snapshot(full),
                    step.id,
                )
        else:
            self._coalescer.take_full(run.id, "message")
        current = get_run(self.db, run.id) or run
        current.tokens_used += gained
        if gained:
            await self._note(
                current.id,
                "usage.updated",
                _usage_event(current.tokens_used, gained),
                step.id,
            )
        if reports:
            current.pending_reports = []
        joined = "\n".join(texts)
        if "CEZ:ASK" in joined and not followup and run.id not in self._finish:
            current.status = "waiting"
            current.ask = _ask_line(joined)
            current.awaiting_answer_since = stamp()
            await self._save(current)
            await self._note(current.id, "lifecycle", "waiting")
            self._notify(current, "running")
            return "stop"
        current.pending_note = ""
        current.check_failure = ""
        await self._save(current)
        return "ok"

    async def _run_check(self, run: Run, step: Step, cancel: asyncio.Event) -> tuple[int, str]:
        project = get_project(self.db, run.project_id)
        store = SecretStore(self.config.data_dir / "secrets")
        values, notes = store.resolve(
            "checks",
            project_id=run.project_id,
            root=project.root if project else "",
            bindings=step.secret_bindings,
        )
        for note in notes:
            await self._note(run.id, "note", note, step.id)
        env = {key: value for key, value in os.environ.items() if not key.startswith("CEZ_")}
        env.update(
            {
                "CEZ_RUN_ID": run.id,
                "CEZ_STEP_ID": step.id,
                "CEZ_WORKTREE": run.worktree_path or "",
                "CEZ_ATTEMPT": "1",
            }
        )
        if run.project_id:
            env["CEZ_PROJECT_ID"] = run.project_id
        if run.branch:
            env["CEZ_BRANCH"] = run.branch
        if run.base_branch:
            env["CEZ_BASE"] = run.base_branch
        env.update(values)
        code, output = await run_shell(
            step.command,
            Path(run.worktree_path or "."),
            cancel,
            self.config.check_timeout_seconds,
            env,
        )
        return code, redact(output, list(values.values()))

    async def _check(self, run: Run, step: Step, cancel: asyncio.Event) -> str:
        # The TypeScript check shell is always `bash -lc`. `bashAllowlist` is an
        # agent-argv concern and does not gate the command.
        code, output = await self._run_check(run, step, cancel)
        await self._note(run.id, "check-output", output or f"exit {code}", step.id)
        if cancel.is_set() or code < 0:
            if run.id in self._finish:
                await self._mark_done(get_run(self.db, run.id) or run)
            else:
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

    async def _review_applies(self, run: Run) -> bool:
        if run.autonomous or not run.worktree_path or not run.base_sha:
            return False
        project = get_project(self.db, run.project_id)
        root = Path(project.root) if project else self.config.repo_root
        if not review_gate_enabled(root):
            return False
        diff = await asyncio.to_thread(diff_against, Path(run.worktree_path), run.base_sha)
        return diff.files > 0

    def _notify(self, run: Run, previous: str) -> None:
        from app.integrations.lifecycle import notify_task

        notify_task(
            self.config.data_dir,
            run_id=run.id,
            title=run.title,
            status=run.status,
            previous=previous,
            project_id=run.project_id,
            error=run.error,
            dry_run=self.config.dry_run,
        )

    async def _enter_review(self, run: Run) -> None:
        current = get_run(self.db, run.id) or run
        if current.status in ("cancelled", "failed"):
            return
        stopped = "the task was finished" if run.id in self._finish else ""
        if not stopped and await self._release_deferred(current, stopped=""):
            return
        if stopped:
            await self._release_deferred(current, stopped=stopped)
        if not await self._review_applies(current):
            await self._mark_done(current)
            return
        previous = current.status
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
        self._notify(current, previous)

    async def _fail(self, run: Run, message: str) -> Run:
        await self._release_deferred(run, stopped="the run failed")
        previous = run.status
        run.status = "failed"
        run.error = message
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "error", message)
        await self._note(run.id, "lifecycle", "failed")
        self._notify(run, previous)
        return run

    async def _mark_cancelled(self, run: Run) -> None:
        if run.status == "cancelled":
            return
        self._finish.discard(run.id)
        await self._release_deferred(run, stopped="the run was cancelled")
        previous = run.status
        run.status = "cancelled"
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "lifecycle", "cancelled")
        self._notify(run, previous)

    async def _mark_done(self, run: Run) -> None:
        self._finish.discard(run.id)
        if run.status == "done":
            return
        failure = await self._required_checks(run)
        if failure:
            await self._fail(run, failure)
            return
        await self._release_deferred(run, stopped="the task was finished")
        previous = run.status
        run.status = "done"
        run.ask = ""
        run.finished_at = stamp()
        await self._save(run)
        await self._note(run.id, "lifecycle", "done")
        self._notify(run, previous)

    async def _required_checks(self, run: Run) -> str | None:
        """Shell commands saved on the project. A non-zero exit keeps the run from `done`.

        TypeScript runs these only while auto-landing onto the trunk. This port
        has no auto-land, so they run in the worktree at the moment of success.
        """
        from app.features.settings.store import read_checks

        commands = read_checks(self.config.data_dir, run.project_id)
        if not commands:
            return None
        cwd = Path(run.worktree_path) if run.worktree_path else self.config.repo_root
        for command in commands:
            code, output = await run_shell(
                command, cwd, asyncio.Event(), self.config.check_timeout_seconds
            )
            if code != 0:
                detail = output.strip() or f"exit {code}"
                return f"required check `{command}` failed:\n{detail}"
        return None

    async def set_archived(self, run_id: str, archived: bool) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.archived = archived
        run.archived_at = stamp() if archived else ""
        if archived:
            run.pinned = False
            run.pinned_at = ""
            if run.status in ("queued", "running", "waiting"):
                self._cancel.setdefault(run_id, asyncio.Event()).set()
        await self._save(run)
        return None

    async def set_pinned(self, run_id: str, pinned: bool) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.pinned = pinned
        run.pinned_at = stamp() if pinned else ""
        if pinned:
            run.archived = False
            run.archived_at = ""
        await self._save(run)
        return None

    async def queue_message(
        self, run_id: str, text: str
    ) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.status != "queued":
            return None, "run already started"
        message: dict[str, object] = {"id": uuid.uuid4().hex, "text": text, "createdAt": stamp()}
        run.queued_messages.append(message)
        await self._save(run)
        return message, None

    async def edit_queued_message(
        self, run_id: str, message_id: str, text: str
    ) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.status != "queued":
            return None, "run already started"
        for message in run.queued_messages:
            if message.get("id") == message_id:
                message["text"] = text
                await self._save(run)
                return message, None
        return None, "not found"

    async def remove_queued_message(self, run_id: str, message_id: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        if run.status != "queued":
            return "run already started"
        kept = [message for message in run.queued_messages if message.get("id") != message_id]
        if len(kept) == len(run.queued_messages):
            return "not found"
        run.queued_messages = kept
        await self._save(run)
        return None

    async def _save(self, run: Run) -> None:
        await self.db.write(save_run, run)
        self.publish()

    async def _note(self, run_id: str, type: str, text: str, step_id: str = "") -> None:
        at = stamp()
        seq = await self.db.write(add_event, run_id, type, text, step_id, at)
        self._fanout(
            {
                "runId": run_id,
                "seq": int(seq),
                "type": type,
                "text": text,
                "stepId": step_id,
                "at": at,
            }
        )
        self.publish()

    async def _emit_live(self, run_id: str, type: str, text: str, step_id: str) -> None:
        """`item.delta` is live-only. It is not written to the event log."""
        self._live_delta(run_id, "message", "text", text, step_id=step_id, type_name=type)

    def _live_delta(
        self,
        run_id: str,
        item_id: str,
        field_name: str,
        text: str,
        *,
        step_id: str = "",
        type_name: str = "item.delta",
    ) -> None:
        self._fanout(
            {
                "runId": run_id,
                "seq": 0,
                "type": type_name,
                "text": text,
                "stepId": step_id,
                "itemId": item_id,
                "field": field_name,
                "at": stamp(),
                "live": True,
            }
        )

    def _fanout(self, payload: dict[str, object]) -> None:
        run_id = str(payload.get("runId", ""))
        for listener in list(self._live.get(run_id, ())):
            listener(payload)

    def _agent_for(self, runner: str) -> Runner:
        if self.agent is not None:
            return self.agent
        if self.config.dry_run:
            from app.engine.agents import DryRunAgent

            return DryRunAgent()
        cached = self._runners.get(runner)
        if cached is not None:
            return cached
        from app.engine.runners.protocol import ProtocolRunner

        created = ProtocolRunner(
            runner,
            self.config.runner_bins.get(runner, runner),
            approval_gate=self.config.approval_gate,
            codex_network_off=self.config.codex_network_off,
        )
        self._runners[runner] = created
        return created

    async def retain(self) -> list[str]:
        """Reclaim finished worktree directories past the cap, and drop old index rows."""
        reclaimed: list[str] = []
        from app.features.settings.store import read_retention

        for project in list_projects(self.db):
            saved = read_retention(self.config.data_dir, project.id)
            keep = self.config.worktree_keep if saved is None else saved
            runs = list_runs(self.db, project.id, None, limit=10_000)
            for run_id in select_reclaimable(runs, keep):
                run = get_run(self.db, run_id)
                if run is None or not run.worktree_path:
                    continue
                gone = await asyncio.to_thread(
                    drop_worktree_dir, Path(project.root), Path(run.worktree_path)
                )
                if not gone:
                    continue
                run.worktree_reclaimed_at = stamp()
                await self._save(run)
                reclaimed.append(run_id)
            runs = list_runs(self.db, project.id, None, limit=10_000)
            for run_id in select_index_prune(
                runs, keep=self.config.runs_keep, archived_keep=self.config.archived_keep
            ):
                await self.db.write(delete_run_row, run_id)
        if reclaimed:
            self.publish()
        return reclaimed

    async def _lay_down_attachments(self, run: Run) -> None:
        if run.attachment_paths or not run.images or not run.worktree_path:
            return
        paths = await asyncio.to_thread(
            materialize,
            self.config.data_dir / "uploads",
            Path(run.worktree_path) / ".cezar-attachments",
            run.images,
        )
        if paths:
            run.attachment_paths = paths
            await self._save(run)

    def _buffer(self) -> DeferredBuffer:
        if self._deferred_buf is None:
            self._deferred_buf = DeferredBuffer(self.config.data_dir / "runs")
        return self._deferred_buf

    def defer_message(self, run_id: str, text: str) -> bool:
        run = get_run(self.db, run_id)
        if run is None or run.status != "running" or not text.strip():
            return False
        self._buffer().add(run_id, text.strip())
        return True

    async def _release_deferred(self, run: Run, *, stopped: str) -> bool:
        pending = self._buffer().take(run.id)
        if not pending:
            return False
        count = len(pending)
        word = "a message" if count == 1 else f"{count} messages"
        if stopped:
            await self._note(
                run.id,
                "lifecycle",
                f"{word} sent while the session was closing could not be delivered — {stopped}",
            )
            return False
        run.mode = "followup"
        run.continuation = "\n\n".join(pending)
        run.status = "queued"
        run.finished_at = ""
        run.ask = ""
        await self._save(run)
        await self._note(
            run.id,
            "lifecycle",
            "delivered a message sent while the session was closing",
        )
        return True

    async def archive_finished(self, project_id: str) -> int:
        changed = sweep_archive(list_runs(self.db, project_id, None, limit=10_000), stamp())
        for run in changed:
            await self._save(run)
        return len(changed)

    async def mark_all_read(self, project_id: str) -> int:
        changed = sweep_read(list_runs(self.db, project_id, None, limit=10_000), stamp())
        for run in changed:
            await self._save(run)
        return len(changed)

    async def set_notes(self, run_id: str, notes: str) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.notes = notes
        await self._save(run)
        return None

    async def set_read(self, run_id: str, read: bool) -> str | None:
        run = get_run(self.db, run_id)
        if run is None:
            return "not found"
        run.seen_at = stamp() if read else ""
        await self._save(run)
        return None

    async def git_commit(
        self, run_id: str, message: str
    ) -> tuple[dict[str, str] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if not run.worktree_path:
            return None, "no worktree"
        result = await asyncio.to_thread(commit_all, Path(run.worktree_path), message)
        if result.get("ok") != "true":
            return None, str(result.get("error", "commit failed"))
        await self._note(
            run.id,
            "note",
            f"commit: {result.get('result', '')} {result.get('sha', '')}",
        )
        return result, None

    async def git_push(self, run_id: str) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if not run.worktree_path or not run.branch:
            return None, "no worktree"
        result = await asyncio.to_thread(
            push_branch, Path(run.worktree_path), run.branch, dry_run=self.config.dry_run
        )
        if not result.get("ok"):
            return None, str(result.get("error", "push failed"))
        await self._note(run.id, "note", f"pushed {run.branch}")
        return cast(dict[str, object], result), None

    async def git_status(self, run_id: str) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if not run.worktree_path:
            return None, "no worktree"
        result = await asyncio.to_thread(
            worktree_git_status, Path(run.worktree_path), run.base_branch or "HEAD"
        )
        if not result.get("ok"):
            return None, str(result.get("error", "git status failed"))
        return result, None

    async def open_draft_pr(self, run_id: str) -> tuple[dict[str, object] | None, str | None]:
        run = get_run(self.db, run_id)
        if run is None:
            return None, "not found"
        if run.status in ("queued", "running", "waiting"):
            return None, "run is still active — wait for the review gate"
        if not run.worktree_path or not run.branch or run.in_place:
            return None, "no worktree/branch to publish"
        result = await asyncio.to_thread(
            create_draft_pr,
            Path(run.worktree_path),
            run.branch,
            run.title,
            dry_run=self.config.dry_run,
        )
        if not result.get("ok"):
            return None, str(result.get("error", "draft PR failed"))
        url = str(result.get("url", ""))
        run.pull_request_url = url
        run.status = "done"
        if not run.finished_at:
            run.finished_at = stamp()
        await self._save(run)
        suffix = " (dry run — no real PR)" if result.get("dryRun") else ""
        await self._note(run.id, "note", f"draft PR created: {url}{suffix}")
        return {"url": url, "dryRun": bool(result.get("dryRun"))}, None

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
        workflow: Workflow | None = None,
    ) -> tuple[Run | None, str | None]:
        text = task.strip()
        if not text:
            return None, "task is empty"
        if len(text) > 100_000:
            return None, "must be at most 100000 characters"
        if runner not in RUNNERS:
            return None, f"unknown runner {runner}"
        chosen = workflow
        if chosen is None:
            chosen = find_workflow(Path(project.root), workflow_name)
        if chosen is None:
            return None, f"unknown workflow: {workflow_name}"
        workflow = chosen
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
        if run.status == "review" or run.status == "waiting":
            await self._mark_done(run)
            await self._report_child(run_id)
            return None
        if run.status == "running":
            self._finish.add(run_id)
            self._cancel.setdefault(run_id, asyncio.Event()).set()
            await self._note(run_id, "lifecycle", "session closed by user")
            return None
        return "no open session"

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
            run.awaiting_answer_since = ""
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


def _if_port(run: Run, node: dict[str, Any], outputs: dict[str, dict[str, str]]) -> str:
    raw_condition = node.get("condition")
    condition = raw_condition if isinstance(raw_condition, dict) else {}
    kind = condition.get("kind")
    if kind == "output":
        ref = str(condition.get("ref", ""))
        node_id, _, field_name = ref.partition(".")
        actual = outputs.get(node_id, {}).get(field_name)
        ok = compare_values(actual, str(condition.get("op", "equals")), condition.get("value"))
        return "true" if ok else "false"
    if kind == "branch":
        return "true" if run.base_branch == condition.get("value") else "false"
    return "false"


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
    command: str,
    cwd: Path,
    cancel: asyncio.Event,
    timeout: float,
    env: dict[str, str] | None = None,
) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        "bash",
        "-lc",
        command,
        cwd=cwd,
        env=env,
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
