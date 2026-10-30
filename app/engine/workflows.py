"""Workflow documents: the checks the TypeScript loader applies before a run starts.

A file lists `steps` or the portable `skills` shorthand, never both. A step is an
agent step (prompt and/or skill) or a check (`command`), never both. `onFail.retry`
may only name an earlier step. `retryOn` lists the failing exit codes worth another
attempt; `0` is rejected because a passing check never reaches the loop.
"""

from __future__ import annotations

from app.config import RUNNERS
from app.engine.model import Step, Workflow, _secret_bindings

QUICK_TASK = Workflow(
    name="quick-task",
    description="One agent run on your task — no ceremony.",
    source="built-in",
    steps=(Step(id="task", name="Do the task", prompt="{{task}}"),),
)


def retryable_exit(retry_on: tuple[int, ...] | list[int], exit_code: int) -> bool:
    """A failing check buys another attempt. With no list, any non-zero code does."""
    if not retry_on:
        return True
    return exit_code in retry_on


def skills_to_steps(skills: list[str]) -> tuple[Step, ...]:
    used: set[str] = set()
    steps: list[Step] = []
    for skill in skills:
        step_id = skill
        n = 2
        while step_id in used:
            step_id = f"{skill}-{n}"
            n += 1
        used.add(step_id)
        steps.append(Step(id=step_id, name=skill, skill=skill, prompt="{{task}}"))
    return tuple(steps)


def skill_stack_of(steps: tuple[Step, ...] | list[Step]) -> tuple[str, ...] | None:
    """The compact `skills:` form, when every step is just "apply this skill to the task"."""
    names: list[str] = []
    for step in steps:
        if step.kind != "agent" or not step.skill:
            return None
        if step.prompt not in ("", "{{task}}"):
            return None
        if step.name not in ("", step.skill):
            return None
        if step.model or step.runner or step.allowed_tools or step.bash_allowlist or step.retry:
            return None
        if step.has_secrets:
            return None
        names.append(step.skill)
    return tuple(names) if names else None


def steps_issue(steps: tuple[Step, ...] | list[Step]) -> str | None:
    ids = [step.id for step in steps]
    for index, step_id in enumerate(ids):
        if step_id in ids[:index]:
            return f'duplicate step id "{step_id}"'
    for index, step in enumerate(steps):
        if not step.retry:
            continue
        target = ids.index(step.retry) if step.retry in ids else -1
        if target < 0 or target >= index:
            return (
                f'step "{step.id}": onFail.retry must reference an earlier step '
                f'(got "{step.retry}")'
            )
    return None


def parse_workflow(
    doc: object, *, source: str, path: str = ""
) -> tuple[Workflow | None, str | None]:
    """Return a workflow or a human-readable problem. Graph files are refused, not guessed."""
    if not isinstance(doc, dict):
        return None, "a workflow file must be a mapping"
    version = doc.get("version")
    if version in (2, "2"):
        from app.engine.graph import graph_issues

        return _parse_graph(doc, source, path, graph_issues)
    name = doc.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "name must be a non-empty string"
    description = doc.get("description", "")
    if description is None:
        description = ""
    if not isinstance(description, str):
        return None, "description must be a string"
    has_steps = "steps" in doc and doc.get("steps") is not None
    has_skills = "skills" in doc and doc.get("skills") is not None
    if has_steps == has_skills:
        return None, 'a workflow lists either "steps" or "skills", not both'
    if has_skills:
        skills = doc.get("skills")
        if not isinstance(skills, list) or not skills:
            return None, "skills must be a non-empty list of names"
        names: list[str] = []
        for item in skills:
            if not isinstance(item, str) or not item.strip():
                return None, "skills must be a non-empty list of names"
            names.append(item.strip())
        steps = skills_to_steps(names)
    else:
        raw_steps = doc.get("steps")
        if not isinstance(raw_steps, list) or not raw_steps:
            return None, "steps must be a non-empty list"
        parsed: list[Step] = []
        for raw in raw_steps:
            step, issue = _parse_step(raw)
            if issue or step is None:
                return None, issue or "invalid step"
            parsed.append(step)
        steps = tuple(parsed)
    issue = steps_issue(steps)
    if issue:
        return None, issue
    return Workflow(name.strip(), description.strip(), steps, source, path), None


def _parse_step(raw: object) -> tuple[Step | None, str | None]:
    if not isinstance(raw, dict):
        return None, "a step must be a mapping"
    step_id = raw.get("id")
    if not isinstance(step_id, str) or not step_id.strip():
        return None, "a step id must be a non-empty string"
    name = raw.get("name", "")
    if name is None:
        name = ""
    if not isinstance(name, str):
        return None, f'step "{step_id}": name must be a string'
    prompt = _optional_str(raw.get("prompt"))
    skill = _optional_str(raw.get("skill"))
    command = _optional_str(raw.get("command"))
    runner = _optional_str(raw.get("runner"))
    model = _optional_str(raw.get("model"))
    if prompt is None or skill is None or command is None or runner is None or model is None:
        return None, f'step "{step_id}": text fields must be strings'
    if runner and runner not in RUNNERS:
        return None, f'step "{step_id}": unknown runner "{runner}"'
    agent = bool(prompt or skill)
    if agent == bool(command):
        return None, (
            f'step "{step_id}": a step is either an agent step (prompt/skill) '
            "or a check step (command), not both"
        )
    secrets = raw.get("secrets")
    has_secrets = secrets not in (None, False)
    if has_secrets and not command:
        return None, f'step "{step_id}": secrets is for check steps only'
    retry = ""
    retry_max = 0
    retry_on: tuple[int, ...] = ()
    if "onFail" in raw and raw.get("onFail") is not None:
        if not command:
            return None, f'step "{step_id}": onFail is for check steps only'
        on_fail = raw.get("onFail")
        if not isinstance(on_fail, dict):
            return None, f'step "{step_id}": onFail must be a mapping'
        target = on_fail.get("retry")
        if not isinstance(target, str) or not target.strip():
            return None, f'step "{step_id}": onFail.retry must name a step'
        retry = target.strip()
        if "max" in on_fail and on_fail.get("max") is not None:
            maximum = on_fail.get("max")
            if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
                return None, f'step "{step_id}": onFail.max must be a positive integer'
            retry_max = maximum
        else:
            retry_max = 2
        if "retryOn" in on_fail and on_fail.get("retryOn") is not None:
            codes = on_fail.get("retryOn")
            if not isinstance(codes, list):
                return None, f'step "{step_id}": onFail.retryOn must be a list of exit codes'
            parsed_codes: list[int] = []
            for code in codes:
                if isinstance(code, bool) or not isinstance(code, int):
                    return None, f'step "{step_id}": onFail.retryOn must be a list of exit codes'
                if code <= 0:
                    return None, (
                        f'step "{step_id}": onFail.retryOn cannot list 0 — '
                        "a check that exits 0 passed"
                    )
                parsed_codes.append(code)
            retry_on = tuple(parsed_codes)
    allowed = _str_list(raw.get("allowedTools"))
    bash = _str_list(raw.get("bashAllowlist"))
    if allowed is None or bash is None:
        return None, f'step "{step_id}": tool lists must be lists of strings'
    return (
        Step(
            id=step_id.strip(),
            name=name.strip(),
            prompt=prompt,
            skill=skill,
            command=command,
            runner=runner,
            model=model,
            retry=retry,
            retry_max=retry_max,
            retry_on=retry_on,
            has_secrets=has_secrets,
            secret_bindings=_secret_bindings(secrets),
            allowed_tools=tuple(allowed),
            bash_allowlist=tuple(bash),
        ),
        None,
    )


def _parse_graph(
    doc: dict[str, object],
    source: str,
    path: str,
    issues_of: object,
) -> tuple[Workflow | None, str | None]:
    from app.engine.graph import rail_nodes

    name = doc.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "name must be a non-empty string"
    description = doc.get("description") or ""
    if not isinstance(description, str):
        return None, "description must be a string"
    nodes = doc.get("nodes")
    edges = doc.get("edges") or []
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return None, "a graph needs nodes and edges"
    graph: dict[str, object] = {"nodes": nodes, "edges": edges}
    problems = issues_of(graph) if callable(issues_of) else []
    if isinstance(problems, list) and problems:
        return None, str(problems[0])
    steps: list[Step] = []
    for node in rail_nodes(graph):  # type: ignore[arg-type]
        node_id = str(node.get("id", ""))
        label = str(node.get("name") or node_id)
        if node.get("type") == "check":
            steps.append(Step(id=node_id, name=label, command=str(node.get("command", ""))))
        else:
            steps.append(
                Step(
                    id=node_id,
                    name=label,
                    prompt=str(node.get("prompt") or ""),
                    skill=str(node.get("skill") or ""),
                )
            )
    return Workflow(name.strip(), description.strip(), tuple(steps), source, path, graph), None


def _optional_str(value: object) -> str | None:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return None


def _str_list(value: object) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        return None
    return [item for item in value if isinstance(item, str)]


def newer_catalog_workflow(snapshot: Workflow, catalog: list[Workflow]) -> Workflow | None:
    """The catalog entry a queued run should start with, when the file changed underneath it.

    A deleted file falls back to the built-in `quick-task` in the catalog. A queued snapshot
    of that file keeps its own steps — switching it to the built-in would drop them.
    Ad-hoc chains such as `(planned)` are not catalog entries and are never replaced.
    """
    if snapshot.source != "file" and snapshot.name != QUICK_TASK.name:
        return None
    current = next((item for item in catalog if item.name == snapshot.name), None)
    if current is None:
        return None
    if snapshot.source == "file" and current.source != "file":
        return None
    if current.to_json() == snapshot.to_json():
        return None
    return current
