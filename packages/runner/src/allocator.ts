import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import {
  collides,
  currentLoad,
  Maker,
  nextUp,
  openAssignments,
  ordered as inOrder,
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

/** The words core refuses an overlapping candidate with. Matched, not re-derived: this
 *  file re-opens that one verdict and nothing else. */
const OVERLAP = "overlaps";

/** Paths declared `collision.append_only` in budget.yaml.
 *
 *  A file that is only ever appended to — one line per new module, as the component map
 *  is — is not a lock: two tasks adding different lines never touch the same one, and
 *  refusing the second serialises work that shares no code. Which paths those are is the
 *  operator's to say, so it is config, read from the same budget.yaml the ceilings come
 *  from: beside the workspace database, else the project's own. */
export function appendOnly(db: DatabaseSync): readonly string[] {
  const here = db.location();
  const beside = here === null ? null : join(dirname(here), "budget.yaml");
  const path =
    beside !== null && existsSync(beside) ? beside : resolve(process.cwd(), "config/budget.yaml");
  if (!existsSync(path)) return [];

  const raw: unknown = parse(readFileSync(path, "utf8"));
  const top = (raw ?? {}) as Record<string, unknown>;
  const collision = (top["collision"] ?? {}) as Record<string, unknown>;
  const declared = collision["append_only"];
  return Array.isArray(declared) ? declared.filter((p): p is string => typeof p === "string") : [];
}

/** Whether two write scopes lock each other once append-only paths are discounted.
 *
 *  A pair is discounted only when *both* globs name a declared path verbatim: one task
 *  appending a line to the map and another that may rewrite the directory it sits in are
 *  still exclusive, so `packages/core/**` keeps holding the map it reaches over. */
const locks = (a: readonly string[], b: readonly string[], free: readonly string[]): boolean =>
  a.some((x) => b.some((y) => collides([x], [y]) && !(free.includes(x) && free.includes(y))));

/** Candidates core refused only for an overlap that is entirely append-only. Nothing else
 *  is reconsidered: a role at its ceiling, a chore nobody can take and a real overlap are
 *  all still refused, in core's words. */
function sharingOnlyAppendOnly(
  db: DatabaseSync,
  config: BudgetConfig,
  refused: readonly Refusal[],
  free: readonly string[],
): { readonly admitted: readonly Candidate[]; readonly refused: readonly Refusal[] } {
  const held = currentLoad(db, config.max_open_per_role).held;
  const byId = new Map(readyCandidates(db).map((c) => [c.id, c]));

  const admitted: Candidate[] = [];
  const kept: Refusal[] = [];
  for (const r of refused) {
    const c = byId.get(r.id);
    if (c === undefined || !r.why.includes(OVERLAP) || locks(c.scope.write, held, free)) {
      kept.push(r);
      continue;
    }
    admitted.push(c);
  }
  return { admitted, refused: kept };
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
  const free = appendOnly(db);
  const second =
    free.length === 0
      ? { admitted: [], refused: ruledOut }
      : sharingOnlyAppendOnly(db, config, ruledOut, free);
  // Re-sorted as one list rather than appended: a task let back in takes its own place in
  // core's order, not a place behind everything that was never refused.
  const walk = second.admitted.length === 0 ? ordered : inOrder([...ordered, ...second.admitted], config.order);
  const refused: Refusal[] = [...second.refused];

  // Walk the order. A candidate that cannot be placed is refused for its own reason and the
  // pass moves on, rather than the whole tick stalling behind one unplaceable task.
  for (const next of walk) {
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
