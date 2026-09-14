/** docs/design/19, the first half: the check. One pass of invariants that reads and reports
 *  and changes nothing.
 *
 *  Every function here is pure over the record. There is no filesystem, no git and no clock
 *  in this file, and there is not meant to be: a check that stats a worktree or asks the
 *  time is answering about the world, and the world is the runner's to read. The runner
 *  materialises a `Snapshot` — one plain object, no live database handle — hands it here,
 *  and gets back the entities that violate each sentence. Nothing is healed, nothing is
 *  proposed and nothing is written; that is the next slice. */

import { SCHEMA_VERSION } from "./store.js";

/** The entities a check can name. The chain project → … → task_test of docs/design/04,
 *  minus project and workspace, which no invariant here speaks about. */
export const CHECKED = [
  "release",
  "epic",
  "story",
  "requirement",
  "acceptance_criteria",
  "acceptance_test",
  "task",
  "task_test",
] as const;

export type Checked = (typeof CHECKED)[number];

/** One row, flattened. `parent_id` is whatever foreign key the entity's table carries, so
 *  the chain below is the only thing that knows which table that points at. */
export interface RecordNode {
  readonly entity: Checked;
  readonly id: number;
  readonly slug: string;
  readonly state: string;
  readonly parent_id: number | null;
  /** story only — the commit the base became when it landed, null until it lands. */
  readonly landed_sha?: string | null;
  /** acceptance_test only — the base it was last seen to fail at, null if nobody watched. */
  readonly red_at_base_sha?: string | null;
  /** task only — the role that would perform it. */
  readonly role?: string;
}

/** What the process holding the workspace is running, as its own lease claims. `buildSha`
 *  is the commit that build was made from; `behind` is how many commits the base has gained
 *  since, measured by that holder. Either may be absent — an install with no git beside it,
 *  or a holder that has not measured yet — and an absent one is a question nobody answered
 *  rather than an answer of zero. */
export interface RunnerBuild {
  readonly holder: string;
  readonly buildSha?: string;
  readonly behind?: number;
}

export interface WorkerRow {
  readonly slug: string;
  readonly role: string;
}

/** What one pass reads. Assembled by the runner from the record and passed whole, so that
 *  every function below is a pure function of its argument. */
export interface Snapshot {
  readonly nodes: readonly RecordNode[];
  readonly workers: readonly WorkerRow[];
  /** The version the record says it is at, or 0 for a file with no version row at all.
   *  Omitted by a caller that is asking only about entities, and then not checked. */
  readonly schema_version?: number;
}

/** What a check found: the invariant it broke and the one entity that broke it. */
export interface Violation {
  readonly invariant: string;
  readonly entity: string;
  readonly id: number | null;
  readonly slug: string;
  readonly detail: string;
}

/** Each parent's child entity and the state that means it succeeded.
 *
 *  A data definition, and it belongs in config: the child chain is tree.ts's walk and the
 *  success states are the non-dropped terminals of config/machines.yaml. It is a literal
 *  here because this slice may not add a config file, and it is one copy with one consumer
 *  rather than two that must agree. Moving it to config/invariants.yaml is the first thing
 *  the runner slice should do. */
export const PARENTS: Readonly<Record<string, { readonly child: Checked; readonly success: string }>> = {
  release: { child: "epic", success: "released" },
  epic: { child: "story", success: "delivered" },
  story: { child: "requirement", success: "delivered" },
  requirement: { child: "acceptance_criteria", success: "met" },
  acceptance_criteria: { child: "acceptance_test", success: "accepted" },
  acceptance_test: { child: "task", success: "passed" },
  task: { child: "task_test", success: "done" },
};

const of = (s: Snapshot, entity: Checked): readonly RecordNode[] => s.nodes.filter((n) => n.entity === entity);

const childrenOf = (s: Snapshot, parent: RecordNode): readonly RecordNode[] => {
  const child = PARENTS[parent.entity]?.child;
  return child === undefined ? [] : s.nodes.filter((n) => n.entity === child && n.parent_id === parent.id);
};

const violation = (invariant: string, node: RecordNode, detail: string): Violation => ({
  invariant,
  entity: node.entity,
  id: node.id,
  slug: node.slug,
  detail,
});

/** The branch a story's work is on. The one naming convention this file shares with the
 *  lander, and the thing the ancestry question below is asked about. */
export const storyBranch = (slug: string): string => `story/${slug}`;

/** What git says about a story's branch against the base.
 *
 *  `in` is the fact a delivered story asserts — the work is in the base, whether it got
 *  there by a land commit of its own or inside somebody else's merge. `out` and
 *  `no-branch` are the two ways of not being there. */
export type Ancestry = "in" | "out" | "no-branch";

/** Said of a story whose branch is in the base with no marker naming the commit. */
export const REACHED_INSIDE_ANOTHER_MERGE = "reached the base inside another merge";

/** Said of a story that is not in the base. Only ever of those: a story that reached the
 *  base must never be described as not having. */
export const NEVER_REACHED_THE_BASE = "delivered with no landed_sha — it never reached the base";

/** A `delivered` story has reached the base. The marker is the convenience and not the
 *  fact: it says which commit did it, and a story merged inside another story's merge has
 *  no land commit of its own to name.
 *
 *  So this half is the question, not the answer. It names every delivered story with no
 *  marker, because that is all a pure pass over the record can know, and the accusation it
 *  writes is only true of the ones git then says are not in. The runner asks git and drops
 *  the rest with `keepUnlanded`; a caller that cannot ask is reading a worst case. */
export function deliveredStoryHasLanded(s: Snapshot): readonly Violation[] {
  return of(s, "story")
    .filter((n) => n.state === "delivered" && (n.landed_sha ?? null) === null)
    .map((n) => violation("delivered_story_has_landed", n, NEVER_REACHED_THE_BASE));
}

/** The ancestry question this check wants asked, one per story it accused. */
export function landedQuestions(
  found: readonly Violation[],
): readonly { readonly violation: Violation; readonly branch: string }[] {
  return found
    .filter((v) => v.invariant === "delivered_story_has_landed" && v.id !== null)
    .map((v) => ({ violation: v, branch: storyBranch(v.slug) }));
}

/** The answers, applied: a story whose branch is in the base has reached it and is not
 *  drift. Everything else is passed through untouched, this one invariant included — the
 *  filter can only ever remove an accusation the world contradicts. */
export function keepUnlanded(
  found: readonly Violation[],
  ancestryOf: (branch: string) => Ancestry,
): readonly Violation[] {
  const reached = new Set(
    landedQuestions(found)
      .filter((q) => ancestryOf(q.branch) === "in")
      .map((q) => q.violation),
  );
  return found.filter((v) => !reached.has(v));
}

/** An `in_progress` story has work under it: a shape with nothing in it is not in progress,
 *  it is empty. */
export function storyInProgressHasARequirement(s: Snapshot): readonly Violation[] {
  return of(s, "story")
    .filter((n) => n.state === "in_progress" && childrenOf(s, n).length === 0)
    .map((n) => violation("story_in_progress_has_a_requirement", n, "in_progress with no requirement under it"));
}

/** A parent whose every child is dropped is not in a success state: everything that was
 *  going to prove it was abandoned, so the parent cannot be what its children would have
 *  made it. */
export function allChildrenDroppedIsNotSuccess(s: Snapshot): readonly Violation[] {
  return s.nodes
    .filter((n) => n.state === PARENTS[n.entity]?.success)
    .filter((n) => childrenOf(s, n).length > 0 && childrenOf(s, n).every((c) => c.state === "dropped"))
    .map((n) => violation("all_children_dropped_is_not_success", n, `${n.state} with every ${PARENTS[n.entity]?.child} dropped`));
}

/** A `ready` acceptance_test has been observed red at its base: a test nobody has seen fail
 *  may be asserting what the code already did. */
export function readyAcceptanceTestWasRedAtBase(s: Snapshot): readonly Violation[] {
  return of(s, "acceptance_test")
    .filter((n) => n.state === "ready" && (n.red_at_base_sha ?? null) === null)
    .map((n) => violation("ready_acceptance_test_was_red_at_base", n, "ready with no red run recorded at its base"));
}

/** A `ready` task has a task_test that is `ready` or `passed`: a task says how it proves
 *  itself before it runs. */
export function readyTaskHasAReadyTaskTest(s: Snapshot): readonly Violation[] {
  return of(s, "task")
    .filter((n) => n.state === "ready" && !childrenOf(s, n).some((c) => c.state === "ready" || c.state === "passed"))
    .map((n) => violation("ready_task_has_a_ready_task_test", n, "ready with no task_test ready or passed"));
}

/** Every role with ready work has at least one worker: a queue of ready tasks under a role
 *  nobody fills is how work starves while the board looks healthy. */
export function roleWithReadyWorkHasAWorker(s: Snapshot): readonly Violation[] {
  const filled = new Set(s.workers.map((w) => w.role));
  const wanted = new Set(of(s, "task").filter((n) => n.state === "ready").map((n) => n.role ?? ""));
  return [...wanted]
    .filter((role) => role !== "" && !filled.has(role))
    .map((role) => ({
      invariant: "role_with_ready_work_has_a_worker",
      entity: "role",
      id: null,
      slug: role,
      detail: "ready work is waiting on this role and it has no worker",
    }));
}

/** A criteria with a failing acceptance_test has an open task under that test: a red test
 *  with nobody working on it is a criteria that has quietly stopped being pursued. */
export function failingCriteriaHasAnOpenTask(s: Snapshot): readonly Violation[] {
  const open = (t: RecordNode): boolean =>
    childrenOf(s, t).some((k) => k.state === "planned" || k.state === "ready" || k.state === "failed");
  return of(s, "acceptance_criteria").flatMap((c) =>
    childrenOf(s, c)
      .filter((t) => t.state === "failed" && !open(t))
      .map((t) =>
        violation("failing_criteria_has_an_open_task", c, `acceptance_test ${t.slug} #${t.id} is failed and no task under it is open`),
      ),
  );
}

/** The record's schema_version is the one this build understands: every sentence above is
 *  read through this build's idea of the tables, so a file at another version is being
 *  judged by the wrong rules. */
export function schemaVersionIsUnderstood(s: Snapshot): readonly Violation[] {
  const found = s.schema_version;
  return found === undefined || found === SCHEMA_VERSION
    ? []
    : [{
        invariant: "schema_version_is_understood",
        entity: "schema_version",
        id: null,
        slug: String(found),
        detail: `the record is at ${found} and this build understands ${SCHEMA_VERSION}`,
      }];
}

/** Said of a runner whose build the base has moved past. The words are the action, because
 *  nothing here restarts anything: a runner that decides to replace itself mid-attempt is a
 *  worse problem than a stale one. */
export const A_RESTART_IS_OWED = "a restart is owed";

/** The runner's build is an ancestor of the base: the process holding this workspace is
 *  running the code that has landed.
 *
 *  Landing a fix changes nothing until the process restarts, and until this sentence
 *  existed nothing said so — the fix that keeps an agent's commits landed and the very next
 *  task still lost its work, because the runner that ran it predated the fix by twenty
 *  minutes. The count is named, not just the fact: "behind" is not something a person can
 *  weigh and "7 commits behind" is.
 *
 *  Quiet about a build that cannot say and about a holder that has not measured: this
 *  invariant accuses a runner of being old, and it may only do that on a number. */
export function runnerBuildIsCurrent(r: RunnerBuild | null): readonly Violation[] {
  if (r === null || r.behind === undefined || r.behind <= 0) return [];
  const built = r.buildSha === undefined ? "an unnamed commit" : r.buildSha.slice(0, 12);
  return [
    {
      invariant: "runner_build_is_current",
      entity: "runner",
      id: null,
      slug: r.holder,
      detail: `built from ${built}, ${r.behind} ${r.behind === 1 ? "commit" : "commits"} behind the base — ${A_RESTART_IS_OWED}`,
    },
  ];
}

/** Every invariant, in the order a person would read them. The caller runs the set; no
 *  function here knows about any other. */
export const INVARIANTS: readonly { readonly name: string; readonly check: (s: Snapshot) => readonly Violation[] }[] = [
  { name: "delivered_story_has_landed", check: deliveredStoryHasLanded },
  { name: "story_in_progress_has_a_requirement", check: storyInProgressHasARequirement },
  { name: "all_children_dropped_is_not_success", check: allChildrenDroppedIsNotSuccess },
  { name: "ready_acceptance_test_was_red_at_base", check: readyAcceptanceTestWasRedAtBase },
  { name: "role_with_ready_work_has_a_worker", check: roleWithReadyWorkHasAWorker },
  { name: "ready_task_has_a_ready_task_test", check: readyTaskHasAReadyTaskTest },
  { name: "failing_criteria_has_an_open_task", check: failingCriteriaHasAnOpenTask },
  { name: "schema_version_is_understood", check: schemaVersionIsUnderstood },
];

/** The checks about the process rather than about the record. Kept apart from `INVARIANTS`
 *  on purpose: that set is a pure function of a `Snapshot` of rows, and both doctors run it
 *  over a record they have just read and then heal what it names. Nothing here is healable
 *  — the only remedy is a person restarting a process, and this code may never do that —
 *  and the subject is not in the snapshot at all. */
export const RUNNER_INVARIANTS: readonly {
  readonly name: string;
  readonly check: (r: RunnerBuild | null) => readonly Violation[];
}[] = [{ name: "runner_build_is_current", check: runnerBuildIsCurrent }];

/** One pass over the runner of record. Null when nobody holds the workspace, and then
 *  there is nothing to say. */
export const checkRunner = (r: RunnerBuild | null): readonly Violation[] =>
  RUNNER_INVARIANTS.flatMap((i) => i.check(r));

/** One pass. Reports everything it finds and changes nothing. */
export function checkRecord(s: Snapshot): readonly Violation[] {
  return INVARIANTS.flatMap((i) => i.check(s));
}
