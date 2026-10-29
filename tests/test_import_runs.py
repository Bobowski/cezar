from app.engine.import_runs import runs_from_document


def test_a_typescript_run_record_is_kept_and_a_broken_one_is_skipped():
    raw = [
        {
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "title": "Old task",
            "task": "do the old thing",
            "status": "done",
            "workflow": "quick-task",
            "runner": "claude",
            "createdAt": "2026-01-01T00:00:00Z",
            "branch": "cez/aaaaaaaa",
            "archived": True,
        },
        {"id": "not-an-id", "task": "nope", "status": "done", "createdAt": "2026-01-01T00:00:00Z"},
        "nope",
    ]
    runs, skipped = runs_from_document(raw, "proj")
    assert skipped == 2
    assert runs[0].id == "aaaaaaaabbbbccccddddeeeeeeeeeeee"
    assert runs[0].status == "done"
    assert runs[0].archived is True
    assert runs[0].task == "do the old thing"
