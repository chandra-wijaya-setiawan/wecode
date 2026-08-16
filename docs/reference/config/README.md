# Configuration

Two hand-edited files. Everything else is in `wecode.db`, which no one edits by hand.

| file | scope | describes |
|---|---|---|
| `company.toml` | the workspace | who exists, what they may do, what outranks them |
| `.wecode/playbook.toml` | one repository | how work is broken down *here* |

The split is deliberate. The company is one thing; a project is a codebase with its own
conventions, and its guidance is versioned with the code it describes.

A third file, `gaps.toml`, sits in the workspace and belongs to neither category
cleanly: it is written by machine and emptied by hand. It is guidance's inbox — see
[playbook.md](playbook.md#gapstoml).

## One page per thing configured

| page | the keys | what it decides |
|---|---|---|
| **[company.md](company.md)** | `[company]` … `[agents.*]` | who exists, what they may do, what outranks them, and which model a seat gets |
| **[notify.md](notify.md)** | `[notify]` | what runs when a task starts waiting on a person |
| **[telegram.md](telegram.md)** | `[telegram]` | how the answer gets back — a reply, or a tapped button |
| **[envelope.md](envelope.md)** | `[templates]` | the prompt a worker receives |
| **[playbook.md](playbook.md)** | `.wecode/playbook.toml`, `gaps.toml` | how work of each kind is broken down, dispatched, and cached |

`[notify]` and `[telegram]` are `company.toml` blocks like the rest, and they are the
two that have their own pages rather than a subheading on the company's. What they
describe between them is a round trip — wecode reaching the operator, and the operator
answering from wherever it found them — and that is a different question from the org
chart it is sent on behalf of. Reading either half without the other leaves a loop that
only goes one way: a notification nobody can answer, or a reply channel nothing speaks
into.

`envelope.md` is split out for the mirror of that reason. `templates.task_envelope` is
one key in `company.toml`, but what it configures is what a *worker* is told, where
everything else on the company page configures what a **person** may do.

## Where things live

```
~/.wecode/
  current                        the default org, set by `wecode use`
  workspaces/<org>/
    company.toml
    wecode.db
  run/<org>/<task>/              worktrees — outside the repo and the workspace
```

Worktrees sit outside both on purpose, so a glob rooted at a worktree cannot sweep up
the file that defines the worker's own grants. Note this is hygiene rather than a
boundary: `run/` and `workspaces/` are siblings, so traversal still reaches it, and what
actually refuses the write is the Broker.

`$WECODE_CONFIG` relocates all of it, which is how the test suite stays isolated.
