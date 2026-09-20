import type { AskKind, FailReason, TestKind, WorkerKind } from "./types.js";

/** Files a worker may change and tools it may run. A role's scope is a ceiling; a task may
 *  narrow it and never exceed it. */
export interface Scope {
  readonly write: readonly string[];
  readonly tools: readonly string[];
}

export interface Budget {
  readonly tokens: number;
  readonly seconds: number;
}

interface Row {
  readonly id: number;
  readonly slug: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface Stateful extends Row {
  readonly state: string;
}

export interface Workspace extends Row {
  readonly name: string;
  readonly path: string;
}

export interface Project extends Stateful {
  readonly workspace_id: number;
  readonly name: string;
  readonly repo: string;
  readonly objective: string;
}

export interface Release extends Stateful {
  readonly project_id: number;
  readonly version: string;
  readonly released_at: string | null;
}

export interface Epic extends Stateful {
  readonly release_id: number;
  readonly title: string;
}

export interface Story extends Stateful {
  readonly epic_id: number;
  readonly title: string;
}

export interface Requirement extends Stateful {
  readonly story_id: number;
  readonly statement: string;
}

export interface AcceptanceCriteria extends Stateful {
  readonly requirement_id: number;
  readonly statement: string;
}

/** acceptance_test hangs off an acceptance_criteria; task_test off a task. Same shape,
 *  same states, different parent — which is why they share one interface. */
export interface Test extends Stateful {
  readonly parent_id: number;
  readonly statement: string;
  readonly kind: TestKind;
  readonly artefact: string | null;
  readonly last_run_at: string | null;
  readonly last_output: string | null;
}

export interface Task extends Stateful {
  readonly acceptance_test_id: number;
  readonly title: string;
  readonly scope: Scope;
  readonly role: string;
  readonly budget: Budget;
  readonly attempts: number;
  readonly max_retry: number;
}

/** A story is here with the three work kinds because a decision is most often about a story:
 *  "do we ship this at all" hangs on the story, not on whichever task happened to surface it,
 *  and an approval hung on a task is answered against words nobody chose for the question. */
export type ObjectiveType = "task" | "acceptance_test" | "task_test" | "story";

/** Written when the assignment is created, and never rewritten. The scope is copied rather
 *  than referenced, so editing a task's scope cannot widen an attempt already running. */
export interface AssignmentSpec {
  readonly objective_type: ObjectiveType;
  readonly objective_id: number;
  readonly worker_id: number;
  readonly scope: Scope;
  readonly budget: Budget;
  readonly worktree: string;
}

/** Overwritten by the runner on every tick. */
export interface AssignmentStatus {
  readonly phase: "pending" | "running" | "waiting" | "succeeded" | "failed";
  readonly reason: FailReason | null;
  readonly kind: AskKind | null;
  readonly question: string | null;
  readonly options: readonly string[] | null;
  readonly answer: string | null;
  readonly answered_by: string | null;
  readonly session: string | null;
  readonly last_seen: string | null;
  readonly spent: Budget;
  readonly commit: string | null;
}

export interface Assignment extends Row {
  readonly spec: AssignmentSpec;
  readonly status: AssignmentStatus;
}

export interface Role extends Row {
  readonly name: string;
  readonly scope: Scope;
  readonly worker_kind: WorkerKind;
  readonly harness: string | null;
}

export interface Worker extends Row {
  readonly name: string;
  readonly role: string;
  readonly kind: WorkerKind;
}

/** The fields one interface declares, as a value. An interface is erased at run time, so
 *  without this nothing can compare a row shape against `pragma_table_info`.
 *
 *  The compiler holds the list to the interface: `Record<keyof T, true>` rejects a missing
 *  field and the excess property check rejects a stray one, so a field added above without
 *  a line here fails `pnpm typecheck`. What the compiler cannot see is the schema, and that
 *  is what schema-shapes.test.ts proves. */
const fields =
  <T>() =>
  (declared: Record<keyof T, true>): readonly string[] =>
    Object.keys(declared);

/** The field a column is named by, where the two differ. `commit` is a keyword in too many
 *  dialects to be a column name, so the column is `commit_sha`. */
export const COLUMN_OF: Readonly<Record<string, string>> = { commit: "commit_sha" };

/** Which table each row interface is the shape of. `acceptance_test` and `task_test` are
 *  both `Test`, which is the one place two tables share an interface. */
export const ROW_FIELDS: Readonly<Record<string, readonly string[]>> = {
  workspace: fields<Workspace>()({ id: true, slug: true, created_at: true, updated_at: true, name: true, path: true }),
  project: fields<Project>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, workspace_id: true, name: true, repo: true, objective: true }),
  release: fields<Release>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, project_id: true, version: true, released_at: true }),
  epic: fields<Epic>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, release_id: true, title: true }),
  story: fields<Story>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, epic_id: true, title: true }),
  requirement: fields<Requirement>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, story_id: true, statement: true }),
  acceptance_criteria: fields<AcceptanceCriteria>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, requirement_id: true, statement: true }),
  acceptance_test: fields<Test>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, parent_id: true, statement: true, kind: true, artefact: true, last_run_at: true, last_output: true }),
  task_test: fields<Test>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, parent_id: true, statement: true, kind: true, artefact: true, last_run_at: true, last_output: true }),
  task: fields<Task>()({ id: true, slug: true, created_at: true, updated_at: true, state: true, acceptance_test_id: true, title: true, scope: true, role: true, budget: true, attempts: true, max_retry: true }),
  role: fields<Role>()({ id: true, slug: true, created_at: true, updated_at: true, name: true, scope: true, worker_kind: true, harness: true }),
  worker: fields<Worker>()({ id: true, slug: true, created_at: true, updated_at: true, name: true, role: true, kind: true }),
  // One row, read as two nested objects: the spec written once and the status the runner
  // overwrites. The columns are the union, flattened.
  assignment: [
    ...fields<Omit<Assignment, "spec" | "status">>()({ id: true, slug: true, created_at: true, updated_at: true }),
    ...fields<AssignmentSpec>()({ objective_type: true, objective_id: true, worker_id: true, scope: true, budget: true, worktree: true }),
    ...fields<AssignmentStatus>()({ phase: true, reason: true, kind: true, question: true, options: true, answer: true, answered_by: true, session: true, last_seen: true, spent: true, commit: true }),
  ],
};
