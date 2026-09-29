import type { DatabaseSync } from "node:sqlite";
import {
  CHORE_KIND_DEFS,
  CHORE_MACHINE,
  CLOSE,
  REPROVE,
  START,
  TABLES,
  type Chore,
  type ChoreKind,
  type ChoreTarget,
} from "../chore.js";
import { queries } from "../db.js";
import { isTerminal, transitionFor } from "../machines.js";
import { now, transact } from "../store.js";
import { ledgerFor, whole } from "./reads.js";
import { FIELDS } from "./rows.js";

/** Reading one chore, moving one chore, and counting what it has already been through.
 *
 *  The record's verbs, apart from the declarations they write to: chore.ts owns the tables
 *  and the machine, and this is what applies them. Every binding it takes from chore.ts is
 *  read inside a function body, so the two modules importing each other stays a module
 *  cycle. */

export function choreFor(
  db: DatabaseSync,
  kind: ChoreKind,
  target_type: ChoreTarget,
  target_id: number,
): Chore | null {
  return whole(
    queries(db)
      .selectFrom(TABLES.chore)
      .select(FIELDS)
      .where("kind", "=", kind)
      .where("target_type", "=", target_type)
      .where("target_id", "=", target_id)
      .get(),
  );
}

export function choreById(db: DatabaseSync, id: number): Chore | null {
  return whole(queries(db).selectFrom(TABLES.chore).select(FIELDS).where("id", "=", id).get());
}

export type ChoreOutcome =
  | { readonly ok: true; readonly from: string; readonly to: string }
  | { readonly ok: false; readonly why: string };

/** A person says go. Recorded rather than acted on: approving a chore does not start it,
 *  it only removes the reason it may not be started. */
export function approveChore(db: DatabaseSync, id: number, by: string): ChoreOutcome {
  const row = choreById(db, id);
  if (row === null) return { ok: false, why: `no chore #${id}` };
  if (!CHORE_KIND_DEFS[row.kind].needs_approval) {
    return { ok: false, why: `a ${row.kind} chore does not wait for approval` };
  }
  const at = now();
  queries(db).update(TABLES.chore).set({ approved_at: at, approved_by: by, updated_at: at }).where("id", "=", id).run();
  return { ok: true, from: row.state, to: row.state };
}

/** Apply a verb to a chore, and append it to the ledger.
 *
 *  Chore does not go through Engine: Engine walks the tree of stateful entities that
 *  cascade into one another, and a chore has no parent to settle. The machine is still
 *  read the same way — a verb that is not legal here is refused with what is. */
export function applyChore(db: DatabaseSync, id: number, verb: string, actor: string): ChoreOutcome {
  const row = choreById(db, id);
  if (row === null) return { ok: false, why: `no chore #${id}` };

  const from = row.state;
  const transition = transitionFor(CHORE_MACHINE, from, verb);
  if (transition === undefined) {
    if (isTerminal(CHORE_MACHINE, from)) return { ok: false, why: `${from} is terminal; nothing may be done to it` };
    const verbs = [...new Set(CHORE_MACHINE.transitions.filter((t) => t.from.includes(from)).map((t) => t.verb))];
    return { ok: false, why: `${verb} is not legal from ${from}. Legal here: ${verbs.join(", ")}` };
  }

  // The one guard a chore has. A chore nobody approved is not a chore nobody may see: it
  // sits on the board in `planned`, saying what it is waiting for.
  if (verb === START && CHORE_KIND_DEFS[row.kind].needs_approval && row.approved_at === null) {
    return { ok: false, why: `a ${row.kind} chore needs approval before it starts` };
  }

  const at = now();
  transact(db, () => {
    const q = queries(db);
    q.update(TABLES.chore).set({ state: transition.to, updated_at: at }).where("id", "=", id).run();
    q.insertInto(TABLES.ledger, {
      entity: "chore",
      entity_id: id,
      verb,
      from_state: from,
      to_state: transition.to,
      actor,
      at,
    }).run();
  });
  return { ok: true, from, to: transition.to };
}

/** Chore's own typed facade: one method per verb the chore machine has.
 *
 *  `applyChore` still takes a string, because a caller that reads a verb off a board or a
 *  command line has a string and nothing better; these are for the callers that know which
 *  verb they mean, and they mean it in the compiler's hearing. It adds no behaviour — every
 *  method is the same `applyChore`, so the same guard refuses it and the same ledger row is
 *  written. */
export class ChoreVerbs {
  constructor(private readonly db: DatabaseSync) {}

  /** chore: planned → ready */
  start(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, START, actor);
  }

  /** chore: ready → running */
  begin(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, "begin", actor);
  }

  /** chore: running → done */
  finish(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, "finish", actor);
  }

  /** chore: running → failed */
  fail(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, "fail", actor);
  }

  /** chore: failed → ready */
  retry(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, "retry", actor);
  }

  /** chore: failed, done → planned */
  reprove(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, REPROVE, actor);
  }

  /** chore: planned, ready, failed → done */
  close(id: number, actor: string): ChoreOutcome {
    return applyChore(this.db, id, CLOSE, actor);
  }
}

export interface ChoreAttempts {
  /** How many times a worker has begun this chore. */
  readonly attempts: number;
  /** The kind's ceiling. */
  readonly max_retry: number;
}

/** How many attempts a chore has had, read from the ledger rather than from a column.
 *
 *  A task counts its attempts in `task.attempts` because a person may reset it. Nobody
 *  resets a chore — wecode raises it and wecode judges it — so the count that matters is
 *  the one already written down: one `begin` row per attempt, in the order they happened. */
export function choreAttempts(db: DatabaseSync, id: number): ChoreAttempts | null {
  const row = choreById(db, id);
  if (row === null) return null;
  const attempts = ledgerFor(db, id).filter((l) => l.verb === "begin").length;
  return { attempts, max_retry: CHORE_KIND_DEFS[row.kind].max_retry };
}

/** What the board says of a chore that has had every attempt its kind allows. One wording,
 *  used by the allocator's refusal, by the board's detail and by the guard in `reraiseChore`
 *  that keeps a spent chore from being raised again. */
export const outOfAttempts = (t: ChoreAttempts): string => `out of attempts · ${t.attempts} of ${t.max_retry}`;
