import type { DatabaseSync } from "node:sqlite";
import {
  Maker,
  nextUp,
  openAssignments,
  readyCandidates,
  type Candidate,
  type Refusal,
} from "@wecode/core";
import type { BudgetConfig } from "./budget.js";

// Eligibility and order are @wecode/core's, not this file's: a view that wants to show
// *what is next* asks core the same question, so there is one decision and not two.
export { collides, eligible, nextUp, ordered } from "@wecode/core";
export type { Candidate, Refusal } from "@wecode/core";

export interface Pass {
  readonly created: number | null;
  readonly refused: readonly Refusal[];
}

/** Where an attempt would run. */
export interface Placement {
  readonly worker_id: number;
  readonly worktree: string;
}

/** Prepare a place for *this* candidate, or say why there is not one. Asynchronous because
 *  cutting a tree is: the caller must not prepare a placement for some other candidate and
 *  hope the allocator picks the same one. */
export type Place = (c: Candidate) => Promise<Placement | { why: string }>;

/** Tasks that are ready and have nothing attempting them. */
export function candidates(db: DatabaseSync): readonly Candidate[] {
  return readyCandidates(db);
}

/** One pass of docs/design/10. Creates at most one assignment: a pass that filled every
 *  slot at once could not react to what the first one did.
 *
 *  This function is the only thing that *acts* on the choice, and it walks core's order
 *  exactly, asking for a placement one candidate at a time — so the task a placement was
 *  prepared for is always the task the pass chose, and a refusal is always the true reason
 *  that candidate could not run. */
export async function allocate(
  db: DatabaseSync,
  config: BudgetConfig,
  place: Place,
): Promise<Pass> {
  const open = openAssignments(db);
  if (open >= config.max_open) {
    return { created: null, refused: [{ id: 0, why: `${open} of ${config.max_open} slots are open` }] };
  }

  const { ordered, refused: ruledOut } = nextUp(db, config);
  const refused: Refusal[] = [...ruledOut];

  // Walk the order. A candidate that cannot be placed is refused for its own reason and the
  // pass moves on, rather than the whole tick stalling behind one unplaceable task.
  for (const next of ordered) {
    const placement = await place(next);
    if ("why" in placement) {
      refused.push({ id: next.id, why: placement.why });
      continue;
    }

    const id = new Maker(db).assignment({
      objective_type: "task",
      objective_id: next.id,
      worker_id: placement.worker_id,
      scope: next.scope,
      budget: next.budget,
      worktree: placement.worktree,
    });
    return { created: id, refused };
  }
  return { created: null, refused };
}
