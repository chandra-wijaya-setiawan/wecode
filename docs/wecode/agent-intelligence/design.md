# Intelligence as a seat property

Status: **proposed** — awaiting approval.

## The problem

No model is named anywhere in `company.toml`. Every agent wecode spawns inherits
whatever the operator last set with `/model`, so the most expensive variable in the
system is decided by terminal state rather than by the org chart. Two runs of the same
task on different afternoons can cost tenfold and nothing records why.

## Not a tier, and not a name

**Not junior/senior.** A senior engineer that differs only in model is two posts
sharing one role, which the chart already expresses. And seniority in a real
organisation carries wider scope and merge rights too — if the word only swaps a model
it promises more than it delivers, and if it carries authority it is a different
*role*, which is already supported. A two-tier vocabulary also cannot stretch to staff,
principal, or "the good model, once, for this".

**Not a model name.** Names churn, and a chart pinned to `claude-opus-5` rots at the
next release. What is stable is *order*: which of a harness's models is stronger than
which.

## The shape

A harness declares its catalogue, weakest first. That single line is the only thing
that needs hand-maintaining, and it is an ordering rather than a set of numbers:

```toml
[agents.claude-code]
command = "claude"
models  = ["haiku", "sonnet", "opus", "fable"]
```

The 1–10 scale is *derived* by spreading the list — four entries give 2.5, 5, 7.5, 10.
Add a fifth model or reorder, and every seat keeps meaning what it meant. Hand-written
levels per model would drift the moment a name changed; an order will not.

A seat then states how capable its occupant is:

```toml
[[posts]]
name         = "impl"
role         = "engineer"
agent        = "claude-code"
intelligence = 5

[[posts]]
name         = "architect"
role         = "designer"      # reads everything, writes docs, runs nothing
agent        = "claude-code"
intelligence = 10
```

`intelligence` sits on the **post**, beside `agent`, not on the role. A role is
enforced capability — what a seat *may do*. Intelligence is a property of *who occupies
it*, exactly like the harness name it sits next to. Putting it on the role would make
two seats with the same authority and different models impossible to express, which is
the one thing the post/role split exists for.

## Choosing the seat is the main lever, and it already works

The playbook picks a seat per subtask. So routing design work to a stronger occupant
needs no new mechanism:

```toml
[feature.design]
kind      = "design"
assign_to = "architect"
```

A design goes to the architect at 10; the build goes to `impl` at 5; a docs step could
go to a cheaper seat still. This is the case worth optimising for, and it is already
expressible the moment posts carry a level.

That leaves a task-level override — `--intelligence 7.5` — for the exception: one
unusually hard piece of work on a seat that is normally enough. It belongs on the
**task**, not on `assign`, so it freezes with acceptance and scope, appears in
`wecode show`, and survives re-assignment. An orchestrator that raises the level has
to say so where it can be seen.

## Ceilings

`max_intelligence` in `[invariants]`, alongside `max_tokens`. Charter invariants
outrank every grant, so a task cannot request past it and a post cannot be configured
past it.

**The post's number is a default, not a ceiling.** If it were both, every task would
run at the top of the scale and this would be an elaborate way to spell "always use
the best model". A task asking for more is clamped by the charter, not by the seat.

## Resolution

`task.intelligence` → the post's `intelligence` → clamped by `max_intelligence`. Then
the level maps to a model by index into the harness's `models` list, and the launch
line gets `--model <name>` the same way `{{tools}}` is substituted today.

A harness with no `models` list gets no `--model` flag and runs its own default, which
is exactly today's behaviour — so this is additive, and an unconfigured company keeps
working.

## What it makes possible

Cost stops being an accident. `spend-real` already records what a run consumed and
`budget-units` will make that number comparable; with a declared level the budget, the
spend and the model are all properties of the chart, and a seat that is too expensive
for what it does becomes visible rather than inferred.

## What it does not do

It is not a quality control. A level names which model is launched, nothing more —
whether the work is good is still the acceptance commands and the human signature.
Raising a number will not rescue a task whose acceptance cannot tell right from wrong.
