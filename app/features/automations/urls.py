from dataclasses import dataclass

from stario import Route
from stario.http.query import ParsedQuery

AUTOMATIONS = Route("GET /automations")
AUTOMATIONS_LIVE = Route("GET /automations/live")
AUTOMATIONS_CREATE = Route("POST /automations")
AUTOMATIONS_ENABLE = Route("POST /automations/{automation_id}/enable")
AUTOMATIONS_PAUSE = Route("POST /automations/{automation_id}/pause")
AUTOMATIONS_RUN = Route("POST /automations/{automation_id}/run")
AUTOMATIONS_DELETE = Route("POST /automations/{automation_id}/delete")


@dataclass(frozen=True, slots=True)
class AutomationsView:
    project: str = ""

    @classmethod
    def from_query(cls, query: ParsedQuery) -> AutomationsView:
        project = query.get("project", "")
        if project and not project.replace("-", "").isalnum():
            project = ""
        return cls(project)

    def query(self) -> dict[str, str]:
        return {"project": self.project}
