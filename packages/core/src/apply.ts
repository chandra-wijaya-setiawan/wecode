import type { DatabaseSync } from "node:sqlite";
import { registry } from "./checks.js";
import { queries, table, type Dialect } from "./db.js";
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

export interface Change {
  readonly entity: StatefulEntity;
  readonly id: number;
  readonly verb: string;
  readonly from: string;
  readonly to: string;
  /** True when nobody invoked it: a completion transition that fired on its own. */
  readonly automatic: boolean;
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

  /** Ask without writing. */
  may(entity: StatefulEntity, id: number, verb: string): Outcome {
    const from = this.repo.stateOf(entity, id);
    if (from === null) return { ok: false, why: `no ${entity} #${id}` };
    const r = check(this.machines[entity], from, verb, this.guards, { entity, id });
    return r.ok
      ? { ok: true, changes: [{ entity, id, verb, from, to: r.applied.to, automatic: false }] }
      : { ok: false, why: r.why };
  }

  /** Apply a verb, then let every completion transition it unblocked fire, upward, until
   *  none does. All of it in one transaction: a cascade that half-ran would leave a story
   *  delivered under an epic that never noticed. */
  apply(entity: StatefulEntity, id: number, verb: string, actor: string): Outcome {
    const from = this.repo.stateOf(entity, id);
    if (from === null) return { ok: false, why: `no ${entity} #${id}` };

    const first = check(this.machines[entity], from, verb, this.guards, { entity, id });
    if (!first.ok) return { ok: false, why: first.why };

    return transact(this.db, () => {
      const changes: Change[] = [];
      this.repo.setState(entity, id, from, first.applied.to, verb, actor);
      changes.push({ entity, id, verb, from, to: first.applied.to, automatic: false });
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
            this.repo.setState(entity, row.id, row.state, fired.to, fired.verb, "settle");
            changes.push({
              entity,
              id: row.id,
              verb: fired.verb,
              from: row.state,
              to: fired.to,
              automatic: true,
            });
          });
          moved = true;
        }
      }
      if (!moved) break;
    }
    return changes;
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

      this.repo.setState(here.entity, here.id, state, fired.to, fired.verb, "cascade");
      changes.push({
        entity: here.entity,
        id: here.id,
        verb: fired.verb,
        from: state,
        to: fired.to,
        automatic: true,
      });
      up = this.repo.parentOf(here.entity, here.id);
    }
  }
}
