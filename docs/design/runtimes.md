# The three runtimes — decouple the seams now, keep one machine for now

The owner's direction (30 Aug): today the agent CLI, the dev environment and
the repo all live on one machine in different worktrees. That stays the
default. What must exist EARLY is the seam between three concerns, so that
moving any one of them off-machine later is a provider swap, not a rewrite.

| Seat | Concern | Today | The seam | Later providers |
|---|---|---|---|---|
| agent runtime | where the coding agent process runs | local `claude -p` / `codex exec` child | the A2A task envelope + harness-contract (queued) — already protocol-shaped | omnigent runner, remote pod |
| devbox runtime | where the worktree/toolchain lives | local git worktree | worktree operations behind a DevboxProvider (create, mount repo, exec, snapshot, destroy) | docker/podman pod, WSL distro, k8s |
| sandbox runtime | where acceptance/execution is isolated | same worktree (no isolation) | SandboxProvider (project wecode-sandbox, P0) | docker, e2b, cube |

Why the decoupling is load-bearing, in the owner's words: the agent is a
developer, and a developer HAS machines. When a machine breaks, wecode holds
the task — journal, scopes, budgets, attempt history — so recovery is
"spin up a devbox and resume", not "start over". That requires the state
machine to be durable and machine-independent: exactly what
rel-transition-journal (unit 001, design signed) persists. Runs are never
ephemeral state in a process's head; the db is the event bus and the truth.

## Omnigent as reference and candidate

Omnigent (Databricks OSS) is the same split: server (sessions, policies,
skills) + runners (laptop → devbox → k8s pod → cloud sandbox) over one API.
Two honest readings:
- **Reference**: its server/runner boundary validates this document's seams.
- **Candidate provider**: wecode stays the control plane (tasks, gates,
  ledger — omnigent has none of these); omnigent could serve as the AGENT
  RUNTIME layer, one dialect of harness-contract, giving remote placement
  and phone/browser session continuity without wecode building any of it.
Boundary check passes: consuming omnigent keeps wecode a control plane;
building our own runner fleet would not.

## Prototype order (small, local-first)
1. Land P0 reliability (journal, lease, recover) — the durable state the
   whole idea rests on.
2. SandboxProvider with LocalProcess + Docker/Podman providers (wecode-sandbox).
3. Point the same trait shape at a devbox: worktree-in-a-pod on this machine.
4. Evaluate omnigent as an agent-runtime dialect behind harness-contract.
