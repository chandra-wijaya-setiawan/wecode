# wecode documentation

Four kinds of page, and it is worth knowing which you want.

| | | |
|---|---|---|
| **[concepts.md](concepts.md)** | what the pieces are | a project, a task, a post, a grant |
| **[lifecycle.md](lifecycle.md)** | how work moves | draft → merged, and who moves it |
| **[features.md](features.md)** | what is built | the honest inventory, including the gaps |
| **[../plan.md](../plan.md)** | what is next | the roadmap |

Then, by task:

- **[guides/getting-started.md](guides/getting-started.md)** — set up a company and run something
- **[guides/playbooks.md](guides/playbooks.md)** — teach a project how its work is broken down
- **[reference/commands.md](reference/commands.md)** — the CLI surface
- **[reference/config/](reference/config/README.md)** — `company.toml` and `.wecode/playbook.toml`, one page per thing configured
- **[reference/schema.md](reference/schema.md)** — what is in `wecode.db`
- **[design/decisions.md](design/decisions.md)** — why it is like this
- **[design/method.md](design/method.md)** — the development method, and which of its rules the machinery enforces rather than an orchestrator remembering
- **[design/theory.md](design/theory.md)** — prior art, and the open questions

## How these are maintained

Every page describes **what exists**, not what is planned. Anything not built yet
belongs in [plan.md](../plan.md), and anything built but weak belongs in the *gaps*
section of [features.md](features.md) — stated plainly, where a reader will find it.

That rule exists because the previous `architecture.md` grew into a mix of the two and
became untrustworthy: it described a four-level hierarchy that had been replaced, an
async runtime that was never added, and an event log that SQLite had superseded. A
reader could not tell which parts still applied. It was deleted rather than corrected.

The reasoning behind a change lives in its **commit message**, which is where it stays
true. `design/decisions.md` keeps only the arguments that a reader still needs in order
to use the system correctly.
