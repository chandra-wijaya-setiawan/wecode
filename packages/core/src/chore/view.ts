import type { DatabaseSync } from "node:sqlite";
import { board as groups, hasTable, type Board, type Row } from "../board.js";
import { CHORE_KIND_DEFS, TABLES } from "../chore.js";
import { queries } from "../db.js";
import { attemptedIds, beginsPerChore, choresWhere, ledgerFor, rowid, whatOf } from "./reads.js";
import { choreById, outOfAttempts, type ChoreAttempts } from "./record.js";
import { choreRefusal } from "./refusal.js";
import type { LedgerRow } from "./rows.js";

/** What an operator reads: the chores still owed, the chores that are over, and the board
 *  with both on it.
 *
 *  The record is chore.ts's; this is the view over it. Nothing here writes. */

/** The one wording for a chore nobody has said go to. The board shows it as a chore's
 *  detail and the allocator refuses with it, so both say the same thing. */
export const WAITING_FOR_APPROVAL = "waiting for approval";

/** What the board says of a chore that has been round once. A first attempt says only its
 *  check — the count is noise until there is something to count. */
const attemptDetail = (t: ChoreAttempts, check: string): string =>
  t.attempts === 0
    ? check
    : t.attempts >= t.max_retry
      ? `${outOfAttempts(t)} · ${check}`
      : `attempt ${t.attempts + 1} of ${t.max_retry} · ${check}`;

/** The last ledger row that took each chore into `done`, which is the verb that settled it.
 *  A chore comes back — `reprove` returns it to `planned` — so it is the most recent one,
 *  taken by id in TypeScript, because the dialect can neither sort nor cap. */
function settlingVerbs(db: DatabaseSync): ReadonlyMap<number, LedgerRow> {
  const last = new Map<number, LedgerRow>();
  const q = queries(db).selectFrom(TABLES.ledger).where("entity", "=", "chore").where("to_state", "=", "done");
  for (const l of q.all()) {
    const seen = last.get(l.entity_id);
    if (seen === undefined || rowid(l) > rowid(seen)) last.set(l.entity_id, l);
  }
  return last;
}

/** The sentence on each chore's refusal row. Guarded, because a workspace whose migrations
 *  stopped before 009 has no such table and the board still has to render. */
const refusalWhys = (db: DatabaseSync): ReadonlyMap<number, string> =>
  !hasTable(db, "chore_refusal")
    ? new Map<number, string>()
    : new Map(queries(db).selectFrom(TABLES.refusal).all().map((r) => [r.chore_id, r.why]));

/** How a chore came to be `done`. Two different facts wearing one state.
 *
 *  `performed` is a worker's: somebody begun the chore, did the work and proved the check.
 *  `closed` is the world's: the condition the chore was raised for went away on its own —
 *  the story landed, the branch stopped conflicting — and nothing was owed any more. Both
 *  are legitimate ends and both stay on the record, but only the first is work carried out,
 *  and a count that adds them together is a claim nobody made.
 *
 *  It is not a column, because it is not a new fact: the ledger already wrote which verb
 *  settled the chore — `finish` from `running`, or `close` from wherever it was sitting. */
export type ChoreSettlement = "performed" | "closed";

const SETTLED_BY: Readonly<Record<string, ChoreSettlement>> = { finish: "performed", close: "closed" };

/** The board's word for each, and the state a settled chore is shown under. `done` keeps
 *  its meaning — a worker proved it — and a closure says it was a closure. */
export const SETTLEMENT_STATE: Readonly<Record<ChoreSettlement, string>> = {
  performed: "done",
  closed: "closed",
};

/** What the board says of a chore closed with no reason on it. A closure is always written
 *  with one, so this is what a pre-`closeChore` row reads as rather than a blank. */
export const CLOSED_WITHOUT_REASON = "closed · the condition no longer held";

export interface ChoreSettled {
  readonly id: number;
  readonly settlement: ChoreSettlement;
  /** Why this chore is over. A performed chore's is the check it proved; a closed one's is
   *  the epitaph the runner read the world by, kept on its `chore_refusal` row. */
  readonly why: string;
  /** When the verb that settled it was applied. */
  readonly at: string;
}

/** How a settled chore was settled, and why — or null if it is not settled at all.
 *
 *  Read from the last ledger row that took the chore into `done`, because a chore comes
 *  back: `reprove` returns it to `planned` and it may be closed this pass having been
 *  performed the last. The most recent settling verb is the one the row is standing on. */
export function choreSettled(db: DatabaseSync, id: number): ChoreSettled | null {
  const row = choreById(db, id);
  if (row === null || row.state !== "done") return null;
  const settled = ledgerFor(db, id)
    .filter((l) => l.to_state === "done")
    .at(-1);
  if (settled === undefined) return null;
  const settlement = SETTLED_BY[settled.verb];
  if (settlement === undefined) return null;
  const why = settlement === "performed" ? row.check : (choreRefusal(db, id)?.why ?? CLOSED_WITHOUT_REASON);
  return { id, settlement, why, at: settled.at };
}

/** Every chore that is over, with how it ended and why, in the board's shape.
 *
 *  Not folded into `openChores`: an operator scanning the board wants the work still owed
 *  in one place. But a settled chore does not vanish either — the row is history, and a
 *  chore that was raised truthfully stays raised — so it is shown here, under the state
 *  that says which kind of ending it had. */
export function settledChores(db: DatabaseSync, project: number | null = null): readonly Row[] {
  const rows = choresWhere(db, "done", "=", project);
  const what = whatOf(db);
  const verbs = settlingVerbs(db);
  const whys = refusalWhys(db);

  return rows.map((r) => {
    const settlement = SETTLED_BY[verbs.get(r.id)?.verb ?? ""] ?? "performed";
    return {
      id: r.id,
      what: what(r),
      state: SETTLEMENT_STATE[settlement],
      detail: settlement === "performed" ? r.check : (whys.get(r.id) ?? CLOSED_WITHOUT_REASON),
    };
  });
}

/** How many chores a worker actually carried out. The count the board reports, and the
 *  reason `settledChores` distinguishes at all: a closure is an ending, not an effort. */
export const choresPerformed = (rows: readonly Row[]): number =>
  rows.filter((r) => r.state === SETTLEMENT_STATE.performed).length;

/** Everything not done, in the board's shape. A chore that is waiting for approval says so
 *  where the reason a task is not running is said: in the detail.
 *
 *  A chore with an assignment open on it reads `running` whatever the column says. The
 *  assignment is the fact — somebody is in a tree on it — and on 15 Sep the board showed
 *  chore 2 as `planned` while assignment 271 ran it, because the row and the assignment
 *  were two answers to one question. There is one answer, and the assignment gives it. */
export function openChores(db: DatabaseSync, project: number | null = null): readonly Row[] {
  const rows = choresWhere(db, "done", "!=", project);
  const what = whatOf(db);
  const attempting = attemptedIds(db);
  const begun = beginsPerChore(db);

  return rows.map((r) => {
    const state = attempting.has(r.id) ? "running" : r.state;
    const attempts = begun.get(r.id) ?? 0;
    return {
      id: r.id,
      what: what(r),
      state,
      detail:
        state === "planned" && CHORE_KIND_DEFS[r.kind].needs_approval && r.approved_at === null
          ? WAITING_FOR_APPROVAL
          : attemptDetail({ attempts, max_retry: CHORE_KIND_DEFS[r.kind].max_retry }, r.check),
    };
  });
}

/** The board, with the work wecode owes itself on it.
 *
 *  docs/design/18: a chore is "not silent — it appears on the board as itself, with its
 *  kind and its target". This wraps board() rather than living inside it because the chore
 *  entity is the one thing board.ts does not know about; index.ts exports this as `board`,
 *  so every client gets the group without asking for it. */
export interface ChoreBoard extends Board {
  readonly chores: readonly Row[];
  /** Chores that are over, each saying whether a worker proved it (`done`) or the world
   *  moved and it was closed (`closed`). Two endings, one state in the column, and the
   *  board is where they have to be told apart: `chores_performed` is a claim about work
   *  that was carried out, so it counts only the first. */
  readonly settled: readonly Row[];
  readonly chores_performed: number;
}

export function board(db: DatabaseSync, project: number | null = null): ChoreBoard {
  const settled = settledChores(db, project);
  return {
    ...groups(db, project),
    chores: openChores(db, project),
    settled,
    chores_performed: choresPerformed(settled),
  };
}
