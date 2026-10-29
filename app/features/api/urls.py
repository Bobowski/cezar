from stario import Route

API_RUNS = Route("GET /api/v1/runs")
API_RUNS_CREATE = Route("POST /api/v1/runs")
API_RUN = Route("GET /api/v1/runs/{run_id}")
API_EVENTS = Route("GET /api/v1/runs/{run_id}/events")
API_CANCEL = Route("POST /api/v1/runs/{run_id}/cancel")
API_FINISH = Route("POST /api/v1/runs/{run_id}/finish")
API_WORKFLOWS = Route("GET /api/v1/workflows")
API_PROJECTS = Route("GET /api/v1/projects")
