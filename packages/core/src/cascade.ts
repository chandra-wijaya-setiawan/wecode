/** The cascades apply.ts does not run: abandonment downward, and beginning upward.
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

/** One ancestor this cascade started. Automatic for the same reason a `Drop` is: the actor
 *  said `start` to the descendant, not to this row. */
export interface Started {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly verb: "start";
  readonly from: "planned";
  readonly to: string;
  readonly automatic: true;
}

export type StartCascade =
  | { readonly ok: true; readonly started: readonly Started[]; readonly kept: readonly Kept[] }
  | { readonly ok: false; readonly why: string };

/** Start every ancestor of a row that has already started and is still merely planned.
 *
 *  The upward cascade in apply.ts only fires *completion* transitions, so starting a story
 *  under a planned epic left the epic planned: the board showed work in progress beneath a
 *  release nobody had begun. Work begun on a child is work begun on its parents; this says
 *  so. Like `cascadeDrop` it does not go through Engine.apply — `start` carries guards about
 *  a row's own children (`task_may_be_attempted`), and a parent is not being proved here.
 *
 *  It climbs the whole chain rather than stopping at the first ancestor already under way.
 *  A planned project above an in_progress release is exactly the drift this repairs, and
 *  stopping early would leave it. An ancestor `start` cannot reach — one on hold, delivered
 *  or dropped — comes back as `kept`, for the caller to report rather than swallow.
 */
export function cascadeStart(
  db: DatabaseSync,
  entity: StatefulEntity,
  id: number,
  machines: MachineSet = loadMachines(),
): StartCascade {
  const repo = new Repo(db);
  const state = repo.stateOf(entity, id);
  if (state === null) return { ok: false, why: `no ${entity} #${id}` };
  if (state === "planned") {
    return { ok: false, why: `${entity} #${id} is planned, not started: nothing to cascade` };
  }

  const started: Started[] = [];
  const kept: Kept[] = [];

  transact(db, () => {
    let up = repo.parentOf(entity, id);
    while (up !== null) {
      const here = up;
      const at = repo.stateOf(here.entity, here.id);
      if (at === null) return;

      const t = at === "planned" ? transitionFor(machines[here.entity], at, "start") : undefined;
      if (t === undefined) {
        kept.push({ entity: here.entity, id: here.id, state: at });
      } else {
        repo.setState(here.entity, here.id, at, t.to, "start", "cascade");
        started.push({
          entity: here.entity,
          id: here.id,
          verb: "start",
          from: "planned",
          to: t.to,
          automatic: true,
        });
      }
      up = repo.parentOf(here.entity, here.id);
    }
  });

  return { ok: true, started, kept };
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
