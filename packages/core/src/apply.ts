import type { DatabaseSync } from "node:sqlite";
import { cascadeDrop } from "./cascade.js";
import { registry } from "./checks.js";
import { queries, table, type Dialect } from "./db.js";
import { attributedTo, type Actor } from "./facade-gen.js";
import type { GuardRegistry } from "./guards.js";
import { automaticFrom, check, loadMachines } from "./machines.js";
import { Repo, type StateRow } from "./repo.js";
import { transact } from "./store.js";
import type { MachineSet, StatefulEntity } from "./types.js";

/** The part of a row settle() reads: what it is, and where it stands. */
type Node = { id: number; state: string };

const NODE = ["id", "state"] as const;

/** Unexported on purpose: `index.ts` re-exports this module wholesale, and these names are
 *  other modules' too. */
const task = table<Node>("task", [...NODE]);
const criteria = table<Node>("acceptance_criteria", [...NODE]);
const requirement = table<Node>("requirement", [...NODE]);
const story = table<Node>("story", [...NODE]);
const epic = table<Node>("epic", [...NODE]);

/** Which rows settle() sweeps, bottom of the tree upward, and how each is read.
 *
 *  The order is the point — a task settling is what lets its criteria settle — and reading
 *  a table by interpolating the entity name into the query text was the one statement in
 *  this module the compiler could say nothing about: neither that the table existed nor
 *  that it kept its state in a column of that name. A closure per entity says the same
 *  thing in a form where both are checked where the lookup is written. */
const SWEEP: readonly { readonly entity: StatefulEntity; readonly rows: (q: Dialect) => readonly StateRow[] }[] = [
  { entity: "task", rows: (q) => q.selectFrom(task).select([...NODE]).all() },
  { entity: "acceptance_criteria", rows: (q) => q.selectFrom(criteria).select([...NODE]).all() },
  { entity: "requirement", rows: (q) => q.selectFrom(requirement).select([...NODE]).all() },
  { entity: "story", rows: (q) => q.selectFrom(story).select([...NODE]).all() },
  { entity: "epic", rows: (q) => q.selectFrom(epic).select([...NODE]).all() },
];

/** What a call is refused for when the actor names nobody. `actorOf` refuses the same
 *  string where an actor is made; this is the engine saying so where one is used, because
 *  `Actor` is an alias and any string reaches here. */
export const NO_ACTOR = "an actor is who did it — there is nobody named here";

/** What a call is refused for when the actor already carries a reason and one was passed
 *  as well. Two reasons for one transition is a caller that has not decided which is true. */
export const TWO_REASONS = "the reason is a parameter now — do not pack a second one into the actor";

/** The identities that are not people. A transition nobody invoked still has an actor, and
 *  these say which sweep fired it. `ANYBODY` is the asker of a question: `may()` writes
 *  nothing, so the change it describes is nobody's in particular. */
export const SETTLE: Actor = "settle";
export const CASCADE: Actor = "cascade";
export const ANYBODY: Actor = "anybody";

/** The separator `attributedTo` joins the two halves under: `who: why`. */
const PACKED = ": ";

/** Read a ledger actor as what it is made of: the identity that acted, and the reason it
 *  was given, if any.
 *
 *  Both halves live in the one `actor` column, because that is the only column of a ledger
 *  row that survives beside the transition it explains. This is the reverse of
 *  `attributedTo`, and the one place a string becomes an actor here: callers and readers
 *  can speak about who and why separately while the schema still keeps them together. */
export function identity(text: string): { actor: Actor; reason: string | null } {
  const cut = text.indexOf(PACKED);
  const actor = (cut === -1 ? text : text.slice(0, cut)).trim();
  const why = cut === -1 ? "" : text.slice(cut + PACKED.length).trim();
  return { actor, reason: why === "" ? null : why };
}

export interface Change {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly verb: string;
  readonly from: string;
  readonly to: string;
  /** True when nobody invoked it: a completion transition that fired on its own. */
  readonly automatic: boolean;
  /** Who did it. An identity, never a sentence: the reason is the field below. */
  readonly actor: Actor;
  /** Why, when the caller said. A transition nobody invoked has nobody's reason. */
  readonly reason: string | null;
}

export type Outcome =
  | { readonly ok: true; readonly changes: readonly Change[] }
  | { readonly ok: false; readonly why: string };

/** Applies verbs and lets the cascade run. One of these per client. */
export class Engine {
  private readonly repo: Repo;
  private readonly guards: GuardRegistry;
  private readonly machines: MachineSet;
  private readonly q: Dialect;

  constructor(
    private readonly db: DatabaseSync,
    machines: MachineSet = loadMachines(),
  ) {
    this.q = queries(db);
    this.repo = new Repo(db);
    this.guards = registry(this.repo);
    this.machines = machines;
  }

  /** Ask without writing. Nobody in particular is asking, so the change it describes is
   *  attributed to `ANYBODY`: a question has no actor, and leaving the field out would make
   *  every reader of a `Change` check whether it has one. */
  may(entity: StatefulEntity, id: number, verb: string, who: Actor = ANYBODY): Outcome {
    const from = this.repo.stateOf(entity, id);
    if (from === null) return { ok: false, why: `no ${entity} #${id}` };
    const r = check(this.machines[entity], from, verb, this.guards, { entity, id });
    return r.ok
      ? {
          ok: true,
          changes: [
            { entity, id, verb, from, to: r.applied.to, automatic: false, actor: who, reason: null },
          ],
        }
      : { ok: false, why: r.why };
  }

  /** Apply a verb, then let every completion transition it unblocked fire, upward, until
   *  none does. All of it in one transaction: a cascade that half-ran would leave a story
   *  delivered under an epic that never noticed. */
  apply(entity: StatefulEntity, id: number, verb: string, who: Actor, reason?: string | null): Outcome {
    // Who and why are taken apart before anything is read: a call with nobody behind it is
    // refused as that, not as a missing row. A caller that packed the two itself still
    // works — `attributedTo` is the packing, `identity` is its reverse — but it may not
    // bring a second reason on top of one it packed.
    const said = identity(who);
    if (said.actor === "") return { ok: false, why: NO_ACTOR };
    const passed = (reason ?? "").trim();
    if (passed !== "" && said.reason !== null) return { ok: false, why: TWO_REASONS };
    const because = passed === "" ? said.reason : passed;

    const from = this.repo.stateOf(entity, id);
    if (from === null) return { ok: false, why: `no ${entity} #${id}` };

    const first = check(this.machines[entity], from, verb, this.guards, { entity, id });
    if (!first.ok) return { ok: false, why: first.why };

    return transact(this.db, () => {
      const changes: Change[] = [];
      // The two halves, back in the one column the schema gives them. This expression is
      // the whole of what is left of the packing at this boundary; the reason gets a column
      // of its own the day `packages/core/sql/**` and `Repo.setState` can be changed.
      const line = because === null ? said.actor : attributedTo(said.actor, because);
      this.repo.setState(entity, id, from, first.applied.to, verb, line);
      changes.push({
        entity,
        id,
        verb,
        from,
        to: first.applied.to,
        automatic: false,
        actor: said.actor,
        reason: because,
      });
      this.cascade(entity, id, changes);
      return { ok: true, changes } as const;
    });
  }

  /** Every completion transition whose guard now holds, anywhere.
   *
   *  The cascade inside apply() is edge-triggered: it walks up from the row that just
   *  changed. That misses anything whose guard became true for another reason — a sibling
   *  settling, a row dropped, a test invalidated — and leaves a criteria sitting in
   *  in_progress with every test passed. This is the level-triggered half: it reads state
   *  and fires, so nothing waits for an event that already happened. */
  settle(): readonly Change[] {
    const changes: Change[] = [];
    this.abandonTestsOfDroppedTasks(changes);

    for (let pass = 0; pass < SWEEP.length; pass++) {
      let moved = false;
      for (const { entity, rows: read } of SWEEP) {
        const rows = read(this.q);

        for (const row of rows) {
          const fired = automaticFrom(this.machines[entity], row.state).find(
            (t) => check(this.machines[entity], row.state, t.verb, this.guards, { entity, id: row.id }).ok,
          );
          if (fired === undefined) continue;

          transact(this.db, () => {
            this.repo.setState(entity, row.id, row.state, fired.to, fired.verb, SETTLE);
            changes.push({
              entity,
              id: row.id,
              verb: fired.verb,
              from: row.state,
              to: fired.to,
              automatic: true,
              actor: SETTLE,
              reason: null,
            });
          });
          moved = true;
        }
      }
      if (!moved) break;
    }
    return changes;
  }

  /** A task_test under a dropped task is dispatchable work nobody means to do.
   *
   *  `task.drop` carries no guard, so a task may be dropped with its tests still `ready` —
   *  and nothing brings them down. cascade.ts is the downward walk, but only a caller who
   *  remembers to run it; `wecode task drop` did and the daemon's own drops did not, so the
   *  tests sat there unsettled and the task's test column read as live work. The sweep is
   *  the level-triggered half, so it is where the omission is repaired rather than at each
   *  of the sites that has to remember.
   *
   *  It goes through cascadeDrop for the two things that file already decides: a drop must
   *  not fire an upward completion transition on its way down, and a `passed` task_test is
   *  a success the machine will not undo. A test it keeps is not reported as a change,
   *  because nothing about it changed. */
  private abandonTestsOfDroppedTasks(changes: Change[]): void {
    for (const row of this.q.selectFrom(task).select([...NODE]).all()) {
      if (row.state !== "dropped") continue;
      const done = cascadeDrop(this.db, "task", row.id, this.machines);
      if (!done.ok) continue;
      for (const d of done.dropped) {
        changes.push({ ...d, automatic: true, actor: CASCADE, reason: null });
      }
    }
  }

  /** Walk up from a settled child, firing any automatic transition whose guard now holds. */
  private cascade(entity: StatefulEntity, id: number, changes: Change[]): void {
    let up = this.repo.parentOf(entity, id);
    while (up !== null) {
      const here = up;
      const state = this.repo.stateOf(here.entity, here.id);
      if (state === null) return;

      const fired = automaticFrom(this.machines[here.entity], state).find(
        (t) => check(this.machines[here.entity], state, t.verb, this.guards, here).ok,
      );
      if (fired === undefined) return;

      this.repo.setState(here.entity, here.id, state, fired.to, fired.verb, CASCADE);
      changes.push({
        entity: here.entity,
        id: here.id,
        verb: fired.verb,
        from: state,
        to: fired.to,
        automatic: true,
        actor: CASCADE,
        reason: null,
      });
      up = this.repo.parentOf(here.entity, here.id);
    }
  }
}
