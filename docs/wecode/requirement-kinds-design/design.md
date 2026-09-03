# A requirement's class is a segment of its handle

Decided: the classification stays in the handle, and the handle gains a segment —
`checkout/NFR-SEC-1`. Not a column, not a second ledger row, not a tag. The vocabulary
is ISO/IEC 25010's quality characteristics, closed, and it lives in `wecode-core`.

## What is recorded today, and what is not

A requirement is not a table. ADR-0005 sketched one; the amendment refused it, and
`schema.rs` says so at the `requirement_id` column: three of the five fields ADR-0005
wanted are already what a ledger row is. So an obligation is a `require` row folded into
`Requirement`, and its class is recovered from its own id:

```rust
pub fn kind(&self) -> ReqKind {
    if self.id.contains("/NFR-") { NonFunctional } else { Functional }
}
```

That is sound, but only because `TaskId` slugifies `/` away — a story id cannot contain
the separator, so a substring search cannot collide with one. The argument for putting
it there in the first place is in `audit.rs` and is still right: the id travels, into a
brief, a merge report, a Telegram message, and a column would say which it is in the one
place that reads the column.

The half that is missing is *which* non-functional. `docs/design/sdlc.md` has carried the
gap in writing since 24 August — "quality model (NFR taxonomy) · ISO/IEC 25010 · NFR rows
in specs, **ad hoc naming**" — and the tree has been filling it by hand ever since:

| in the tree today | what it means | trouble |
|---|---|---|
| `NFR-04-PER-01`, `NFR-11-PERF-01` | performance | two spellings of one characteristic |
| `NFR-11-SEC-01`, `NFR-11-SAF-01`, `NFR-11-REL-01`, `NFR-10-MNT-01` | 25010, correctly | nothing checks them |
| `NFR-07-CI-01`, `NFR-07-MIG-01`, `NFR-12-COST-01`, `NFR-12-DOC-01` | invented | not characteristics at all |
| `NFR-11-OBS-01` | observability | not a 25010 characteristic either |

Twelve codes, one taxonomy, no enforcement, and none of it reaches the store: every one
of those obligations is `NonFunctional` and nothing more the moment wecode records it.
"Which security obligations does this project owe?" has no answer, which is the same
shape of hole ADR-0005 was written to close for "which tasks served this requirement?".

## The decision

    <story>/FR-<n>                 a functional obligation
    <story>/NFR-<QUALITY>-<n>      a quality obligation, and which quality

Minted per story and per class, so `checkout/NFR-SEC-1` is that story's first security
obligation whatever else has been written since — the rule `declare_requirement` already
follows one axis down.

| code | ISO/IEC 25010 characteristic |
|---|---|
| `PERF` | Performance efficiency |
| `COMPAT` | Compatibility |
| `INTER` | Interaction capability (Usability, in the 2011 edition) |
| `REL` | Reliability |
| `SEC` | Security |
| `MNT` | Maintainability |
| `FLEX` | Flexibility (Portability, in the 2011 edition) |
| `SAF` | Safety (added in the 2023 revision) |

Eight, not nine. Functional suitability is left out on purpose: an FR *is* the
functional-suitability statement, and offering `NFR-FIT-1` would let one obligation be
written on either axis, which is a classification that classifies nothing. An FR
therefore takes no class segment and never grows one.

## What it was decided against

| instead | why it loses |
|---|---|
| a `class` column | there is no table to put it on, and inventing one reverses ADR-0005's amendment for a single field |
| the ledger row's spare `mode` column | it would be right if the class were an event; it is part of the obligation's identity, and the id would still travel meaning nothing |
| a second `classify` row beside `require` | two answers to one question, and the reader who has only the handle gets the worse one |
| free text — `--nfr "performance"` | four spellings of latency inside a month; the tree already proves this with `PER` and `PERF` |
| derived from the wording by a classifier | a classification that changes when the classifier changes is not a record |
| a per-repo vocabulary in `.wecode/playbook.toml` | two repos would classify one obligation differently and the ledgers stop comparing |

The last one is the only close call, because this repo's standing rule is that
enumerations are configuration. That rule is about *who may change a thing*, and the
answer here is nobody: the list changes when ISO revises it, not when an operator
decides. A closed vocabulary in code is the honest reading of the rule, not an exception
to it. What genuinely is per-repo — which characteristics a project bothers to state —
is answered by the requirements it writes, not by a list it has to maintain first.

## Where the vocabulary lives

`ReqKind` sits in `wecode-store::audit` today, so the CLI imports a persistence crate to
name a domain concept. The class vocabulary joins it there only if we are content that
the admission gate cannot see it — and `core` cannot depend on `store`, so the direction
is decided for us by the crate order the playbook sets out.

Move both to `wecode-core`, in `requirement.rs`, beside `check_requirement`. It is a pure
type with no dependencies, which is exactly what that crate is for, and one definition
read by the gate and the command beats a vocabulary enforced by whichever caller
remembers to. `requirement.rs` is 70 lines and was split out of `admission.rs` at the
ratchet for this reason; this is the concept it was split out to hold.

Parsing belongs in the same file and nowhere else. `Requirement::kind()` stops being a
substring search and becomes a parse of `<story>/<CLASS>-<n>` — the story is everything
before the single `/`, which slugification guarantees, and the class is everything before
the last `-`.

## The codes already in the tree

Every one maps, which is the check that the vocabulary is big enough:

| in `specs/` | becomes | note |
|---|---|---|
| `PER`, `PERF` | `PERF` | the drift this ends |
| `SEC`, `SAF`, `REL`, `MNT` | unchanged | already 25010 |
| `COST` | `PERF` | wasted agent tokens is resource utilisation |
| `DOC` | `INTER` | help text is the operator's interface |
| `CI`, `INTEG` | `REL` | a gate that refuses a bad write is fault tolerance |
| `MIG` | `FLEX` | importing without loss is adaptability |
| `OBS` | `MNT` | analysability — the closest true home, and not a perfect one |

`OBS` is the one that grates. Observability is a characteristic in every practitioner
taxonomy and in none of 25010's, so it lands under maintainability's analysability
sub-characteristic and reads slightly wrong. That is the price of a closed vocabulary and
it is worth paying: an open one has no PER/PERF answer at all.

## Old handles, and how the class becomes required

The ledger is append-only and the rows never change, so `reply-story/NFR-1` stays valid
and stays readable. The parse accepts three shapes — `FR-<n>`, `NFR-<n>`, and
`NFR-<CLASS>-<n>` — and an NFR with no class segment reads as unclassified rather than as
an error.

At the surface, `--nfr` takes a value: `--nfr sec`. Bare `--nfr` still mints
`NFR-<n>` and prints a note saying the obligation has no quality named. A note is never a
refusal — that is already the rule this repo states about playbook fills, and it is what
lets the change land without failing work in flight.

The note becomes a refusal when the tree holds no unclassified NFR, in the commit that
classifies the last one and not before it. That is `.max-lines`' rule and
`design-check.sh`'s: the floor follows the tree rather than leading it, because a gate
raised in front of the work fails tasks that are not allowed to fix what fails them.

## What this makes harder

**Reclassification.** A wrongly-classed obligation cannot be corrected in place, because
the handle *is* the record and the tasks pointing at it point at the old string. The
remedy is to restate it under the right class and drop the old one — and `dropped`, the
third state ADR-0005 names, is not reachable: nothing can drop a requirement yet.
So this decision takes a dependency on that gap, and until it closes a misclassified
obligation stays visible and wrong. The `classify` row rejected above is the shape that
would have avoided this, which is the honest reason to record it here rather than in a
list of things that were never considered.

**Longer handles.** `checkout/NFR-SEC-1` is what an operator types on a serving task.
Mitigated by never asking anyone to invent one — the handle is minted, printed back by
`wecode check`, and copied.

## The room it has to land in

The build this hands off is small, and three of the files it touches are not:

| file | lines | cap | headroom |
|---|---|---|---|
| `crates/wecode-store/src/plan.rs` | 1683 | 1700 | 17 |
| `crates/wecode-core/src/admission.rs` | 1679 | 1700 | 21 |
| `crates/wecode-store/src/audit.rs` | 1140 | 1700 | 560 |
| `crates/wecode-core/src/requirement.rs` | 70 | 1700 | ample |
| `crates/wecode-cli/tests/requirements.rs` | 124 | 1500 | ample |

The vocabulary and the parse go to `requirement.rs`, the minting stays in `audit.rs`, and
the tests go to `requirements.rs` rather than `tests/plan.rs` where the single existing
`--nfr` assertion sits. Acceptance reads the whole worktree, so a build task that grows
`store/plan.rs` by twenty lines fails on a file it had no business in.

## What would show this was decided wrong

Two things, both readable in a few months rather than argued now.

If nothing ever asks a question the class answers — no board line, no report, no query by
characteristic — then the segment bought a longer handle and nothing else, and bare
`NFR-<n>` with the note was the right ceiling.

If obligations routinely want two characteristics at once, a single segment is the wrong
cardinality. One or two straddlers is normal and the writer picks the dominant one; a
steady stream of them means the class is a set, a set does not go in an id, and the
`classify` row wins after all.
