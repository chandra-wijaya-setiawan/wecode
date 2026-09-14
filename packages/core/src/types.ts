/** Every entity that has a state machine. Entities without one — workspace, role, worker —
 *  are deliberately absent: a state exists only where behaviour depends on it. */
export const STATEFUL = [
  "project",
  "release",
  "epic",
  "story",
  "requirement",
  "acceptance_criteria",
  "acceptance_test",
  "task_test",
  "task",
  "assignment",
] as const;

export type StatefulEntity = (typeof STATEFUL)[number];

/** One legal move. `guard` names a check in the guard registry; `automatic` means no actor
 *  invokes it — it fires when its guard becomes true. */
export interface Transition {
  readonly verb: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly guard?: string;
  readonly automatic?: boolean;
}

export interface Machine {
  readonly states: readonly string[];
  readonly initial: string;
  readonly terminal: readonly string[];
  readonly transitions: readonly Transition[];
}

export type MachineSet = Readonly<Record<StatefulEntity, Machine>>;

/** Why an attempt ended without getting there. */
export const FAIL_REASONS = [
  "budget_exceeded",
  "timeout",
  "lost",
  "out_of_scope",
  "max_retry",
  "other",
] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

/** What a worker asked a person for. `approval` may be answered only by the operator. */
export const ASK_KINDS = ["approval", "input", "option"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** A test is run by the runner, or performed by a worker. */
export const TEST_KINDS = ["script", "judged"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

/** Where a test's script is meant to live. Spec, written once: it may name a file that does
 *  not exist yet, and it is never a reading of the filesystem — no companion flag says
 *  whether the file is there, because that answer changes with every branch. Null means the
 *  test does not say, which is every judged test and every row written before the column. */
export interface TestScript {
  readonly script_path: string | null;
}

export const WORKER_KINDS = ["agent", "human"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/** Why one row was refused, in the refuser's own words. One definition: the allocator
 *  passing a candidate over and a bulk action declining an id are the same fact. */
export interface Refusal {
  readonly id: number;
  readonly why: string;
}
