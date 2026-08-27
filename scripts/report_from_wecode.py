"""Generate a ticket's requirement-status table from the wecode store.

Lives here rather than in the repository it writes into. It reads wecode's own store — its
projects, tasks, criteria and audit log — so a change to that data model breaks this script,
and the two should travel together. Kept in the consuming repository, every wecode schema
change became someone else's build failure.

Python in a Rust repository, deliberately: this is a `scripts/` asset like `design-check.sh`
beside it, not shipped code. It is not built, not installed with the binary, and not on the
release path. If it earns a place in the binary it becomes a `wecode report` subcommand and
this file goes.

Invoked from a consuming repository by path, e.g.

    uv run python $WECODE_REPO/scripts/report_from_wecode.py \\
      --project ticket-54-silver \\
      --out specs/54-silver-layer-definition/report_as_finished.md \\
      --sync-status


wecode is the single source of truth for tracking; ``report_as_finished.md`` is a
product of it. This reads the store and emits the table, so the report cannot
disagree with the tracker the way hand-maintained prose always eventually does.

Two axes, because "done" is one bit and a requirement needs two. wecode's acceptance
commands come in tiers (``verify.rs``): a command prefixed ``live:`` is deferred unless
``WECODE_LIVE=1``, so it is the one that needs real infrastructure. That maps onto the
distinction the report has always drawn by hand:

* **Built**  — the offline tier passed. The capability exists in code.
* **Proven** — the live tier passed. The capability has been observed running.

Per-criterion verdicts are read from ``audit_log``, where ``wecode verify`` records
every check it ran as ``"<cmd> — exit N"``. A live criterion that is declared but has
no ledger row was never run, which is exactly what "not proven" means.

Usage::

    uv run python specs/_tools/requirement_status.py \\
      --project stetss-53-bronze \\
      --out specs/53-bronze-seed-from-csv/report_as_finished.md
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BEGIN = "<!-- BEGIN wecode:requirement-status -->"
END = "<!-- END wecode:requirement-status -->"

SUMMARY_BEGIN = "<!-- BEGIN wecode:summary -->"
SUMMARY_END = "<!-- END wecode:summary -->"

DIFF_BEGIN = "<!-- BEGIN wecode:repository-diff -->"
DIFF_END = "<!-- END wecode:repository-diff -->"

LIVE_MARK = "live:"
"""The tier marker wecode reads. Kept in step with ``verify.rs`` ``LIVE_MARK``."""

DEFAULT_DB = Path.home() / ".wecode" / "workspaces" / "cws" / "wecode.db"

# `wecode verify` writes the command and its outcome as one ledger line.
LEDGER_LINE = re.compile(r"^(?P<cmd>.*?) — (?P<outcome>exit (?P<code>-?\d+).*|did not start)$")

# A project id carries its tracker number: ticket-53-bronze -> 53.
ISSUE_IN_ID = re.compile(r"-(\d+)-")

# Task ids are namespaced by ticket because wecode ids are global and a ledger entry is
# permanent: once `fr-53-01` has run it can never be reused, even for the same
# requirement. `t53-fr-01` reads back out as `FR-53-01`.
TASK_ID = re.compile(r"^t(?P<issue>\d+)-(?P<sort>fr|nfr)-(?P<rest>.+)$")


def display_id(task_id: str) -> str:
    """The requirement label a reader recognises, recovered from the wecode task id."""
    found = TASK_ID.match(task_id)
    if not found:
        return task_id.upper()
    return f"{found['sort'].upper()}-{found['issue']}-{found['rest'].upper()}"


def sort_key(task_id: str) -> tuple[int, str]:
    """Functional requirements first, then non-functional, each in id order."""
    found = TASK_ID.match(task_id)
    if not found:
        return (2, task_id)
    return (0 if found["sort"] == "fr" else 1, found["rest"])


@dataclass(frozen=True)
class Criterion:
    """One acceptance command, with whatever the ledger last said about it."""

    cmd: str
    live: bool
    expect: int
    exit_code: int | None
    ran_at: int | None

    @property
    def passed(self) -> bool:
        return self.exit_code == self.expect

    @property
    def ran(self) -> bool:
        return self.ran_at is not None


@dataclass(frozen=True)
class Requirement:
    """One wecode task: a requirement, and the criteria that would demonstrate it."""

    id: str
    title: str
    kind: str
    status: str
    criteria: tuple[Criterion, ...]

    def tier(self, *, live: bool) -> tuple[Criterion, ...]:
        return tuple(c for c in self.criteria if c.live is live)


@dataclass(frozen=True)
class Project:
    """A wecode project: one GitLab ticket."""

    id: str
    objective: str
    requirements: tuple[Requirement, ...]


def verdict(criteria: tuple[Criterion, ...]) -> str:
    """Summarise one tier as a single cell.

    An empty tier is ``n/a`` rather than a pass: a requirement with no live criterion
    has not been proven, and calling that a pass is the exact overstatement this table
    exists to prevent.
    """
    if not criteria:
        return "n/a"
    if any(not c.ran for c in criteria):
        return "not run"
    return "yes" if all(c.passed for c in criteria) else "**no**"


def issue_number(project_id: str) -> str | None:
    """The tracker number a project id carries, if it carries one."""
    found = ISSUE_IN_ID.search(project_id)
    return found.group(1) if found else None


def issue_url(remote: str, number: str) -> str:
    """Turn a git remote and an issue number into a browsable GitLab URL."""
    path = remote.removeprefix("git@").removeprefix("https://").removesuffix(".git")
    path = path.replace(":", "/", 1) if "@" not in path else path
    return f"https://{path}/-/issues/{number}"


def git_remote(repo: Path) -> str:
    """The origin URL, or an empty string when there is no remote to ask."""
    done = subprocess.run(  # noqa: S603
        ["git", "-C", str(repo), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=False,
    )
    return done.stdout.strip() if done.returncode == 0 else ""


def _ledger(conn: sqlite3.Connection) -> dict[tuple[str, str], tuple[int | None, int]]:
    """The last outcome the ledger recorded for every (task, command) it ran.

    Ordered by ``seq`` so a later run overwrites an earlier one — the ledger is
    append-only, so the newest row is the current verdict.
    """
    out: dict[tuple[str, str], tuple[int | None, int]] = {}
    rows = conn.execute(
        "SELECT task_id, target, at FROM audit_log "
        "WHERE action = 'run' AND task_id IS NOT NULL ORDER BY seq"
    )
    for task_id, target, at in rows:
        found = LEDGER_LINE.match(target or "")
        if not found:
            continue
        code = found.group("code")
        out[(task_id, found.group("cmd"))] = (int(code) if code is not None else None, at)
    return out


def load(db: Path, project_id: str) -> Project:
    """Read one project, its tasks and their criteria out of the wecode store."""
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = conn.execute(
            "SELECT objective FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            raise SystemExit(f"no such wecode project: {project_id}")
        ledger = _ledger(conn)
        requirements = []
        tasks = conn.execute(
            "SELECT id, title, kind, status FROM tasks "
            "WHERE project_id = ? AND archived = 0 ORDER BY id",
            (project_id,),
        ).fetchall()
        for task_id, title, kind, status in tasks:
            criteria = []
            accepts = conn.execute(
                "SELECT cmd, expect_status FROM task_acceptance "
                "WHERE task_id = ? AND kind = 'command' ORDER BY seq",
                (task_id,),
            ).fetchall()
            for cmd, expect in accepts:
                live = cmd.lower().startswith(LIVE_MARK)
                bare = cmd[len(LIVE_MARK) :] if live else cmd
                code, at = ledger.get((task_id, bare), (None, None))
                criteria.append(
                    Criterion(
                        cmd=bare,
                        live=live,
                        expect=expect if expect is not None else 0,
                        exit_code=code,
                        ran_at=at,
                    )
                )
            requirements.append(
                Requirement(
                    id=task_id,
                    title=title,
                    kind=kind,
                    status=status,
                    criteria=tuple(criteria),
                )
            )
        return Project(id=project_id, objective=row[0], requirements=tuple(requirements))
    finally:
        conn.close()


def render(project: Project, ticket: str = "") -> str:
    """Render the requirement-status block, markers included."""
    lines = [BEGIN, ""]
    lines.append(
        f"*Generated from the wecode project `{project.id}`"
        + (f" ([#{issue_number(project.id)}]({ticket}))" if ticket else "")
        + ". Do not edit by hand — run `make requirement-status`.*"
    )
    lines += [
        "",
        "**Built** is the offline acceptance tier: the capability exists in code. "
        "**Proven** is the `live:` tier: it has been observed against real "
        "infrastructure. `not run` means the criterion is declared and has never "
        "been executed — not that it failed.",
        "",
        "| ID | Requirement | Built | Proven | Criteria |",
        "|---|---|---|---|---|",
    ]
    for req in sorted(project.requirements, key=lambda r: sort_key(r.id)):
        offline, live = req.tier(live=False), req.tier(live=True)
        detail = "<br>".join(
            f"`{c.cmd if len(c.cmd) <= 60 else c.cmd[:57] + '…'}` — "
            + ("not run" if not c.ran else f"exit {c.exit_code}")
            + (" *(live)*" if c.live else "")
            for c in req.criteria
        )
        lines.append(
            f"| `{display_id(req.id)}` | {req.title} | {verdict(offline)} "
            f"| {verdict(live)} | {detail or '—'} |"
        )
    built = sum(1 for r in project.requirements if verdict(r.tier(live=False)) == "yes")
    proven = sum(1 for r in project.requirements if verdict(r.tier(live=True)) == "yes")
    total = len(project.requirements)
    lines += [
        "",
        f"**{built} of {total} built, {proven} of {total} proven.** "
        "A requirement is proven only when its live criteria have run and passed.",
        "",
        END,
    ]
    return "\n".join(lines)


def splice(document: str, block: str, begin: str = BEGIN, end: str = END) -> str:
    """Replace the marked block in ``document``, or append it when absent."""
    if begin in document and end in document:
        head = document[: document.index(begin)]
        tail = document[document.index(end) + len(end) :]
        return head + block + tail
    return document.rstrip("\n") + "\n\n" + block + "\n"


# --- status synchronisation ---------------------------------------------------------
# The board and the report must not be able to disagree. wecode's own task status is
# set by `verify`, which also judges the branch diff against the task's scope — and in a
# project where tasks RECORD work rather than commission it, the branch holds every
# commit of the ticket while each task claims a subset. So every task reads `failed`
# while every acceptance criterion passes: #53 shipped 39,223 rows against a board
# saying 3 of 13 done. Deriving the status from the criteria instead makes the two
# surfaces one fact with two renderings.

STATUS_DONE = "done"
STATUS_VERIFYING = "verifying"
STATUS_FAILED = "failed"
STATUS_READY = "ready"


def derived_status(requirement: Requirement) -> str:
    """The status the acceptance criteria imply, ignoring the diff-versus-scope verdict.

    ``verifying`` is the state the two-tier table needs and a binary done/failed cannot
    express: built, and awaiting the evidence that it runs.
    """
    offline, live = requirement.tier(live=False), requirement.tier(live=True)
    if any(c.ran and not c.passed for c in requirement.criteria):
        return STATUS_FAILED
    if offline and any(not c.ran for c in offline):
        return STATUS_READY
    if live and any(not c.ran for c in live):
        return STATUS_VERIFYING
    return STATUS_DONE


def sync_status(project: Project, run: Any) -> list[tuple[str, str]]:
    """Set every task's status to what its criteria imply. Returns what changed."""
    changed = []
    for requirement in project.requirements:
        want = derived_status(requirement)
        if want != requirement.status:
            run(["wecode", "status", requirement.id, want])
            changed.append((requirement.id, want))
    return changed


# --- the deterministic figures -------------------------------------------------------


CHANGE_ORDER = {"del": 0, "mod": 1, "add": 2}
"""How the diff table is sorted: deleted, then modified, then added.

Not alphabetical, because the table is a review aid and those three carry different risk. A
deleted file removes behaviour something may still depend on; a modified one changes
behaviour that already has callers; an added one can only be new. Reviewer attention should
run out at the bottom of the table rather than in the middle of it.

Within a group, path order — so a reviewer can still find a file they are looking for.
"""


def repo_diff(repo: Path, base: str) -> list[tuple[str, str, int, int]]:
    """``(path, change, added, removed)`` for every file this branch touches.

    Ordered by risk rather than by path: see ``CHANGE_ORDER``.
    """
    def git(*args: str) -> str:
        return subprocess.run(  # noqa: S603
            ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
        ).stdout

    status = dict(
        (line.split("\t")[1], line.split("\t")[0])
        for line in git("diff", "--name-status", f"{base}...HEAD").strip().splitlines()
        if "\t" in line
    )
    rows = []
    for line in git("diff", "--numstat", f"{base}...HEAD").strip().splitlines():
        added, removed, path = line.split("\t")
        change = {"A": "add", "M": "mod", "D": "del"}.get(status.get(path, "A"), "mod")
        rows.append((path, change, int(added), int(removed)))
    return sorted(rows, key=lambda row: (CHANGE_ORDER.get(row[1], 1), row[0]))


def existing_annotations(document: str) -> dict[str, tuple[str, str]]:
    """The judgement columns of a previously generated diff table, keyed by path.

    Regenerating must not discard them: the mechanical columns come from git and cannot
    be allowed to drift, while which requirement a file serves is a reading of the work
    that no tool supplies.
    """
    out: dict[str, tuple[str, str]] = {}
    for row in re.finditer(
        r"^\| `([^`]+)` \| \w+ \| [^|]* \| ([^|]*) \| ([^|]*) \|$", document, re.M
    ):
        out[row.group(1)] = (row.group(2).strip(), row.group(3).strip())
    return out


def render_diff(
    rows: list[tuple[str, str, int, int]],
    annotations: dict[str, tuple[str, str]],
) -> str:
    """The repository-diff block. Mechanical columns from git, judgement carried forward."""
    lines = [
        DIFF_BEGIN,
        "",
        "*Path, change type and line counts come from `git diff --numstat`. The last two "
        "columns are judgement and are carried forward when this is regenerated.*",
        "",
        "| Path | Change | Lines | FR / NFR | Notes |",
        "|---|:-:|--:|---|---|",
    ]
    added = removed = 0
    for path, change, a, r in rows:
        added += a
        removed += r
        counts = f"+{a}" + (f" / −{r}" if r else "")
        fr, note = annotations.get(path, ("—", ""))
        lines.append(f"| `{path}` | {change} | {counts} | {fr} | {note} |")
    lines += [
        "",
        f"**{len(rows)} files, +{added:,} / −{removed} lines.** Row count audited against "
        "`git diff --numstat`, which is also where the line figures come from.",
        "",
        DIFF_END,
    ]
    return "\n".join(lines)


def render_summary(
    project: Project,
    rows: list[tuple[str, str, int, int]],
    tests: int | None,
) -> str:
    """The summary figure table — every number derived, none typed."""
    built = sum(1 for r in project.requirements if verdict(r.tier(live=False)) == "yes")
    proven = sum(1 for r in project.requirements if verdict(r.tier(live=True)) == "yes")
    total = len(project.requirements)
    files = len(rows)
    added = sum(a for _, _, a, _ in rows)
    removed = sum(r for _, _, _, r in rows)
    lines = [
        SUMMARY_BEGIN,
        "",
        "| | |",
        "|---|---|",
        f"| Requirements | **{built} of {total} built · {proven} of {total} proven**"
        " — see the table below |",
        f"| Repository | {files} files, **+{added:,} / −{removed}** lines |",
    ]
    if tests is not None:
        lines.append(f"| Tests | **{tests}** collected in this package |")
    lines += [
        "",
        SUMMARY_END,
    ]
    return "\n".join(lines)


def collected_tests(repo: Path, path: str) -> int | None:
    """How many tests pytest collects, or None when it cannot be asked."""
    done = subprocess.run(  # noqa: S603
        ["uv", "run", "pytest", path, "--collect-only", "-q"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    found = re.search(r"^(\d+) tests? collected", done.stdout, re.M)
    return int(found.group(1)) if found else None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the command line."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, help="wecode project id")
    parser.add_argument("--out", type=Path, help="report to splice into; omit to print")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="wecode store")
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="repo for the remote")
    parser.add_argument("--base", default="origin/develop", help="branch the diff is against")
    parser.add_argument(
        "--tests-path", default="app/lakehouse", help="what to count collected tests in"
    )
    parser.add_argument(
        "--sync-status",
        action="store_true",
        help="also set each wecode task's status to what its criteria imply",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:  # pragma: no cover - thin CLI wrapper
    """Generate the block and either print it or splice it into the report."""
    args = parse_args(argv)
    project = load(args.db, args.project)
    number = issue_number(args.project)
    remote = git_remote(args.repo)
    ticket = issue_url(remote, number) if number and remote else ""
    if args.sync_status:
        changed = sync_status(project, lambda cmd: subprocess.run(cmd, check=False))  # noqa: S603
        for task, status in changed:
            print(f"  {task} -> {status}")
        print(f"synchronised {len(changed)} task status(es) with their criteria")
        # Re-read: the statuses just written are part of what the report reports.
        project = load(args.db, args.project)

    block = render(project, ticket)
    if args.out is None:
        print(block)
        return

    rows = repo_diff(args.repo, args.base)
    document = args.out.read_text(encoding="utf-8")
    annotations = existing_annotations(document)
    document = splice(document, block, BEGIN, END)
    document = splice(
        document,
        render_summary(project, rows, collected_tests(args.repo, args.tests_path)),
        SUMMARY_BEGIN,
        SUMMARY_END,
    )
    document = splice(
        document, render_diff(rows, annotations), DIFF_BEGIN, DIFF_END
    )
    args.out.write_text(document, encoding="utf-8")
    print(
        f"spliced {len(project.requirements)} requirements and {len(rows)} files "
        f"into {args.out}"
    )


if __name__ == "__main__":  # pragma: no cover
    main()
