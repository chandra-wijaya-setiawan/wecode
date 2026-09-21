import type { DatabaseSync } from "node:sqlite";
import { choreFor } from "./chore/record.js";
import type { AssignmentRow, ChoreRow, LedgerRow, RefusalRow } from "./chore/rows.js";
import { excluded, queries, table } from "./db.js";
import { now } from "./store.js";
import type { Machine } from "./types.js";

/** docs/design/18. Work wecode needs done, created deterministically by wecode and
 *  performed by a system worker. It is not a task because it proves no acceptance_test:
 *  merging a story into the base branch makes no criteria true. It is still work, so it
 *  still needs a record — a kind, a target, a check and a state. */

export class ChoreError extends Error {}

/** The conditions — when a chore is owed, owed again, or no longer owed — live in
 *  chore/raise.ts and come back out through here. index.ts re-exports this module and
 *  nothing under it, so a client that asks core for `ensureChore` still gets it, and the
 *  split is this module's business rather than every caller's. */
export { closeChore, ensureChore, reraiseChore } from "./chore/raise.js";

/** The rest of the module, for the same reason and on the same terms. What is left here is
 *  the record itself — the kinds, the machine, the tables and the one write that needs the
 *  insert's shape — and everything built on it is under `chore/`: the reads every consumer
 *  shares (`chore/reads.ts`), the verbs (`chore/record.ts`), what an operator sees
 *  (`chore/view.ts`), what the allocator may hand out (`chore/allocation.ts`) and why a
 *  chore is not moving (`chore/refusal.ts`).
 *
 *  Each of those imports this module back. The cycle is a module cycle only: every binding
 *  they take from here is read inside a function body, never while they are evaluating. */
export { isAttempted } from "./chore/reads.js";
export {
  applyChore,
  approveChore,
  choreAttempts,
  choreById,
  choreFor,
  ChoreVerbs,
  outOfAttempts,
  type ChoreAttempts,
  type ChoreOutcome,
} from "./chore/record.js";
export { choreCandidates, choreRole } from "./chore/allocation.js";
export {
  clearChoreRefusal,
  choreRefusal,
  recordChoreRefusal,
  writeChoreRefusal,
  type ChoreRefusal,
} from "./chore/refusal.js";
export {
  board,
  choresPerformed,
  choreSettled,
  CLOSED_WITHOUT_REASON,
  openChores,
  settledChores,
  SETTLEMENT_STATE,
  WAITING_FOR_APPROVAL,
  type ChoreBoard,
  type ChoreSettled,
  type ChoreSettlement,
} from "./chore/view.js";

/** A kind is a name, a condition, a role and a check — never a switch statement. Only the
 *  two wecode needs now are declared; adding `heal` or `deploy` is a row here.
 *
 *  This table and CHORE_MACHINE below belong in packages/core/config/machines.yaml with
 *  every other machine. They are literals here only because loadMachines() rejects any
 *  top-level key that is not in STATEFUL, and types.ts is outside this task's scope. */
export const CHORE_KINDS = ["merge", "refresh", "land", "sweep"] as const;
export type ChoreKind = (typeof CHORE_KINDS)[number];

export interface ChoreKindDef {
  /** A chore runs under `system`, the only role wide enough for work whose files are
   *  wherever the conflict is. */
  readonly role: string;
  /** Whether a person must say go before it may leave `planned`. */
  readonly needs_approval: boolean;
  /** How many attempts this kind gets before a chore that keeps failing its check stops
   *  being raised again. A task's ceiling is a column because a person may raise one task's
   *  and not another's; a chore's belongs to the kind, because nobody creates a chore. */
  readonly max_retry: number;
  /** Who makes the attempt. `worker` is the ordinary shape — an assignment, a tree, a
   *  session — and `runner` is the kind wecode performs itself, because the work is a git
   *  merge nobody needs an agent's judgement for and the tree it happens in is not one an
   *  agent may be put in. A `runner` kind is never a candidate: handing it to a worker
   *  would cut a story tree for a merge that cannot be made there. */
  readonly performer: "worker" | "runner";
}

/** A kind whose attempts are wecode's own. Asked rather than compared, so the rule reads
 *  the same at the three places that need it. */
export const performedByTheRunner = (kind: ChoreKind): boolean => CHORE_KIND_DEFS[kind].performer === "runner";

/** `merge` needs no approval: wecode has already tried the deterministic merge and it
 *  failed, so the chore is the retry, and asking would only add a person to a queue.
 *  `refresh` is the same shape the other way round — the base has moved and a story tree
 *  in flight is behind it, wecode has already tried the merge, and the chore is the retry.
 *  `land` is the third of that family and the same rule again: a delivered story reaching
 *  the base is a merge the gate has already permitted, so the runner makes it inline and
 *  the chore is what is left when it could not — the reason, on the board, with the
 *  attempts behind it. Asking a person first would be asking them to approve the merge they
 *  already approved by delivering the story.
 *  `sweep` rewrites work that is already on the record, which is not wecode's to decide
 *  alone — and neither is `heal`, when it arrives. */
export const CHORE_KIND_DEFS: Readonly<Record<ChoreKind, ChoreKindDef>> = {
  merge: { role: "system", needs_approval: false, max_retry: 3, performer: "worker" },
  refresh: { role: "system", needs_approval: false, max_retry: 3, performer: "worker" },
  land: { role: "system", needs_approval: false, max_retry: 3, performer: "runner" },
  sweep: { role: "system", needs_approval: true, max_retry: 3, performer: "worker" },
};

/** What a chore is about. A chore always serves a project; `project` is a target only when
 *  the project itself is the thing worked on. */
export const CHORE_TARGETS = ["story", "project"] as const;
export type ChoreTarget = (typeof CHORE_TARGETS)[number];

/** planned → ready → running → done, and failed beside it.
 *
 *  Neither `failed` nor `done` is a memo about the past. A chore's state is a claim about
 *  the world now, and the world moves both ways: a merge that could not be made today can
 *  be made once the branch it fought with has moved, and a story whose branch merged
 *  cleanly can fall behind the base the moment the story beside it lands. So `reprove`
 *  comes back from `done` as well as from `failed`, and `close` goes to `done` from every
 *  state nobody is working in. `done` stays terminal in the machine's sense — no attempt
 *  may be begun there, and nothing is owed — but it is not beyond wecode re-reading the
 *  condition and saying otherwise. */
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
    { verb: "reprove", from: ["failed", "done"], to: "planned" },
    { verb: "close", from: ["planned", "ready", "failed"], to: "done" },
  ],
};

/** Every verb the chore machine has, declared beside it. `facade.ts` is generated from
 *  machines.yaml and chore is not in there (see CHORE_MACHINE above), so chore carries its
 *  own typed surface — `ChoreVerbs` in chore/record.ts — and this is the list both are held
 *  against. `chore-verbs-cover-the-machine` in the facade test fails if a transition is
 *  added here and not there. */
export const CHORE_VERBS = ["start", "begin", "finish", "fail", "retry", "reprove", "close"] as const;
export type ChoreVerb = (typeof CHORE_VERBS)[number];

/** The one verb a guard names, spelled as the machine spells it. */
export const START: ChoreVerb = "start";

/** The edge back. `retry` is a person's — it puts a failed chore straight in the queue.
 *  `reprove` is wecode's: it returns the chore to `planned`, where a raised chore starts,
 *  so a kind that waits for approval waits for it again rather than inheriting the go that
 *  was given to the attempt that failed. */
export const REPROVE: ChoreVerb = "reprove";

/** The edge out, and wecode's alone: the condition the chore was raised for is no longer
 *  true, so the chore is over whether or not anybody ever performed it. `running` is left
 *  out on purpose — a worker is in a tree on it, and `finish` or `fail` is that attempt's
 *  to say. */
export const CLOSE: ChoreVerb = "close";

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

/** The tables this module touches, declared once. `check` needs no special handling here —
 *  the dialect quotes every identifier it writes, so the SQL keyword that had to be spelled
 *  `"check" AS "check"` in every statement is now just a column name.
 *
 *  The row behind each is in `chore/rows.ts`, so a consumer can read a row's shape without
 *  importing the table. The declarations themselves stay here and only here: a table
 *  declared in two modules is two answers to what a column list is, and
 *  `typed-chore.test.ts` holds each of these against `PRAGMA table_info`. */
const chore = table<ChoreRow>("chore", [
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
  "created_at",
  "updated_at",
]);

const ledger = table<LedgerRow>("ledger", [
  "id",
  "entity",
  "entity_id",
  "verb",
  "from_state",
  "to_state",
  "actor",
  "at",
]);

const refusal = table<RefusalRow>("chore_refusal", ["chore_id", "why", "at", "since", "passes"]);

const assignment = table<AssignmentRow>("assignment", ["objective_type", "objective_id", "phase"]);

/** The target's own title, which used to arrive through two outer joins. */
const story = table<{ id: number; title: string }>("story", ["id", "title"]);
const project = table<{ id: number; name: string }>("project", ["id", "name"]);

/** The six, handed to the modules under `chore/` as one object.
 *
 *  They are consumed rather than re-declared: the record is one thing, and the split moved
 *  the consumers out of this file, not the tables. */
export const TABLES = { chore, ledger, refusal, assignment, story, project } as const;

const slugOf = (s: ChoreSpec): string => `${s.kind}-${s.target_type}-${s.target_id}`;

/** Write the row for a chore that is not there yet, and answer with it.
 *
 *  The write, and none of the deciding: whether a chore is owed at all is `ensureChore`'s
 *  in chore/raise.ts, and this is what it calls once it has decided. Kept here because the
 *  insert's shape is the declaration above, and the two must not drift.
 *
 *  On a clash the dialect writes over the row it found rather than ignoring it, so the
 *  loser of the race writes the slug it was already going to write: the slug is derived
 *  from the conflict key itself, so `slug = excluded.slug` leaves the row it found exactly
 *  as it was. What the clause is for is unchanged — two runners reading one condition in
 *  the same tick make one chore, and neither of them raises. */
export function insertChore(db: DatabaseSync, spec: ChoreSpec): Chore {
  const at = now();
  queries(db)
    .insertInto(chore, {
      slug: slugOf(spec),
      kind: spec.kind,
      project_id: spec.project_id,
      target_type: spec.target_type,
      target_id: spec.target_id,
      check: spec.check,
      state: CHORE_MACHINE.initial,
      approved_at: null,
      approved_by: null,
      created_at: at,
      updated_at: at,
    })
    .onConflict(["kind", "target_type", "target_id"], { slug: excluded<ChoreRow>("slug") })
    .run();

  const made = choreFor(db, spec.kind, spec.target_type, spec.target_id);
  if (made === null) throw new ChoreError(`chore ${slugOf(spec)} was neither created nor found`);
  return made;
}
