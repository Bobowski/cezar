"""Routes that sit beside the run lifecycle.

Git actions, read receipts, bulk archive, UI state, uploads, telemetry consent,
provider and model discovery, terminal sessions, the design-mode proxy, webhook
receivers, and GitHub/Jira/Linear hook intake. Each one is the behavior the
engine can actually perform.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from litewriter import LiteWriter
from stario import App, Context, Route, Writer
from stario.datastar import SSE
from stario.exceptions import RequestBodyError
from stario.json import JsonValue

from app.config import Config
from app.engine.engine import Engine
from app.engine.preview import design_proxy_issue, start_proxy
from app.engine.providers import model_catalog, provider_status
from app.engine.telemetry_store import read_consent, write_consent
from app.engine.ui_state import merge_state, read_state
from app.engine.uploads import delete_upload, write_upload
from app.integrations.hooks import (
    append_receipt,
    delete_receiver,
    github_signature_ok,
    load_receivers,
    public_receiver,
    recent_deliveries,
    recent_receipts,
    record_delivery,
    save_receiver,
    shared_secret_ok,
)
from app.store.db import get_project, get_run, list_enabled_automations

_NO_WORKTREE = "no worktree"


class SurfaceApi:
    def __init__(self, db: LiteWriter, engine: Engine, config: Config) -> None:
        self.db = db
        self.engine = engine
        self.config = config
        self._proxies: dict[str, object] = {}

    def register(self, app: App) -> None:
        routes = (
            ("POST", "/runs/archive-finished", self.archive_finished),
            ("POST", "/runs/read-all", self.read_all),
            ("POST", "/runs/{run_id}/read", self.read_one),
            ("POST", "/runs/{run_id}/unread", self.unread_one),
            ("GET", "/runs/{run_id}/diff", self.diff),
            ("GET", "/runs/{run_id}/git/status", self.git_status),
            ("POST", "/runs/{run_id}/git/commit", self.git_commit),
            ("POST", "/runs/{run_id}/git/push", self.git_push),
            ("POST", "/runs/{run_id}/pr", self.draft_pr),
            ("POST", "/runs/{run_id}/terminal", self.terminal_open),
            ("POST", "/runs/{run_id}/terminal/{session_id}/input", self.terminal_input),
            ("POST", "/runs/{run_id}/terminal/{session_id}/resize", self.terminal_resize),
            ("GET", "/runs/{run_id}/terminal/{session_id}/output", self.terminal_output),
            ("DELETE", "/runs/{run_id}/terminal/{session_id}", self.terminal_close),
            ("GET", "/ui-state", self.ui_state),
            ("PUT", "/ui-state", self.put_ui_state),
        )
        for method, path, handler in routes:
            app.add(Route(f"{method} /api/v1{path}"), handler)
            app.add(Route(f"{method} /api/v1/p/{{project_id}}{path}"), handler)
        app.add(Route("GET /api/v1/workspace/ui-state"), self.workspace_ui)
        app.add(Route("PUT /api/v1/workspace/ui-state"), self.put_workspace_ui)
        app.add(Route("POST /api/v1/workspace/uploads"), self.upload)
        app.add(Route("DELETE /api/v1/workspace/uploads/{upload_id}"), self.delete_upload)
        app.add(Route("GET /api/v1/telemetry/consent"), self.telemetry)
        app.add(Route("PUT /api/v1/telemetry/consent"), self.put_telemetry)
        app.add(Route("POST /api/v1/telemetry/event"), self.telemetry_event)
        app.add(Route("GET /api/v1/providers/status"), self.providers)
        app.add(Route("GET /api/v1/models"), self.models)
        app.add(Route("POST /api/v1/preview/design-proxy"), self.preview)
        app.add(Route("GET /api/v1/webhooks"), self.webhooks)
        app.add(Route("POST /api/v1/webhooks"), self.create_webhook)
        app.add(Route("DELETE /api/v1/webhooks/{receiver_id}"), self.delete_webhook)
        app.add(Route("POST /api/v1/webhooks/{receiver_id}/test"), self.test_webhook)
        app.add(Route("GET /api/v1/webhooks/{receiver_id}/deliveries"), self.deliveries)
        app.add(
            Route("POST /api/v1/webhooks/outbox/{sequence}/replay"),
            self.replay_outbox,
        )
        app.add(Route("POST /api/v1/hooks/github"), self.github_hook)
        app.add(Route("POST /api/v1/hooks/jira"), self.jira_hook)
        app.add(Route("POST /api/v1/hooks/linear"), self.linear_hook)
        app.add(Route("GET /api/v1/hooks/receipts"), self.receipts)
        app.add(Route("GET /api/v1/fs/browse"), self.browse)
        app.add(Route("GET /api/v1/github/prs/{number}/merge-state"), self.merge_state)
        app.add(Route("POST /api/v1/github/prs/{number}/merge"), self.merge_pr)
        app.add(Route("POST /api/v1/github/prs/{number}/reviews"), self.review_pr)

    async def archive_finished(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        count = await self.engine.archive_finished(project.id)
        w.json({"archived": count})

    async def read_all(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        w.json({"read": await self.engine.mark_all_read(project.id)})

    async def read_one(self, c: Context, w: Writer) -> None:
        await self._seen(c, w, True)

    async def unread_one(self, c: Context, w: Writer) -> None:
        await self._seen(c, w, False)

    async def diff(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if not run.worktree_path or not run.base_sha:
            w.json({"error": _NO_WORKTREE}, status=409)
            return
        from app.engine.gitwork import diff_against

        diff = diff_against(Path(run.worktree_path), run.base_sha)
        w.text(diff.text, 200)

    async def git_status(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        result, reason = await self.engine.git_status(run.id)
        if reason or result is None:
            w.json({"error": reason or _NO_WORKTREE}, status=409 if reason != "not found" else 404)
            return
        w.json(cast(JsonValue, result))

    async def git_commit(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        message = body.get("message", "")
        if not isinstance(message, str):
            w.json({"error": "commit message must be one plain line"}, status=400)
            return
        result, reason = await self.engine.git_commit(run.id, message)
        if reason or result is None:
            status = 404 if reason == "not found" else 409
            w.json({"error": reason or "commit failed"}, status=status)
            return
        if result.get("result") == "nothing":
            w.json({"committed": False, "result": "nothing"})
            return
        w.json({"committed": True, "sha": result.get("sha", "")})

    async def git_push(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        result, reason = await self.engine.git_push(run.id)
        if reason or result is None:
            w.json({"error": reason or "push failed"}, status=409 if reason != "not found" else 404)
            return
        w.json(
            cast(
                JsonValue,
                {
                    "pushed": True,
                    "branch": result.get("branch", ""),
                    "remote": result.get("remote", ""),
                    "upstreamSet": bool(result.get("upstreamSet")),
                    "dryRun": bool(result.get("dryRun")),
                },
            )
        )

    async def draft_pr(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        result, reason = await self.engine.open_draft_pr(run.id)
        if reason or result is None:
            code = 404 if reason == "not found" else 409
            if reason and reason.startswith("no worktree"):
                code = 400
            w.json({"error": reason or "draft PR failed"}, status=code)
            return
        w.json(cast(JsonValue, result), status=201)

    async def terminal_open(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        if not run.worktree_path:
            w.json({"error": _NO_WORKTREE}, status=409)
            return
        session_id = await self.engine._terminals.open(Path(run.worktree_path))
        w.json({"id": session_id}, status=201)

    async def terminal_input(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        data = body.get("data", "")
        if not isinstance(data, str):
            w.json({"error": "data must be a string"}, status=400)
            return
        session_id = c.match.params.get("session_id", "")
        if not await self.engine._terminals.write(session_id, data):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"ok": True})

    async def terminal_resize(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        rows = body.get("rows", 24)
        cols = body.get("cols", 80)
        if not isinstance(rows, int) or not isinstance(cols, int):
            w.json({"error": "rows and cols must be integers"}, status=400)
            return
        session_id = c.match.params.get("session_id", "")
        if not self.engine._terminals.resize(session_id, rows, cols):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"ok": True})

    async def terminal_output(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        session_id = c.match.params.get("session_id", "")
        session = self.engine._terminals.sessions.get(session_id)
        if session is None:
            w.json({"error": "not found"}, status=404)
            return
        import asyncio
        import time

        sse = SSE(w)
        sse.open()
        sent = 0
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if len(session.chunks) > sent:
                _frame(w, "".join(session.chunks[sent:]))
                sent = len(session.chunks)
                if "\n" in "".join(session.chunks):
                    return
            await asyncio.sleep(0.05)
        if sent == 0:
            _frame(w, "")

    async def terminal_close(self, c: Context, w: Writer) -> None:
        run = self._run(c, w)
        if run is None:
            return
        closed = await self.engine._terminals.close(c.match.params.get("session_id", ""))
        if not closed:
            w.json({"error": "not found"}, status=404)
            return
        w.json({"closed": True})

    async def ui_state(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        w.json(cast(JsonValue, read_state(_ui_path(Path(project.root)))))

    async def put_ui_state(self, c: Context, w: Writer) -> None:
        project = self._project(c, w)
        if project is None:
            return
        body = await _json(c, w)
        if body is None:
            return
        merged, reason = merge_state(_ui_path(Path(project.root)), body)
        if reason or merged is None:
            w.json({"error": reason or "ui state must be an object"}, status=400)
            return
        w.json(cast(JsonValue, merged))

    async def workspace_ui(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, read_state(self.config.data_dir / "ui-state.json")))

    async def put_workspace_ui(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        merged, reason = merge_state(self.config.data_dir / "ui-state.json", body)
        if reason or merged is None:
            w.json({"error": reason or "ui state must be an object"}, status=400)
            return
        w.json(cast(JsonValue, merged))

    async def upload(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        media = body.get("mediaType", "")
        data = body.get("data", "")
        name = body.get("name", "")
        if not isinstance(media, str) or not isinstance(data, str):
            w.json(
                {
                    "error": (
                        "unsupported attachment type — send other files as application/octet-stream"
                    )
                },
                status=400,
            )
            return
        meta, reason = write_upload(
            self.config.data_dir / "uploads",
            media,
            data,
            name if isinstance(name, str) else "",
        )
        if reason or meta is None:
            w.json({"error": reason or "attachment rejected"}, status=400)
            return
        w.json(
            cast(JsonValue, {"uploadId": meta["id"], "mediaType": meta["mediaType"]}),
            status=201,
        )

    async def delete_upload(self, c: Context, w: Writer) -> None:
        upload_id = c.match.params.get("upload_id", "")
        if not delete_upload(self.config.data_dir / "uploads", upload_id):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"deleted": True})

    async def telemetry(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, read_consent(self.config.data_dir / "telemetry.json")))

    async def put_telemetry(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        enabled = body.get("enabled") is True
        w.json(cast(JsonValue, write_consent(self.config.data_dir / "telemetry.json", enabled)))

    async def telemetry_event(self, c: Context, w: Writer) -> None:
        consent = read_consent(self.config.data_dir / "telemetry.json")
        if consent.get("enabled") is not True:
            w.json({"error": "telemetry is off"}, status=403)
            return
        w.empty()

    async def providers(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, provider_status(self.config.runner_bins)))

    async def models(self, c: Context, w: Writer) -> None:
        runner = c.req.query.get("runner", "")
        w.json(cast(JsonValue, model_catalog(runner, self.config.runner_bins)))

    async def preview(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        url = body.get("url", "")
        if not isinstance(url, str):
            w.json({"error": "design mode only mirrors loopback http"}, status=400)
            return
        issue = design_proxy_issue(url, enabled=self.config.design_mode)
        if issue:
            w.json({"error": issue}, status=409)
            return
        proxy, close = await start_proxy(url)
        self._proxies[proxy] = close
        w.json({"url": proxy})

    async def webhooks(self, _c: Context, w: Writer) -> None:
        rows = [public_receiver(row) for row in load_receivers(self.config.data_dir)]
        w.json(cast(JsonValue, {"receivers": rows}))

    async def create_webhook(self, c: Context, w: Writer) -> None:
        body = await _json(c, w)
        if body is None:
            return
        name = body.get("name", "")
        url = body.get("url", "")
        if not isinstance(name, str) or not isinstance(url, str):
            w.json({"error": "name and url are required"}, status=400)
            return
        row, reason = save_receiver(self.config.data_dir, name, url)
        if reason or row is None:
            w.json({"error": reason or "rejected"}, status=400)
            return
        w.json(
            cast(JsonValue, {"receiver": public_receiver(row), "secret": row.get("secret", "")}),
            status=201,
        )

    async def delete_webhook(self, c: Context, w: Writer) -> None:
        if not delete_receiver(self.config.data_dir, c.match.params.get("receiver_id", "")):
            w.json({"error": "not found"}, status=404)
            return
        w.json({"deleted": True})

    async def test_webhook(self, c: Context, w: Writer) -> None:
        receiver_id = c.match.params.get("receiver_id", "")
        row = next(
            (
                item
                for item in load_receivers(self.config.data_dir)
                if item.get("id") == receiver_id
            ),
            None,
        )
        if row is None:
            w.json({"error": "not found"}, status=404)
            return
        delivery = record_delivery(self.config.data_dir, row, dry_run=self.config.dry_run)
        w.json(cast(JsonValue, delivery))

    async def replay_outbox(self, c: Context, w: Writer) -> None:
        import time

        from app.integrations.outbox import Outbox, OutboxError, replay

        raw = c.match.params.get("sequence", "")
        if not raw.isdigit():
            w.json({"error": "Delivery not found"}, status=404)
            return
        directory = self.config.data_dir / "webhook-outbox"
        install = directory / "installation"
        if not install.is_file():
            w.json({"error": "Delivery not found"}, status=404)
            return
        box = Outbox(directory, install.read_text(encoding="utf-8").strip())
        try:
            box.open()
        except OSError, OutboxError:
            w.json({"error": "Delivery not found"}, status=404)
            return
        reason = replay(box, int(raw), now_ms=int(time.time() * 1000))
        if reason:
            status = 404 if reason == "Delivery not found" else 409
            w.json({"error": reason}, status=status)
            return
        w.json({"replayed": True})

    async def deliveries(self, c: Context, w: Writer) -> None:
        receiver_id = c.match.params.get("receiver_id", "")
        w.json(
            cast(
                JsonValue,
                {"items": recent_deliveries(self.config.data_dir, receiver_id)},
            )
        )

    async def github_hook(self, c: Context, w: Writer) -> None:
        raw = await _raw(c, w)
        if raw is None:
            return
        secret = self.config.github_webhook_secret
        header = c.req.headers.get("x-hub-signature-256", "")
        if not github_signature_ok(secret, raw, header):
            w.json({"error": "invalid signature"}, status=401)
            return
        await self._accept_hook(w, "github", raw, c.req.headers.get("x-github-event", ""))

    async def jira_hook(self, c: Context, w: Writer) -> None:
        await self._shared_hook(c, w, "jira", self.config.jira_webhook_secret)

    async def linear_hook(self, c: Context, w: Writer) -> None:
        await self._shared_hook(c, w, "linear", self.config.linear_webhook_secret)

    async def merge_state(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import merge_state

        number = _pr_number(c.match.params.get("number", ""))
        if number is None:
            w.json({"error": "invalid pull request number"}, status=400)
            return
        w.json(
            cast(
                JsonValue,
                merge_state(number, dry_run=self.config.dry_run, cwd=self.config.repo_root),
            )
        )

    async def merge_pr(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import merge_pr

        number = _pr_number(c.match.params.get("number", ""))
        body = await _json(c, w)
        if number is None or body is None:
            if number is None:
                w.json({"error": "invalid pull request number"}, status=400)
            return
        method = body.get("method", "squash")
        result = merge_pr(
            number,
            method if isinstance(method, str) else "",
            dry_run=self.config.dry_run,
            cwd=self.config.repo_root,
        )
        if not result.get("ok"):
            status = result.get("status")
            code = status if isinstance(status, int) else 409
            w.json({"error": str(result.get("error", "merge failed"))}, status=code)
            return
        w.json(cast(JsonValue, {key: value for key, value in result.items() if key != "ok"}))

    async def review_pr(self, c: Context, w: Writer) -> None:
        from app.integrations.github_review import review_pr

        number = _pr_number(c.match.params.get("number", ""))
        body = await _json(c, w)
        if number is None or body is None:
            if number is None:
                w.json({"error": "invalid pull request number"}, status=400)
            return
        event = body.get("event", "")
        text = body.get("body", "")
        result = review_pr(
            number,
            event if isinstance(event, str) else "",
            text if isinstance(text, str) else "",
            dry_run=self.config.dry_run,
            cwd=self.config.repo_root,
        )
        if not result.get("ok"):
            status = result.get("status")
            code = status if isinstance(status, int) else 409
            w.json({"error": str(result.get("error", "review failed"))}, status=code)
            return
        w.json(cast(JsonValue, {key: value for key, value in result.items() if key != "ok"}))

    async def browse(self, c: Context, w: Writer) -> None:
        from pathlib import Path

        from app.engine.fs_browse import browse as browse_directory

        root = Path(self.config.browse_root or str(Path.home()))
        result = browse_directory(
            root,
            c.req.query.get("path", ""),
            show_hidden=c.req.query.get("showHidden") == "1",
        )
        if result.get("ok") is not True:
            status = result.get("status")
            code = status if isinstance(status, int) else 400
            w.json({"error": str(result.get("error", "browse failed"))}, status=code)
            return
        w.json(cast(JsonValue, {key: value for key, value in result.items() if key != "ok"}))

    async def receipts(self, _c: Context, w: Writer) -> None:
        w.json(cast(JsonValue, {"receipts": recent_receipts(self.config.data_dir)}))

    async def _shared_hook(self, c: Context, w: Writer, source: str, secret: str) -> None:
        raw = await _raw(c, w)
        if raw is None:
            return
        header = c.req.headers.get("x-cezar-webhook-secret", "")
        if not shared_secret_ok(secret, header):
            w.json({"error": "invalid signature"}, status=401)
            return
        event = c.req.headers.get("x-cezar-event", "")
        await self._accept_hook(w, source, raw, event)

    async def _accept_hook(self, w: Writer, source: str, raw: bytes, event: str) -> None:
        try:
            loaded = json.loads(raw.decode())
        except UnicodeError, json.JSONDecodeError:
            w.json({"error": "invalid json"}, status=400)
            return
        title = _hook_title(loaded)
        run_id = await self._maybe_start(source, event, title)
        receipt = {
            "source": source,
            "event": event,
            "accepted": True,
            "runId": run_id or "",
            "title": title,
        }
        append_receipt(self.config.data_dir, receipt)
        w.json(cast(JsonValue, {"ok": True, "runId": run_id or ""}))

    async def _maybe_start(self, source: str, event: str, title: str) -> str | None:
        if not title:
            return None
        for item in list_enabled_automations(self.db):
            if item.tracker != source:
                continue
            if item.tracker_event and item.tracker_event != event:
                continue
            project = get_project(self.db, item.project_id)
            if project is None:
                continue
            run, _reason = self.engine.plan_run(
                project=project,
                task=title,
                workflow_name=item.workflow or "quick-task",
                runner=item.runner,
            )
            if run is None:
                continue
            await self.engine.enqueue(run)
            return run.id
        return None

    async def _seen(self, c: Context, w: Writer, read: bool) -> None:
        run = self._run(c, w)
        if run is None:
            return
        reason = await self.engine.set_read(run.id, read)
        if reason:
            w.json({"error": reason}, status=404)
            return
        updated = get_run(self.db, run.id)
        from app.features.api.records import public_run

        w.json(cast(JsonValue, public_run(updated or run, full=False)))

    def _project(self, c: Context, w: Writer):
        from app.store.db import get_project as load

        project_id = c.match.params.get("project_id", "") or self.engine.boot_project_id
        project = load(self.db, project_id)
        if project is None:
            w.json({"error": "not found"}, status=404)
            return None
        return project

    def _run(self, c: Context, w: Writer):
        run = get_run(self.db, c.match.params.get("run_id", ""))
        if run is None:
            w.json({"error": "not found"}, status=404)
            return None
        project_id = c.match.params.get("project_id", "")
        if project_id and project_id != run.project_id:
            w.json({"error": "not found"}, status=404)
            return None
        return run


def _pr_number(raw: str) -> int | None:
    if not raw.isdigit():
        return None
    number = int(raw)
    return number if number > 0 else None


def _ui_path(root: Path) -> Path:
    return root / ".ai" / "cezar" / "ui-state.json"


def _hook_title(loaded: object) -> str:
    if not isinstance(loaded, dict):
        return ""
    issue = loaded.get("issue")
    if isinstance(issue, dict):
        title = issue.get("title")
        if isinstance(title, str):
            return title
    title = loaded.get("title")
    return title if isinstance(title, str) else ""


def _frame(w: Writer, text: str) -> None:
    w.write(f"event: output\ndata: {json.dumps(text)}\n\n".encode())


async def _raw(c: Context, w: Writer) -> bytes | None:
    try:
        body = await c.req.body()
    except RequestBodyError:
        w.json({"error": "invalid json"}, status=400)
        return None
    if isinstance(body, str):
        return body.encode()
    if isinstance(body, bytes):
        return body
    w.json({"error": "invalid json"}, status=400)
    return None


async def _json(c: Context, w: Writer) -> dict[str, object] | None:
    raw = await _raw(c, w)
    if raw is None:
        return None
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        w.json({"error": "invalid json"}, status=400)
        return None
    if not isinstance(loaded, dict):
        w.json({"error": "invalid json"}, status=400)
        return None
    return loaded
