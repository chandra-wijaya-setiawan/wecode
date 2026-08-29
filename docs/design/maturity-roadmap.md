# Maturity roadmap — from engine to product (29 Aug 2026)

The owner's direction, distilled: reliability before intelligence. wecode's
orchestration core is sound; the work is making it installable, unstickable,
and observable before making it smarter. Center stays fixed:
**wecode = control plane for autonomous software-development projects.**
It consumes sandboxes, LLMs, CI and Git hosting; it becomes none of them.

## Priorities

| P | Area | Needed | Already standing |
|---|------|--------|------------------|
| P0 | Reliability | persist state BEFORE side effects; restart reconstructs, reclaims dead workers, resumes | state machine + stalled detection + verify-on-commit recovery |
| P0 | Isolation | SandboxProvider trait (create/exec/read/write/snapshot/destroy); Local + Docker providers first | worktrees (fs isolation only) |
| P0 | Installation | docker run / curl install + `wecode init` detection flow | `wecode doctor`, `wecode init` templates |
| P1 | UX | web dashboard: DAG, per-task drill (diff/logs/cost/retry/approve) | tui + board |
| P1 | Integrations | issue→tasks→PR→merge→issue-closed loop, GitHub + GitLab | --onto branches, issue links, MR flow proven on ste-p2 |
| P1 | Observability | per-task timeline, project metrics (cost, success %, retry %, human %) | ledger + audit hold the events; nothing renders them |
| P2 | Scale | distributed workers | — |
| P2 | Intelligence | PM agent: observes, proposes replans into the deterministic gate; never executes | — |
| P2 | Ecosystem | adapter SDK | harness-contract (queued) is its seed |

## SDLC hardening (the classical chapters still missing)

decisions/ADR and measurement have queued projects (wecode-decisions,
wecode-findings). Risk register and spec→code→test traceability have nothing
and are the next admissions once record-mode lands. A merge signature without
a checklist is approval, not review — the review post needs a checklist the
signature attests to.
