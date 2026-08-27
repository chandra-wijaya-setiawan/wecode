"""Unit tests for generating a ticket's requirement-status table from the wecode store."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

# The script sits beside this file rather than a package on the path.
sys.path.insert(0, str(Path(__file__).parent))

from report_from_wecode import (  # noqa: E402
    BEGIN,
    END,
    Criterion,
    display_id,
    issue_number,
    issue_url,
    load,
    render,
    sort_key,
    splice,
    verdict,
)

SCHEMA = """
CREATE TABLE projects (id TEXT, repo TEXT, objective TEXT, status TEXT,
  budget_tokens INTEGER, budget_wall INTEGER, archived INTEGER);
CREATE TABLE tasks (id TEXT, project_id TEXT, kind TEXT, title TEXT, parent_id TEXT,
  status TEXT, assignee TEXT, budget_tokens INTEGER, budget_wall INTEGER,
  archived INTEGER, doer TEXT, steps TEXT);
CREATE TABLE task_acceptance (task_id TEXT, seq INTEGER, kind TEXT, cmd TEXT,
  expect_status INTEGER, name TEXT, target REAL, cmp TEXT, path TEXT, note TEXT);
CREATE TABLE audit_log (seq INTEGER PRIMARY KEY, at INTEGER, session_id TEXT, post TEXT,
  agent TEXT, human TEXT, project_id TEXT, task_id TEXT, source TEXT, action TEXT,
  target TEXT, outcome TEXT, mode TEXT, detail TEXT);
"""


def _criterion(*, live: bool = False, exit_code: int | None = 0, ran: bool = True) -> Criterion:
    return Criterion(
        cmd="pytest",
        live=live,
        expect=0,
        exit_code=exit_code,
        ran_at=1 if ran else None,
    )


@pytest.fixture
def store(tmp_path: Path) -> Path:
    """A wecode store holding one project, one task and one recorded check."""
    db = tmp_path / "wecode.db"
    conn = sqlite3.connect(db)
    conn.executescript(SCHEMA)
    conn.execute(
        "INSERT INTO projects VALUES ('ticket-53-bronze','ss-53','Seed it','draft',0,0,0)"
    )
    conn.execute(
        "INSERT INTO tasks VALUES ('t53-fr-01','ticket-53-bronze','feat','Stage the CSVs',"
        "NULL,'ready',NULL,0,0,0,NULL,NULL)"
    )
    conn.execute("INSERT INTO task_acceptance VALUES ('t53-fr-01',0,'command','pytest -q',0,"
                 "NULL,NULL,NULL,NULL,NULL)")
    conn.execute("INSERT INTO task_acceptance VALUES ('t53-fr-01',1,'command','live:aws s3 ls',0,"
                 "NULL,NULL,NULL,NULL,NULL)")
    conn.execute(
        "INSERT INTO audit_log (seq,at,task_id,action,target,outcome) "
        "VALUES (1,100,'t53-fr-01','run','pytest -q — exit 0','allow')"
    )
    conn.commit()
    conn.close()
    return db


def test_a_tier_with_no_criteria_is_not_a_pass() -> None:
    """A requirement with no live criterion has not been proven, so it is never `yes`."""
    assert verdict(()) == "n/a"


def test_a_tier_whose_criteria_all_passed_is_a_pass() -> None:
    """Every criterion ran and returned what was expected."""
    assert verdict((_criterion(), _criterion())) == "yes"


def test_one_unrun_criterion_makes_the_whole_tier_unrun() -> None:
    """A tier is only settled when every criterion in it has actually executed."""
    assert verdict((_criterion(), _criterion(ran=False, exit_code=None))) == "not run"


def test_one_failing_criterion_fails_the_tier() -> None:
    """A single wrong exit code is enough: the tier is a conjunction."""
    assert verdict((_criterion(), _criterion(exit_code=1))) == "**no**"


def test_a_criterion_that_never_started_is_not_a_pass() -> None:
    """`None` means the command could not be run, which is not evidence of anything."""
    assert not _criterion(exit_code=None, ran=True).passed


def test_display_id_recovers_the_requirement_label() -> None:
    """The wecode task id is namespaced; the report shows the label a reader knows."""
    assert display_id("t53-fr-01") == "FR-53-01"
    assert display_id("t53-nfr-infra-01") == "NFR-53-INFRA-01"


def test_display_id_passes_through_an_id_it_does_not_recognise() -> None:
    """A task added outside the convention still renders rather than crashing."""
    assert display_id("some-other-task") == "SOME-OTHER-TASK"


def test_functional_requirements_sort_before_non_functional() -> None:
    """The table leads with capability, then with the properties around it."""
    assert sort_key("t53-fr-07") < sort_key("t53-nfr-doc-01")


def test_issue_number_is_read_off_the_project_id() -> None:
    """The project id is the only place the tracker number lives."""
    assert issue_number("ticket-53-bronze") == "53"
    assert issue_number("no-number-here") is None


def test_issue_url_is_built_from_an_ssh_remote() -> None:
    """The remote is SSH; the ticket link has to be HTTPS."""
    url = issue_url("git@gitlab.example.net:group/sub/repo.git", "53")
    assert url == "https://gitlab.example.net/group/sub/repo/-/issues/53"


def test_load_reads_both_tiers_and_the_recorded_verdict(store: Path) -> None:
    """The offline criterion has a ledger row; the live one was never run."""
    project = load(store, "ticket-53-bronze")
    (req,) = project.requirements
    offline, live = req.tier(live=False), req.tier(live=True)
    assert offline[0].exit_code == 0
    assert live[0].cmd == "aws s3 ls"
    assert not live[0].ran


def test_load_rejects_a_project_that_does_not_exist(store: Path) -> None:
    """Naming the wrong project is an error, not an empty table that reads as done."""
    with pytest.raises(SystemExit):
        load(store, "no-such-project")


def test_render_marks_the_block_so_it_can_be_replaced(store: Path) -> None:
    """The markers are what make the report regenerable rather than hand-maintained."""
    block = render(load(store, "ticket-53-bronze"))
    assert block.startswith(BEGIN)
    assert block.rstrip().endswith(END)
    assert "`FR-53-01`" in block


def test_render_counts_built_separately_from_proven(store: Path) -> None:
    """One requirement, built but not proven — the distinction the table exists for."""
    assert "**1 of 1 built, 0 of 1 proven.**" in render(load(store, "ticket-53-bronze"))


def test_splice_replaces_an_existing_block() -> None:
    """Regenerating twice must not stack two copies of the table."""
    doc = f"before\n{BEGIN}\nold\n{END}\nafter\n"
    out = splice(doc, f"{BEGIN}\nnew\n{END}")
    assert "old" not in out
    assert out == f"before\n{BEGIN}\nnew\n{END}\nafter\n"


def test_splice_appends_when_the_document_has_no_block() -> None:
    """First run on a report written by hand."""
    out = splice("body\n", f"{BEGIN}\nx\n{END}")
    assert out.startswith("body\n")
    assert BEGIN in out


def test_the_diff_table_puts_riskier_changes_first() -> None:
    """Deleted, then modified, then added — the order a reviewer's attention should run in.

    A deleted file removes behaviour something may still depend on, a modified one changes
    behaviour that already has callers, and an added one can only be new. Alphabetical order
    scatters the first two through the third.
    """
    from report_from_wecode import CHANGE_ORDER

    rows = [
        ("z_added.py", "add", 10, 0),
        ("a_modified.py", "mod", 5, 5),
        ("m_deleted.py", "del", 0, 20),
        ("b_added.py", "add", 3, 0),
        ("c_modified.py", "mod", 1, 1),
    ]
    ordered = sorted(rows, key=lambda row: (CHANGE_ORDER.get(row[1], 1), row[0]))
    assert [r[1] for r in ordered] == ["del", "mod", "mod", "add", "add"]
    # Path order within a group, so a reviewer can still find a named file.
    assert [r[0] for r in ordered if r[1] == "add"] == ["b_added.py", "z_added.py"]
