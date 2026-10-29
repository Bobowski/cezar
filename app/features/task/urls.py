from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

TASK = Route("GET /tasks/{run_id}")
TASK_LIVE = Route("GET /tasks/{run_id}/live")
TASK_CANCEL = Route("POST /tasks/{run_id}/cancel")
TASK_FINISH = Route("POST /tasks/{run_id}/finish")
TASK_DELETE = Route("POST /tasks/{run_id}/delete")
TASK_MESSAGE = Route("POST /tasks/{run_id}/message")
TASK_DISPATCH = Route("POST /tasks/{run_id}/dispatch")

PANES = ("session", "diff")


@dataclass(frozen=True, slots=True)
class TaskView:
    pane: str = "session"

    @classmethod
    def from_query(cls, query: ParsedQuery) -> TaskView:
        pane = query.get("pane", "session")
        return cls(pane if pane in PANES else "session")

    def query(self) -> dict[str, str]:
        return {"pane": self.pane}
