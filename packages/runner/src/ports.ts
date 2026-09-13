import type { AskKind, Budget, FailReason, Scope } from "@wecode/core";

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
  | { readonly phase: "succeeded"; readonly session: string; readonly spent: Budget; readonly commit: string | null }
  | { readonly phase: "failed"; readonly session: string | null; readonly spent: Budget; readonly reason: FailReason };

/** One per kind of worker. The only thing in wecode that knows a harness from a person.
 *
 *  Above it there are assignments and phases; below it there are flags, or a URL, or a
 *  message to somebody. */
export interface WorkerAdapter {
  readonly kind: string;
  start(work: Work): Promise<Observation>;
  poll(work: Work): Promise<Observation>;
  answer(work: Work, answer: string): Promise<Observation>;
  kill(work: Work): Promise<void>;
}
