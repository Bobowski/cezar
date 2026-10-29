from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, project_name, status_chip
from app.config import RUNNERS
from app.engine.model import Run, Workflow
from app.features.task.urls import TASK
from app.features.tasks.urls import TASKS, TASKS_CREATE, TASKS_LIVE, TASKS_NEW, TasksView


def render_list(runs: list[Run], view: TasksView, chrome: Chrome, tab: str) -> HtmlElement:
    filters = []
    for status in ("all", "queued", "running", "waiting", "review", "done", "failed", "cancelled"):
        nxt = TasksView(view.project, status)
        attrs = {"href": TASKS.href(query=nxt.query())}
        if view.status == status:
            attrs["class"] = "on"
        filters.append(h.A(attrs, status))
    rows: list[HtmlElement] = []
    for run in runs:
        rows.append(
            h.A(
                {"class": "task-row", "href": TASK.href(run.id)},
                status_chip(run.status),
                h.Strong(run.title),
                h.Span({"class": "meta grow"}, run.workflow),
                h.Span({"class": "meta"}, "child" if run.parent_id else ""),
            )
        )
    if not rows:
        rows.append(h.P({"class": "muted"}, "No tasks yet."))
    name = project_name(chrome.projects, view.project)
    return frame(
        chrome,
        TASKS_LIVE.href(query=view.query()),
        {"tab": tab},
        h.Div(
            {"id": "tasks"},
            h.Div(
                {"class": "top"},
                h.Div(h.H1("Tasks"), h.P({"class": "sub"}, name)),
                h.A(
                    {"class": "btn btn-primary", "href": TASKS_NEW.href(query=view.query())},
                    "New task",
                ),
            ),
            h.Nav({"class": "filters"}, *filters),
            h.Div({"class": "task-list"}, *rows),
        ),
    )


def render_new(
    workflows: list[Workflow],
    view: TasksView,
    chrome: Chrome,
    tab: str,
    default_runner: str,
) -> HtmlElement:
    return frame(
        chrome,
        None,
        {
            "tab": tab,
            "task": "",
            "workflow": "quick-task",
            "runner": default_runner,
            "model": "",
            "autonomous": False,
            "_error": "",
        },
        h.Main(
            {"id": "new-task"},
            h.H1("New task"),
            h.P({"class": "sub"}, project_name(chrome.projects, view.project)),
            h.Form(
                {"id": "new-task-form"},
                data.on(
                    "submit",
                    at.post(TASKS_CREATE.href(query=view.query())),
                    prevent=True,
                ),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Task"),
                    h.Textarea(
                        {"required": True, "maxlength": "20000"},
                        data.bind("task"),
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Workflow"),
                    h.Select(
                        data.bind("workflow"),
                        *[h.Option({"value": item.name}, item.name) for item in workflows],
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Agent"),
                    h.Select(
                        data.bind("runner"),
                        *[h.Option({"value": runner}, runner) for runner in RUNNERS],
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Model (optional)"),
                    h.Input({"type": "text", "maxlength": "120"}, data.bind("model")),
                ),
                h.Label(
                    {"class": "inline"},
                    h.Input({"type": "checkbox"}, data.bind("autonomous")),
                    "Autonomous — tell the agent not to stop and ask",
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Start",
                ),
            ),
        ),
    )
