# 008 — A merge installs the executable it just produced

**Task:** #<number> `cli-self-install-on-merge` · **Branch:** `wecode/cli-self-install-on-merge`
· **Target:** `master`

Execution state is tracked in `report_as_finished.md`. This document is the contract.
The decision it implements is `docs/wecode/cli-self-install-on-merge/design.md`; where
the two disagree, the design is the record of what was signed and this is what the build
is held to.

## 1. Requirement summary

A merge that lands on a repository's integration branch builds that repository's
executable from the merge commit and installs it at a path the operator declared in
`company.toml`, then reports what it did in the merge report. `wecode install` is the
same behaviour on demand.

Permanent. No scaffolding: the installer is one function with two callers, and the
timidity belongs to the automatic one — the shape `teardown::after_landing` already has.

**What forced it.** Every command except `approve` is reachable only from the repository
directory, through `./wecode`, which is `cargo run` against whatever branch that
checkout is on. `telegram` moved *signing* off the desk and left asking, verifying,
planning and rolling back on it.

**Out of this slice's delivery scope:** a build stamp in the binary (`--version` naming a
commit) — see §6.

## 2. Architecture

C4 L3, `wecode-cli`, one new module `install` beside `teardown` and `record`. L4: it
shells out to `cargo` and to `git` through the existing `git::tree_for`, and touches the
filesystem outside every repository — which is why the authority for it is read from
`wecode-org` (`company.toml`) and never from a playbook. No new crate, no store schema,
no dependency.

Assumed placement, since no C4 drawing covers `merge` today: the installer is a
supervisor-side post-landing step, in the same band as teardown, and not an actor in the
Broker's authorisation path.

## 3. Requirement details

Provisional and slice-local.

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-08-01 | org | `[[repos]]` accepts an optional `installs` field: the absolute (or `~`-relative) destination path for the executable that repository builds |
| FR-08-02 | org | `installs` absent means nothing is installed for that repository, and nothing is said about it |
| FR-08-03 | org | No playbook field, and no project field, can name an install destination |
| FR-08-04 | cli/install | The installed bytes are built from a checkout of the integration branch at the merge commit — never copied from `current_exe()`, never from the task worktree's artefact |
| FR-08-05 | cli/install | The build runs in the tree `git::tree_for` resolves for the target branch, with `CARGO_TARGET_DIR` set to the repository's own `target/` |
| FR-08-06 | cli/install | The build uses the same cargo profile the wrapper and the loop run (debug) |
| FR-08-07 | cli/install | Installation writes a temporary file in the destination's own directory, sets mode `0755`, and renames it over the destination |
| FR-08-08 | cli/install | It declines, naming the reason, when: the destination's parent directory does not exist; the destination is a directory; the destination is a symlink; the build fails |
| FR-08-09 | cli/install | It installs and warns when the destination is not on wecode's own `PATH`, giving the line that would put it there |
| FR-08-10 | cli/gov | `merge_task` runs the installer after teardown and before the report is rendered, so the outcome is a fact the report carries |
| FR-08-11 | cli/record | The merge report carries one `install` line in `summary`: destination, short sha and profile on success; destination and reason on a decline |
| FR-08-12 | cli/install | No outcome of the installer changes the merge's exit status or the task's status |
| FR-08-13 | cli | `wecode install [--repo <name>]` runs the same installer on demand and prints the same line from the same renderer |
| FR-08-14 | cli/install | A failed install directs the operator to `wecode install`, never to re-running `wecode merge` |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-08-SEC-01 | cli/install | The destination is read only from `company.toml`; no value reachable by a task's commit can influence where bytes are written |
| NFR-08-SEC-02 | gov | No seat, role or grant gains a path to the installer; it is supervisor-only, and the charter's `never_touch` is unweakened |
| NFR-08-PERF-01 | cli/install | With a warm repository `target/`, the merge-path install adds no full rebuild — the shared cache is the mechanism (see A2) |
| NFR-08-REL-01 | cli/install | An interrupted install leaves the previous executable intact and runnable |
| NFR-08-REL-02 | cli/install | An install into a destination whose previous binary is currently executing succeeds (no `ETXTBSY`) |
| NFR-08-OBS-01 | cli/record | The installed sha appears in the committed `report.md`, so the record survives the terminal |
| NFR-08-MNT-01 | cli/record | One renderer for the line, shared by the merge path and `wecode install` |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A merge in a repo declaring `installs` leaves an executable at that path whose bytes are the merge commit's build, and a report line naming the sha | FR-08-01, FR-08-04, FR-08-10, FR-08-11 | end-to-end test in `tests/cli.rs` against a fixture repo that builds a trivial binary |
| AC-2 | A merge in a repo with no `installs` writes nothing outside the repo and says nothing about installing | FR-08-02 | test: destination tree untouched, report has no `install` line |
| AC-3 | A playbook containing an install destination is rejected or ignored — it cannot cause a write | FR-08-03, NFR-08-SEC-01 | test: `deny_unknown_fields` on the playbook keeps the field unparseable |
| AC-4 | A merge commit that does not compile leaves the merge landed, the report saying the build failed with its exit code, and the old binary in place | FR-08-08, FR-08-12, NFR-08-REL-01 | test: fixture whose merge result fails to build; assert merge exit 0 and the line |
| AC-5 | Replacing a destination that is currently being executed succeeds | FR-08-07, NFR-08-REL-02 | test: hold the old binary running, install over it, assert both the running process and the new file |
| AC-6 | Each declining condition produces its own named reason, and none of them fails the command | FR-08-08, FR-08-12 | unit tests, one per row of the design's decline table |
| AC-7 | A destination off wecode's `PATH` is installed and warned about, with the repair line | FR-08-09 | unit test on the rendered line |
| AC-8 | `wecode install` after a decline installs the same bytes and prints the same line | FR-08-13, NFR-08-MNT-01 | end-to-end test; assert the two lines are produced by one function |
| AC-9 | The report never suggests re-merging as the repair | FR-08-14 | assertion on the failure line's text |
| AC-10 | The build reuses the repository's `target/`, not a cache of its own | FR-08-05, NFR-08-PERF-01 | test asserting the `CARGO_TARGET_DIR` the child is given |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| declare where a repo's executable installs | edit `company.toml` `[[repos]] installs` | (none — `company.toml` is outside every write scope, deliberately) | n/a: not an action, a grant |
| install on demand | `wecode install [--repo <name>]` | (none — deliberate; see below) | — |
| learn what was installed, and whether it failed | the `install` line in the merge report and in `wecode install` | the same line, in the committed `docs/wecode/<task>/report.md` the handoff already reads | same text, one renderer |
| know a merge left master uncompilable | the `install` line's failure text | same line, same file | same |

The empty agent cells are authority, not capability, and that is the boundary
`docs/design/ax.md` draws. A seat that could write the destination could replace the
supervisor's own executable, which is arbitrary code execution as the process that
enforces the Broker — every other check becomes advisory. Information parity is kept in
full: an agent reads the same rendered outcome a human does, from the record.

## 5. Technical component details

**`install` module.** One entry point taking the repo path, the resolved destination, the
target branch and the merge sha, returning an outcome enum with a variant per decline
reason — the `teardown::Torn` / `record::Recorded` shape, so the renderer matches on it
rather than parsing a string. The automatic caller passes the merge's facts; `wecode
install` resolves the same inputs from `company.toml` and `git rev-parse`.

**Ordering in `merge_task`.** After `teardown::after_landing`, before `record::merged`.
The report is rendered once from facts already gathered, which is why the installer
cannot run later, and it must not run earlier than teardown because a build wants the
merged tree rather than a tree that is about to be removed.

**The build.** `cargo build -p <bin crate>` in the resolved tree, environment carrying
`CARGO_TARGET_DIR=<repo>/target`. Cargo's own lock on that directory is what makes a
concurrent `cargo run` from the loop safe; it blocks.

**The write.** `<dest>.wecode-new` in the destination's directory, then `fs::rename`.
Same directory because rename is not cross-filesystem; rename rather than in-place
write because the destination may be executing.

**Which crate's binary.** The repository's, resolved from cargo metadata rather than
assumed to be named after the repo — `installs` names the destination, not the source.

## 6. Out of scope

| Not doing | Owner / why |
|---|---|
| `wecode --version` printing a build stamp | named in the design as the gap this creates. It needs a commit stamped at build time, which changes the build of every commit — its own slice |
| installing to more than one destination, or a `--prefix` | rejected in the design: two binaries on one machine and no way to know which answered |
| a release profile, stripping, or install size management | the accepted cost; the lever is a profile on the field if disk ever matters |
| installing anything that is not the repository's own executable | that is deploy, which `plan.md` refuses as a task kind and this does not reopen |
| a ledger row for the install | the committed report is the record; a second one would be a second thing to keep in agreement |
| non-Unix destinations | `0755` and `ETXTBSY` are the Unix contract; Windows is not a supported host today |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | A debug build of the CLI is fast enough for interactive use — it is SQLite and git subprocesses, not compute | the profile becomes a field on `installs`, and the decision's cost table is where that is already anticipated |
| A2 | Sharing the repository's `target/` keeps the merge-path build to a link step in the common case | NFR-08-PERF-01 fails; the fallback in the design is to install only from a warm tree and decline otherwise |
| A3 | `git::tree_for` can be called a third time in one merge (merge, record, install) without surprise | the installer takes the tree the record used, which means threading it out of `record::keep` — a wider change, so it is called out rather than assumed silently |
| A4 | The operator's shell has `~/.local/bin` on `PATH`, or will add it once told | FR-08-09's warning is the whole mitigation; the binary is installed either way |
| A5 | The bin crate to build is discoverable from the repository without configuration | a second field appears, against the one-place rule — raise it before adding it |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| The destination lives in `company.toml`, on `[[repos]]` | it is an authority to write outside a repository, so it must live in the file no agent can commit to | design §The decision |
| Naming a destination is the opt-in; no separate switch | one place for one answer | global config rule |
| Build from the merge commit; never copy `current_exe()` or the worktree artefact | both are the wrong bytes, and one of them would put a stale binary behind a fresh sha | design §The decision |
| Self-detection by `installs`, not by `current_exe()` ancestry | path-based detection fails once the binary is installed outside any repo — it breaks on success | design §The decision |
| Debug profile, shared target dir | the operator runs the artefact the loop already built; `cargo install --path` forces release, a second cache and cargo's prefix | design §The decision |
| Temp-file + rename | `ETXTBSY` on a running binary, and a torn copy on a crash | NFR-08-REL-01/02 |
| Never fatal; repair is `wecode install` | the merge has landed and there is nothing to undo; re-merging lands nothing and confuses the history | `record::keep` precedent |
| No agent path to the installer | authority, not capability — writing the destination is code execution as the supervisor | `docs/design/ax.md` |
| The install is the first compile of the merge result, and says so when it fails | acceptance ran pre-merge on the branch; both sides can pass and the merge still not build | design §The decision |

## 9. References

**Project documents**

- `docs/wecode/cli-self-install-on-merge/design.md` — the signed decision this implements
- `docs/wecode/merge-record/design.md` — why post-landing steps report instead of failing, and why the report is generated
- `crates/wecode-cli/src/teardown.rs` — the two-caller, timid-automatic-caller shape
- `docs/design/ax.md` — parity of capability, never of authority
- `docs/reference/config/company.md` — the file `installs` is added to
- `plan.md` — build-cache bloat; deploy refused as a task kind

**Caveat.** None of the above covers packaging or distribution: this installs one
executable on the machine wecode is already running on, for the operator who already
owns the workspace.
