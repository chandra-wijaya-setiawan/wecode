/** The cascade a drop sets off: down to what hung off the row, and up to what the row was
 *  the last of.
 *
 *  apply.ts cascades upward: a settled child fires the completion transition of its
 *  parent. Nothing cascaded the other way, and `acceptance_criteria.drop` carries no
 *  guard, so dropping a criteria left its acceptance_tests in `ready` — dispatchable
 *  work under a criteria nobody intends to accept, and a task under that test still on
 *  the board. Abandoning a parent abandons what hangs off it; this file says so.
 *
 *  `cascadeReopen` is the same upward walk run for the opposite event: a new child hung
 *  under a parent that had already settled, which is the one thing `cascadeAbandon` cannot
 *  leave the record in.
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
import { CHECKED, type Checked, successOf } from "./invariants.js";
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

/** The ancestor the upward walk stopped at, and the sentence that stopped it. */
export interface Held {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly why: string;
}

export type AbandonCascade =
  | { readonly ok: true; readonly dropped: readonly Drop[]; readonly held: Held | null }
  | { readonly ok: false; readonly why: string };

/** Settle every ancestor of a dropped row that has nothing left to prove it.
 *
 *  The mirror of `cascadeDrop`, and the other thing that follows from a drop. Dropping a
 *  criteria's last acceptance_test must not *prove* the criteria — all-dropped is not
 *  all-passed, and all-dropped.test.ts is the record of the five deliveries that bug cost.
 *  But leaving it in `in_progress` is no better: `accept` refuses it for ever after, so the
 *  criteria is unprovable work sitting on the board with nobody able to say why. It is
 *  settled here, as `dropped`, which is what it is.
 *
 *  It starts at whichever rung was dropped, not only at an acceptance_test: a criteria
 *  somebody drops carries up to the requirement it was the last criteria of, by the same
 *  walk and for the same reason.
 *
 *  The walk stops at the first ancestor that still bears a child this cascade did not
 *  abandon — a passed sibling test, a live criteria — and reports it as `held` rather than
 *  swallowing it: one live child is the whole reason the parent stays. It stops the same
 *  way at an ancestor the machine will not drop, so a `met` requirement is not undone by
 *  the last of its criteria going away.
 *
 *  Like the downward walk it invokes no verb through Engine.apply, so no completion
 *  transition fires on the way up. Abandonment proves nothing at any level.
 */
export function cascadeAbandon(
  db: DatabaseSync,
  entity: StatefulEntity,
  id: number,
  machines: MachineSet = loadMachines(),
): AbandonCascade {
  const repo = new Repo(db);
  const state = repo.stateOf(entity, id);
  if (state === null) return { ok: false, why: `no ${entity} #${id}` };
  if (state !== "dropped") {
    return { ok: false, why: `${entity} #${id} is ${state}, not dropped: nothing to cascade` };
  }

  const dropped: Drop[] = [];
  const held = transact(db, () => climb(repo, machines, entity, id, dropped));

  return { ok: true, dropped, held };
}

/** One ancestor this cascade reopened. Automatic for the same reason the others are: the
 *  actor hung a child, and nobody said `reopen` to the parent. */
export interface Reopen {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly verb: "reopen";
  readonly from: string;
  readonly to: "in_progress";
  readonly automatic: true;
}

export type ReopenCascade =
  | { readonly ok: true; readonly reopened: readonly Reopen[]; readonly held: Held | null }
  | { readonly ok: false; readonly why: string };

/** Reopen every settled ancestor of a row that is open — a new child hung under a parent
 *  that had finished with it.
 *
 *  `cascadeAbandon` is the same walk run the other way, and this is the state it cannot
 *  leave the record in. A parent settles on a guard over the children it could see, so a
 *  criteria accepted last week is accepted on a count of acceptance_tests that no longer
 *  holds the moment somebody hangs a new one under it. Nothing downward notices: from the
 *  criteria's side nothing is missing. invariants.ts sees it from the child's side and calls
 *  it `nothing_is_open_under_a_settled_parent` — a `ready` test under an `accepted` criteria
 *  under a `delivered` story, work that will be dispatched and proved and reported under a
 *  story that already said it was done. This is the heal: the ancestors go back to
 *  `in_progress`, where the completion guards can weigh the new child and settle them again
 *  on their own.
 *
 *  It stops at the first ancestor that is already open — that one is weighing the new work
 *  by definition, and everything above it is too. It stops the same way, as `held`, at an
 *  ancestor no cascade revives: a released version and a `done` task are somebody's
 *  decision to undo, not a walk's.
 *
 *  Like both other walks it invokes no verb through Engine.apply, so no completion
 *  transition fires. A reopen proves nothing either.
 */
export function cascadeReopen(
  db: DatabaseSync,
  entity: StatefulEntity,
  id: number,
  machines: MachineSet = loadMachines(),
): ReopenCascade {
  const repo = new Repo(db);
  const state = repo.stateOf(entity, id);
  if (state === null) return { ok: false, why: `no ${entity} #${id}` };
  if (settled(entity, state)) {
    return { ok: false, why: `${entity} #${id} is ${state}, not open: nothing to cascade` };
  }

  const reopened: Reopen[] = [];
  const held = transact(db, () => rise(repo, machines, entity, id, reopened));

  return { ok: true, reopened, held };
}

/** The rungs a cascade may settle or revive, in either direction.
 *
 *  Everything between a criteria and an epic is work: it exists to be proved, and with
 *  nothing left to prove it there is nothing left of it — and when something to prove it
 *  turns up again, it is work again. A release and the project above it are not —
 *  cascade.test.ts already stops the upward *success* cascade at the release, because
 *  shipping is a decision, and abandoning or unshipping a version is the same decision said
 *  another way. A task is not on the list either: it is dropped by whoever gave it up, and
 *  a task that finished on a branch of its own is revived by a person too.
 *
 *  One list, not two: the rung a cascade may walk down through is the rung it may walk back
 *  up through, and two copies of it would be two things that have to agree. */
const RUNGS: readonly StatefulEntity[] = [
  "acceptance_criteria",
  "requirement",
  "story",
  "epic",
];

/** Settled is succeeded or dropped — the two ways of being finished with, spelled exactly as
 *  invariants.ts spells it. `nothing_is_open_under_a_settled_parent` is the finding the
 *  upward reopen walk heals, so the walk and the check must mean the same thing by the word
 *  or the doctor reports what the cascade thinks it already fixed. Success comes from
 *  `successOf`; an entity no invariant speaks about has only `dropped`. */
const checked = (entity: StatefulEntity): entity is Checked => (CHECKED as readonly string[]).includes(entity);

const settled = (entity: StatefulEntity, state: string): boolean =>
  state === "dropped" || (checked(entity) && state === successOf(entity));

function climb(
  repo: Repo,
  machines: MachineSet,
  entity: StatefulEntity,
  id: number,
  dropped: Drop[],
): Held | null {
  let up = repo.parentOf(entity, id);
  while (up !== null) {
    const here = up;
    const state = repo.stateOf(here.entity, here.id);
    if (state === null) return null;

    if (!RUNGS.includes(here.entity)) {
      return { ...here, why: `${here.entity} #${here.id} is not abandoned by a cascade: dropping it is a decision` };
    }

    const alive = repo.childrenOf(here.entity, here.id).find((row) => row.state !== "dropped");
    if (alive !== undefined) {
      const child = repo.childEntityOf(here.entity);
      return {
        ...here,
        why: `${here.entity} #${here.id} still bears ${child} #${alive.id} (${alive.state})`,
      };
    }
    if (transitionFor(machines[here.entity], state, "drop") === undefined) {
      return { ...here, why: `${here.entity} #${here.id} is ${state}: the machine will not drop it` };
    }

    repo.setState(here.entity, here.id, state, "dropped", "drop", "cascade");
    dropped.push({ ...here, verb: "drop", from: state, to: "dropped", automatic: true });
    up = repo.parentOf(here.entity, here.id);
  }
  return null;
}

/** The mirror of `climb`: up from an open child, reopening what had finished with it. */
function rise(
  repo: Repo,
  machines: MachineSet,
  entity: StatefulEntity,
  id: number,
  reopened: Reopen[],
): Held | null {
  let up = repo.parentOf(entity, id);
  while (up !== null) {
    const here = up;
    const state = repo.stateOf(here.entity, here.id);
    if (state === null) return null;

    // Already open, so it is already weighing this child — and so is everything above it.
    if (!settled(here.entity, state)) return null;

    if (!RUNGS.includes(here.entity)) {
      return { ...here, why: `${here.entity} #${here.id} is not reopened by a cascade: reviving it is a decision` };
    }
    if (transitionFor(machines[here.entity], state, "reopen") === undefined) {
      return { ...here, why: `${here.entity} #${here.id} is ${state}: the machine will not reopen it` };
    }

    repo.setState(here.entity, here.id, state, "in_progress", "reopen", "cascade");
    reopened.push({ ...here, verb: "reopen", from: state, to: "in_progress", automatic: true });
    up = repo.parentOf(here.entity, here.id);
  }
  return null;
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
