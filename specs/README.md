# specs/ — one folder per work unit

Adapted from the wt-53 delivery model. Every main task is a work unit that delivers
something, and it carries two documents in `specs/<number>-<task>/`:

| File | What it is | Changes when |
|---|---|---|
| `specification.md` | the **contract** — requirements, ACs, design, decisions | scope changes |
| `report_as_finished.md` | **execution state** — built, proven, outstanding | every checkpoint |

Kept apart on purpose: a contract that carries status churns with progress and stops
being a stable thing to review against. The spec step of a wecode task writes the
first from `_TEMPLATE-specification.md`; the report step writes the second and must
generate its numbers from `git diff --numstat`, never by hand.
