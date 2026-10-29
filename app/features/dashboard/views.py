from stario import h
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import STATUSES, Run
from app.features.dashboard.urls import DASHBOARD_LIVE
from app.features.tasks.urls import TASKS


def render(runs: list[Run], chrome: Chrome, tab: str) -> HtmlElement:
    counts = {status: sum(1 for run in runs if run.status == status) for status in STATUSES}
    tokens = sum(run.tokens_used for run in runs)
    cost = sum(run.cost_usd for run in runs)
    cards = [
        h.A(
            {
                "class": "count",
                "href": TASKS.href(query={"status": status, "project": chrome.project_id}),
            },
            h.B(str(counts[status])),
            status,
        )
        for status in STATUSES
    ]
    return frame(
        chrome,
        DASHBOARD_LIVE.href(),
        {"tab": tab},
        h.Main(
            {"id": "dashboard"},
            h.H1("Dashboard"),
            h.P({"class": "sub"}, "Counts across every project in this cockpit."),
            h.Div({"class": "counts"}, *cards),
            h.Div(
                {"class": "counts"},
                h.Div({"class": "count"}, h.B(str(tokens)), "tokens reported"),
                h.Div({"class": "count"}, h.B(f"${cost:.2f}"), "cost reported"),
            ),
            h.P(
                {"class": "muted"},
                "The mock agent reports no usage. There is no usage-window chart.",
            ),
        ),
    )
