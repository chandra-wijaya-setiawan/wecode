import type { DatabaseSync } from "node:sqlite";
import { Engine, type Change } from "./apply.js";
import type { MachineSet, Refusal } from "./types.js";

export type BulkOutcome =
  | { readonly ok: true; readonly changes: readonly Change[] }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

const TX = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;

/** The same database, minus the ability to open or close a transaction.
 *
 *  Engine.apply() wraps itself in one so a cascade cannot half-run. Under a bulk that must
 *  be all-or-nothing across many ids, that inner transaction is the wrong boundary, and
 *  SQLite has no nested BEGIN. So the engine runs against a handle whose transaction
 *  statements are no-ops and the bulk owns the single real transaction. Every read and
 *  write still goes through the engine to the real database. */
function inOuterTransaction(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return (sql: string): void => {
          if (!TX.test(sql)) target.exec(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Drop every task in `ids`, or none of them.
 *
 *  Each id goes through the engine's drop verb one at a time, so every guard and every
 *  cascade runs exactly as it would for a single drop — this writes no state itself. The
 *  whole list shares one transaction: if any id refuses, nothing is written and the
 *  refusals come back verbatim, because a half-applied bulk action is worse than none. */
export function bulkDrop(
  db: DatabaseSync,
  ids: readonly number[],
  actor: string,
  machines?: MachineSet,
): BulkOutcome {
  const engine =
    machines === undefined
      ? new Engine(inOuterTransaction(db))
      : new Engine(inOuterTransaction(db), machines);

  const changes: Change[] = [];
  const refusals: Refusal[] = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of ids) {
      // Once one id has refused nothing will be written, so the rest are asked rather than
      // applied: the caller still learns every offender, not just the first.
      const r = refusals.length === 0 ? engine.apply("task", id, "drop", actor) : engine.may("task", id, "drop");
      if (r.ok) changes.push(...r.changes);
      else refusals.push({ id, why: r.why });
    }
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (refusals.length > 0) {
    db.exec("ROLLBACK");
    return { ok: false, refusals };
  }
  db.exec("COMMIT");
  return { ok: true, changes };
}
