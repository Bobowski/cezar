from stario import h
from stario.markup import HtmlElement, svg

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
            usage_chart(runs, show_tokens=show_tokens, show_cost=show_cost),
            h.P({"id": "usage-hidden", "class": "muted"}, hidden) if hidden else None,
            h.P(
                {"class": "muted"},
                "Bars are each day's reported tokens. There is no usage-window series.",
            ),
        ),
    )


def usage_chart(runs: list[Run], *, show_tokens: bool, show_cost: bool) -> HtmlElement | None:
    """One bar per finish day. The height is that day's reported tokens."""
    if not show_tokens and not show_cost:
        return None
    buckets: dict[str, tuple[int, float]] = {}
    for run in runs:
        day = (run.finished_at or "")[:10]
        if len(day) != 10:
            continue
        tokens, cost = buckets.get(day, (0, 0.0))
        buckets[day] = (tokens + run.tokens_used, cost + run.cost_usd)
    if not buckets:
        return h.P({"id": "usage-chart"}, "No daily usage yet.")
    days = sorted(buckets)
    peak = max(buckets[day][0] for day in days) or 1
    width = 16 + len(days) * 48
    marks: list[HtmlElement] = []
    for index, day in enumerate(days):
        tokens, cost = buckets[day]
        height = 4 if tokens == 0 else max(4, round(80 * tokens / peak))
        x = 16 + index * 48
        marks.append(
            svg.Rect(
                {
                    "x": x,
                    "y": 90 - height,
                    "width": 28,
                    "height": height,
                    "fill": "currentColor",
                }
            )
        )
        label = day[5:]
        if show_cost:
            label = f"{label} ${cost:.0f}"
        marks.append(svg.Text({"x": x + 14, "y": 106, "text-anchor": "middle"}, label))
    return h.Figure(
        {"id": "usage-chart"},
        h.Figcaption("Daily reported tokens"),
        svg.Svg(
            {
                "viewBox": f"0 0 {width} 112",
                "role": "img",
                "aria-label": "Daily usage",
            },
            *marks,
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
