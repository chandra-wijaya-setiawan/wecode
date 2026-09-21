import type { ChoreKind, ChoreTarget } from "../chore.js";

/** The shape of each row chore.ts reads, apart from the declarations that name the tables.
 *
 *  board.ts keeps its rows in `board/rows.ts` for the same reason: the declaration must stay
 *  in the one module that owns the table, but the interface behind it is read by every
 *  consumer, and a consumer that had to import it from chore.ts would be importing the
 *  table too. Nothing here is on core's surface — `index.ts` re-exports chore.ts and nothing
 *  under it — so these names are free to be the plain ones without colliding with board's.
 *
 *  `id` is optional on the rows that have one because the same declaration is the insert's
 *  shape, and a row's id is SQLite's to give. Every read goes through `whole` in
 *  `chore/reads.ts`, which insists on it. */

/** `kind` and `target_type` are declared as their unions rather than as `string`: the column
 *  holds nothing else, `CHORE_KIND_DEFS[chore.kind]` has always assumed so, and declaring it
 *  means a `where("kind", "=", "merg")` is a typecheck failure rather than a query that
 *  matches nothing. `typed-chore.test.ts` holds each column list against `PRAGMA table_info`. */
export interface ChoreRow {
  id?: number;
  slug: string;
  kind: ChoreKind;
  project_id: number;
  target_type: ChoreTarget;
  target_id: number;
  check: string;
  state: string;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id?: number;
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
}

export interface RefusalRow {
  chore_id: number;
  why: string;
  at: string;
  since: string;
  passes: number;
}

export interface AssignmentRow {
  objective_type: string;
  objective_id: number;
  phase: string;
}

/** What a chore row is read as: the record's columns, minus the stamps nobody outside asks
 *  for. One list, so the shape of `Chore` and the columns fetched cannot drift. */
export const FIELDS = [
  "id",
  "slug",
  "kind",
  "project_id",
  "target_type",
  "target_id",
  "check",
  "state",
  "approved_at",
  "approved_by",
] as const;

export type ChoreFields = Pick<ChoreRow, (typeof FIELDS)[number]>;

/** An assignment nobody has finished with. order.ts holds the same list for the same
 *  reason; the two meet in the same three names until one module can import the other
 *  without a cycle. */
export const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];
