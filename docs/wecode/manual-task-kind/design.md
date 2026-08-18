# A task whose doer is a person

Status: **the state is built; the surface and the store column are not.** What works and
what does not is set out at the bottom, under *what is not wired yet* — read that before
trying to create one.

Notes for `manual-task-kind`, alongside [brief.md](brief.md), which is the owner's ask
in the owner's words. The brief contributes the surface — the steps travelling in a
Telegram message, **Complete** as the signature, **Hold** as a recorded refusal. This
task contributes the state underneath it: work that reaches *blocked-on-human* instead
of being dispatched, and advances only on an explicit signature.

## The specimen

Watching real fares needs a Travelpayouts token, and only the owner can create one. The
cloud work has the same shape from the other side: a bucket, a role, a key that exists
in a console and nowhere an agent may reach. Both were dependencies of tasks already in
the plan, and both lived in conversation — untracked, unreminded, and invisible to the
graph built to hold exactly this.

The alternative is worse than untidy. The only way to let a task do the work is to hand
the credential to whoever runs the task, which is to say to an agent. The kind exists so
that a plan can hold a step touching real cloud resources without that trade.

## A second axis, not a seventh kind

The obvious shape is `TaskKind::Manual`, beside `Feature` and `Chore` and `Design`. It
is wrong, for the reason `parent` and `depends_on` are kept apart one field over: it
conflates two questions that come apart in practice.

Provisioning a bucket by hand is still a chore. Rotating a signing key is still a chore.
Writing a design someone else will implement in a console is still a design. The kind
says *what the work is* — it selects the playbook, the acceptance commands, the subtask
expansion — and spending it on *who holds the keyboard* costs a manual task the ability
to say which it was, in exactly the place a reader looks to find out.

So `Task::doer` — `Doer::Agent` or `Doer::Person` — and `TaskKind` untouched.

It is not the assignee either, though the brief describes it that way ("a task assigned
to a post whose occupant is a user rather than a harness"). Asked of the post, the answer
can be lost by leaving a seat unfilled and invented by filling one, and the two places
that most need it — the admission gate and the tick — hold a plan and no company. A
manual task may name a post, and often should; naming it is not what makes it manual.

## Where the rule lives, and why it is the tick

`scheduler::transitions` is the only author of a manual task's promotion. Unblocked, it
goes to `needs-approval` **directly from `waiting`**, without a tick spent in a `ready`
that would be a lie about what could start it.

The reason it belongs in the tick rather than at the door is prerequisites. A console
step whose instructions come out of an earlier task must not reach the operator before
that task has finished, and the graph is what knows. Demotion still wins over it: a
manual task whose prerequisite is reopened goes back to `waiting` rather than staying in
front of a person, because unfinished groundwork is not something to go and ask about.

`scheduler::dispatchable` filters manual work out as well, and that filter should never
be the thing that catches one. It is there because the stored status is a **cache**: a
hand-set `ready`, a stale plan read, a tick that has not run yet — and the difference is
an agent being handed the console step. `commands::exec::prepare` holds the same line at
the last door, the one `wecode run` and `wecode start` both come through.

## What the gate stops asking for

`admission::check_task` turns three of its rules off for a manual task, all for one
reason: a write scope bounds a worktree, a budget bounds a run, and an executable
measure is a command a harness executes over the result. Every one of them describes a
dispatch, and there is none.

Asking anyway would not make anything safer. It would teach operators to declare a glob
nothing writes and a token count nothing spends in order to get past the gate, and a
gate answered with fiction has stopped measuring anything.

What the gate keeps asking is the part that still bites: a singular title, and
dependencies that exist. A person needs to know which one thing is being asked of them
as much as an agent does.

Acceptance may be empty, and may also be a probe. Where a check is cheap it is worth
having — `test -n "$TRAVELPAYOUTS_TOKEN"` is a legitimate measure — and `wecode verify`
runs it like any other. What it cannot do is finish the task: `Task::needs_a_signature`
is true for a manual task as it is for a design, so a passing probe lands in
`needs-approval` and stops. Tap-says-done and probe-agrees is the strongest state this
can reach, and the tap is the half no command can supply.

## Two requests wearing one status

`needs-approval` means opposite things depending on who the doer is. On an agent's task
it means *look at what I did*. On a manual task it means *nothing has been done, and the
doing is yours*. Same status, and the board would otherwise print the same word for
both, sending an operator to look for a diff that was never going to exist.

`render::waiting_word` is the one place that decides, so the board and the cockpit
cannot come to disagree: `yours to do` for a manual task in `needs-approval`, and the
status's own name for everything else — `failed` and `needs-input` already ask for
exactly what they want, from either doer.

The plan listing marks the row beside the post rather than in the tag column, for the
same reason the kind was left alone: `by hand` is not what the work *is*, it is who the
arrow points at. `wecode show` spells it out under the assignee, and the admission
heading says it first, so `admitted` over a task with no scope, no budget and no
acceptance reads as one thing asked for none of them rather than three things missing.

## What is not wired yet

The state is built and honoured everywhere the state is read. Three pieces of the path
around it are outside this task's write scope, and a manual task cannot be created or
signed from the command line until they land:

- **No column in the store.** `tasks` carries a kind and not a doer, so a plan read back
  out of `wecode.db` reads `Doer::Agent` for everything. Until the column and its
  migration exist, a manual task cannot survive being saved.
- **No flag that sets it.** `wecode task add` has `--kind` and nothing for the doer.
- **`wecode approve` still gates on the kind.** It asks `task.kind.needs_a_signature()`,
  which is true of a design and not of a manual chore, so the signature that is supposed
  to be the only thing that advances a manual task is refused by the one command that
  gives it. `Task::needs_a_signature` — the doer-aware answer — is what it should ask,
  and `wecode verify` already does.

Until the third lands, nothing can move a manual task out of `needs-approval`, which is
the safe direction to be broken in: work stops in front of a person rather than being
handed to an agent. The surface the brief asks for — the steps in the message, Complete
and Hold as taps — sits on top of that signature and is a separate task again.
