from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, status_chip
from app.engine.gitwork import Diff
from app.engine.model import Event, Run
from app.features.task.urls import (
    TASK,
    TASK_CANCEL,
    TASK_COMMIT,
    TASK_DELETE,
    TASK_DISPATCH,
    TASK_FINISH,
    TASK_LIVE,
    TASK_MESSAGE,
    TASK_PR,
    TASK_PUSH,
    TaskView,
)
from app.features.tasks.urls import TASKS


def render(
    run: Run,
    events: list[Event],
    children: list[Run],
    view: TaskView,
    diff: Diff | None,
    chrome: Chrome,
    tab: str,
) -> HtmlElement:
    steps = run.definition().steps
    rail = []
    for index, step in enumerate(steps):
        klass = "here" if index == run.step_index and run.status == "running" else ""
        attrs = {"class": klass} if klass else {}
        rail.append(h.Li(attrs, step.name or step.id))
    transcript = [
        h.Li(
            {"class": f"ev ev-{event.type}"},
            h.Span({"class": "ev-type"}, event.type),
            event.text,
        )
        for event in events
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
        h.A({"href": TASK.href(run.id, query={"pane": "session"})}, "Session"),
        h.A({"href": TASK.href(run.id, query={"pane": "diff"})}, "Changes"),
        h.A({"href": TASKS.href(query={"project": run.project_id, "status": "all"})}, "All tasks"),
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
                    f" · {run.branch}" if run.branch else "",
                    f" · {run.pull_request_url}" if run.pull_request_url else "",
                ),
            ),
            h.Div({"class": "actions"}, *actions) if actions else None,
        ),
        panes,
        h.Ol({"class": "steps"}, *rail),
    ]
    if run.error:
        blocks.append(h.P({"class": "error"}, run.error))
    if run.status == "waiting" and run.ask:
        blocks.append(h.Div({"class": "card-block ask"}, h.Strong("The agent asked"), h.P(run.ask)))
    if view.pane == "diff":
        body = diff.text if diff and diff.text else "No diff yet."
        blocks.append(h.Pre({"class": "diff"}, body))
    else:
        blocks.append(h.Ol({"id": "transcript", "class": "transcript"}, *transcript))
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
        {"tab": tab, "message": "", "objective": "", "_error": ""},
        h.Main({"id": "task"}, *blocks),
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
