# Data model

Proposed schema for `wecode.db`, for review. Not yet implemented.

A workspace is **two files**:

```
~/.wecode/workspaces/cws/
  company.toml     hand-edited: roles, posts, users, repos, agents, templates
  wecode.db        machine-written: projects, tasks, sessions, audit
```

Configuration stays a file because you edit it, diff it and review it. The database
holds only what the program writes.

---

## Tables

```mermaid
erDiagram
    PROJECTS {
        text id PK
        text repo "name declared in company.toml"
        text objective
        text status
        int  budget_tokens "nullable"
        int  budget_wall "nullable"
    }

    TASKS {
        text id PK
        text project_id FK
        text kind "feature|bug|chore|spike|docs"
        text title
        text parent_id FK "nullable — is part of"
        text status
        text assignee "nullable — post name"
        int  budget_tokens "nullable"
        int  budget_wall "nullable"
    }

    TASK_DEPENDS_ON {
        text task_id PK,FK
        text prerequisite_id PK,FK "must finish first"
    }

    TASK_SCOPES {
        text task_id PK,FK
        text access PK "read|write"
        text glob PK
    }

    PROJECT_MEASURES {
        text project_id PK,FK
        int  seq PK "keeps author order"
        text kind "command|metric|deliverable|judged"
        text cmd "nullable"
        int  expect_status "nullable"
        text name "nullable"
        real target "nullable"
        text cmp "nullable"
        text path "nullable"
        text note "nullable"
    }

    TASK_ACCEPTANCE {
        text task_id PK,FK
        int  seq PK
        text kind "command|metric|deliverable"
        text cmd "nullable"
        int  expect_status "nullable"
        text name "nullable"
        real target "nullable"
        text cmp "nullable"
        text path "nullable"
    }

    SESSIONS {
        text id PK
        text post "name declared in company.toml"
        text agent
        text human "nullable — NULL means autonomous"
        int  opened
        int  last_seen
        int  closed "nullable — NULL while open"
    }

    AUDIT_LOG {
        int  seq PK "AUTOINCREMENT — monotonic across all writers"
        int  at
        text session_id FK
        text post
        text agent
        text human "nullable"
        text project_id "nullable"
        text task_id "nullable"
        text source "broker|supervisor|harness"
        text action
        text target
        text outcome "allow|deny|alarm|approval"
        text mode "nullable — regimented|sanctioned"
        text detail
    }

    PROJECTS  ||--o{ TASKS            : contains
    PROJECTS  ||--o{ PROJECT_MEASURES : "is done when"
    TASKS     ||--o| TASKS            : "is part of (parent_id)"
    TASKS     ||--o{ TASK_DEPENDS_ON  : "waits on"
    TASKS     ||--o{ TASK_SCOPES      : "may touch"
    TASKS     ||--o{ TASK_ACCEPTANCE  : "is done when"
    SESSIONS  ||--o{ AUDIT_LOG        : "did"
```

---

## The two task relations

This is the part worth reviewing hardest, because collapsing them is tempting and
wrong.

| | Column / table | Means | Shape |
|---|---|---|---|
| Hierarchy | `tasks.parent_id` | **is part of** | tree — at most one parent, hence a column |
| Sequence | `task_depends_on` | **must come after** | DAG — many-to-many, hence a table |

```mermaid
flowchart TB
    subgraph legend[" "]
        direction LR
        l1[A] -.->|"is part of"| l2[B]
        l3[C] ==>|"waits on"| l4[D]
    end

    layer["cache-layer"]
    struct["cache-struct"]
    evict["cache-eviction"]
    tests["cache-tests"]
    docs["docs"]
    release["release"]

    struct -.-> layer
    evict -.-> layer
    tests ==> layer
    docs ==> layer
    release ==> tests
    release ==> docs
```

Reading that diagram:

- `cache-struct` and `cache-eviction` are **parts of** `cache-layer`, and run in
  parallel. Neither waits for the other.
- A subtask is **not blocked by its parent** — `cache-struct` can start immediately;
  it is *how* `cache-layer` gets done.
- `release` waits on **two** prerequisites that are unrelated to each other. A tree
  cannot express that; one parent is not enough.
- Progress counts leaves *under* a task. `cache-tests` must not be a child of
  `cache-layer`, or finishing the tests would count as finishing part of the layer.

## Changes from the first draft

Three polymorphic columns removed, each replaced by a table named for its relation:

| Was | Now | Why |
|---|---|---|
| `task_deps(task_id, depends_on_id)` | `task_depends_on(task_id, prerequisite_id)` | direction was ambiguous; `prerequisite_id` cannot be misread |
| `scopes(owner_kind, owner_id, …)` | `task_scopes(task_id, …)` | only tasks have scopes, so `owner_kind` held no information — and a real foreign key with cascade becomes possible |
| `measures(owner_kind, owner_id, …)` | `project_measures` + `task_acceptance` | same reason, and it matches the domain: a project has *measures*, a task has *acceptance* |
| `audit` | `audit_log` | terse for a table |

Every table now has a real foreign key with `ON DELETE CASCADE`, so deleting a
project cannot leave orphaned rows.

## References the database cannot enforce

Three columns point at names declared in `company.toml`, so SQLite cannot check
them. **They must be validated in code on write**, and this is the one real cost of
keeping configuration in a file:

| Column | Points at |
|---|---|
| `projects.repo` | a `[[repos]]` name |
| `tasks.assignee` | a `[[posts]]` name |
| `sessions.post` | a `[[posts]]` name |

The alternative — repos and posts as tables — would buy referential integrity and
lose hand-editable, reviewable config. Given a role's write scope is exactly the
thing you want to review in a diff, the file wins and the check moves to code.

## Deferred

`task_executions` — one row per *run* of a task, holding the worktree path, pid,
the A2A-aligned status lifecycle, spend totals, and `attempt` as a retry counter.

Deliberately not created yet: nothing writes it until a dispatcher exists, and every
column would be a guess about code that does not exist. `user_version` migration is
already wired up, so adding it later is cheap.

Shape when it lands:

```mermaid
erDiagram
    TASKS ||--o{ TASK_EXECUTIONS : "run as"
    SESSIONS ||--o{ TASK_EXECUTIONS : "ran by"
    TASK_EXECUTIONS {
        text id PK
        text task_id FK
        text session_id FK
        int  attempt "1, 2, 3 on retry"
        text status "A2A's 8 states"
        text worktree "nullable"
        int  pid "nullable"
        int  started
        int  ended "nullable"
        int  spent_tokens
        int  spent_wall
    }
```

Note the naming: the **execution** is the entity; **attempt** is which try it is.
That also settles a three-way collision — A2A's `Task` maps to `TASK_EXECUTIONS`,
not to our `TASKS`, since A2A has no notion of planned-but-unstarted work.
