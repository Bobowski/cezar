from stario import Route

PROJECTS = Route("GET /projects")
PROJECTS_LIVE = Route("GET /projects/live")
PROJECTS_ADD = Route("POST /projects")
PROJECTS_REMOVE = Route("POST /projects/{project_id}/remove")
