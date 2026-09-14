/** docs/design/19, the first half: the check. One pass of invariants that reads and reports
 *  and changes nothing.
 *
 *  Every function here is pure over the record. There is no filesystem, no git and no clock
 *  in this file, and there is not meant to be: a check that stats a worktree or asks the
 *  time is answering about the world, and the world is the runner's to read. The runner
 *  materialises a `Snapshot` — one plain object, no live database handle — hands it here,
 *  and gets back the entities that violate each sentence. Nothing is healed, nothing is
 *  proposed and nothing is written; that is the next slice. */

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

export interface WorkerRow {
  readonly slug: string;
  readonly role: string;
}

/** What one pass reads. Assembled by the runner from the record and passed whole, so that
 *  every function below is a pure function of its argument. */
export interface Snapshot {
  readonly nodes: readonly RecordNode[];
  readonly workers: readonly WorkerRow[];
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

/** A `delivered` story has a landed marker: delivered says the work is in the base, and
 *  without a sha nothing says it ever got there. */
export function deliveredStoryHasLanded(s: Snapshot): readonly Violation[] {
  return of(s, "story")
    .filter((n) => n.state === "delivered" && (n.landed_sha ?? null) === null)
    .map((n) => violation("delivered_story_has_landed", n, "delivered with no landed_sha — it never reached the base"));
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

/** Every invariant, in the order a person would read them. The caller runs the set; no
 *  function here knows about any other. */
export const INVARIANTS: readonly { readonly name: string; readonly check: (s: Snapshot) => readonly Violation[] }[] = [
  { name: "delivered_story_has_landed", check: deliveredStoryHasLanded },
  { name: "story_in_progress_has_a_requirement", check: storyInProgressHasARequirement },
  { name: "all_children_dropped_is_not_success", check: allChildrenDroppedIsNotSuccess },
  { name: "ready_acceptance_test_was_red_at_base", check: readyAcceptanceTestWasRedAtBase },
  { name: "role_with_ready_work_has_a_worker", check: roleWithReadyWorkHasAWorker },
  { name: "ready_task_has_a_ready_task_test", check: readyTaskHasAReadyTaskTest },
];

/** One pass. Reports everything it finds and changes nothing. */
export function checkRecord(s: Snapshot): readonly Violation[] {
  return INVARIANTS.flatMap((i) => i.check(s));
}
