# wecode-cloud — why these ten tasks, in this order

Taken over by the chief seat on the owner's instruction, 18 Aug 2026. Filed by the
opencode session; the requirements come from the student-success (ste-p2) repo, whose
flow wecode must be able to drive:

- GitLab-hosted (`gitlab.aisingapore.net`), primary branch `develop`
- a branch is created from a GitLab issue; work lands by merge request
- CI: test → build → deploy → **cloud-test** (`pytest -m cloud` against the deployed
  AWS runtime — real AgentCore, Bedrock, S3, billed) → promote
- Terraform in layered roots under `infra/`, which is in the company's `never_touch`

## The order, and what each unblocks

1. **#224 manual-task-kind** — a task whose agent is a person (brief in its own dir;
   converged from both sessions). The MR approval and every console-only step is this.
2. **#225 task-onto-branch → #226 task-issue-link** — the GitLab shape: a worktree cut
   from a per-task ref off `develop`, and the issue reference carried on the task
   rather than encoded in its id.
3. **#227 run-deny-rules → #228 charter-exception** — safety before capability: grant
   `aws *` read verbs without the destructive ones; let one signed task touch
   `infra/**` for its lifetime without weakening the invariant for everyone.
4. **#229→#231 cloud-secrets** — credentials resolved at dispatch, injected into the
   one process, never in a worktree; refuse dispatch when the credential outlives its
   TTL mid-run. First customers: AWS creds for cloud-test, the Travelpayouts token.
5. **#232 task-teardown-hook → #233 live-acceptance-tier** — the cloud-test gate:
   spin up, test against the real thing, tear down whatever the outcome, and keep
   billed checks out of the default acceptance run.

## Not doing

- No GitLab API automation beyond the issue reference (#226): creating MRs stays with
  the operator or a granted `glab` verb, later, if wanted.
- No new provisioning tools: Terraform stays the repo's own; wecode only governs who
  may run it, with what secrets, and what must be true afterwards.
