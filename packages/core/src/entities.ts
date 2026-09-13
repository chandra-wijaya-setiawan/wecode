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

export type ObjectiveType = "task" | "acceptance_test" | "task_test";

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
