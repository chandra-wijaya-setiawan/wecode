/** The shape of each record the board reads, and the one read of them all.
 *
 *  Shapes only: the `table(...)` declarations that name the columns stay in `board.ts`, so
 *  the ask and the schema are still held against each other in one place. What is here is
 *  the type each of those declarations is parameterised by, and `Ledger` — every row the
 *  board needs, read once, so the groups, the pulse and the fold cannot disagree about
 *  what was in the record.
 *
 *  A module that is handed a `Ledger` needs no database: `walk.ts`, `panels.ts` and
 *  `pulse.ts` are all pure over it, which is why the read stays at the edge in `board.ts`
 *  rather than being taken again by each of them. */

/** An assignment nobody has finished with. One list, matched in TypeScript, rather than
 *  the four copies of the same three phase names that four SQL strings held. */
export const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];

/** A test nobody is waiting on any more — what `every_task_test_settled` reads. */
export const SETTLED: readonly string[] = ["passed", "dropped"];

export interface ProjectRow {
  id: number;
  name: string;
  state: string;
  updated_at: string;
}

export interface ReleaseRow {
  id: number;
  project_id: number;
}

export interface EpicRow {
  id: number;
  release_id: number;
  title: string;
  state: string;
  updated_at: string;
}

export interface StoryRow {
  id: number;
  epic_id: number;
  title: string;
  state: string;
  updated_at: string;
}

export interface RequirementRow {
  id: number;
  story_id: number;
}

export interface CriteriaRow {
  id: number;
  requirement_id: number;
}

export interface AcceptanceTestRow {
  id: number;
  parent_id: number;
  statement: string;
  state: string;
  red_at_base_sha: string | null;
  last_run_at: string | null;
  last_output: string | null;
}

export interface TaskTestRow {
  id: number;
  parent_id: number;
  state: string;
  last_run_at: string | null;
  last_output: string | null;
}

export interface TaskRow {
  id: number;
  acceptance_test_id: number;
  title: string;
  role: string;
  attempts: number;
  max_retry: number;
  state: string;
  updated_at: string;
}

export interface AssignmentRow {
  id: number;
  objective_type: string;
  objective_id: number;
  worker_id: number | null;
  worktree: string;
  budget: string | null;
  phase: string;
  kind: string | null;
  question: string | null;
  last_seen: string | null;
  spent: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerRow {
  id: number;
  name: string;
}

export interface RefusalRow {
  task_id: number;
  why: string;
  at: string;
  since: string;
  passes: number;
}

export interface ChoreRow {
  id: number;
  kind: string;
  project_id: number;
  target_type: string;
  target_id: number;
  state: string;
}

export interface ChoreRefusalRow {
  chore_id: number;
  why: string;
  since: string;
  passes: number;
}

export interface LandConflictRow {
  story_id: number;
  branch: string;
  reason: string;
}

/** Every row the board reads, in one read.
 *
 *  `chores`, `choreRefusals` and `landConflicts` arrive from tables a workspace may not
 *  have yet; nothing recorded reads as an empty list here, which is what the missing table
 *  already meant to every group that asked. */
export interface Ledger {
  readonly projects: readonly ProjectRow[];
  readonly releases: readonly ReleaseRow[];
  readonly epics: readonly EpicRow[];
  readonly stories: readonly StoryRow[];
  readonly requirements: readonly RequirementRow[];
  readonly criteria: readonly CriteriaRow[];
  readonly tests: readonly AcceptanceTestRow[];
  readonly taskTests: readonly TaskTestRow[];
  readonly tasks: readonly TaskRow[];
  readonly assignments: readonly AssignmentRow[];
  readonly workers: readonly WorkerRow[];
  readonly refusals: readonly RefusalRow[];
  readonly chores: readonly ChoreRow[];
  readonly choreRefusals: readonly ChoreRefusalRow[];
  readonly landConflicts: readonly LandConflictRow[];
}
