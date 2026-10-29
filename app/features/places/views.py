from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, status_chip
from app.engine.model import Run, Workflow
from app.features.places.urls import GITHUB, INBOX_READ, REPO, SETTINGS_WEBHOOKS_SAVE, TRACKER
from app.features.settings.nav import settings_nav
from app.features.task.urls import TASK
from app.features.tasks.urls import TASKS_NEW


def inbox(runs: list[Run], chrome: Chrome, tab: str) -> HtmlElement:
    rows = [
        h.A(
            {"class": "task-row", "href": TASK.href(run.id)},
            status_chip(run.status),
            h.Strong(run.title),
        )
        for run in runs
    ] or [h.P({"class": "muted"}, "Nothing unread.")]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "inbox"},
            h.H1("Inbox"),
            h.P({"class": "sub"}, "Finished runs you have not opened since they settled."),
            h.Button(
                {"type": "button", "class": "btn"},
                data.on("click", at.post(INBOX_READ.href())),
                "Mark read",
            ),
            h.Div({"class": "task-list"}, *rows),
        ),
    )


def github(
    owner: str, repo_name: str, lines: list[str], notice: str, chrome: Chrome, tab: str
) -> HtmlElement:
    items = [h.Li(line) for line in lines] or [h.Li({"class": "muted"}, "No open issues.")]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "github"},
            h.H1("GitHub"),
            h.Form(
                {"method": "get", "action": GITHUB.href(), "class": "composer"},
                h.Label(
                    {"class": "field"},
                    h.Span("Owner"),
                    h.Input({"name": "owner", "value": owner, "aria-label": "Owner"}),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Repository"),
                    h.Input({"name": "repo", "value": repo_name, "aria-label": "Repository"}),
                ),
                h.Button({"class": "btn btn-primary", "type": "submit"}, "List open issues"),
            ),
            h.P({"id": "github-notice", "class": "sub"}, notice),
            h.Ul({"id": "github-issues"}, *items),
        ),
    )


def tracker(kind: str, key: str, notice: str, chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "tracker"},
            h.H1("Tracker"),
            h.P(
                {"class": "sub"},
                "Look up a Jira or Linear issue. A saved connection is used when it has a token.",
            ),
            h.Form(
                {"method": "get", "action": TRACKER.href(), "class": "composer"},
                h.Label(
                    {"class": "field"},
                    h.Span("Tracker"),
                    h.Select(
                        {"name": "kind", "aria-label": "Tracker"},
                        h.Option({"value": "jira", "selected": kind != "linear"}, "Jira"),
                        h.Option({"value": "linear", "selected": kind == "linear"}, "Linear"),
                    ),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("Issue"),
                    h.Input({"name": "key", "value": key, "aria-label": "Issue key"}),
                ),
                h.Button({"class": "btn btn-primary", "type": "submit"}, "Look up"),
            ),
            h.P({"id": "tracker-result", "class": "sub"}, notice),
        ),
    )


_GIT_PANES = ("commits", "changes", "branches", "files")


def repo(pane: str, lines: list[str], chrome: Chrome, tab: str) -> HtmlElement:
    chosen = pane if pane in _GIT_PANES else "commits"
    links = []
    for name in _GIT_PANES:
        attrs = {"href": REPO.href(query={"pane": name})}
        if name == chosen:
            attrs["class"] = "on"
        links.append(h.A(attrs, name))
    rows = [h.Li(line) for line in lines] or [h.Li({"class": "muted"}, "Nothing here.")]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "git"},
            h.H1("Repository"),
            h.Nav({"class": "filters", "id": "git-panes"}, *links),
            h.H2(chosen),
            h.Ul({"id": "git-rows"}, *rows),
        ),
    )


def workflow(item: Workflow | None, chrome: Chrome, tab: str) -> HtmlElement:
    if item is None:
        return _page(chrome, tab, "workflow", "Workflow", "That workflow is not in the catalog.")
    graph = item.graph if isinstance(item.graph, dict) else None
    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    if isinstance(nodes, list) and nodes:
        rows = [
            h.Li(f"{node.get('id')} · {node.get('type')}")
            for node in nodes
            if isinstance(node, dict)
        ]
    else:
        rows = [h.Li(step.name or step.id) for step in item.steps]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "workflow"},
            h.H1(item.name),
            h.P({"class": "sub"}, item.description or item.source),
            h.Ol(*rows),
            h.A(
                {
                    "class": "btn btn-primary",
                    "href": TASKS_NEW.href(query={"workflow": item.name}),
                },
                "Start a task",
            ),
        ),
    )


def compare(runs: list[Run], chrome: Chrome, tab: str) -> HtmlElement:
    rows = [
        h.A(
            {"class": "task-row", "href": TASK.href(run.id)},
            h.Strong(run.variant or run.id[:8]),
            status_chip(run.status),
            h.Span(run.title),
        )
        for run in runs
    ]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main({"id": "compare"}, h.H1("Compare"), h.Div({"class": "task-list"}, *rows)),
    )


def privacy(chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "privacy"},
            settings_nav(),
            h.H1("Privacy"),
            h.P(
                {"class": "sub"},
                "Telemetry, self-update, and the star count are intentionally not ported. "
                "This fork does not send anything to an upstream endpoint.",
            ),
        ),
    )


def agents(lines: list[str], chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "agents"},
            settings_nav(),
            h.H1("Agents"),
            h.Ul({"id": "agent-bins"}, *[h.Li(line) for line in lines]),
        ),
    )


def webhooks(names: list[str], chrome: Chrome, tab: str) -> HtmlElement:
    rows = [h.Li(name) for name in names] or [h.Li({"class": "muted"}, "No receivers.")]
    return frame(
        chrome,
        None,
        {"tab": tab, "name": "", "url": "", "_error": ""},
        h.Main(
            {"id": "webhooks"},
            settings_nav(),
            h.H1("Webhooks"),
            h.Ul({"id": "receivers"}, *rows),
            h.Form(
                {"class": "composer"},
                data.on("submit", at.post(SETTINGS_WEBHOOKS_SAVE.href()), prevent=True),
                h.Label(
                    {"class": "field"},
                    h.Span("Name"),
                    h.Input({"required": True, "maxlength": "80"}, data.bind("name")),
                ),
                h.Label(
                    {"class": "field"},
                    h.Span("URL"),
                    h.Input({"type": "url", "required": True}, data.bind("url")),
                ),
                h.P(
                    {"class": "error", "role": "alert"},
                    data.show("$_error"),
                    data.text("$_error"),
                ),
                h.Button({"class": "btn btn-primary", "type": "submit"}, "Save receiver"),
            ),
        ),
    )


def worktrees(keep: int, chrome: Chrome, tab: str) -> HtmlElement:
    text = (
        f"The {keep} newest finished worktree directories are kept. "
        "Older directories are removed and the branch stays."
        if keep > 0
        else "Worktree retention is off. Finished directories are kept."
    )
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "worktrees"},
            settings_nav(),
            h.H1("Worktrees"),
            h.P({"class": "sub"}, text),
            h.P({"id": "worktree-keep"}, str(keep)),
        ),
    )


def _page(chrome: Chrome, tab: str, element_id: str, title: str, text: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main({"id": element_id}, h.H1(title), h.P({"class": "sub"}, text)),
    )
