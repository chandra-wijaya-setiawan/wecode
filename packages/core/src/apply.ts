import type { DatabaseSync } from "node:sqlite";
import { registry } from "./checks.js";
import type { GuardRegistry } from "./guards.js";
import { automaticFrom, check, loadMachines } from "./machines.js";
import { Repo } from "./repo.js";
import { transact } from "./store.js";
import type { MachineSet, StatefulEntity } from "./types.js";

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

  constructor(
    private readonly db: DatabaseSync,
    machines: MachineSet = loadMachines(),
  ) {
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
