from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, status_chip
from app.engine.gitwork import Diff
from app.engine.model import Event, Run
from app.features.places.urls import COMPARE
from app.features.task.data import list_commits, list_worktree_files
from app.features.task.mermaid import diagrams
from app.features.task.urls import (
    TASK,
    TASK_CANCEL,
    TASK_COMMIT,
    TASK_DELETE,
    TASK_DISPATCH,
    TASK_FINISH,
    TASK_LIVE,
    TASK_MESSAGE,
    TASK_NOTES,
    TASK_PR,
    TASK_PUSH,
    TASK_SHELL,
    TaskView,
)


def render(
    run: Run,
    events: list[Event],
    children: list[Run],
    view: TaskView,
    diff: Diff | None,
    chrome: Chrome,
    tab: str,
    merge: dict[str, object] | None = None,
) -> HtmlElement:
    steps = run.definition().steps
    rail = []
    for index, step in enumerate(steps):
        klass = "here" if index == run.step_index and run.status == "running" else ""
        attrs = {"class": klass} if klass else {}
        rail.append(h.Li(attrs, step.name or step.id))
    window = events if view.earlier or len(events) <= 40 else events[-40:]
    earlier = None
    if len(window) < len(events):
        earlier = h.A(
            {
                "id": "transcript-earlier",
                "href": TASK.href(run.id, query={"pane": "session", "earlier": "1"}),
            },
            f"Earlier ({len(events) - len(window)})",
        )
    transcript = [
        h.Li(
            {"class": f"ev ev-{event.type}"},
            h.Span({"class": "ev-type"}, event.type),
            event.text,
            *diagrams(event.text),
        )
        for event in window
    ]
    actions: list[HtmlElement] = []
    if run.status in ("queued", "running", "waiting", "review"):
        actions.append(
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(TASK_CANCEL.href(run.id))),
                data.indicator("_saving"),
                "Cancel",
            )
        )
    if run.status == "review":
        actions.append(
            h.Button(
                {"type": "button", "class": "btn btn-primary"},
                data.on("click", at.post(TASK_FINISH.href(run.id))),
                data.indicator("_saving"),
                "Finish",
            )
        )
        actions.append(
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(TASK_COMMIT.href(run.id))),
                data.indicator("_saving"),
                "Commit",
            )
        )
        actions.append(
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(TASK_PUSH.href(run.id))),
                data.indicator("_saving"),
                "Push",
            )
        )
        actions.append(
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(TASK_PR.href(run.id))),
                data.indicator("_saving"),
                "Draft PR",
            )
        )
    if run.status in ("review", "done", "failed", "cancelled"):
        actions.append(
            h.Button(
                {"type": "button", "class": "btn btn-danger"},
                data.on("click", at.post(TASK_DELETE.href(run.id))),
                data.indicator("_saving"),
                "Delete",
            )
        )
    panes = h.Nav(
        {"class": "filters"},
        *[
            h.A({"href": TASK.href(run.id, query={"pane": pane})}, label)
            for pane, label in (
                ("session", "Session"),
                ("diff", "Changes"),
                ("files", "Files"),
                ("commits", "Commits"),
                ("graph", "Graph"),
                ("notes", "Notes"),
                ("terminal", "Terminal"),
                ("browser", "Browser"),
            )
        ],
    )
    blocks: list[HtmlElement] = [
        h.Div(
            {"class": "top"},
            h.Div(
                h.H1(run.title),
                h.P(
                    {"class": "sub"},
                    status_chip(run.status),
                    " ",
                    run.workflow,
                    " · ",
                    run.runner,
                    f" · variant {run.variant}" if run.variant else "",
                    f" · {run.branch}" if run.branch else "",
                    f" · {run.pull_request_url}" if run.pull_request_url else "",
                    " · " if run.group_id else "",
                    h.A({"href": COMPARE.href(run.id)}, "Compare") if run.group_id else None,
                ),
            ),
            h.Div({"class": "actions"}, *actions) if actions else None,
        ),
        _merge_box(merge) if merge and merge.get("available") else None,
        panes,
        h.Ol({"class": "steps"}, *rail),
    ]
    if run.error:
        blocks.append(h.P({"class": "error"}, run.error))
    if run.status == "waiting" and run.ask:
        blocks.append(h.Div({"class": "card-block ask"}, h.Strong("The agent asked"), h.P(run.ask)))
    if earlier is not None and view.pane == "session":
        blocks.append(earlier)
    blocks.extend(_pane(run, view, diff, transcript))
    if run.status in ("waiting", "review"):
        blocks.append(
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_MESSAGE.href(run.id)), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Answer" if run.status == "waiting" else "Follow-up"),
                    h.Textarea({"required": True, "maxlength": "20000"}, data.bind("message")),
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Send",
                ),
            )
        )
    if run.status in ("running", "waiting") and run.branch:
        blocks.append(
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_DISPATCH.href(run.id)), prevent=True),
                data.indicator("_dispatching"),
                h.Label(
                    {"class": "field"},
                    h.Span("Dispatch a child task"),
                    h.Textarea({"required": True, "maxlength": "4000"}, data.bind("objective")),
                ),
                h.Button(
                    {"class": "btn", "type": "submit"},
                    data.attr("disabled", "$_dispatching"),
                    "Dispatch",
                ),
            )
        )
    if children:
        blocks.append(h.H2("Children"))
        blocks.append(
            h.Div(
                {"class": "stack"},
                *[
                    h.A(
                        {"class": "task-row", "href": TASK.href(child.id)},
                        status_chip(child.status),
                        h.Span(child.title),
                    )
                    for child in children
                ],
            )
        )
    blocks.append(
        h.P({"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error"))
    )
    return frame(
        chrome,
        TASK_LIVE.href(run.id, query=view.query()),
        {
            "tab": tab,
            "message": "",
            "objective": "",
            "notes": run.notes,
            "command": "",
            "_shell": "",
            "_error": "",
        },
        h.Main({"id": "task"}, *blocks),
    )


def _pane(run: Run, view: TaskView, diff: Diff | None, transcript: list) -> list[HtmlElement]:
    if view.pane == "diff":
        body = diff.text if diff and diff.text else "No diff yet."
        return [h.Pre({"class": "diff"}, body)]
    if view.pane == "files":
        names = list_worktree_files(run.worktree_path)
        rows = [h.Li(name) for name in names] or [h.Li({"class": "muted"}, "No files yet.")]
        return [h.H2("Files"), h.Ul(*rows)]
    if view.pane == "commits":
        lines = list_commits(run.worktree_path)
        rows = [h.Li(line) for line in lines] or [h.Li({"class": "muted"}, "No commits.")]
        return [h.H2("Commits"), h.Ul(*rows)]
    if view.pane == "graph":
        graph = run.workflow_def.get("graph")
        nodes = graph.get("nodes") if isinstance(graph, dict) else None
        if isinstance(nodes, list) and nodes:
            rows = [
                h.Li(f"{item.get('id')} · {item.get('type')}")
                for item in nodes
                if isinstance(item, dict)
            ]
        else:
            rows = [h.Li(step.name or step.id) for step in run.definition().steps]
        return [h.H2("Graph"), h.Ol(*rows)]
    if view.pane == "notes":
        return [
            h.H2("Notes"),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_NOTES.href(run.id)), prevent=True),
                h.Textarea({"maxlength": "20000"}, data.bind("notes")),
                h.Button({"class": "btn", "type": "submit"}, "Save notes"),
            ),
        ]
    if view.pane == "terminal":
        return [
            h.H2("Terminal"),
            h.P({"class": "sub"}, "A PTY in this task's worktree. Resize is cols and rows."),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(TASK_SHELL.href(run.id)), prevent=True),
                h.Input(
                    {"required": True, "maxlength": "400", "aria-label": "Command"},
                    data.bind("command"),
                ),
                h.Button({"class": "btn", "type": "submit"}, "Run"),
            ),
            h.Pre({"id": "shell-output", "class": "diff"}, data.text("$_shell")),
        ]
    if view.pane == "browser":
        return [
            h.H2("Browser"),
            h.P(
                {"class": "sub"},
                "Design Mode mirrors a loopback http server and injects a picker marker. "
                "It is off when the cockpit is hosted.",
            ),
        ]
    return [h.Ol({"id": "transcript", "class": "transcript"}, *transcript)]


def _merge_box(payload: dict[str, object]) -> HtmlElement:
    state = payload.get("mergeState")
    inner = state if isinstance(state, dict) else {}
    heading = "Ready to merge" if inner.get("eligibility") == "ready" else "Merge blocked"
    blockers = inner.get("blockers")
    rows = blockers if isinstance(blockers, list) else []
    messages = [h.Li(str(item.get("message", ""))) for item in rows if isinstance(item, dict)]
    number = inner.get("number")
    button = None
    if inner.get("canMerge") is True and isinstance(number, int):
        button = h.Button(
            {"type": "button", "class": "btn btn-primary", "id": "merge-pr"},
            data.on("click", at.post(f"/api/v1/github/prs/{number}/merge")),
            "Squash and merge",
        )
    return h.Section(
        {"id": "merge-box"},
        h.H2(heading),
        h.Ul(*messages) if messages else None,
        button,
    )


def render_missing(chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "task"},
            h.H1("Task not found"),
            h.P({"class": "sub"}, "That run is not in this cockpit."),
        ),
    )
