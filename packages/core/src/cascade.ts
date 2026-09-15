/** The downward half of the cascade.
 *
 *  apply.ts cascades upward: a settled child fires the completion transition of its
 *  parent. Nothing cascaded the other way, and `acceptance_criteria.drop` carries no
 *  guard, so dropping a criteria left its acceptance_tests in `ready` — dispatchable
 *  work under a criteria nobody intends to accept, and a task under that test still on
 *  the board. Abandoning a parent abandons what hangs off it; this file says so.
 *
 *  Two things it deliberately does not do:
 *
 *  - It does not invoke `drop` through Engine.apply. Each of those would run the upward
 *    cascade from the child it just dropped, and a task with one passed task_test and
 *    one freshly dropped one would satisfy `every_task_test_settled` and finish on the
 *    way down. A drop cascade must not prove anything.
 *  - It does not force a state the machine refuses. `drop` is illegal from
 *    acceptance_test `passed`, task `done` and task_test `passed`: those descendants
 *    succeeded, and a success already recorded is not undone by the parent being
 *    abandoned. They come back as `kept`, for the caller to report rather than swallow.
 */

import type { DatabaseSync } from "node:sqlite";
import { loadMachines, transitionFor } from "./machines.js";
import { Repo } from "./repo.js";
import { transact } from "./store.js";
import type { MachineSet, StatefulEntity } from "./types.js";

/** One descendant this cascade dropped. Shaped like apply.ts's `Change`, and automatic
 *  for the same reason: no actor invoked it. */
export interface Drop {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly verb: "drop";
  readonly from: string;
  readonly to: "dropped";
  readonly automatic: true;
}

/** A descendant the cascade left alone, and the state that made it untouchable. */
export interface Kept {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly state: string;
}

export type DropCascade =
  | { readonly ok: true; readonly dropped: readonly Drop[]; readonly kept: readonly Kept[] }
  | { readonly ok: false; readonly why: string };

/** Drop every live descendant of a row that has already been dropped.
 *
 *  The row itself is not touched: somebody said `drop` to it and the ledger records them
 *  as the actor. This is what follows from that, written in one transaction so a tree is
 *  never half-abandoned, and attributed to `cascade`.
 */
export function cascadeDrop(
  db: DatabaseSync,
  entity: StatefulEntity,
  id: number,
  machines: MachineSet = loadMachines(),
): DropCascade {
  const repo = new Repo(db);
  const state = repo.stateOf(entity, id);
  if (state === null) return { ok: false, why: `no ${entity} #${id}` };
  if (state !== "dropped") {
    return { ok: false, why: `${entity} #${id} is ${state}, not dropped: nothing to cascade` };
  }

  const dropped: Drop[] = [];
  const kept: Kept[] = [];

  transact(db, () => {
    walk(repo, machines, entity, id, dropped, kept);
  });

  return { ok: true, dropped, kept };
}

function walk(
  repo: Repo,
  machines: MachineSet,
  entity: StatefulEntity,
  id: number,
  dropped: Drop[],
  kept: Kept[],
): void {
  const child = repo.childEntityOf(entity);
  if (child === null) return;

  for (const row of repo.childrenOf(entity, id)) {
    // Already abandoned, or a success the machine will not undo. Either way it is not
    // dropped here — but what hangs off it may still be live, so the walk continues.
    if (row.state === "dropped") {
      // nothing to record: it was dropped before this cascade reached it
    } else if (transitionFor(machines[child], row.state, "drop") === undefined) {
      kept.push({ entity: child, id: row.id, state: row.state });
    } else {
      repo.setState(child, row.id, row.state, "dropped", "drop", "cascade");
      dropped.push({
        entity: child,
        id: row.id,
        verb: "drop",
        from: row.state,
        to: "dropped",
        automatic: true,
      });
    }
    walk(repo, machines, child, row.id, dropped, kept);
  }
}
