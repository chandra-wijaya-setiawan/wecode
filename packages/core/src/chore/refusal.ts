import type { DatabaseSync } from "node:sqlite";
import { TABLES } from "../chore.js";
import { queries } from "../db.js";
import { now, transact } from "../store.js";
import type { Refusal } from "../types.js";
import { isAttempted } from "./reads.js";

/** Why a chore is not moving, kept the way a task's reason is kept: one row per chore,
 *  replaced each pass, and the same sentence keeps the time it was first said. */

/** Why this chore was passed over on the last pass, kept the way a task's refusal is kept:
 *  one row, replaced each pass, and the same reason keeps its `since`.
 *
 *  A chore something is attempting was not passed over, so nothing may be written about it
 *  here and anything already written is wrong the moment the assignment exists. Guarded
 *  here rather than at each caller because the callers are the problem: dispatchChore has
 *  six ways out and nextUp has another, and a refusal outliving its condition only needs
 *  one of them to forget. `no worker free for role system` survived sixteen passes past
 *  the worker arriving that way. */
export function recordChoreRefusal(db: DatabaseSync, why: string, choreId: number): void {
  if (isAttempted(db, choreId)) return clearChoreRefusal(db, choreId);
  writeChoreRefusal(db, why, choreId);
}

/** The row itself, with no guard on it. `chore_refusal` holds two kinds of sentence — why a
 *  chore was passed over, and why a closed chore was closed — and only the first is a claim
 *  that nothing is attempting it. `closeChore` writes through here so that the reason a
 *  chore was closed survives an assignment still standing open against it, which is exactly
 *  the shape a chore left `planned` by a failed `begin` is in. Exported for `closeChore`,
 *  which is the other writer and lives in chore/raise.ts; nothing else may use it, because
 *  everything else writing here is saying "passed over" and owes the guard. */
export function writeChoreRefusal(db: DatabaseSync, why: string, choreId: number): void {
  // The upsert's two `CASE WHEN … = excluded.why` arms are the rule — the same sentence
  // keeps its `since` and counts a pass, a new one starts over — and the dialect spells no
  // CASE, so the rule is read and applied here. In a transaction, because the read of the
  // row and the write over it were one statement and must stay one act.
  transact(db, () => {
    const at = now();
    const seen = choreRefusal(db, choreId);
    const q = queries(db);
    if (seen === null) {
      q.insertInto(TABLES.refusal, { chore_id: choreId, why, at, since: at, passes: 1 }).run();
      return;
    }
    const same = seen.why === why;
    q.update(TABLES.refusal)
      .set({ why, at, since: same ? seen.since : at, passes: same ? seen.passes + 1 : 1 })
      .where("chore_id", "=", choreId)
      .run();
  });
}

export function clearChoreRefusal(db: DatabaseSync, choreId: number): void {
  queries(db).deleteFrom(TABLES.refusal).where("chore_id", "=", choreId).run();
}

export interface ChoreRefusal extends Refusal {
  readonly at: string;
  readonly since: string;
  readonly passes: number;
}

export function choreRefusal(db: DatabaseSync, choreId: number): ChoreRefusal | null {
  const row = queries(db).selectFrom(TABLES.refusal).where("chore_id", "=", choreId).get();
  // `chore_id AS id`, in TypeScript: a Refusal is an id and a sentence whatever table the
  // sentence is kept in, and the rename is the only reason this is not the row itself.
  return row === null ? null : { id: row.chore_id, why: row.why, at: row.at, since: row.since, passes: row.passes };
}
