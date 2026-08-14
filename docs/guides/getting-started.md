# Getting started

Ten minutes to a company that can run a task.

## 1. A workspace

```bash
cargo build --release
alias wecode=./target/release/wecode

wecode init mycompany --template solo
wecode use mycompany
wecode company show
```

`init` writes two files: `company.toml`, which you edit, and nothing else — the
database appears on first use. Templates are `solo` and `software-company`; the latter
has separate implementer, tester and reviewer seats.

## 2. Point it at real code

Edit `company.toml` and set `[[repos]]` to a repository you have:

```toml
[[repos]]
name = "app"
path = "~/projects/app"
```

The workspace is not that repository, and should not be inside it. A worker's working
directory must never be the place its own authority is defined.

## 3. Take a seat

```bash
wecode login you
wecode whoami
```

A session is a connection, not a credential — it selects a seat and expires on idle. It
survives between processes, so every later command finds it by itself.

## 4. Plan something

```bash
wecode project add api "cut export p99 below 500ms" \
    --repo app --measure-cmd "cargo bench" --tokens 200000 --wall 3600

wecode task add cache --project api "add a response cache to the export endpoint" \
    --accept-cmd "cargo test cache" --write "src/cache/**" --tokens 50000 --wall 900
```

Expect to be refused at least once. The gate asks a fixed question for each defect: a
title naming two outcomes, a word like *faster*, missing acceptance, missing scope,
missing budget, a scope that overlaps a task which could run at the same time. That last
one looks across projects: a repo can carry several, and two of them claiming the same
paths is two worktrees changing the same lines. Answer it — narrow the scope, or add
`--after <task>`, which may name a task in another project — or pass `--force` and the
defects are recorded as waivers.

## 5. Teach the project how it works

```bash
wecode playbook init --language rust
$EDITOR ~/projects/app/.wecode/playbook.toml
wecode playbook feature
```

Fill in the guidance and the defaults, and the next `task add` stops needing
`--accept-cmd`, `--tokens` and `--to`. See [playbooks.md](playbooks.md).

## 6. Run it

```bash
wecode assign cache --to impl
wecode start cache            # a worktree and the envelope — you do the work
# or
wecode run cache              # wecode spawns the agent and supervises it
```

`start` hands you the envelope; `run` spawns the agent named by the post. Both prepare
identically, so the result lands in the same place either way.

Then:

```bash
wecode verify cache           # the diff against scope, then the acceptance commands
wecode merge cache            # if it passed and the policy allows
wecode rollback cache         # if it should not have
```

## 7. Watch it

```bash
wecode board                  # a snapshot
wecode up                     # live: j/k move, enter descend, a archived, q quit
wecode ready                  # what a dispatcher could pick up now
wecode audit --denied         # what was refused, and why
```

The **spend** cell fills in once a task has actually run — `90/50000`, tokens against
the budget you declared. Over budget turns the row red, after the fact: the tokens are
gone before anyone hears about them, and the wall limit is the control that stops a run
mid-flight.

A cell still reading `0` after a run means the agent reported no token count, not that
it was free. `wecode show <task>` has the per-attempt column and says which, and
[config.md](../reference/config.md) lists the `protocol` values wecode can read a count
out of.

## 8. Let it run itself

```bash
wecode loop                   # promote what is unblocked, dispatch what is ready
```

Foreground on purpose — a daemon that forks is a daemon whose logs you cannot find. For
a service, a systemd user unit with `Restart=always`, `--session <id>` so it never has
to guess which seat, and an explicit `PATH` so the acceptance commands can find your
toolchain.

The loop stops on anything that needs you, which is only useful if you find out. Add a
hook to `company.toml` and it will tell you instead of waiting to be looked at:

```toml
[notify]
command = "notify-send 'wecode' \"$WECODE_TASK needs you: $WECODE_WAITING_FOR\""
```

It runs once, when a task *starts* waiting — for a signature, an answer, or a decision
about work that failed. `WECODE_WAITING_FOR` is `approval`, `input`, `failed` or
`signature`, so one `case` in shell can route them differently; the full list of
variables is in [config.md](../reference/config.md#the-notify-hook). Anything that runs
in a shell works, and a hook that fails is reported rather than allowed to affect the
task.

## Working through an agent

wecode is meant to be driven by your coding agent rather than typed. One line in
`~/.claude/CLAUDE.md`:

```markdown
If I say "use wecode", run `wecode brief` before anything else.
```

`brief` tells the agent which seat it holds, what that seat may and may not do, what the
charter forbids outright, and which projects have playbooks. All of it derived from the
grant, so it stays true when you edit a role.
