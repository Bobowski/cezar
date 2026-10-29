from stario import h
from stario.datastar import at, data
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame, status_chip
from app.engine.model import Run, Workflow
from app.features.places.urls import INBOX_READ
from app.features.task.urls import TASK


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


def github(body: str, chrome: Chrome, tab: str) -> HtmlElement:
    return _page(chrome, tab, "github", "GitHub", body)


def tracker(chrome: Chrome, tab: str) -> HtmlElement:
    return _page(
        chrome,
        tab,
        "tracker",
        "Tracker",
        "Look up a Jira or Linear issue from Settings credentials. "
        "Nothing is fetched until a key is configured.",
    )


def repo(lines: list[str], chrome: Chrome, tab: str) -> HtmlElement:
    rows = [h.Li(line) for line in lines] or [h.Li({"class": "muted"}, "No commits.")]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main({"id": "git"}, h.H1("Repository"), h.H2("Commits"), h.Ul(*rows)),
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
    return _page(
        chrome,
        tab,
        "privacy",
        "Privacy",
        "Telemetry, self-update, and the star count are intentionally not ported. "
        "This fork does not send anything to an upstream endpoint.",
    )


def agents(lines: list[str], chrome: Chrome, tab: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main(
            {"id": "agents"},
            h.H1("Agents"),
            h.Ul(*[h.Li(line) for line in lines]),
        ),
    )


def webhooks(names: list[str], chrome: Chrome, tab: str) -> HtmlElement:
    rows = [h.Li(name) for name in names] or [h.Li({"class": "muted"}, "No receivers.")]
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main({"id": "webhooks"}, h.H1("Webhooks"), h.Ul(*rows)),
    )


def worktrees(keep: int, chrome: Chrome, tab: str) -> HtmlElement:
    text = (
        f"The {keep} newest finished worktree directories are kept. "
        "Older directories are removed and the branch stays."
        if keep > 0
        else "Worktree retention is off. Finished directories are kept."
    )
    return _page(chrome, tab, "worktrees", "Worktrees", text)


def _page(chrome: Chrome, tab: str, element_id: str, title: str, text: str) -> HtmlElement:
    return frame(
        chrome,
        None,
        {"tab": tab},
        h.Main({"id": element_id}, h.H1(title), h.P({"class": "sub"}, text)),
    )
