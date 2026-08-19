# A credential a task may use and never keeps

Status: **decided, not built**. The design task for #229→#231. It decides one thing —
how a task that must reach a real cloud gets the credential for it — and it decides it
in a way that is meant to survive the first customers being AWS session credentials for
`pytest -m cloud` and a Travelpayouts token.

## The only door there is today, and why it is the wrong shape

An agent's environment is built rather than inherited: `env_clear`, then
`env_allowlist` from `[agents.claude-code]` in `company.toml`. Absent a container that
allowlist is the whole environment a worker gets, and — as `spawn.rs` says at the top of
the file — the only network control there is.

Which makes it the only place a credential could go today, and it is wrong in three
independent ways:

- **It is per-harness, not per-task.** `AWS_SECRET_ACCESS_KEY` on the allowlist is on
  every task that harness runs — the docs task, the refactor, the one that only edits a
  comment. The blast radius of a feature that four tasks in a hundred need becomes the
  whole workspace.
- **It is inherited.** The value is whatever is in the operator's shell when `wecode`
  was started, which is normally a long-lived key rather than a session, and is
  certainly not scoped to the work. The one credential nobody should hand an agent is
  the one that mints the others, and it is exactly the one that lives in a shell.
- **It has no clock.** An allowlisted variable is as old as the shell. Nothing expires,
  so nothing bounds the exposure after the run ends.

The rest of this replaces that door for the cloud cases, and changes nothing about the
allowlist for `PATH`, `HOME`, `LANG` and the harness's own API key. Those are properties
of the machine; a credential for an AWS account is a property of the *work*.

## The declaration: two files, and one that stays out of it

**The task names ids.** A new field beside `scope` and `budget` — `secrets: Vec<String>`
on `Task`, set at creation:

```
wecode task new --project ste-p2 --secret aws-cloud-test "run the cloud suite"
```

Ids, not environment variable names, and that is the first real decision. One `aws sso`
login yields three variables today (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`) and a different number the day the operator moves to OIDC or to a
named profile. A task that named variables would be encoding somebody else's credential
plumbing into a row in `wecode.db`, and every task in the plan would need editing when
the plumbing changed. `aws-cloud-test` says what the task needs to be able to do.

**`company.toml` says what an id is.** It is the operator's hand-edited file, it already
holds `[invariants]` and the allowlist, and wecode never rewrites it:

```toml
[secrets.aws-cloud-test]
command = "aws configure export-credentials --profile cloud-test --format env-no-export"
vars    = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]
ttl     = "1h"
timeout = "20s"

[secrets.travelpayouts]
command = "pass show travelpayouts/token | sed 's/^/TRAVELPAYOUTS_TOKEN=/'"
vars    = ["TRAVELPAYOUTS_TOKEN"]
ttl     = "30d"
```

A command rather than a value, for the reason `[notify]` and `[telegram]` are commands:
every machine that has credentials already has something that prints them — `aws`,
`pass`, `op`, `vault`, `gcloud` — and a wecode that grew its own vault would be asking
operators to copy secrets into a second place to keep them out of a first.

**The project playbook stays out of it.** `[project.build_cache]` is in the playbook
because a cache belongs to a repository; a credential belongs to an account, and the
playbook is committed to the repo *and read by every worker in the worktree*. A line
naming how to mint a production credential does not go in a file whose whole purpose is
to be handed to agents.

## What a resolver may print

`KEY=VALUE`, one per line, on stdout. Everything else is refused, at the point of
resolution, with the id named:

- **A key not in `vars`.** The declared list is the contract, so a resolver that starts
  printing a fourth variable cannot start setting a fourth variable. This is also the
  only defence against `command` being edited to something more generous than what it
  was reviewed as.
- **`PATH` and the loader variables**, wherever they appear. Same rule as the build
  cache, and the same reason: those say which program runs, not what it may reach.
- **An empty value.** Every credential helper on a bad day prints a variable with
  nothing after the `=`, and the run that follows fails inside a cloud SDK ten minutes
  later with an error about signatures.
- **A value with a newline in it.** A line-based protocol cannot tell a two-line value
  from two variables. A PEM is the case that wants this, and the answer for a PEM is not
  a file wecode writes — see below.
- **A non-zero exit, or a timeout.** Stdin is `/dev/null`: a resolver that wants an MFA
  prompt cannot have one, and a credential that genuinely needs a person at the keyboard
  is a `person` task (#224) rather than a broken dispatch.

The resolver's **stderr** is shown to the operator and truncated onto the record; its
**stdout** is never shown, never logged, and never recorded, because that is where the
values are. Two streams, two rules, and the asymmetry is the whole point of having it.

## Where the value goes, and where it never goes

Resolved **once per dispatch**, held in memory for the life of that dispatch, and set on
both processes wecode starts: the agent, and the acceptance commands that judge it.

Both, for the reason the build cache is both — half of it would be worse than none. The
cloud gate *is* an acceptance command (`pytest -m cloud`, #233), so a secret that reached
the agent and not the checks would look like the feature was on and fail the gate with a
credentials error. The two environments keep their existing asymmetry: the agent's is
built from `env_clear` plus the allowlist, and secrets are applied **after** the
allowlist and after the cache, so a stale inherited `AWS_*` cannot beat a freshly minted
one; acceptance inherits the operator's shell and the values are laid over it.

Once per dispatch and not once per process: two resolutions mean two logins, two entries
in the provider's own audit trail for one task, and two expiry times where the design
below needs one. Every **attempt** resolves again, though — a retry after a kill must not
reuse a credential that has already been alive for the whole of the first attempt.

Nowhere else. In particular:

- **Never a file in the worktree.** No `.env`, no `~/.aws/credentials` written by
  wecode, no `git config`. A file lands in the diff or in the operator's `git status`,
  `**/.env` is in `never_touch` already — so wecode writing one would be wecode doing
  what the charter forbids every seat — and a worktree survives a killed run, so the
  file outlives the process that needed it. Environment variables die with the process
  group.
- **Never in the envelope.** The prompt names the ids, so a worker knows which
  credentials it holds and can say so in its result; the values are not in the rendered
  text, and `wecode start <task> --json` shows the ids only.
- **Never in the store.** `wecode.db` keeps the ids a task declared and the ids a run
  held. It has no column a value could go in, which is what makes "how does wecode
  encrypt secrets at rest" a question with no surface: it holds none.

## The TTL refusal

`ttl` is required, and it is compared against the wall budget the task will actually run
under — the task's, capped by the role's and the harness template's. If the credential
expires before the run can end, **dispatch is refused**, before the worktree is made and
before a token is spent:

```
cannot start ste-p2-w4f: aws-cloud-test lives 1h and the run may take 1h30m
  shorten the wall budget to 1h, or declare a longer-lived credential
```

Refused at the front rather than re-resolved mid-run, and this is the decision the plan
line "refuse dispatch when the credential outlives its TTL mid-run" is asking for. A
credential that dies at minute 20 of a 90-minute run produces a failure 70 minutes later
that reads as a broken test; the agent retries it, the retry fails the same way, and the
budget is gone before anyone reads the word `ExpiredToken`. Re-resolution would mean
writing into a live process's environment, which cannot be done without either a file —
refused above — or a helper the agent has to cooperate with, and an agent that can
decline to refresh its credential is a control that is really a request.

`ttl` is what the operator *says*, and wecode believes it. It cannot verify it, and
believing it costs nothing a wrong number does not already cost: the real expiry is
enforced by the provider, and the only thing this figure buys is the refusal above.

## Two gates, in two places, on purpose

**At admission: does the id exist.** `Defect::SecretUnknown { id, known }`, checked the
way `RepoUnknown` already is — the workspace's declared ids are passed into
`check_task`, and the comparison stays a pure function of its inputs. A typo belongs to
the Tuesday the task was written, not to the Friday its last predecessor landed.

**At dispatch: may this seat hold it.** A new `Action::Secret { id }` through
`Broker::authorize`, because the crate's first rule is one chokepoint for every
consequential action and handing over a credential is one. It is `Regimented` rather than
`Sanctioned`, and the reason is the same reversibility test `control_mode` already
applies: there is no afterwards in which a credential can be un-handed. Denied as
`DenyReason::SecretNotPermitted { id }`.

Authority for it is a new `secrets` list on `Grant`, matched with `glob::permits` — so
`["aws-*", "!aws-prod-*"]` reads off one block in the order it was written, exactly as
`run` does after #227. `narrows` gets a line for it, and delegation keeps only ever
narrowing.

The charter floor — `never_hand = ["prod-*"]` in `[invariants]`, under every seat
regardless of role, with `Lifted::Hand` so one signed task may reach a production
credential for its lifetime the way #228 lets one reach `infra/**` — follows the same
argument and is deliberately the **second** half. It can land in #231, or later, and
nothing above depends on it. The per-seat `secrets` list is what makes the feature safe
to turn on; the floor is what makes a misconfigured role survivable.

## Scrubbing what comes back

Every resolved value is registered with a redactor that both captured streams run
through: `reader` in `spawn.rs` sees whole lines, so the substitution happens once at the
top of that loop, before the meter and before the buffer, and the same redactor wraps the
acceptance command output in `verify.rs`. What replaces a value is `«aws-cloud-test»`, so
the record says which credential was echoed.

This is a net over **accidents** — an agent running `env`, a boto stack trace quoting a
key, a `pytest -vv` dump — and it is worth having because those are the ways a secret
actually reaches a log. It is not a control: an agent that wants the value out has
`base64`, and stating that plainly here is better than a later reader assuming the
scrubber was a boundary.

## The trade, stated

This does not stop an agent using the credential, and it cannot. The task exists in order
to call AWS, so something in that process has to be able to authorise the call. What
changes is *what* the agent holds and *for how long*: a short-lived session credential,
minted for this dispatch, scoped by the provider's own policy, expiring on its own,
handed to one process that dies with the run — and never the long-lived key that minted
it, which stays in the operator's `pass` or SSO cache and never enters a wecode process's
environment at all.

So "without handing agents the keys" resolves to: the agent gets a lease. Everything past
that — how narrow the policy is, how short the TTL is — is the operator's to set, in
their own cloud account, with tools that already do it properly. wecode's job is to make
the lease per-task, to refuse a run that would outlive it, to record who held what, and
to keep it out of every file.

One thing it explicitly is not: a network permission. Declaring `travelpayouts` does not
open a host, and the `hosts` list on the grant is unchanged and declared separately. A
token with no route is useless and a route with no token is harmless; conflating them
would mean a credential silently widening what a seat may reach.

## Where the code goes, and the ratchet standing in front of it

The crate order in the playbook holds: `core` → `gov` → `org` → `store` → `cli`.

| crate | what lands |
|---|---|
| core | `Task.secrets`, `Defect::SecretUnknown`, the admission check |
| gov | `Action::Secret`, `DenyReason::SecretNotPermitted`, `Grant.secrets`, `narrows` |
| org | `[secrets.*]` parsed into `SecretDef { id, command, vars, ttl, timeout }`, every refusal above at parse |
| store | schema 12: `ALTER TABLE tasks ADD COLUMN secrets TEXT`, and the ids on the execution row |
| cli | a new `secrets.rs` — resolve, redact — wired at `exec.rs:781` and in `verify.rs` |

**`broker.rs` has seven lines of room.** It is 1593 against `src=1600`, so #230 cannot add
a variant to `Action` and its match arms, let alone tests, without failing acceptance on a
file it is not there to fix. The playbook warns about exactly this and says to declare the
split up front, so: **move `Exception`, `Lifted`, `sign_exception`, `expire` and their
tests into `crates/wecode-gov/src/exception.rs` first**, as its own step with its own
scope. That is roughly the 495 lines #228 added, it is a seam the module already has, and
it leaves both files clear. `exec.rs` (1539) and `spawn.rs` (1474) survive because the new
work is a module of its own and their diffs are call sites.

## What would prove it works

Not a unit test that the parser parses. The playbook's test step wants the assembled
thing driven, and it can be driven without a cloud account: a fixture resolver is a
`printf 'AWS_ACCESS_KEY_ID=AKIAFIXTURE\n'` script, and the agent template is already an
`sh -c` in the existing tests.

- The variable reaches the agent, and reaches the acceptance command — the two halves
  `spawn.rs:854` and `verify.rs:908` already prove for the cache, which is the shape to
  copy.
- The value appears in **no** artifact: not in the captured output after a resolver whose
  agent echoes it, not on the execution row, not in `wecode start --json`, not in the
  ledger record of the `Secret` action.
- A `ttl` under the wall budget refuses dispatch, and no worktree exists afterwards.
- An unknown id fails at `task new`, and a seat without the id in its `secrets` list is
  denied at dispatch with the id in the message.

## What this does not do

No secret storage, no rotation, no expiry warnings, no `wecode secret show`. No caching
of a resolved value between dispatches: the second task logs in again, and the provider's
audit trail showing one resolution per dispatch is worth more than the second it saves.
No file-shaped credentials — a tool that will only read `~/.aws/credentials` is served by
the operator's own `credential_process`, not by wecode writing files near a worktree. And
no per-key network enforcement, which stays where it is.
