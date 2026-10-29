"""Turn a ```mermaid fence in a transcript into an SVG flowchart.

Only `A --> B` edges are drawn. Anything else stays as the source, so a diagram
this port cannot lay out is still visible.
"""

from __future__ import annotations

import re

from stario import h
from stario.markup import HtmlElement, svg

_FENCE = re.compile(r"```mermaid\s*\n(.*?)```", re.S)
_EDGE = re.compile(r"^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$")


def diagrams(text: str) -> list[HtmlElement]:
    blocks: list[HtmlElement] = []
    for source in _FENCE.findall(text):
        drawn = flowchart(source)
        blocks.append(drawn if drawn is not None else h.Pre({"class": "mermaid"}, source.strip()))
    return blocks


def flowchart(source: str) -> HtmlElement | None:
    edges = [match.groups() for line in source.splitlines() if (match := _EDGE.match(line))]
    if not edges:
        return None
    order: list[str] = []
    for left, right in edges:
        for name in (left, right):
            if name not in order:
                order.append(name)
    width = 40 + len(order) * 120
    nodes = []
    labels = []
    lines = []
    at = {name: 24 + index * 120 for index, name in enumerate(order)}
    for left, right in edges:
        lines.append(
            svg.Line(
                {
                    "x1": at[left] + 72,
                    "y1": 28,
                    "x2": at[right],
                    "y2": 28,
                    "stroke": "currentColor",
                }
            )
        )
    for name in order:
        nodes.append(
            svg.Rect(
                {
                    "x": at[name],
                    "y": 8,
                    "width": 72,
                    "height": 40,
                    "rx": 6,
                    "fill": "none",
                    "stroke": "currentColor",
                }
            )
        )
        labels.append(svg.Text({"x": at[name] + 36, "y": 32, "text-anchor": "middle"}, name))
    return svg.Svg(
        {
            "class": "mermaid",
            "role": "img",
            "aria-label": " ".join(order),
            "viewBox": f"0 0 {width} 56",
            "width": str(width),
            "height": "56",
        },
        *lines,
        *nodes,
        *labels,
    )
