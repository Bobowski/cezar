from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import Project
from app.features.projects.urls import PROJECTS_ADD, PROJECTS_LIVE, PROJECTS_REMOVE


def render(projects: list[Project], chrome: Chrome, tab: str) -> HtmlElement:
    rows = []
    for project in projects:
        rows.append(
            h.Div(
                {"class": "card-block"},
                h.Strong(project.name),
                h.P({"class": "sub"}, project.root),
                h.P({"class": "meta"}, f"base {project.base_branch}"),
                h.Button(
                    {"type": "button", "class": "btn btn-danger"},
                    data.on("click", at.post(PROJECTS_REMOVE.href(project.id))),
                    "Remove",
                ),
            )
        )
    return frame(
        chrome,
        PROJECTS_LIVE.href(),
        {"tab": tab, "path": "", "_error": ""},
        h.Main(
            {"id": "projects"},
            h.H1("Projects"),
            h.P({"class": "sub"}, "Each directory is a repo the cockpit can run tasks in."),
            *rows,
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(PROJECTS_ADD.href()), prevent=True),
                data.indicator("_saving"),
                h.Label(
                    {"class": "field"},
                    h.Span("Directory"),
                    h.Input(
                        {"type": "text", "required": True, "maxlength": "500"}, data.bind("path")
                    ),
                ),
                h.P(
                    {"class": "error", "role": "alert"}, data.show("$_error"), data.text("$_error")
                ),
                h.Button(
                    {"class": "btn btn-primary", "type": "submit"},
                    data.attr("disabled", "$_saving"),
                    "Add project",
                ),
            ),
        ),
    )
