"""Wire records for the run and project routes.

Required keys match `runRecordSchema` / `projectListEntrySchema`. Optional keys
are omitted when this port has nothing to say, which is what an absent field
means on those schemas.
"""

from __future__ import annotations

from pathlib import Path
from typing import cast

from stario.json import JsonValue

from app.engine.gitwork import head_branch, is_git_repo
from app.engine.model import Run


def public_run(run: Run, *, full: bool) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {
        "id": run.id,
        "title": run.title,
        "workflow": run.workflow,
        "task": run.task,
        "status": run.status,
        "runner": run.runner,
        "createdAt": run.created_at,
        "tokensUsed": run.tokens_used,
        "archived": run.archived,
        "steps": _steps(run),
    }
    if run.model:
        body["model"] = run.model
    if run.autonomous:
        body["autonomous"] = True
    if run.started_at:
        body["startedAt"] = run.started_at
    if run.finished_at:
        body["finishedAt"] = run.finished_at
    if run.error:
        body["error"] = run.error
    if run.branch:
        body["branch"] = run.branch
    if run.worktree_path:
        body["worktreePath"] = run.worktree_path
    if run.base_branch:
        body["baseBranch"] = run.base_branch
    if run.cost_usd:
        body["costUsd"] = run.cost_usd
    if run.in_place:
        body["worktree"] = False
    if run.archived_at:
        body["archivedAt"] = run.archived_at
    if run.pinned:
        body["pinned"] = True
    if run.pinned_at:
        body["pinnedAt"] = run.pinned_at
    if run.group_id:
        body["groupId"] = run.group_id
    if run.account_id:
        body["accountId"] = run.account_id
    if run.variant:
        body["variant"] = run.variant
    if run.seen_at:
        body["seenAt"] = run.seen_at
    if run.pull_request_url:
        body["pullRequestUrl"] = run.pull_request_url
    if run.queued_messages:
        body["queuedMessages"] = [
            {
                "id": str(message.get("id", "")),
                "text": str(message.get("text", "")),
                "createdAt": str(message.get("createdAt", "")),
            }
            for message in run.queued_messages
        ]
    if full:
        body["workflowDef"] = cast(JsonValue, _workflow(run.workflow_def))
    return body


def public_project(project_id: str, name: str, root: str, added_at: str) -> dict[str, JsonValue]:
    path = Path(root)
    if not path.exists():
        status = "missing"
    elif is_git_repo(path):
        status = "ok"
    else:
        status = "not-git"
    body: dict[str, JsonValue] = {
        "id": project_id,
        "name": name,
        "root": root,
        "addedAt": added_at,
        "lastOpenedAt": added_at,
        "source": "local",
        "status": status,
    }
    if status == "ok":
        body["branch"] = head_branch(path)
    return body


def _steps(run: Run) -> list[JsonValue]:
    steps = run.definition().steps
    total = len(steps)
    out: list[JsonValue] = []
    for index, step in enumerate(steps):
        status = _step_status(run.status, index, run.step_index, total)
        item: dict[str, JsonValue] = {
            "id": step.id,
            "name": step.name or step.id,
            "kind": step.kind,
            "status": status,
            "iterations": 0 if status in ("pending", "skipped") else 1,
            "tokensUsed": 0,
        }
        used = run.retries.get(step.id, 0)
        if used:
            item["retriesUsed"] = used
        out.append(item)
    return out


def _step_status(run_status: str, index: int, cursor: int, total: int) -> str:
    if run_status == "queued":
        return "pending"
    if index < cursor:
        return "done"
    if index > cursor:
        return "skipped" if run_status in ("done", "failed", "cancelled", "review") else "pending"
    if run_status == "running":
        return "running"
    if run_status == "waiting":
        return "waiting"
    if run_status == "failed":
        return "failed"
    if run_status == "cancelled":
        return "cancelled"
    if run_status in ("review", "done"):
        return "done"
    if index == total:
        return "pending"
    return "pending"


def _workflow(raw: dict[str, object]) -> dict[str, object]:
    source = raw.get("source")
    steps = raw.get("steps")
    body: dict[str, object] = {
        "name": raw.get("name") if isinstance(raw.get("name"), str) else "",
        "source": source if source in ("built-in", "file") else "built-in",
        "steps": steps if isinstance(steps, list) else [],
    }
    description = raw.get("description")
    if isinstance(description, str) and description:
        body["description"] = description
    path = raw.get("path")
    if isinstance(path, str) and path:
        body["path"] = path
    return body
