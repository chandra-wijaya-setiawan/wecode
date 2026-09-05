# wecode — the plan

The roadmap. What **exists** is in [docs/features.md](docs/features.md), including the
gaps; this file is only what is next. A slice becomes tasks on the board when it starts,
not before — a board full of speculative tasks is a board full of guesses, against an
attention budget of five.

## Now

**a2a-handoff.** The A2A data model and the handoff both exist; the envelope is still
assembled beside the model rather than from it. Rendering the prompt out of a `Message`
makes the text form one rendering among possible others.

## Playbooks that know their language

`wecode playbook init --language rust` writes the same TODO template whatever you pass
it — the language lands in one field and changes nothing else. So every new repo starts
with acceptance commands nobody has run, which is how wemail acquired `python -m pytest`
on a machine that has no `python`.

Three steps, and the order matters because each needs the one before it:

- **Check what a playbook names.** `verify` already tells exit 127 apart from a real
  failure. Nothing applies that at planning time, so a playbook can promise a toolchain
  the machine does not have and only say so once a task has been dispatched against it.
- **Share the build cache.** A worktree isolates source, which is the point, and build
  state, which is not: one in-flight Rust task measured 890 MB of `target/`, none of it
  shared with the 2.5 GB next door, recompiled from zero on every attempt. Python paid
  37 MB, and only because `~/.cache/uv` sits outside the worktree. The lever —
  `CARGO_TARGET_DIR`, `UV_PROJECT_ENVIRONMENT` — cannot be pulled today: an agent
  template can *allow* an environment variable through but not *set* one.
- **Write starters that know a toolchain.** Real accept commands, the scope globs a
  build actually dirties (`uv.lock` cost a task), and the cache settings above. What an
  orchestrator needs at `project add` time, rather than a file full of TODO.

## Next

**Integration acceptance, enforced.** The SDLC's missing chapter, and the
owner's main theme: an executable story cannot enter delivery without an
integration acceptance declared, and cannot close without evidence that it
passed against the assembled revision. Admission checks the obligation exists,
verification records the tested revision, and amending the revision invalidates
the evidence — a component task finishing must stop reading as its capability
being delivered. Specified in [docs/design/sdlc.md](docs/design/sdlc.md), and
proven against **Conduit**: the RealWorld API with a vendored spec and an
upstream Hurl suite, run as a versioned delivery campaign — greenfield release,
seeded bug repairs, spec-led change requests, interrupted-run recovery — where
every failed run becomes a reproducible wecode defect.

**Retry.** The envelope already carries the previous attempt and the reason it was
rejected, so a retry has something to learn from. What is missing is the loop doing it
by itself, bounded — a count, so a task cannot cycle forever, and a stop that puts it in
front of a person.

**Crash recovery.** A scheduler that dies mid-run leaves a task `running` and leaks a
slot. A single-scheduler lock makes recovery deterministic rather than guessed: holding
the only lock means nothing else is running, so every unfinished execution is stale by
definition. No heartbeat, no pid liveness check.

**Record the launch before it happens.** The ledger records an agent's exit but not its
start, so a crashed run leaves no audit trace at all — absence looks the same as never
having been dispatched.

## Later

**Close the scope-laundering hole.** `verify` should name any scope amendment made after
the task started running. The ledger holds both facts today and joins neither.

**Read `result.json`.** The envelope instructs every agent to write it and nothing
consumes it. Either read it as `Source::Harness` — a summary for a human, inadmissible
as evidence — or stop asking for it.

**Protocol adapters.** `protocol` is an unvalidated string that nothing matches on.
Parsing agent output buys live progress and token spend, neither of which correctness
depends on, which is why it has waited.

**Remote agents over A2A.** The data model is in place, so this is a transport and an
`AgentCard`, not a redesign.

**Containers.** The environment allowlist is the only network control there is without
one, and the docs should stop implying otherwise the moment that changes.

## Not doing

**Deploy as a task kind.** It is not a change to a repository, and `never_touch` plus
`never_run` forbid it outright. Making it work means weakening the charter, which is a
decision rather than a feature.

**A review task kind.** A review that writes a note is an ordinary task and already
works. A review that only says yes or no is the approval gate, which exists. A review
that produces an opinion should not be a task at all — task acceptance must be
executable, precisely so nothing is marked done because someone was satisfied.

**An event bus, and async.** Both were designed and both were reversed: the database is
the bus, and threads are enough for the handful of agents an operator can actually
oversee.
