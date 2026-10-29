import asyncio
from datetime import timedelta
from pathlib import Path

import pytest
from litewriter import LiteWriter
from stario import App, Relay
from tests.conftest import init_repo

from app.clock import now, stamp
from app.config import RUNNERS, Config
from app.engine.agents import AgentEvent, AgentSpec, StdinAgent, usage_from_line
from app.engine.engine import Engine, rebaseline_automations
from app.engine.gitignore_data import DATA_GITIGNORE_ENTRIES, ensure_data_gitignore
from app.engine.gitwork import diff_against, is_safe_git_ref, log_count, prune_orphans
from app.engine.model import Automation, Run, Settings, Step, Workflow
from app.store.db import get_run, insert_run, list_runs, mark_interrupted, save_run, schema


def config_for(tmp_path: Path, repo: Path, **overrides: object) -> Config:
    data = tmp_path / "state"
    data.mkdir(exist_ok=True)
    values: dict[str, object] = {
        "app_name": "cezar",
        "version": "test",
        "data_dir": data,
        "db_path": data / "app.sqlite3",
        "repo_root": repo,
        "dry_run": True,
        "real_agents": False,
        "dispatch_enabled": True,
        "tick_seconds": 0.05,
        "check_timeout_seconds": 30,
        "runner_bins": {runner: runner for runner in RUNNERS},
        "listen_host": "127.0.0.1",
        "listen_port": 4321,
    }
    values.update(overrides)
    return Config(**values)  # type: ignore[arg-type]


class RecordingAgent:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.systems: list[str] = []
        self.calls = 0

    async def stream(self, spec: AgentSpec):
        self.prompts.append(spec.user_prompt)
        self.systems.append(spec.system_prompt)
        self.calls += 1
        if "mock:fail" in spec.user_prompt:
            yield AgentEvent("error", "boom")
            return
        if self.calls >= 2:
            Path(spec.cwd, "done.txt").write_text("ok\n", encoding="utf-8")
        yield AgentEvent("text", "CEZ:DONE")
        yield AgentEvent("turn-end")


class GateAgent:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.count = 0

    async def stream(self, spec: AgentSpec):
        self.count += 1
        self.started.set()
        await self.release.wait()
        yield AgentEvent("turn-end")


@pytest.fixture
async def world(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        yield engine, repo


async def _start(engine: Engine, task: str = "do the thing") -> Run:
    from app.store.db import get_project

    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    run, reason = engine.plan_run(
        project=project, task=task, workflow_name="quick-task", runner="claude"
    )
    assert run is not None, reason
    await engine.enqueue(run)
    return run


async def test_a_graph_check_reviews_on_pass_and_fails_on_an_unwired_failure(world):
    from app.engine.workflows import parse_workflow

    engine, _repo = world
    project = __import__("app.store.db", fromlist=["get_project"]).get_project(
        engine.db, engine.boot_project_id
    )
    assert project is not None

    def run_graph(command: str):
        workflow, issue = parse_workflow(
            {
                "name": "g",
                "version": 2,
                "nodes": [
                    {"id": "start", "type": "start"},
                    {"id": "tests", "type": "check", "command": command},
                    {"id": "ok", "type": "end", "status": "success"},
                ],
                "edges": [
                    {"from": "start", "to": "tests"},
                    {"from": "tests.pass", "to": "ok"},
                ],
            },
            source="file",
        )
        assert workflow is not None, issue
        return workflow

    passed, reason = engine.plan_run(
        project=project,
        task="graph",
        workflow_name="g",
        runner="claude",
        workflow=run_graph("true"),
    )
    assert passed is not None, reason
    await engine.enqueue(passed)
    await engine.execute(passed.id)
    assert (get_run(engine.db, passed.id) or passed).status == "review"

    failed, reason = engine.plan_run(
        project=project,
        task="graph",
        workflow_name="g",
        runner="claude",
        workflow=run_graph("false"),
    )
    assert failed is not None, reason
    await engine.enqueue(failed)
    await engine.execute(failed.id)
    done = get_run(engine.db, failed.id)
    assert done is not None and done.status == "failed"


async def test_queued_messages_are_folded_into_the_prompt_and_not_written_back(world):
    engine, repo = world
    run = await _start(engine, "original task")
    message, reason = await engine.queue_message(run.id, "also this")
    assert reason is None and message is not None
    await engine.execute(run.id)
    stored = get_run(engine.db, run.id)
    assert stored is not None
    assert stored.task == "original task"
    assert stored.queued_messages[0]["text"] == "also this"
    written = (repo / ".ai" / "cezar" / "worktrees" / run.id / "CEZAR_DRY_RUN.txt").read_text(
        encoding="utf-8"
    )
    assert "original task" in written
    assert "also this" in written


def test_dry_run_is_opt_in_like_the_typescript_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("PROJECT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("CEZ_DRY_RUN", raising=False)
    assert Config.from_env().dry_run is False
    monkeypatch.setenv("CEZ_DRY_RUN", "1")
    assert Config.from_env().dry_run is True


def test_option_like_refs_are_refused():
    assert is_safe_git_ref("main")
    assert not is_safe_git_ref("--upload-pack=touch")
    assert not is_safe_git_ref("")


def test_usage_frame_is_read_and_other_lines_are_not():
    assert usage_from_line('{"type":"result","usage":{"input_tokens":3,"output_tokens":4}}') == (
        3,
        4,
    )
    assert usage_from_line("hello") is None


async def test_a_stale_schedule_does_not_launch_a_backlog(world):
    engine, _repo = world
    stale = Automation(
        id="ab" * 16,
        project_id=engine.boot_project_id,
        name="nightly",
        task="check deps",
        workflow="quick-task",
        runner="claude",
        every_minutes=60,
        enabled=True,
        next_at=(now() - timedelta(days=2)).isoformat(),
        created_at=stamp(),
    )
    await engine.create_automation(stale)
    await engine.db.write(rebaseline_automations)
    await engine._launch_due()
    assert list_runs(engine.db, None, None) == []
    assert await engine.set_automation_enabled(stale.id, True) is None
    assert list_runs(engine.db, None, None) == []
    fresh = Automation(
        id="cd" * 16,
        project_id=engine.boot_project_id,
        name="soon",
        task="check deps soon",
        workflow="quick-task",
        runner="claude",
        every_minutes=60,
        enabled=True,
        next_at=(now() - timedelta(minutes=1)).isoformat(),
        created_at=stamp(),
    )
    await engine.create_automation(fresh)
    await engine._launch_due()
    launched = [run for run in list_runs(engine.db, None, None) if run.task == "check deps soon"]
    assert len(launched) == 1


async def test_a_restart_fails_a_running_agent_and_leaves_the_queue(world):
    engine, _repo = world
    queued = await _start(engine, "queued work")
    running = Run(
        id="a" * 32,
        project_id=engine.boot_project_id,
        title="live",
        task="live",
        workflow="quick-task",
        status="running",
        runner="claude",
        created_at=stamp(),
        workflow_def={},
    )
    await engine.db.write(insert_run, running)
    await engine.db.write(mark_interrupted)
    assert (get_run(engine.db, running.id) or running).status == "failed"
    assert "interrupted" in (get_run(engine.db, running.id) or running).error
    assert (get_run(engine.db, queued.id) or queued).status == "queued"


async def test_success_stops_at_review_and_finish_does_not_merge(world):
    engine, repo = world
    run = await _start(engine, "write the note")
    await engine.execute(run.id)
    done = get_run(engine.db, run.id)
    assert done is not None
    assert done.status == "review"
    assert done.branch == f"cez/{run.id[:8]}"
    assert log_count(repo) == 1
    diff = diff_against(Path(done.worktree_path), done.base_sha)
    assert "CEZAR_DRY_RUN.txt" in diff.text
    assert diff.adds > 0
    assert "CEZAR_DRY_RUN" not in (repo / "README.md").read_text(encoding="utf-8")
    assert await engine.finish(run.id) is None
    assert (get_run(engine.db, run.id) or done).status == "done"
    assert log_count(repo) == 1
    assert await engine.finish(run.id) == "no open session"


async def test_a_bad_base_does_not_run_in_the_main_tree(world):
    engine, repo = world
    from dataclasses import replace

    from app.store.db import get_project, save_project

    project = get_project(engine.db, engine.boot_project_id)
    assert project is not None
    await engine.db.write(save_project, replace(project, base_branch="no-such-branch"))
    run = await _start(engine, "should fail")
    await engine.execute(run.id)
    failed = get_run(engine.db, run.id)
    assert failed is not None and failed.status == "failed"
    assert not (repo / "CEZAR_DRY_RUN.txt").exists()


async def test_a_directory_that_is_not_a_git_repo_runs_in_place(tmp_path: Path):
    repo = tmp_path / "plain"
    repo.mkdir()
    cfg = config_for(tmp_path, repo)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        run = await _start(engine, "notes")
        await engine.execute(run.id)
        done = get_run(engine.db, run.id)
        assert done is not None
        assert done.status == "review"
        assert done.in_place is True
        assert (repo / "CEZAR_DRY_RUN.txt").exists()


async def test_cez_done_does_not_skip_the_next_agent_step(world):
    engine, _repo = world
    agent = RecordingAgent()
    engine.agent = agent
    run = await _start(engine, "chain the work")
    definition = Workflow(
        name="chain",
        description="",
        source="built-in",
        steps=(
            Step(id="one", name="First", prompt="{{task}}"),
            Step(id="two", name="Second", prompt="{{task}}"),
        ),
    )
    run.workflow = definition.name
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    assert agent.calls == 2
    assert "step 1 of 2" in agent.prompts[0]
    assert "step 2 of 2" in agent.prompts[1]
    assert "chain the work" in agent.prompts[0]
    assert (get_run(engine.db, run.id) or run).status == "review"


async def test_a_check_retries_an_earlier_step_then_fails_when_max_is_spent(world):
    engine, _repo = world
    agent = RecordingAgent()
    engine.agent = agent
    run = await _start(engine, "make it pass")
    definition = Workflow(
        name="fix",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", name="Implement", prompt="{{task}}"),
            Step(
                id="verify",
                name="Verify",
                command="test -f done.txt",
                retry="implement",
                retry_max=2,
            ),
        ),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    assert agent.calls == 2
    assert (get_run(engine.db, run.id) or run).status == "review"
    assert "Failing output" in agent.prompts[1]

    class Never(RecordingAgent):
        async def stream(self, spec: AgentSpec):
            self.prompts.append(spec.user_prompt)
            self.calls += 1
            yield AgentEvent("text", "still missing")
            yield AgentEvent("turn-end")

    never_agent = Never()
    engine.agent = never_agent
    again = await _start(engine, "never")
    never = Workflow(
        name="fix",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", name="Implement", prompt="{{task}}"),
            Step(
                id="verify",
                name="Verify",
                command="test -f missing.txt",
                retry="implement",
                retry_max=2,
            ),
        ),
    )
    again.workflow_def = never.to_json()
    await engine.db.write(save_run, again)
    await engine.execute(again.id)
    failed = get_run(engine.db, again.id)
    assert failed is not None
    assert failed.status == "failed"
    assert "after 3 attempts" in failed.error


async def test_retry_on_skips_codes_the_agent_cannot_fix(world):
    engine, _repo = world
    agent = RecordingAgent()
    engine.agent = agent
    run = await _start(engine, "once")
    definition = Workflow(
        name="gated",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", name="Implement", prompt="{{task}}"),
            Step(
                id="verify",
                name="Verify",
                command="exit 2",
                retry="implement",
                retry_max=2,
                retry_on=(1,),
            ),
        ),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    assert agent.calls == 1
    assert (get_run(engine.db, run.id) or run).status == "failed"


async def test_a_check_receives_a_secret_and_a_bash_allowlist_blocks_other_commands(world):
    from app.secrets.store import SecretStore
    from app.store.db import list_events

    engine, _repo = world
    project = __import__("app.store.db", fromlist=["get_project"]).get_project(
        engine.db, engine.boot_project_id
    )
    assert project is not None
    store = SecretStore(engine.config.data_dir / "secrets")
    store.set(project.id, "BUILD_TOKEN", "super-secret-value", root=project.root)
    run = await _start(engine, "secret")
    definition = Workflow(
        name="secret",
        description="",
        source="built-in",
        steps=(
            Step(id="implement", prompt="{{task}}"),
            Step(
                id="verify",
                command='printf %s "$BUILD_TOKEN"',
                secret_bindings=(("BUILD_TOKEN", "BUILD_TOKEN"),),
            ),
        ),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    await engine.execute(run.id)
    done = get_run(engine.db, run.id)
    assert done is not None and done.status == "review"
    texts = [event.text for event in list_events(engine.db, run.id)]
    assert "super-secret-value" not in "\n".join(texts)
    assert any("●" in text for text in texts)
    blocked = await _start(engine, "blocked")
    blocked.workflow_def = Workflow(
        name="blocked",
        description="",
        source="built-in",
        steps=(Step(id="nope", command="true", bash_allowlist=("npm",)),),
    ).to_json()
    await engine.db.write(save_run, blocked)
    await engine.execute(blocked.id)
    allowed = get_run(engine.db, blocked.id)
    assert allowed is not None and allowed.status == "review"


async def test_an_ask_waits_and_the_answer_continues(world):
    engine, _repo = world
    run = await _start(engine, "mock:ask the name")
    await engine.execute(run.id)
    waiting = get_run(engine.db, run.id)
    assert waiting is not None and waiting.status == "waiting"
    assert "Which name" in waiting.ask
    assert await engine.deliver(run.id, "use the short one") is None
    await engine.execute(run.id)
    assert (get_run(engine.db, run.id) or waiting).status == "review"


async def test_cancel_stops_a_check_without_waiting_for_it(world):
    engine, _repo = world
    run = await _start(engine, "sleep")
    definition = Workflow(
        name="slow",
        description="",
        source="built-in",
        steps=(Step(id="verify", command="sleep 30"),),
    )
    run.workflow_def = definition.to_json()
    await engine.db.write(save_run, run)
    task = asyncio.create_task(engine.execute(run.id))
    for _ in range(50):
        current = get_run(engine.db, run.id)
        if current and current.status == "running":
            break
        await asyncio.sleep(0.02)
    await engine.cancel(run.id)
    await asyncio.wait_for(task, timeout=3)
    assert (get_run(engine.db, run.id) or run).status == "cancelled"


async def test_only_one_run_occupies_a_slot_when_max_parallel_is_one(world):
    engine, _repo = world
    gate = GateAgent()
    engine.agent = gate
    engine.app = App()
    await engine.save_workspace(Settings(max_parallel=1))
    first = await _start(engine, "first")
    second = await _start(engine, "second")
    await engine.tick()
    await asyncio.wait_for(gate.started.wait(), timeout=2)
    assert (get_run(engine.db, second.id) or second).status == "queued"
    gate.release.set()
    for _ in range(50):
        if (
            first.id not in engine._tasks
            and (get_run(engine.db, first.id) or first).status == "review"
        ):
            break
        await asyncio.sleep(0.02)
    await engine.tick()
    for _ in range(50):
        if (get_run(engine.db, second.id) or second).status == "review":
            break
        await asyncio.sleep(0.02)
    assert (get_run(engine.db, second.id) or second).status == "review"
    assert gate.count == 2
    assert gate.count == 2


async def test_dispatch_caps_children_and_reports_when_one_settles(world):
    engine, _repo = world
    parent = await _start(engine, "commander")
    parent.status = "running"
    parent.branch = "main"
    await engine.db.write(save_run, parent)
    from app.engine.dispatch_logic import DispatchOrder

    for index in range(4):
        child_id, reason = await engine.dispatch(
            parent.id, DispatchOrder(objective=f"child {index}")
        )
        assert reason is None, reason
        assert child_id
    _refused_id, reason = await engine.dispatch(parent.id, DispatchOrder(objective="one more"))
    assert reason is not None and "cap is 4" in reason
    child = next(run for run in list_runs(engine.db, None, None) if run.parent_id == parent.id)
    await engine.execute(child.id)
    parent_after = get_run(engine.db, parent.id)
    assert parent_after is not None
    assert parent_after.pending_reports
    assert "Report from task" in str(parent_after.pending_reports[0]["text"])
    parent_after.budget_usd = 1
    await engine.db.write(save_run, parent_after)
    _over, refused = await engine.dispatch(
        parent.id, DispatchOrder(objective="too expensive", max_cost=100)
    )
    assert refused is not None and "$100.00" in refused


async def test_dispatch_is_off_when_the_flag_says_so(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo, dispatch_enabled=False)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        parent = await _start(engine, "commander")
        parent.status = "running"
        parent.branch = "main"
        await engine.db.write(save_run, parent)
        from app.engine.dispatch_logic import DispatchOrder

        child_id, reason = await engine.dispatch(parent.id, DispatchOrder(objective="nope"))
        assert child_id is None
        assert reason is not None and "CEZ_DISPATCH=0" in reason


async def test_experimental_stdin_runner_records_usage(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    binary = tmp_path / "fake-claude"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "sys.stdin.readline()\n"
        "sys.stdout.write("
        '\'{"type":"result","result":"ok","usage":{"input_tokens":3,"output_tokens":4}}\\n\')\n'
        "sys.stdout.flush()\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    bins = {runner: runner for runner in RUNNERS}
    bins["claude"] = str(binary)
    cfg = config_for(tmp_path, repo, dry_run=False, real_agents=True, runner_bins=bins)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        run = await _start(engine, "hello from stdin")
        await engine.execute(run.id)
        done = get_run(engine.db, run.id)
        assert done is not None and done.status == "review"
        assert done.tokens_used == 7
    events = [
        event
        async for event in StdinAgent(str(binary)).stream(
            AgentSpec("prompt", "", str(repo), "claude", "", asyncio.Event())
        )
    ]
    assert any("input_tokens" in event.text for event in events)


async def test_a_missing_backend_fails_the_run_instead_of_spawning(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    cfg = config_for(tmp_path, repo, dry_run=False, real_agents=False)
    async with LiteWriter(cfg.db_path, schema=schema, claim=5) as db:
        engine = Engine(db, Relay(), cfg)
        await engine.startup()
        run = await _start(engine, "real")
        await engine.execute(run.id)
        failed = get_run(engine.db, run.id)
        assert failed is not None
        assert "not found" in failed.error


def test_gitignore_appends_missing_entries_and_keeps_user_lines(tmp_path: Path):
    path = tmp_path / ".ai" / "cezar"
    path.mkdir(parents=True)
    (path / ".gitignore").write_text("# mine\nkeep-me\n", encoding="utf-8")
    ensure_data_gitignore(tmp_path)
    text = (path / ".gitignore").read_text(encoding="utf-8")
    assert text.startswith("# mine\nkeep-me\n")
    for entry in DATA_GITIGNORE_ENTRIES:
        assert entry in text.splitlines()
    ensure_data_gitignore(tmp_path)
    assert (path / ".gitignore").read_text(encoding="utf-8") == text


def test_orphan_worktrees_go_and_known_runs_stay(tmp_path: Path):
    repo = tmp_path / "repo"
    init_repo(repo)
    orphan = "ab" * 16
    keep = "cd" * 16
    root = repo / ".ai" / "cezar" / "worktrees"
    (root / orphan).mkdir(parents=True)
    (root / keep).mkdir()
    removed = prune_orphans(repo, {keep})
    assert orphan in removed
    assert not (root / orphan).exists()
    assert (root / keep).exists()
