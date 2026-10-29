from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

WORKFLOWS = Route("GET /workflows")
WORKFLOWS_LIVE = Route("GET /workflows/live")
WORKFLOWS_CREATE = Route("POST /workflows")
WORKFLOWS_DELETE = Route("POST /workflows/{name}/delete")


@dataclass(frozen=True, slots=True)
class WorkflowsView:
    project: str = ""

    @classmethod
    def from_query(cls, query: ParsedQuery) -> WorkflowsView:
        project = query.get("project", "")
        if project and not project.replace("-", "").isalnum():
            project = ""
        return cls(project)

    def query(self) -> dict[str, str]:
        return {"project": self.project}
