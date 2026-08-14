# A starter that knows its language toolchain

Status: **built**. Written alongside the implementation, like the two slices before it —
there was no design task in front of this one, and the decisions are worth keeping
whichever order they were made in.

This is the third and last step of *playbooks that know their language*. The first
([playbook-check]) made a playbook name a command this machine actually has; the second
([build-cache-env]) let a project share the directory its worktrees rebuild. Both gave a
project somewhere to put a fact. Neither put anything there.

[playbook-check]: ../../guides/playbooks.md
[build-cache-env]: ../build-cache-env/design.md

## What went wrong

`wecode playbook init --language rust` wrote the same file as `--language python`. The
word landed in `[project] language`, which nothing reads, and every other line was a
prompt:

```toml
accept    = []            # e.g. ["cargo test --workspace"]
# [project.build_cache]
# write  = ["src/**"]
```

Three blanks, and a project paid for each one on its first task rather than at
`project add`:

- **`accept = []`** means a task is accepted by nothing until somebody types a command
  in. The admission gate refuses a task with no acceptance, so the cost lands as a
  refusal per task until the file is edited — or, worse, as a command typed from memory.
  wemail acquired `python -m pytest` that way, on a machine with no `python`.
- **No build cache** means every worktree compiles from cold, twice per attempt. That
  cost is now avoidable in one block, and the block was commented out.
- **`write = ["src/**"]`** is wrong in every language for the same reason: it does not
  name the file a build rewrites. A task that added a dependency dirtied `uv.lock`,
  which its scope did not cover, and verification reported the work as reaching outside
  it — after the budget was spent.

None of the three needs to know anything about the project. They are facts about a
toolchain, and the repository already says which toolchain it is.

## The table

One row per language, in `wecode-org::toolchain`: the acceptance commands, the cache
variables, the tracked files a build rewrites, the write scope a code task usually
needs, and one sentence of prose for whoever plans the work.

Two properties keep this from becoming the thing wecode has avoided everywhere else —
a list of ecosystems it has heard of, consulted at run time:

- **It is read once, while a file is being written.** What it produces is ordinary
  playbook text: hand-edited, committed, and from then on the only source of truth.
  Nothing at dispatch, verification or merge asks what language a project is. Being
  wrong about a language therefore costs an edit and not a behaviour, which is what
  makes four rows an acceptable amount of knowledge to hold.
- **It never gets a last word.** The commands it writes face the same load-time check as
  a hand-written playbook's. A starter that names a program this machine lacks is
  refused exactly like any other file that does.

`[project.build_cache]` stays a name and a path at run time, as [build-cache-env]
settled. This adds a table that *suggests* a name and a path; it does not add one that
interprets them.

## Detection

The language is read off the manifest at the repository root — `Cargo.toml`, `go.mod`,
`pyproject.toml`, `package.json` — when `--language` is not given.

This exists because the flag was optional and therefore forgotten, and a forgotten flag
produced the TODO file. Asking the repository is both the cheaper question and the more
accurate one.

Two limits, both deliberate:

- **Root only.** Walking the tree would find the `package.json` of a docs site inside a
  Rust workspace and scaffold the project as TypeScript. A wrong answer here is a whole
  file of commands for the wrong language.
- **First match wins**, in table order, and the file that decided is printed. A repo
  carrying two manifests is exactly where a person needs the last word, so `--language`
  overrides detection even when the manifest disagrees.

A repository that names nothing is not guessed at. It gets the prompts-and-TODO starter,
with a line at the top naming the languages that would have got more — the only place
somebody who typed `rsut` can find out.

## What is declared, and what is offered

The build cache is **declared live**, not commented out.

That is the one genuinely arguable decision in this slice, and the argument that settles
it is timing: the cost a commented-out block prevents is paid by the *first* task, which
starts long before anyone has read to the bottom of a config file. A project that would
rather have cold builds deletes two lines, and the block says so in the file. A project
with no known toolchain still gets the commented example, because wecode has no name to
suggest and a guessed variable would be worse than a blank one.

The `subtasks` template stays commented out, unchanged: ceremony on small work is a real
risk, and `--expand` is opt-in per kind. Only its write scope changed — from `src/**` to
the globs that language builds from, lock file included.

## Where the toolchain facts go

The sentence about what a build rewrites goes in `guidance`, in every kind that changes
code, and is therefore repeated four times in the file.

That repetition is on purpose. A planner runs `wecode playbook bug` and reads one kind;
comments in the TOML are invisible to it, and a fact stated once under `[feature]` would
not reach the person planning a chore. `guidance` is the only channel that reaches a
reader, so the fact that costs a task lives there — wrapped to the width the rest of the
file is written at, because the table states each sentence as one line and a file meant
to be hand-edited should not contain the only 150-column lines in the repo.

## Reporting instead of hiding

`playbook init` prints what it decided: the language and the file it was read from, the
acceptance commands, the cache directory.

These are the lines a person is expected to disagree with. Stated only in TOML, they
would be trusted by whoever never opened the file — which is the failure this whole
slice is about, one level up.

It then reads back what it wrote. A starter now names a real test command, so it can
name one this machine does not have, and that is reported as a warning rather than
raised as an error: the file is right for the repository and wrong only here, and
deleting it would be the wrong answer. The exit stays zero, the refusal names the
program, and every later command that reads the playbook refuses it until the line is
changed — which is the behaviour [playbook-check] built, arriving one step earlier.

## What this does not do

It does not choose commands by looking at the machine. A starter written on a laptop
without `uv` still says `uv run pytest -q`, because the playbook describes the
repository and is committed to it; picking commands from whatever happens to be
installed would make the file depend on where it was generated.

It does not check that the commands pass, or that a `test` script exists behind
`npm test`. It writes the toolchain's usual commands, says they are the toolchain's and
not the project's, and asks that they be run once.

It does not manage the cache directory it declares, and it does not update an existing
playbook. `init` refuses to overwrite, as it always did: folding a new fact into a file
somebody has edited is a person's job, and `wecode playbook gap` is where the ones found
later are queued.
