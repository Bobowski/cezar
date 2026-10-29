from stario import h
from stario.datastar import at, data
from stario.datastar.format import string_literal
from stario.markup import HtmlElement

from app.features.settings.store import KINDS, SkillRepo, TrackerConnection
from app.features.settings.urls import (
    GLOBAL_INSTRUCTIONS_SAVE,
    GLOBAL_SKILLS_REMOVE,
    GLOBAL_SKILLS_SAVE,
    RESOURCES_SAVE,
    TASKS_SETTINGS_SAVE,
    TRACKER_SETTINGS_SAVE,
)


def tasks(branch: str, checks: list[str]) -> tuple[HtmlElement, ...]:
    rows = [h.Li(name) for name in checks] or [h.Li({"class": "muted"}, "No required checks.")]
    return (
        h.P(
            {"class": "sub"},
            "New task worktrees branch from this. Required checks are listed here; "
            "merge does not block on the list.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(TASKS_SETTINGS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Base branch"),
                h.Input(
                    {"required": True, "maxlength": "200", "aria-label": "Base branch"},
                    data.bind("branch"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Required checks"),
                h.Input(
                    {
                        "maxlength": "2000",
                        "placeholder": "lint, unit",
                        "aria-label": "Required checks",
                    },
                    data.bind("checks"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.P({"class": "meta"}, f"Landing branch: {branch}"),
        h.Ul({"id": "required-checks"}, *rows),
    )


def tracker(row: TrackerConnection) -> tuple[HtmlElement, ...]:
    saved = "A token is saved." if row.token else "No token yet."
    return (
        h.P(
            {"class": "sub"},
            "Connect this cockpit to Jira or Linear. Lookup uses the saved token when "
            "the row is complete, otherwise the process credentials. The token is not shown again.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(TRACKER_SETTINGS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Tracker"),
                h.Select(
                    {"aria-label": "Tracker"},
                    data.bind("kind"),
                    *[
                        h.Option({"value": kind, "selected": kind == row.kind}, kind)
                        for kind in KINDS
                    ],
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Site"),
                h.Input(
                    {"type": "url", "maxlength": "200", "aria-label": "Site"}, data.bind("site")
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Email"),
                h.Input(
                    {"type": "email", "maxlength": "200", "aria-label": "Email"},
                    data.bind("email"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Token"),
                h.Input(
                    {"type": "password", "maxlength": "500", "aria-label": "Token"},
                    data.bind("token"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save connection"),
        ),
        h.P({"id": "tracker-saved"}, f"{row.kind} · {row.site or 'no site'} · {saved}"),
    )


def instructions(prompt: str) -> tuple[HtmlElement, ...]:
    return (
        h.P(
            {"class": "sub"},
            "Rules for every project. A project's own system prompt is what a run prepends today.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(GLOBAL_INSTRUCTIONS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Global system prompt"),
                h.Textarea(
                    {"id": "global-prompt-input", "maxlength": "20000"},
                    data.bind("prompt"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.Pre({"id": "global-prompt"}, prompt),
    )


def skills(rows: list[SkillRepo]) -> tuple[HtmlElement, ...]:
    items = [
        h.Li(
            f"{row.repo} @ {row.ref}",
            h.Button(
                {"type": "button", "class": "btn"},
                data.on(
                    "click",
                    f"$repo = {string_literal(row.repo)}; " + at.post(GLOBAL_SKILLS_REMOVE.href()),
                ),
                "Remove",
            ),
        )
        for row in rows
    ] or [h.Li({"class": "muted"}, "No org skill repos.")]
    return (
        h.P(
            {"class": "sub"},
            "Org skill repositories. A run still reads skills from the repo directories only.",
        ),
        h.Ul({"id": "skill-repos"}, *items),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(GLOBAL_SKILLS_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Repository"),
                h.Input(
                    {
                        "type": "url",
                        "required": True,
                        "maxlength": "200",
                        "aria-label": "Repository",
                    },
                    data.bind("repo"),
                ),
            ),
            h.Label(
                {"class": "field"},
                h.Span("Ref"),
                h.Input({"maxlength": "80", "aria-label": "Ref"}, data.bind("ref")),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Add repo"),
        ),
    )


def resources(limit: int | None) -> tuple[HtmlElement, ...]:
    sentence = "No memory cap." if limit is None else f"Memory cap: {limit} MB."
    return (
        h.P(
            {"class": "sub"},
            "How much memory one task may use. Saved for this cockpit. "
            "The run loop does not pause a task from this number yet.",
        ),
        h.Form(
            {"class": "composer"},
            data.on("submit", at.post(RESOURCES_SAVE.href()), prevent=True),
            h.Label(
                {"class": "field"},
                h.Span("Memory cap (MB)"),
                h.Input(
                    {
                        "type": "number",
                        "min": "256",
                        "max": "65536",
                        "aria-label": "Memory cap",
                    },
                    data.bind("memory"),
                ),
            ),
            h.Button({"class": "btn btn-primary", "type": "submit"}, "Save"),
        ),
        h.P({"id": "memory-cap"}, sentence),
    )
