# How work is organised, and who has to know

Two questions this answers: what development method wecode assumes, and how much of it an
orchestrator must hold in its head. They are the same question asked from either end —
everything the machinery does not enforce is something a reader has to remember.

## The method, in one table

| layer | method | why |
|---|---|---|
| within a feature | waterfall, as an SOP | there is no tacit channel between agents |
| across features | parallel, partitioned by coupling | measured 45–52% faster — *when partitioned properly* |
| a shared hub file | isolated, never parallel | one file everything touches serialises everything |
| the human gates | agile | the only feedback loop with someone who can change their mind |

## Why waterfall inside, when agile won for humans

The two most-cited multi-agent software frameworks both chose sequential phases.
[ChatDev](https://arxiv.org/html/2307.07924v5) runs requirements through to deliverable
with each phase's output as the next one's input;
[MetaGPT](https://arxiv.org/pdf/2308.00352) encodes "human-like SOPs" and credits them
with *reducing unproductive collaboration among LLM-based agents*.

That is not nostalgia, and the reason it does not contradict agile is worth stating
carefully. **Waterfall's fatal flaw for humans was information latency** — you learned at
the end. Agile fixed it with short loops, which works because humans accumulate tacit
knowledge continuously and leak it to each other informally.

Agents have neither property. They are stateless between runs, and there is no informal
channel: whatever is not in the handoff artifact does not exist. So the thing waterfall
was criticised for — heavy explicit documents between phases — is the *only* mechanism
available, and making it explicit is a strength rather than a cost.

This is why a signed design travels in the next task's envelope rather than sitting in a
directory, and why `report.md` is generated rather than narrated.

## Why parallelism must be partitioned, not merely allowed

[Co-Coder](https://arxiv.org/html/2606.00953) treats this as graph partitioning — files
as vertices, coupling weight from shared symbols as edges — and reports 45–52% lower
latency, 11–14% higher pass rates and 28–35% lower cost. The two failure modes it names
matter more than the numbers:

- **naive file-based partitioning** inflates cost ~60% for minimal quality gain, because
  concurrently generated files violate cross-file contracts
- **unstructured multi-agent** achieves the lowest latency and quality *below the
  sequential baseline*

The second is the one to keep in view. Running agents in parallel without partitioning
produces worse code than running them one at a time. wecode's admission gate refusing
two tasks that claim the same paths is not friction; it is the check that keeps
parallelism from being a downgrade.

[AgenticFlict](https://arxiv.org/html/2604.03551v1) catalogues what the failure looks
like in the wild: merge conflicts in agent-authored pull requests, at scale.

## What the research does not cost

Every benchmark runs in a throwaway container, so nobody prices a worktree. Measured
here: one in-flight Rust task held **890 MB** of `target/`, none of it shared with the
2.5 GB beside it, rebuilt from zero on every attempt. Python paid 37 MB, and only
because `~/.cache/uv` sits outside the tree.

That cost pushes toward fewer, larger branches — directly against the integration risk
the same papers warn about. It is wecode's tension to resolve, and the resolution is to
make a worktree cheap (a shared build cache, a reused slot) rather than to batch harder.

## Mechanical, or advice

Every rule above is one of two things. **Mechanical** rules are checked before the action
and an orchestrator need not know them — it cannot violate them. **Advice** lives in a
playbook, is read at planning time, and depends on someone choosing to follow it.

Mechanical today:

| rule | enforced by |
|---|---|
| two tasks claiming the same paths cannot run at once | admission, scope overlap |
| a title naming two outcomes is refused | admission — which also makes a goal singular |
| a feature needs a signed design before it | the design gate |
| a subtask finishes; the parent takes the signature | the merge gate |
| what a run may execute | the role's grant, as the harness's allow-list |
| acceptance and scope cannot move to fit the result | frozen at creation |

Advice today — the orchestrator must carry all of it:

| rule | why it is not yet a check |
|---|---|
| declare scopes as files, not crates | the gate compares globs, so it cannot tell a coarse declaration from a true collision |
| group what ships together | wecode has no notion of coupling, only of paths |
| isolate a hub file | nothing counts how many tasks touch one file |
| keep a parent under about five items | batch size is unmodelled |
| a project is one vertical slice | value is a human judgement, and probably stays advice |

**The second table is the roadmap.** Each row is prose an orchestrator has to remember,
and every row that becomes a check is one less thing to get wrong at two in the morning.
Two of them are close: a cohesion-aware partitioner would collapse the first two rows,
and counting task-touches-per-file would give the third.

The last row is different in kind. Whether a slice delivers value is not checkable, and
a gate that pretended otherwise would be the rubber-stamp risk in another costume. That
one stays advice on purpose.

## The third place: checked, but afterwards

Two categories were one too few. A rule can also be enforced by a project's **acceptance
commands**, which is neither of the above: it is a check, so nobody has to remember it,
but it runs after the budget is spent rather than before the action. It refuses the
*result*, not the plan.

That is a worse gate than admission and a better one than a paragraph, and it is the
only place available for a rule about the code rather than about the work. Admission
sees a task; it has never seen the tree.

wecode's own file-size ratchet is the worked example. `scripts/max-lines.sh` fails when
a source file grows past the number in `.max-lines`, and every kind in
`.wecode/playbook.toml` that changes code now runs it in `accept`. The rule it enforces
is the one the second table above cannot reach from the other end: **isolate a hub
file**. Counting how many tasks touch one file would name a hub after the fact; keeping
any single file from growing without bound is the pressure that stops one forming, and
it is a check a `wc -l` can carry today.

Two properties come with the position, and both are constraints rather than caveats:

- **The threshold may only follow the tree, never lead it.** Acceptance runs against the
  whole worktree while a task may write only inside its scope, so a limit under the
  tallest file fails tasks that are forbidden from fixing it. The number comes down in
  the commit that lands a split.
- **A check nothing runs is not in this category at all.** The ratchet shipped wired to
  nothing, which was the right call — turning it on before the splits it argued for
  would have failed every queued task for a debt none of them created — and it is still
  what the interval demonstrates. Within a day its test limit went from correct to five
  thousand lines clear of the largest test file, because the suite it was measured
  against was split into seven and no number followed. The line in `accept` is the whole
  difference, which is the first table's point restated: the enforcement is the rule,
  and the prose beside it is a description that may already be false.

## What this does not change

No new task kind for a sprint. A sprint is a *shape* — a parent with subtasks — not a
sort of work, and the parent's kind already carries information a `sprint` kind would
erase: `wemail-jwz` is a feature delivered in four steps. What is missing is behaviour,
not vocabulary — a parent with open subtasks should not be dispatchable, and its
acceptance should be derived from its children rather than declared twice.
