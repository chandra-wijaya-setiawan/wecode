import type { AskKind, Budget, FailReason, Scope } from "@wecode/core";

/** What the last attempt at this task left behind.
 *
 *  A retry gets a new session with no memory, which is deliberate — but the branch is not
 *  new: a rejected attempt still commits, so its work is already here. This is the part of
 *  it the record knows, so the retry can read the commit instead of rediscovering it. */
export interface History {
  /** Attempts already made. One or more, or there is no history to carry. */
  readonly attempts: number;
  /** Why the previous assignment ended as it did, when it ended badly. */
  readonly reason: FailReason | null;
  /** What that attempt committed, and what this branch therefore already holds. */
  readonly commit: string | null;
  /** One per task_test still failing: what it asks for, and the last thing it said. */
  readonly failures: readonly TestFailure[];
}

export interface TestFailure {
  readonly statement: string;
  /** The last non-empty line of the test's output — the wall, without the run. */
  readonly line: string;
}

/** What the foreman hands an adapter: the assignment's spec, and its id. */
export interface Work {
  readonly id: number;
  readonly objective_type: "task" | "acceptance_test" | "task_test";
  readonly objective_id: number;
  readonly instruction: string;
  readonly scope: Scope;
  readonly budget: Budget;
  readonly worktree: string;
  /** Set when a killed attempt is being continued rather than restarted. */
  readonly session: string | null;
  /** What earlier attempts on this project learned, newest first and capped at ten. Absent
   *  when the project has none — an empty heading teaches the next agent nothing and costs
   *  it the attention the real lines need. See docs/design/17. */
  readonly lessons?: readonly string[];
  /** Null on a first attempt: it gets exactly the prompt it would have got anyway. */
  readonly history: History | null;
}

/** What an adapter saw. Nothing here is a decision — the foreman turns it into a verb. */
export type Observation =
  | { readonly phase: "running"; readonly session: string; readonly spent: Budget }
  | {
      readonly phase: "waiting";
      readonly session: string;
      readonly spent: Budget;
      readonly kind: AskKind;
      readonly question: string;
      readonly options: readonly string[];
    }
  | {
      readonly phase: "succeeded";
      readonly session: string;
      readonly spent: Budget;
      readonly commit: string | null;
      /** One sentence the session ended with, if it offered one. An adapter that cannot ask
       *  never sets it. */
      readonly lesson?: string;
    }
  | {
      readonly phase: "failed";
      readonly session: string | null;
      readonly spent: Budget;
      readonly reason: FailReason;
      /** A failed attempt is the one most likely to have learned something. */
      readonly lesson?: string;
    };

/** One per kind of worker. The only thing in wecode that knows a harness from a person.
 *
 *  Above it there are assignments and phases; below it there are flags, or a URL, or a
 *  message to somebody. */
export interface WorkerAdapter {
  readonly kind: string;
  start(work: Work): Promise<Observation>;
  poll(work: Work): Promise<Observation>;
  /** Pick up a session this adapter has lost track of — a restart, usually. `work.session`
   *  is the session to resume and its worktree still exists; the foreman has checked both.
   *
   *  A harness that cannot reattach to a session says so by returning failed/lost. That is
   *  an answer, not an error: the foreman then fails the attempt as it would have anyway. */
  resume(work: Work): Promise<Observation>;
  answer(work: Work, answer: string): Promise<Observation>;
  kill(work: Work): Promise<void>;
}
