import type { DatabaseSync } from "node:sqlite";
import { board as groups, type Board, type Row } from "./board.js";
import { isTerminal, transitionFor } from "./machines.js";
import { now, transact } from "./store.js";
import type { Machine } from "./types.js";

/** docs/design/18. Work wecode needs done, created deterministically by wecode and
 *  performed by a system worker. It is not a task because it proves no acceptance_test:
 *  merging a story into the base branch makes no criteria true. It is still work, so it
 *  still needs a record — a kind, a target, a check and a state. */

export class ChoreError extends Error {}

/** A kind is a name, a condition, a role and a check — never a switch statement. Only the
 *  two wecode needs now are declared; adding `heal` or `deploy` is a row here.
 *
 *  This table and CHORE_MACHINE below belong in packages/core/config/machines.yaml with
 *  every other machine. They are literals here only because loadMachines() rejects any
 *  top-level key that is not in STATEFUL, and types.ts is outside this task's scope. */
export const CHORE_KINDS = ["merge", "sweep"] as const;
export type ChoreKind = (typeof CHORE_KINDS)[number];

export interface ChoreKindDef {
  /** A chore runs under `system`, the only role wide enough for work whose files are
   *  wherever the conflict is. */
  readonly role: string;
  /** Whether a person must say go before it may leave `planned`. */
  readonly needs_approval: boolean;
}

/** `merge` needs no approval: wecode has already tried the deterministic merge and it
 *  failed, so the chore is the retry, and asking would only add a person to a queue.
 *  `sweep` rewrites work that is already on the record, which is not wecode's to decide
 *  alone — and neither is `heal`, when it arrives. */
export const CHORE_KIND_DEFS: Readonly<Record<ChoreKind, ChoreKindDef>> = {
  merge: { role: "system", needs_approval: false },
  sweep: { role: "system", needs_approval: true },
};

/** What a chore is about. A chore always serves a project; `project` is a target only when
 *  the project itself is the thing worked on. */
export const CHORE_TARGETS = ["story", "project"] as const;
export type ChoreTarget = (typeof CHORE_TARGETS)[number];

/** planned → ready → running → done, and failed beside it.
 *
 *  `failed` is not terminal: a merge that could not be made today can be made once the
 *  branch it fought with has moved. `done` is, because the condition that created the
 *  chore is gone by then, and the unique key means nothing will create it again. */
export const CHORE_MACHINE: Machine = {
  states: ["planned", "ready", "running", "done", "failed"],
  initial: "planned",
  terminal: ["done"],
  transitions: [
    { verb: "start", from: ["planned"], to: "ready" },
    { verb: "begin", from: ["ready"], to: "running" },
    { verb: "finish", from: ["running"], to: "done" },
    { verb: "fail", from: ["running"], to: "failed" },
    { verb: "retry", from: ["failed"], to: "ready" },
  ],
};

export interface Chore {
  readonly id: number;
  readonly slug: string;
  readonly kind: ChoreKind;
  readonly project_id: number;
  readonly target_type: ChoreTarget;
  readonly target_id: number;
  readonly check: string;
  readonly state: string;
  readonly approved_at: string | null;
  readonly approved_by: string | null;
}

export interface ChoreSpec {
  readonly project_id: number;
  readonly kind: ChoreKind;
  readonly target_type: ChoreTarget;
  readonly target_id: number;
  readonly check: string;
}

/** `check` is a SQL keyword; every read of the column quotes it and renames it. */
const COLUMNS =
  `id, slug, kind, project_id, target_type, target_id, "check" AS "check", state, approved_at, approved_by`;

const slugOf = (s: ChoreSpec): string => `${s.kind}-${s.target_type}-${s.target_id}`;

/** The chore for this condition, creating it if it is not there yet.
 *
 *  Idempotent on purpose. The runner is level-triggered: it re-reads the condition on every
 *  tick, and the condition stays true until the chore is done. Returning the chore that is
 *  already there — rather than throwing, or inserting a second — is what makes "a story
 *  that will not merge" one row instead of one row a tick. */
export function ensureChore(db: DatabaseSync, spec: ChoreSpec): Chore {
  const found = choreFor(db, spec.kind, spec.target_type, spec.target_id);
  if (found !== null) return found;

  const at = now();
  db.prepare(
    `INSERT INTO chore (slug, kind, project_id, target_type, target_id, "check", state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, target_type, target_id) DO NOTHING`,
  ).run(slugOf(spec), spec.kind, spec.project_id, spec.target_type, spec.target_id, spec.check, CHORE_MACHINE.initial, at, at);

  const made = choreFor(db, spec.kind, spec.target_type, spec.target_id);
  if (made === null) throw new ChoreError(`chore ${slugOf(spec)} was neither created nor found`);
  return made;
}

export function choreFor(
  db: DatabaseSync,
  kind: ChoreKind,
  target_type: ChoreTarget,
  target_id: number,
): Chore | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM chore WHERE kind = ? AND target_type = ? AND target_id = ?`)
    .get(kind, target_type, target_id) as Chore | undefined;
  return row ?? null;
}

export function choreById(db: DatabaseSync, id: number): Chore | null {
  return (db.prepare(`SELECT ${COLUMNS} FROM chore WHERE id = ?`).get(id) as Chore | undefined) ?? null;
}

export type ChoreOutcome =
  | { readonly ok: true; readonly from: string; readonly to: string }
  | { readonly ok: false; readonly why: string };

/** A person says go. Recorded rather than acted on: approving a chore does not start it,
 *  it only removes the reason it may not be started. */
export function approveChore(db: DatabaseSync, id: number, by: string): ChoreOutcome {
  const chore = choreById(db, id);
  if (chore === null) return { ok: false, why: `no chore #${id}` };
  if (!CHORE_KIND_DEFS[chore.kind].needs_approval) {
    return { ok: false, why: `a ${chore.kind} chore does not wait for approval` };
  }
  const at = now();
  db.prepare("UPDATE chore SET approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?").run(at, by, at, id);
  return { ok: true, from: chore.state, to: chore.state };
}

/** Apply a verb to a chore, and append it to the ledger.
 *
 *  Chore does not go through Engine: Engine walks the tree of stateful entities that
 *  cascade into one another, and a chore has no parent to settle. The machine is still
 *  read the same way — a verb that is not legal here is refused with what is. */
export function applyChore(db: DatabaseSync, id: number, verb: string, actor: string): ChoreOutcome {
  const chore = choreById(db, id);
  if (chore === null) return { ok: false, why: `no chore #${id}` };

  const from = chore.state;
  const transition = transitionFor(CHORE_MACHINE, from, verb);
  if (transition === undefined) {
    if (isTerminal(CHORE_MACHINE, from)) return { ok: false, why: `${from} is terminal; nothing may be done to it` };
    const verbs = [...new Set(CHORE_MACHINE.transitions.filter((t) => t.from.includes(from)).map((t) => t.verb))];
    return { ok: false, why: `${verb} is not legal from ${from}. Legal here: ${verbs.join(", ")}` };
  }

  // The one guard a chore has. A chore nobody approved is not a chore nobody may see: it
  // sits on the board in `planned`, saying what it is waiting for.
  if (verb === "start" && CHORE_KIND_DEFS[chore.kind].needs_approval && chore.approved_at === null) {
    return { ok: false, why: `a ${chore.kind} chore needs approval before it starts` };
  }

  const at = now();
  transact(db, () => {
    db.prepare("UPDATE chore SET state = ?, updated_at = ? WHERE id = ?").run(transition.to, at, id);
    db.prepare(
      `INSERT INTO ledger (entity, entity_id, verb, from_state, to_state, actor, at)
       VALUES ('chore', ?, ?, ?, ?, ?, ?)`,
    ).run(id, verb, from, transition.to, actor, at);
  });
  return { ok: true, from, to: transition.to };
}

/** Everything not done, in the board's shape. A chore that is waiting for approval says so
 *  where the reason a task is not running is said: in the detail. */
export function openChores(db: DatabaseSync, project: number | null = null): readonly Row[] {
  const rows = db
    .prepare(
      `SELECT c.id AS id,
              c.kind || ' ' || c.target_type || ' ' || coalesce(s.title, p.name, c.target_id) AS what,
              c.state AS state,
              c."check" AS "check",
              c.kind AS kind,
              c.approved_at AS approved_at
         FROM chore c
         LEFT JOIN story s ON s.id = c.target_id AND c.target_type = 'story'
         LEFT JOIN project p ON p.id = c.target_id AND c.target_type = 'project'
        WHERE c.state <> 'done'
          AND (:project IS NULL OR c.project_id = :project)
        ORDER BY c.id`,
    )
    .all({ project }) as unknown as {
      id: number;
      what: string;
      state: string;
      check: string;
      kind: ChoreKind;
      approved_at: string | null;
    }[];

  return rows.map((r) => ({
    id: r.id,
    what: r.what,
    state: r.state,
    detail:
      r.state === "planned" && CHORE_KIND_DEFS[r.kind].needs_approval && r.approved_at === null
        ? "waiting for approval"
        : r.check,
  }));
}

/** The board, with the work wecode owes itself on it.
 *
 *  docs/design/18: a chore is "not silent — it appears on the board as itself, with its
 *  kind and its target". This wraps board() rather than living inside it because the chore
 *  entity is the one thing board.ts does not know about; index.ts exports this as `board`,
 *  so every client gets the group without asking for it. */
export interface ChoreBoard extends Board {
  readonly chores: readonly Row[];
}

export function board(db: DatabaseSync, project: number | null = null): ChoreBoard {
  return { ...groups(db, project), chores: openChores(db, project) };
}
