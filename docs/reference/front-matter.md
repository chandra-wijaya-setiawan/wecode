---
class: hand-tended
subject:
  - crates/wecode-core/src/docs.rs
---

# Document front-matter

A page declares what it governs. `wecode verify` refuses a diff that touched one of those
paths and left the page where it was.

```markdown
---
class: hand-tended
subject:
  - crates/wecode-cli/src/notify.rs
  - docs/design/notify*.md
---

# The notify hook
```

## Keys

| key | value | default |
|---|---|---|
| `subject` | globs, in the write-scope language — `[a, b]`, a lone glob, or `- ` items | none, and none means *governs nothing* |
| `class` | `generated` · `executable` · `record` · `evergreen` · `hand-tended` | `hand-tended` |

Read only at the head of the file, between a leading `---` and the next one. A `---` rule
in the prose is prose. A page with no front-matter declares nothing and is never asked
about — which is what makes coverage something that ratchets rather than a number somebody
picks, and what keeps this convention clear of `design-check.sh`, which reads a design
record's first line as its title.

## Which classes are joined

| class | joined | why not |
|---|---|---|
| `evergreen`, `hand-tended` | yes | nothing else keeps these true |
| `generated` | no | a generator's output moving is the generator's problem |
| `executable` | no | it runs, so drift already fails a gate of its own |
| `record` | no | an ADR or a merge report is history; editing one is the defect |

An unrecognised word is watched, not exempt. The exemptions are what this gate's silence
is made of, and a misspelling must not be able to buy one.

## What the gate asks

Only that the page's path is in the same diff. Not a size floor, not a similarity measure,
not a judgement about whether the edit was any good — a one-word change satisfies it. Form
is `design-check.sh`'s business and substance is an owner's signature's; what is left for a
machine is the join.

The comparison is over the branch diff and never over git history, so a run can only be
refused for coupling that run created. Nobody inherits a stale page from `master`.

## Answering a finding

Two answers, and no third:

| answer | when |
|---|---|
| edit the page | the change is one the page describes |
| narrow its `subject:` | the page never governed that path |

Narrowing is not an escape hatch — it is the page telling the truth about what it governs,
which is the thing the gate is made of. There is no waiver and no per-run override flag.

Both edits have to be inside the task's declared write scope, and scope is frozen at
creation. Until admission asks the same question at planning time, put the page in the
scope of any task that will reach its subject.

## See also

`docs/design/living-docs.md` (the classification and why staleness is a design defect),
`specs/006-docs-first/specification.md` (the contract), `wecode_core::docs` (the parser and
the join).
