# 013 — A project can be excluded from the agent runner

**Task:** TBD · **Branch:** `wecode/013-exclude-from-agent-runner` · **Target:** `main`

Execution state is tracked in `report_as_finished.md`. This document is the contract.

## 1. Requirement summary

`wecode loop` dispatches every `ready` task in every project. There is no way to say *leave
this project alone* — so a project being worked in a session has its tasks taken by the runner
underneath whoever is working them.

That happened on the STETSS lakehouse. The board was being driven interactively, tasks marked
`ready` as their predecessors landed; the runner took each one and it failed. Seven dispatches,
439,676 tokens, none reaching the work. Setting a task back to `ready` bought another identical
failure, because `ready` is the only word wecode has for both *someone will pick this up* and
*the runner may take this*.

**One field on the project: `exclude_from_agent_runner`.** Set, the runner skips the project.
Its tasks stay `ready`, visible and dispatchable by hand.

The name is deliberately negative. It says what it stops and claims nothing about who does the
work instead — which matters, because the obvious alternative does not survive contact with the
charter: `chief` is the post an interactive session occupies, and the charter says of that role
*"deliberately unable to do the work: an agent that can both set the criteria and satisfy them
is not governed."* A field naming `chief` as the driver would assert something the charter
forbids. Attribution is already solved: `wecode cost` records work the runner never dispatched,
and every view marks it as stated rather than metered.

## 2. Architecture

TBD — a column on the project record, a filter in the runner, a marker in the views.

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-13-01 | project record | A project records `exclude_from_agent_runner`, a boolean, defaulting to false. |
| FR-13-02 | project add / edit | Settable at creation and afterwards. Which projects a session is driving changes week to week. |
| FR-13-03 | runner | `wecode loop` skips every task in an excluded project, and names the projects it skipped on each tick rather than passing over them silently. |
| FR-13-04 | run | `wecode run <task>` still works on an excluded project. The point is to stop the runner reaching for work unasked, not to stop a person dispatching deliberately. |
| FR-13-05 | views | `wecode show` and the board mark an excluded project, so a screen full of `ready` does not imply a screen full of *about to be taken*. |
| FR-13-06 | runner | Setting it does not interrupt tasks already running. It governs what is taken next. |

**Non-functional**

| ID | Component | Requirement |
|---|---|---|
| NFR-13-COST-01 | runner | An excluded project costs no agent tokens unless a person dispatches into it. |
| NFR-13-SAFE-01 | runner | Default false, so no existing project changes behaviour on upgrade. |

## 4. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | The granularity is the project | If one project needs both — some tasks the runner's, some a session's — this wants a task-level exclusion too. `--by person` is the near neighbour and is a different question: whether an agent *can* do the work, not whether the runner should reach for it |
| A2 | A session driving a project wants all of it | If not, `wecode run` per task already covers the exception |

## 5. Why this is separate from 012

`012` is a dispatch that should have worked and did not — the task landed in a tree where its
acceptance path did not exist. This is a dispatch that should not have happened at all, because
someone was already working the project. Both cost tokens the same afternoon, and neither fix
substitutes for the other: one validates *where* an agent works, this decides *whether the
runner reaches for the work*.

Raised by Chandra, who wanted STETSS driven from a session while other projects keep running on
subagents.
