import type { DatabaseSync } from "node:sqlite";
import { ChoreError, TABLES, type Chore } from "../chore.js";
import { queries } from "../db.js";
import { FIELDS, OPEN_PHASES, type ChoreFields, type LedgerRow } from "./rows.js";

/** The reads every consumer of the chore record shares, in one place.
 *
 *  The tables stay declared in chore.ts — they are the record, and a table declared twice is
 *  two records — so this takes them from `TABLES` and asks the questions. Each of these used
 *  to be a correlated subquery per board row; each is now one read for the whole board.
 *
 *  It imports chore.ts and chore.ts re-exports what is built on it. The cycle is a module
 *  cycle only: every binding from chore.ts is read inside a function body, never while this
 *  module is evaluating. */

/** A row's id, insisted on rather than assumed. The column is `INTEGER PRIMARY KEY` and
 *  cannot be null, so this never fires — but it is what makes an optional `id` on the
 *  declaration safe, instead of a cast that says "trust me" over every read. */
export const rowid = (r: { readonly id?: number }): number => {
  if (r.id === undefined) throw new ChoreError("a row came back from the database without its id");
  return r.id;
};

export const whole = (r: ChoreFields | null): Chore | null => (r === null ? null : { ...r, id: rowid(r) });

/** Every ledger row this chore has, oldest first. Its verbs are the only record of how many
 *  attempts a chore has had and of which verb settled it, and both answers come from one
 *  read rather than from a count and a sort-and-cap the dialect cannot spell. */
export const ledgerFor = (db: DatabaseSync, id: number): readonly LedgerRow[] =>
  queries(db)
    .selectFrom(TABLES.ledger)
    .where("entity", "=", "chore")
    .where("entity_id", "=", id)
    .all()
    .sort((a, b) => rowid(a) - rowid(b));

/** Chore ids something is attempting right now. */
export const attemptedIds = (db: DatabaseSync): ReadonlySet<number> =>
  new Set(
    queries(db)
      .selectFrom(TABLES.assignment)
      .where("objective_type", "=", "chore")
      .all()
      .filter((a) => OPEN_PHASES.includes(a.phase))
      .map((a) => a.objective_id),
  );

/** How many times a worker has begun each chore, from the ledger. One read for the whole
 *  board, where each row used to carry its own correlated subquery. */
export const beginsPerChore = (db: DatabaseSync): ReadonlyMap<number, number> => {
  const counted = new Map<number, number>();
  const q = queries(db).selectFrom(TABLES.ledger).where("entity", "=", "chore").where("verb", "=", "begin");
  for (const l of q.all()) counted.set(l.entity_id, (counted.get(l.entity_id) ?? 0) + 1);
  return counted;
};

/** The chores of one state, or of every project when `project` is null — the two shapes the
 *  `:project IS NULL OR project_id = :project` clause had, told apart here. */
export function choresWhere(db: DatabaseSync, state: string, op: "=" | "!=", project: number | null): readonly Chore[] {
  const base = queries(db).selectFrom(TABLES.chore).select(FIELDS).where("state", op, state);
  const q = project === null ? base : base.where("project_id", "=", project);
  return q
    .all()
    .map((r) => ({ ...r, id: rowid(r) }))
    .sort((a, b) => a.id - b.id);
}

/** What an operator reads for a chore's target: the story's title, the project's name, or
 *  the bare id when the row the chore names is not there. */
export function whatOf(db: DatabaseSync): (c: Chore) => string {
  const q = queries(db);
  const titles = new Map(q.selectFrom(TABLES.story).all().map((s) => [s.id, s.title]));
  const names = new Map(q.selectFrom(TABLES.project).all().map((p) => [p.id, p.name]));
  return (c) => {
    const named = c.target_type === "story" ? titles.get(c.target_id) : names.get(c.target_id);
    return `${c.kind} ${c.target_type} ${named ?? c.target_id}`;
  };
}

/** Is anything attempting this chore? The same question the board asks of every chore,
 *  asked of one, so the state the board shows and the guard on a refusal cannot differ. */
export function isAttempted(db: DatabaseSync, choreId: number): boolean {
  return (
    queries(db)
      .selectFrom(TABLES.assignment)
      .where("objective_type", "=", "chore")
      .where("objective_id", "=", choreId)
      .all()
      .filter((a) => OPEN_PHASES.includes(a.phase)).length > 0
  );
}
