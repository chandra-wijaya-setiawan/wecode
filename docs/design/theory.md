# Theory, prior art, and open questions

Supporting material for [the concepts](../concepts.md) and [the decisions](decisions.md). Nothing here is
required to implement the system; it records where the design came from, what has
already been built elsewhere, and which claims are untested.

---

## 1. Grounding

### Viable System Model — Stafford Beer, *Brain of the Firm* (1972)

Organizational cybernetics. Any viable system has five necessary subsystems, and
**every viable system contains and is contained in viable systems**, all
structurally identical. That recursion is why `Unit` is one type used at every
scale.

| VSM | Beer's name | where it shows up |
|---|---|---|
| S1 | Operations | `Post` — the leaf where work happens |
| S2 | Coordination | Coordination |
| S3 | Control / Optimization | Control |
| S3* | Audit | Audit |
| S4 | Development / Intelligence | Intelligence |
| S5 | Policy / Valuation | Policy + the operator |

Two mechanisms taken directly:

- **Variety engineering** (Ashby's Law of Requisite Variety) — a controller must
  command variety matching what it controls. Channels attenuate upward and amplify
  downward. Applied to the operator, this is why concurrency derives from attention.
- **Algedonic signals** — an emergency channel from operations direct to policy,
  bypassing intermediate levels.

### Organizational Control Layer — arXiv [2606.04306](https://arxiv.org/pdf/2606.04306)

Governance primitives for LLM agents: roles, permissions, delegation, escalation,
audit, separation of duties. Central claim, adopted: enforce at the **execution
boundary**, not in the prompt. Prompt guardrails are circumventable by
construction; middleware validating actions before they execute is not.

### IMACS — arXiv [2607.25446](https://arxiv.org/abs/2607.25446)

Separates three concerns most frameworks entangle: who participates, how they
coordinate, and which algorithm combines outputs. Encodes Belbin roles, Mintzberg
coordination and RACI accountability as executable configuration; a
contextual-bandit meta-protocol selecting per task beat every fixed protocol.

The constraining finding: **accountability placement changes outcomes, and the
winning placement flips across model families.** Hence the org chart is
configuration, and RACI is explicit rather than implied by the tree.

### MOISE+ / JaCaMo

Multi-agent systems research built roles, groups and permissions in the 2000s.
MOISE+ decomposes an organization into **structural** (roles, groups, links),
**functional** (goals, missions) and **deontic** (permissions *and obligations*)
dimensions. In JaCaMo the specification compiles to NPL and is enforced by
organizational artifacts — enforcement in the environment, not the agent.

Two contributions:

- **Regimentation vs. enforcement.** Regimentation makes violation impossible;
  enforcement permits it and sanctions afterwards. The literature treats this as a
  tradeoff, which is why `ControlMode` splits by reversibility.
- **Obligations.** MOISE+ has obligations with deadlines. We have only permissions
  — see §3.2.

### PROSA — holonic manufacturing

A reference architecture of recursive, self-similar *holons*: order, product and
resource holons, plus staff holons supplying expertise. Self-similarity is valued
explicitly for reconfigurability. Two confirmations: its order/resource split
arrives at the project/unit distinction independently, and it demonstrates
recursion running industrial production for 25 years.

### RACI

A responsibility-assignment matrix. **R**esponsible does the work;
**A**ccountable owns the outcome and answers for it (exactly one);
**C**onsulted gives input before the decision; **I**nformed is told after. The R/A
distinction matters because they are different failure modes. Omitted in the `solo`
profile, where accountability is always the operator.

### Goal and task hierarchies

> **Superseded in part.** This section described a four-level `Intent` tree — vision,
> goal, project, task — with typed links between nodes. That was replaced by two levels
> and two relations (see [../concepts.md](../concepts.md)). The prior art below is still
> where the ideas came from; the notes say what survived.

| Source | Contributes |
|---|---|
| **KAOS** (goal-oriented requirements engineering) | AND/OR goal refinement. *Dropped* with the goal tree: a task either happens or it does not, and alternatives are a planning conversation rather than a stored edge. Its *obstacles* idea is still unused and still interesting |
| **i\* / Tropos** | means-ends refinement; actor-dependency modelling. Strong on stakeholders, weak on multi-level decomposition, which is why KAOS supplies the tree |
| **GRL** | contribution links with polarity and satisfaction levels. *Dropped*: weighted partial contribution needs calibration a two-level plan has nowhere to put |
| **HTN planning** | the **compound vs. primitive** distinction. *Survived*, and is the load-bearing one: a project cannot execute and a task can, which is why a project with no tasks is a defect |
| **OKRs** | objectives paired with measurable key results. *Survived* as a project's objective and its `Measure`s; `weight` was dropped along with sibling priority |

Two things deliberately *not* taken: KAOS obstacles (worth adding later — see §3.11)
and GRL's quantitative satisfaction propagation, which needs calibration the tree
will not have.

---

## 2. Prior art

### VSM as software

| Project | What | State |
|---|---|---|
| Project Cybersyn (Chile, 1971–73) | Beer's own implementation, managing a national economy | historical |
| [`viable-systems`](https://viable-systems.github.io/vsm-docs/) | Elixir/OTP. Full S1–S5, algedonic channel, temporal variety channel, Z3N security | v0.1.0 alpha; general-purpose, not agent-specific |
| [VSM code review](https://www.eoinhurrell.com/posts/20250306-viable-systems-ai/) | Five specialist review agents on LangGraph | S1 built; S2–S5 conceptual |
| [Autonomous AI Organisations](https://medium.com/@fearney/applying-stafford-beers-viable-system-model-to-create-the-autonomous-ai-organisation-aaaed39b37e2) | VSM as governance blueprint | conceptual |

**The pattern is the finding: everyone builds the operational layer and leaves the
regulatory layers as prose.** That is the failure mode this design is most likely
to repeat, and the reason enforcement and oversight precede Intelligence in the
build order.

### MAS infrastructure

AGR → MadKit; MOISE+ → S-MOISE+, ORA4MAS, JaCaMo; also OperA, TAEMS, and
ISLANDER/electronic institutions. **Reorganization** — dynamic adaptation of roles
and groups — is the overload response under an older name.

### LLM-era frameworks

| Framework | Roles | Enforcement |
|---|---|---|
| CrewAI | core abstraction | no gate between an agent's decision and tool execution; permissions configurable yet bypassable at runtime |
| MetaGPT / ChatDev | PM, Architect, Engineer | SOP pipeline; roles are prompt content |
| AutoGen / Semantic Kernel | partial | strongest of the group: sandboxing, identity, policy |
| Agno | teams with modes | early-stage trust layer |

None combine recursive organization, enforced capabilities and an emergency bypass.

### Position

**This is not a new organizational model. It is a mature one ported to a new
substrate.** MAS research supplies the formalism, holonic manufacturing proved the
recursion, VSM supplies the five functions and the algedonic channel. What is new
is the substrate: foreign coding-CLI subprocesses holding filesystem write access,
where enforcement points are worktrees, argv patterns and diffs rather than method
calls in a JVM.

That lowers confidence in novelty and raises it in feasibility.

### Explicitly rejected

- **SDLC role-play.** Assigning a model the role of Product Manager, then
  Architect, then Engineer is a pipeline in an org costume — the roles carry no
  authority, budget or enforcement.
- **Vague cybernetics.** VSM write-ups tend to be concrete about the S1–S5 labels
  and silent on mechanics. The alarm triggers, rollup bound and overload response
  in the shipped design are engineering, not citation.

---

## 3. Open questions

### 3.1 Does the theory transfer?

VSM was built for human organizations. Its necessary-and-sufficient claim was never
tested on systems whose operational units cost cents per action, can be cloned, and
have no memory between cycles. Recursion and channel asymmetry transfer cleanly.
Whether **Intelligence** means anything for a unit whose environment is one git
repository is unclear — it may collapse into "read the issue tracker."

### 3.2 Permissions without obligations

MOISE+ carries obligations with time constraints; we have only permissions.
Consequence: **a post that does nothing violates nothing.** There is no way to
express "the reviewer is obliged to review within 2 cycles," so idle posts and SLA
breaches are invisible. Closing it means `Obligation { mission, deadline, on_breach }`
on `Role`, and giving Audit something to check. Probably the highest-value
borrowing available.

### 3.3 The regimentation split is a guess

Reversibility is a defensible criterion and an untested one.
`Sanction::RevokeCapability` could produce a degradation spiral: a post narrowed
after one bad cycle can no longer do useful work, and is narrowed again. No
sanction model exists yet.

### 3.4 Governance bounds reach, not quality

A post with legitimate write access to `crates/auth/**` can still write a subtly
broken authentication check. Every control governs *reach*; none governs
correctness. Quality rests on key results and Audit, which are weaker instruments.
The thoroughness of the permission model must not imply safety it does not provide.

### 3.5 Weak enforcement points

`RunCommand` and `Network` are weak without containers. An allowed command that
spawns a shell escapes its pattern. Real, not theoretical.

### 3.6 No org evaluation harness

IMACS implies configurations must be re-measured per model family. That needs a
task benchmark, org variants and a scoring function. Until it exists, every org
shape here — including the default — is an untested guess.

### 3.7 Cost is unmodeled

Each level adds channels; Intelligence adds model calls. Nobody has computed the
overhead of a deep org versus flat dispatch. Depth may only pay above a project
count that never arrives.

### 3.8 Mid-flight steering barely works

A subprocess CLI that has stopped to ask a question generally cannot be resumed, so
`InputRequired` degrades to cancel-and-restart with the answer appended, losing
in-process context. Possible fix: adapters declare `resumable` and use the CLI's own
session flag. Unvalidated, and the most user-visible weakness.

### 3.9 Remote posts and scope

An `A2aAgent` returns patches rather than editing a worktree, so scope checks run
after applying a patch. The strongest guardrail behaves differently depending on
occupant kind — the kind of asymmetry that causes bugs later.

### 3.10 Does `viable-systems` make this redundant?

It already implements S1–S5 with an algedonic channel in Elixir. Whether to target
it, port from it, or ignore it depends on how much of its alpha status is nominal.
Worth a day's investigation before building depth >1.

### 3.11 Plans rot, and nothing gardens them

Largely defused by dropping the goal tree: with two levels there is no elaborate
structure to look healthy while meaning nothing. What still rots is smaller and real —
finished projects accumulate, dropped tasks stay in the tree, and a playbook drifts from
the code it describes with nothing to notice.

Archiving handles the first deliberately. The other two are unaddressed: nothing detects
a playbook whose acceptance commands no longer exist, and dropped tasks are visible
forever because task-level archiving was judged not yet worth its cost.

KAOS *obstacles* would still give blockers first-class status — refinable, with their
own mitigation subtrees — instead of a flat failure. Worth revisiting once real usage
shows what actually blocks work.

### 3.12 Classification is a model call on the critical path

An orchestrator proposes `kind`, `parent` and `--after` when it decomposes a request,
and a plausible-looking wrong one is easy to accept. The damage is smaller than it was
under a deep tree — a wrong `parent` now means sharing the wrong worktree, and a wrong
`--after` means starting too early or too late — but nothing detects either.

Playbook guidance is the only mitigation, and it is advice: it shapes what gets
proposed without checking what was. The admission gate catches structural mistakes —
cycles, overlaps, missing acceptance — and is silent on a task that is well-formed and
attached to the wrong thing.
