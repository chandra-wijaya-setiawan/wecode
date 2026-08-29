# Writing down a run transition before the thing it authorises happens

Status: **decided, not built**.

Notes for `rel-transition-journal`, the first P0 line of `docs/design/maturity-roadmap.md`:
*persist state BEFORE side effects; restart reconstructs, reclaims dead workers, resumes*.

## The run nobody can get back

A dispatch writes `running` on the task, cuts a worktree, opens an execution row, and
spawns an agent. If the wecode process is killed anywhere after that row is opened —
`kill -9`, the OOM killer, a laptop lid — the row stays `working` with `ended` NULL and
the task stays `running`. `Claim`'s `Drop` is what hands the status back, and `Drop` is a
courtesy a process pays only while it is alive enough to pay it.

What that costs is not a tidy-up. `scheduler::contended` refuses any further dispatch of a
task that is `running` with a run in flight, and `scheduler::free_slots` counts it against
the concurrency limit. So the task is unstartable forever and one seat is gone with it,
until a person types `wecode status <id> ready` — and to know that is the right thing to
type, they have to work out whether the agent from the dead run is still writing into the
worktree. Nothing in the tree answers that. `store.unfinished_executions()` exists and
finds these rows; it has no caller. `task_executions.pid` was meant to be the evidence,
and the schema comment says it is written at spawn, but the one call site passes `None`.

## The rule

**A step that changes something outside the database writes its intent to the database
first, and settles it afterwards.** A restart then has one job: find intents that were
never settled and settle them. It never infers what happened from the wreckage.

An intent is only useful if the step it names can be resolved after the fact, so every
step declares how:

| resolve | means | steps |
|---|---|---|
| `redo` | doing it again is a no-op or an overwrite | `prepare` — `worktree add` then `reset --hard` is already idempotent |
| `verify` | the world can be asked whether it happened | `spawn` (is that process there?), `commit` (is there a commit for this attempt?), `verdict` (re-judge the tree) |
| `refuse` | neither, and a second one costs real money | a teardown hook, an outbound notification |

`refuse` is not a failure of the design; it is the honest class. A step in it is settled
as `abandoned` and becomes an operator's question. The interesting move is that a step can
be pushed out of `refuse` into `verify` by what its intent carries — spawning an agent is
irreversible and unverifiable in general, and becomes verifiable because the intent names
the process precisely enough to go and look.

## Naming the owner precisely enough

Recovery must distinguish *the supervisor that owned this run is gone* from *it is still
working*, because a hand-run `wecode run t` beside a running `wecode serve` is ordinary,
and a restart that assumed everything unsettled was its own would kill a live sibling's
agent. A pid alone cannot make that distinction: pids are reused.

So identity is three facts, all cheap file reads, no new dependency and no `unsafe`:
`/proc/sys/kernel/random/boot_id`, the pid, and the process start time from field 22 of
`/proc/<pid>/stat`. Together these are a proof rather than an estimate. A different boot
id means the machine restarted and *nothing* recorded before it survives. The same boot id
means the question is answerable exactly: `/proc/<pid>` either exists with the recorded
start time, and the owner is alive, or it does not, and the owner is dead. There is no
threshold and no clock.

The child gets the same treatment, and one thing more. Its pid is known the instant
`Command::spawn` returns, and `process_group(0)` makes the group id equal to it, so one
recorded number addresses the whole tree the agent spawned. The window between the kernel
creating that process and wecode writing the number down is small but real, so the intent
written *before* the spawn carries a token, and the token is laid into the child's
environment — `env_clear()` means we own that environment completely. An orphan whose pid
was never recorded is still findable by its token in `/proc/*/environ`.

## The journal

One table, in the same workspace database, at schema 12:

```sql
CREATE TABLE run_journal (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id      TEXT    NOT NULL,   -- no FK: outlives the task, like `worktrees`
    exec_id      INTEGER,            -- NULL before the execution row exists
    step         TEXT    NOT NULL,   -- 'prepare'|'spawn'|'commit'|'verdict'|'reclaim'
    resolve      TEXT    NOT NULL,   -- 'redo'|'verify'|'refuse'
    target       TEXT    NOT NULL,   -- the worktree, the launch line, the branch
    token        TEXT    NOT NULL,
    host         TEXT    NOT NULL,
    boot         TEXT    NOT NULL,
    owner_pid    INTEGER NOT NULL,   -- the wecode process that wrote this intent
    owner_start  INTEGER NOT NULL,
    child_pid    INTEGER,            -- written the moment the child exists; == its pgid
    child_start  INTEGER,
    opened       INTEGER NOT NULL,
    settled      INTEGER,            -- NULL while in doubt
    outcome      TEXT                -- 'done'|'undone'|'abandoned'
) STRICT;

CREATE INDEX journal_open ON run_journal(task_id) WHERE settled IS NULL;
```

Not the ledger. `audit_log` is evidence — every row is a decision somebody can be held to,
and it is append-only because of that. Journal rows are machinery: they are written to be
overwritten, and half of them are questions rather than facts. Putting retractable rows in
the ledger would make the ledger's one promise false.

Not columns on `task_executions` either, which is the closer call, since that row is
already opened before the spawn. Three things decide it. The row does not exist yet when
`prepare` cuts the tree, so the first step could not be journaled at all. A run has several
steps in doubt at different moments, so a column set overwritten in place needs a `step`
column anyway — and once it has one, keeping the previous rows costs nothing. And
`task_executions` is what `wecode show` renders as the account of a run; doubt about a git
command does not belong in it.

## What a restart does

`wecode reclaim` adjudicates. `wecode serve` calls it once at startup, before its first
pass; `wecode doctor` reports what it would do and touches nothing. That split is the one
`teardown` already draws between `take_down` and `after_landing`: an operator naming a
thing has decided, and an automatic caller has to be able to decline and say why.

For each unsettled intent, the owner is the only question asked first. **Owner alive: stop,
this is not ours.** Owner dead, in order:

1. **Kill the child group**, if the recorded child identity still matches a live process.
   An agent whose supervisor is gone is unsupervised — no clock, no meter, no budget, no
   pipe — and unsupervised is not a state wecode offers. Adopting it is not on the table:
   the output stream it was being metered through died with the parent.
2. **Commit what is in the worktree** as that attempt, exactly as `commit_attempt` does on
   every other way out of a run. This is what makes reclaiming non-destructive rather than
   a decision to throw the work away.
3. **Close the execution row** as `canceled` — stopped from outside, which is precisely
   what happened — with a cause naming the crash rather than an exit code nobody observed.
4. **Hand the task back** to the status the claim recorded, and leave the worktree
   standing. The branch and the tree are the surviving copy of the work; taking them down
   is a separate decision with its own command.

Recovery has no recovery, because every step of it is a repeat-safe step: killing a dead
group, committing a clean tree and closing a closed row are all no-ops the second time. A
`reclaim` interrupted halfway is finished by the next one.

## Durability, honestly

The database runs in WAL with SQLite's default `synchronous=NORMAL`, which does not fsync
on every commit. That is sufficient here, and the reason is worth stating rather than
assuming: NORMAL is durable against *process* death, which is the whole of the failure this
addresses, because the pages are already in the operating system's cache. The case it does
not cover is a host losing power — and after a power cut the boot id has changed, every
recorded owner is dead by definition, and each step's resolution is `redo` or `verify`
against what is actually on the disk. A journal row lost to a power cut costs a hint, not
correctness.

## What this does not do

It does not resume a run. A run's supervisor holds the pipe, the meter and the clock; when
it dies the run is over, and the retry that follows is a new attempt with its own row. It
does not journal `merge`, `rollback` or the teardown hook, which are steps outside a run —
the table is shaped to take them and the rule already covers them, but each needs its own
resolve class argued, and the teardown hook is the first thing in `refuse`. It does not
replace `Claim`'s `Drop`, which stays as the fast path for the ordinary error returns.

## What would show this decided wrong

The drill is a test, and it is the implementation task's acceptance: dispatch a task with a
slow fake agent, `kill -9` the supervisor, run `wecode reclaim`, and assert that the task is
back in its previous status, the run reads `canceled`, the agent process is gone and the
worktree still stands. A second `reclaim` must change nothing.

Three observations would mean this is wrong. If `reclaim` ever stops a live sibling's agent,
the identity proof is too weak and a lock file per run is the fallback. If operators
routinely find `abandoned` rows they have to resolve by hand, the resolve classes are drawn
in the wrong place. And if the journal grows a step per git invocation, the granularity is
wrong — a step is a thing a person would name when asked what the run was doing, and there
should be four or five of them in a run, not forty.
