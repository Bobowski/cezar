from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import Automation, Workflow
from app.features.automations.urls import (
    AUTOMATIONS_CREATE,
    AUTOMATIONS_DELETE,
    AUTOMATIONS_ENABLE,
    AUTOMATIONS_LIVE,
    AUTOMATIONS_PAUSE,
    AUTOMATIONS_RUN,
    AutomationsView,
)


def render(
    items: list[Automation],
    workflows: list[Workflow],
    view: AutomationsView,
    chrome: Chrome,
    tab: str,
) -> HtmlElement:
    rows = []
    for item in items:
        toggle = (
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(AUTOMATIONS_PAUSE.href(item.id))),
                "Pause",
            )
            if item.enabled
            else h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(AUTOMATIONS_ENABLE.href(item.id))),
                "Enable",
            )
        )
        rows.append(
            h.Div(
                {"class": "card-block"},
                h.Strong(item.name),
                h.P(
                    {"class": "sub"},
                    "every "
                    f"{item.every_minutes} min · "
                    f"{'enabled' if item.enabled else 'paused'} · next {item.next_at}",
                ),
                h.P(item.task),
                h.Div(
                    {"class": "actions"},
                    toggle,
                    h.Button(
                        {"type": "button", "class": "btn"},
                        data.on("click", at.post(AUTOMATIONS_RUN.href(item.id))),
                        "Run now",
                    ),
                    h.Button(
                        {"type": "button", "class": "btn btn-danger"},
                        data.on("click", at.post(AUTOMATIONS_DELETE.href(item.id))),
                        "Delete",
                    ),
                ),
            )
        )
    if not rows:
        rows.append(
            h.P({"class": "muted"}, "No automations. A new one stays paused until you enable it.")
        )
    return frame(
        chrome,
        AUTOMATIONS_LIVE.href(query=view.query()),
        {"tab": tab, "name": "", "task": "", "every": 60, "workflow": "quick-task", "_error": ""},
        h.Main(
            {"id": "automations"},
            h.H1("Automations"),
            h.P(
                {"class": "sub"},
                "Interval schedules only. GitHub, Jira, and Linear triggers are not in this port. "
                "Enabling a stale schedule does not launch a backlog.",
            ),
            *rows,
            h.Form(
                {"class": "composer"},
                data.on(
                    "submit", at.post(AUTOMATIONS_CREATE.href(query=view.query())), prevent=True
                ),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Name"),
                    h.Input({"required": True, "maxlength": "80"}, data.bind("name")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Task"),
                    h.Textarea({"required": True, "maxlength": "20000"}, data.bind("task")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Every N minutes"),
                    h.Input(
                        {"type": "number", "min": "1", "max": "10080", "required": True},
                        data.bind("every"),
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
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Add paused automation",
                ),
            ),
        ),
    )
