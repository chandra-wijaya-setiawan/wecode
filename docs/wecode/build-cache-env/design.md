# Sharing a build cache across worktrees

Status: **built**. Written alongside the implementation rather than before it — there
was no design task in front of this one, and the decisions below are worth keeping
whichever order they were made in.

## What went wrong

A worktree is a clean checkout, which is exactly what makes it safe: a task cannot
disturb the operator's working copy, and its diff is the whole of what it did. It also
means `target/` starts empty.

So the first thing every task does is a cold build, and it does it twice — once inside
the agent, which compiles to find out whether its edit works, and once in verification,
which runs `cargo test --workspace` to judge it. On this repository that is minutes per
attempt, paid again by every retry, and paid in full for a one-line change to a doc
comment. Nothing about the output is task-specific: it is this repository compiled at
roughly this commit, and the next worktree over would have produced almost all of the
same artifacts.

The cost is invisible in the ledger, too. It lands in wall time, so it eats the wall
budget the task was given for *doing the work*.

## The declaration

A project names the directories its worktrees share, in the playbook — the file that
already describes that repository's toolchain and is versioned with it:

```toml
[project.build_cache]
CARGO_TARGET_DIR = "~/.cache/wecode/wecode/target"
```

Key is an environment variable, value is a directory. wecode sets them and knows nothing
else about them, which is the point: `CARGO_TARGET_DIR` for Rust, `GOCACHE` for Go,
`YARN_CACHE_FOLDER` for a JS project, `SCCACHE_DIR` beside any of them. Deriving a
variable from `language` would have made this a list of ecosystems wecode has heard of,
and a project on the wrong side of that list has no way to say so.

It is a project setting rather than a company one because a cache belongs to a
repository. Two projects on one repo want the same directory; two repos want different
ones, and would corrupt nothing by sharing but would queue behind each other's locks for
no reason.

## Both processes, or neither

The variables are set on the spawned agent **and** on the acceptance commands.

Half of this would be worse than none. The agent builds while it works; verification
builds again to judge it, and on most tasks the verification build is the larger of the
two — the agent may have run `cargo check`, verification runs the suite. Sharing only
the agent's build leaves the expensive half cold and looks, from the outside, like the
feature is on.

The two environments are built differently and stay that way:

- **The agent's is constructed from nothing.** `env_clear`, then the template's
  allowlist. The cache is applied *after* the allowlist, so a project's answer for this
  repository beats an inherited `CARGO_TARGET_DIR` pointing at the operator's own
  checkout — which is the one directory a worktree run must not write into.
- **Acceptance inherits.** Those commands are wecode's own and need the toolchain the
  operator has; a `sh` without `PATH` could not run the tests it is meant to judge. The
  declared variables are laid over that.

Nothing about the cache is on the allowlist in `company.toml`, and that is deliberate.
The allowlist governs what may be *inherited* — what of the operator's shell an agent
may see. These values are not inherited from anywhere; they are what a repository file
said. Requiring them in both files would mean editing the company profile for every
project that wanted a cache, which is the wrong file to be editing.

## What a value may be

Three refusals, all at parse, all because the failure they prevent is silent:

- **A relative path is refused.** `target/shared` resolves against whichever worktree is
  running, so every task would get its own directory under a name promising the
  opposite. The build still succeeds; the cache is simply not shared, and nothing looks
  wrong. Absolute, or under `~/`.
- **A key that is not an environment variable name is refused** — it could never be set.
- **`PATH` and the loader variables are refused.** A build cache says where output goes.
  These say which program runs, and a repository file that could set them would be
  choosing the toolchain for every agent that works on that repo. That is a different
  power wearing this feature's clothes, and it belongs to the operator's allowlist.

The `~` is resolved at use rather than at parse, for the same reason the `accept` check
lives at load and not at parse: one playbook has to describe the same cache on two
machines with different homes.

The directories are created before anything is pointed at them, and a directory that
cannot be created is an error rather than a warning. A toolchain handed an uncreatable
path either fails obscurely or quietly falls back to the worktree's own `target/` — the
second being the same silent non-sharing the relative-path rule exists to prevent.

## The trade, stated

Cargo takes an exclusive lock on its target directory. Two tasks building at the same
moment now queue instead of building in parallel.

That is the deal, and it is the right one: waiting for a lock costs seconds where the
rebuild it replaces costs minutes, and wecode's concurrency is bounded by the operator's
attention rather than by cores. A project that would rather have parallel cold builds
declares nothing, which is what every project had before this existed.

The cache outlives the worktrees — `wecode worktree remove` does not touch it, and
nothing here ever deletes one. A shared cache that a teardown could delete would be a
shared cache one task could take away from another.

## What this does not do

It does not manage the directory. No size cap, no eviction, no `wecode cache clean`:
every toolchain that reads one of these variables already has its own opinion about
cleaning, and a wrapper around `cargo clean` that wecode ran on its own schedule would
be a way to lose a cache at the least convenient time.

It does not share anything between *repositories*, and it does not warm a cold cache.
The first task after a dependency bump still pays; the ones behind it do not.
