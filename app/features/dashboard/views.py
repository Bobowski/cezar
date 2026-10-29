from stario import h
from stario.markup import HtmlElement

from app.common.shell import Chrome, frame
from app.engine.model import STATUSES, Run
from app.features.dashboard.urls import DASHBOARD_LIVE
from app.features.tasks.urls import TASKS


def render(
    runs: list[Run],
    chrome: Chrome,
    tab: str,
    *,
    show_tokens: bool,
    show_cost: bool,
) -> HtmlElement:
    counts = {status: sum(1 for run in runs if run.status == status) for status in STATUSES}
    tokens = sum(run.tokens_used for run in runs)
    cost = sum(run.cost_usd for run in runs)
    cards = [
        h.A(
            {
                "class": "count",
                "id": f"count-{status}",
                "href": TASKS.href(query={"status": status, "project": chrome.project_id}),
            },
            h.B(str(counts[status])),
            status,
        )
        for status in STATUSES
    ]
    usage: list[HtmlElement] = []
    if show_tokens:
        usage.append(
            h.Div({"class": "count", "id": "token-total"}, h.B(str(tokens)), "tokens reported")
        )
    if show_cost:
        usage.append(
            h.Div({"class": "count", "id": "cost-total"}, h.B(f"${cost:.2f}"), "cost reported")
        )
    hidden = _hidden_note(show_tokens, show_cost)
    return frame(
        chrome,
        DASHBOARD_LIVE.href(),
        {"tab": tab},
        h.Main(
            {"id": "dashboard"},
            h.H1("Dashboard"),
            h.P({"class": "sub"}, "Counts across every project in this cockpit."),
            h.Div({"class": "counts"}, *cards),
            h.Div({"class": "counts"}, *usage) if usage else None,
            h.P({"id": "usage-hidden", "class": "muted"}, hidden) if hidden else None,
            h.P(
                {"class": "muted"},
                "Totals only. There is no daily usage chart.",
            ),
        ),
    )


def _hidden_note(show_tokens: bool, show_cost: bool) -> str:
    if show_tokens and show_cost:
        return ""
    if not show_tokens and not show_cost:
        return "Token and cost totals are hidden."
    if not show_tokens:
        return "Token totals are hidden."
    return "Cost totals are hidden."
