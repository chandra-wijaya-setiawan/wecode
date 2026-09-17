import type { DatabaseSync } from "node:sqlite";
import { board as groups, hasTable, type Board, type Row } from "./board.js";
import { excluded, queries, table } from "./db.js";
import type { Budget, Scope } from "./entities.js";
import { isTerminal, transitionFor } from "./machines.js";
import type { Candidate } from "./order.js";
import type { RoleConfig } from "./roles.js";
import { now, transact } from "./store.js";
import type { Machine, Refusal } from "./types.js";

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
 *  own typed surface — `ChoreVerbs` below — and this is the list both are held against.
 *  `chore-verbs-cover-the-machine` in the facade test fails if a transition is added here
 *  and not there. */
export const CHORE_VERBS = ["start", "begin", "finish", "fail", "retry", "reprove", "close"] as const;
export type ChoreVerb = (typeof CHORE_VERBS)[number];

/** The one verb a guard in this module names, spelled as the machine spells it. */
const START: ChoreVerb = "start";

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
 *  `kind` and `target_type` are declared as their unions rather than as `string`: the column
 *  holds nothing else, `CHORE_KIND_DEFS[chore.kind]` has always assumed so, and declaring it
 *  means a `where("kind", "=", "merg")` is a typecheck failure rather than a query that
 *  matches nothing. `typed-chore.test.ts` holds each column list against `PRAGMA table_info`.
 *
 *  `id` is optional because the same declaration is the insert's shape, and a chore's id is
 *  SQLite's to give. Every read goes through `whole`, which insists on it. */
interface ChoreRow {
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

interface LedgerRow {
  id?: number;
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
}
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

interface RefusalRow {
  chore_id: number;
  why: string;
  at: string;
  since: string;
  passes: number;
}
const refusal = table<RefusalRow>("chore_refusal", ["chore_id", "why", "at", "since", "passes"]);

const assignment = table<{ objective_type: string; objective_id: number; phase: string }>("assignment", [
  "objective_type",
  "objective_id",
  "phase",
]);

/** The target's own title, which used to arrive through two outer joins. */
const story = table<{ id: number; title: string }>("story", ["id", "title"]);
const project = table<{ id: number; name: string }>("project", ["id", "name"]);

/** What a chore row is read as: the record's columns, minus the stamps nobody outside asks
 *  for. One list, so the shape of `Chore` and the columns fetched cannot drift. */
const FIELDS = [
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

type ChoreFields = Pick<ChoreRow, (typeof FIELDS)[number]>;

/** A row's id, insisted on rather than assumed. The column is `INTEGER PRIMARY KEY` and
 *  cannot be null, so this never fires — but it is what makes an optional `id` on the
 *  declaration safe, instead of a cast that says "trust me" over every read. */
const rowid = (r: { readonly id?: number }): number => {
  if (r.id === undefined) throw new ChoreError("a row came back from the database without its id");
  return r.id;
};

const whole = (r: ChoreFields | null): Chore | null => (r === null ? null : { ...r, id: rowid(r) });

/** An assignment nobody has finished with. order.ts holds the same list for the same
 *  reason; the two meet in the same three names until one module can import the other
 *  without a cycle. */
const OPEN_PHASES: readonly string[] = ["pending", "running", "waiting"];

const slugOf = (s: ChoreSpec): string => `${s.kind}-${s.target_type}-${s.target_id}`;

/** Every ledger row this chore has, oldest first. Its verbs are the only record of how many
 *  attempts a chore has had and of which verb settled it, and both answers come from one
 *  read rather than from a count and a sort-and-cap the dialect cannot spell. */
const ledgerFor = (db: DatabaseSync, id: number): readonly LedgerRow[] =>
  queries(db)
    .selectFrom(ledger)
    .where("entity", "=", "chore")
    .where("entity_id", "=", id)
    .all()
    .sort((a, b) => rowid(a) - rowid(b));

/** Chore ids something is attempting right now. */
const attemptedIds = (db: DatabaseSync): ReadonlySet<number> =>
  new Set(
    queries(db)
      .selectFrom(assignment)
      .where("objective_type", "=", "chore")
      .all()
      .filter((a) => OPEN_PHASES.includes(a.phase))
      .map((a) => a.objective_id),
  );

/** How many times a worker has begun each chore, from the ledger. One read for the whole
 *  board, where each row used to carry its own correlated subquery. */
const beginsPerChore = (db: DatabaseSync): ReadonlyMap<number, number> => {
  const counted = new Map<number, number>();
  for (const l of queries(db).selectFrom(ledger).where("entity", "=", "chore").where("verb", "=", "begin").all()) {
    counted.set(l.entity_id, (counted.get(l.entity_id) ?? 0) + 1);
  }
  return counted;
};

/** The chores of one state, or of every project when `project` is null — the two shapes the
 *  `:project IS NULL OR project_id = :project` clause had, told apart here. */
function choresWhere(db: DatabaseSync, state: string, op: "=" | "!=", project: number | null): readonly Chore[] {
  const base = queries(db).selectFrom(chore).select(FIELDS).where("state", op, state);
  const q = project === null ? base : base.where("project_id", "=", project);
  return q
    .all()
    .map((r) => ({ ...r, id: rowid(r) }))
    .sort((a, b) => a.id - b.id);
}

/** What an operator reads for a chore's target: the story's title, the project's name, or
 *  the bare id when the row the chore names is not there. */
function whatOf(db: DatabaseSync): (c: Chore) => string {
  const q = queries(db);
  const titles = new Map(q.selectFrom(story).all().map((s) => [s.id, s.title]));
  const names = new Map(q.selectFrom(project).all().map((p) => [p.id, p.name]));
  return (c) => {
    const named = c.target_type === "story" ? titles.get(c.target_id) : names.get(c.target_id);
    return `${c.kind} ${c.target_type} ${named ?? c.target_id}`;
  };
}

/** The chore for this condition, creating it if it is not there yet.
 *
 *  Idempotent on purpose. The runner is level-triggered: it re-reads the condition on every
 *  tick, and the condition stays true until the chore is done. Returning the chore that is
 *  already there — rather than throwing, or inserting a second — is what makes "a story
 *  that will not merge" one row instead of one row a tick. */
export function ensureChore(db: DatabaseSync, spec: ChoreSpec, by = "runner"): Chore {
  const found = choreFor(db, spec.kind, spec.target_type, spec.target_id);
  if (found !== null) {
    // The one place a settled chore stops being a dead end. Being here at all is the caller
    // saying the condition is true — that is what `ensureChore` means — so the chore goes
    // back to `planned` and is raised again. `done` as much as `failed`: a chore that was
    // discharged and whose condition has come back is the same chore with a second pass,
    // not a memo about the merge that worked in March. Never on a timer, and never quietly:
    // the reraise is a ledger row, and the attempts behind it stay on the record.
    if (found.state === "failed" || found.state === "done") reraiseChore(db, found.id, by);
    return choreById(db, found.id) ?? found;
  }

  const at = now();
  // On a clash the dialect writes over the row it found rather than ignoring it, so the
  // loser of the race writes the
  // slug it was already going to write: the slug is derived from the conflict key itself, so
  // `slug = excluded.slug` leaves the row it found exactly as it was. What the clause is for
  // is unchanged — two runners reading one condition in the same tick make one chore, and
  // neither of them raises.
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

export function choreFor(
  db: DatabaseSync,
  kind: ChoreKind,
  target_type: ChoreTarget,
  target_id: number,
): Chore | null {
  return whole(
    queries(db)
      .selectFrom(chore)
      .select(FIELDS)
      .where("kind", "=", kind)
      .where("target_type", "=", target_type)
      .where("target_id", "=", target_id)
      .get(),
  );
}

export function choreById(db: DatabaseSync, id: number): Chore | null {
  return whole(queries(db).selectFrom(chore).select(FIELDS).where("id", "=", id).get());
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
  queries(db).update(chore).set({ approved_at: at, approved_by: by, updated_at: at }).where("id", "=", id).run();
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
    q.update(chore).set({ state: transition.to, updated_at: at }).where("id", "=", id).run();
    q.insertInto(ledger, {
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

/** Put a settled chore back to `planned`, because the condition that made it is true again.
 *
 *  The caller's presence is the proof: `ensureChore` is only reached from a runner that has
 *  just re-read the condition. So this refuses on everything else — `planned`, `ready` and
 *  `running` have nothing to come back from, because they never left — and one that has
 *  used its attempts is drift for the doctor to name rather than a loop to keep turning.
 *
 *  The attempts stay: a reraised chore is on its second pass, and the board says so. That
 *  is the point of reraising rather than deleting the row and letting `ensureChore` insert
 *  a fresh one, which would lose every attempt and read as if this were the first time. */
export function reraiseChore(db: DatabaseSync, id: number, by = "runner"): ChoreOutcome {
  const row = choreById(db, id);
  if (row === null) return { ok: false, why: `no chore #${id}` };
  if (row.state !== "failed" && row.state !== "done") {
    return { ok: false, why: `a ${row.state} chore is not waiting to be raised again` };
  }

  const tries = choreAttempts(db, id);
  if (tries !== null && tries.attempts >= tries.max_retry) {
    return { ok: false, why: outOfAttempts(tries) };
  }
  const out = new ChoreVerbs(db).reprove(id, by);
  // Whatever was last said about why this chore was not being handed out is about a world
  // that has moved on. The reason it is back is the ledger row this just wrote.
  if (out.ok) clearChoreRefusal(db, id);
  return out;
}

/** Close a chore whose condition no longer holds.
 *
 *  The mirror of `reraiseChore`, and one rule with it: a chore's state is a claim about the
 *  world now. When the branch that would not merge merges, nothing is owed, and leaving the
 *  row in `failed` is a stale claim that the board keeps showing and the allocator keeps
 *  refusing. So the runner says so with a verb, and with the reason it read.
 *
 *  `max_retry` does not bear on this. Attempts bound how often wecode hands a chore out
 *  again; they say nothing about whether the work is still owed, and a chore out of
 *  attempts whose condition has gone is exactly the one most worth closing.
 *
 *  The reason is kept where a chore's other free text about itself is kept — `chore_refusal`,
 *  one row per chore — so `choreRefusal(db, id)` reads why a closed chore was closed. */
export function closeChore(db: DatabaseSync, id: number, why: string, by = "runner"): ChoreOutcome {
  if (choreById(db, id) === null) return { ok: false, why: `no chore #${id}` };

  const out = new ChoreVerbs(db).close(id, by);
  // Unguarded on purpose: this is not "passed over", it is the epitaph, and it has to stand
  // even when an assignment is still open on the chore. See `writeChoreRefusal`.
  if (out.ok) writeChoreRefusal(db, why, id);
  return out;
}

const outOfAttempts = (t: ChoreAttempts): string => `out of attempts · ${t.attempts} of ${t.max_retry}`;

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
  for (const l of queries(db).selectFrom(ledger).where("entity", "=", "chore").where("to_state", "=", "done").all()) {
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
    : new Map(queries(db).selectFrom(refusal).all().map((r) => [r.chore_id, r.why]));

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

/** The one wording for a chore nobody has said go to. The board shows it as a chore's
 *  detail and the allocator refuses with it, so both say the same thing. */
export const WAITING_FOR_APPROVAL = "waiting for approval";

/** A chore's role is its kind's role, and its scope and budget are that role's — a chore
 *  narrows nothing, because the files a merge conflict is in are wherever the conflict is.
 *  config/roles.yaml is the one definition of both, so this reads it rather than holding a
 *  copy — the caller hands in the loaded config. */
export function choreRole(kind: ChoreKind, roles: RoleConfig): { scope: Scope; budget: Budget } | null {
  const def = roles.roles[CHORE_KIND_DEFS[kind].role];
  return def === undefined ? null : { scope: def.scope, budget: def.budget };
}

/** Chores the allocator could choose, in id order.
 *
 *  A chore is a candidate when nothing is attempting it and it is neither `done` — the
 *  condition that made it is gone — nor `running` — somebody is on it. `planned` is
 *  included on purpose: that is where a chore wecode raised sits, and leaving it out is
 *  exactly the bug where three merge chores wait for ever for a state nobody sets.
 *
 *  A kind that needs approval and has none is not a candidate, and says so in the board's
 *  words rather than vanishing.
 *
 *  `roles` is what makes chores considered at all, and asking for it is deliberate rather
 *  than a convenience: a caller that cannot say where a chore's scope comes from is a
 *  caller that has not been taught chores, and handing it one would have it create a
 *  `task` assignment pointing at a chore id. With no roles the answer is empty — not one
 *  guessed scope, and not a refusal about a chore nobody asked about.
 */
export function choreCandidates(
  db: DatabaseSync,
  roles?: RoleConfig,
): { readonly candidates: readonly Candidate[]; readonly refused: readonly Refusal[] } {
  if (roles === undefined) return { candidates: [], refused: [] };

  // `NOT IN ('done','running')` and the `NOT EXISTS` are two set differences, taken here:
  // `done` is excluded by the query, and the other two by the sets the board reads anyway.
  const attempting = attemptedIds(db);
  const begun = beginsPerChore(db);
  const rows = choresWhere(db, "done", "!=", null).filter((c) => c.state !== "running" && !attempting.has(c.id));

  const candidates: Candidate[] = [];
  const refused: Refusal[] = [];
  for (const r of rows) {
    // A kind wecode performs itself is neither offered nor refused here. Not offered,
    // because there is no worker to offer it to; not refused, because a refusal is a
    // sentence about this pass and would write over the reason the chore is actually
    // carrying — the conflict its last attempt hit. It stays on the board saying that.
    if (performedByTheRunner(r.kind)) continue;
    const attempts = begun.get(r.id) ?? 0;
    const tries = { attempts, max_retry: CHORE_KIND_DEFS[r.kind].max_retry };
    // A chore that has failed its check as often as its kind allows is not handed out
    // again. It stays on the board saying so, which is the doctor's to name.
    if (tries.attempts >= tries.max_retry) {
      refused.push({ id: r.id, why: outOfAttempts(tries) });
      continue;
    }
    if (CHORE_KIND_DEFS[r.kind].needs_approval && r.approved_at === null) {
      refused.push({ id: r.id, why: WAITING_FOR_APPROVAL });
      continue;
    }
    const role = choreRole(r.kind, roles);
    if (role === null) continue;
    candidates.push({
      id: r.id,
      objective_type: "chore",
      title: `${r.kind} ${r.target_type} #${r.target_id}`,
      role: CHORE_KIND_DEFS[r.kind].role,
      scope: role.scope,
      budget: role.budget,
      attempts,
    });
  }
  return { candidates, refused };
}

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
 *  the shape a chore left `planned` by a failed `begin` is in. */
function writeChoreRefusal(db: DatabaseSync, why: string, choreId: number): void {
  // The upsert's two `CASE WHEN … = excluded.why` arms are the rule — the same sentence
  // keeps its `since` and counts a pass, a new one starts over — and the dialect spells no
  // CASE, so the rule is read and applied here. In a transaction, because the read of the
  // row and the write over it were one statement and must stay one act.
  transact(db, () => {
    const at = now();
    const seen = choreRefusal(db, choreId);
    const q = queries(db);
    if (seen === null) {
      q.insertInto(refusal, { chore_id: choreId, why, at, since: at, passes: 1 }).run();
      return;
    }
    const same = seen.why === why;
    q.update(refusal)
      .set({ why, at, since: same ? seen.since : at, passes: same ? seen.passes + 1 : 1 })
      .where("chore_id", "=", choreId)
      .run();
  });
}

export function clearChoreRefusal(db: DatabaseSync, choreId: number): void {
  queries(db).deleteFrom(refusal).where("chore_id", "=", choreId).run();
}

/** Is anything attempting this chore? The same question the board asks of every chore,
 *  asked of one, so the state the board shows and the guard on a refusal cannot differ. */
export function isAttempted(db: DatabaseSync, choreId: number): boolean {
  return (
    queries(db)
      .selectFrom(assignment)
      .where("objective_type", "=", "chore")
      .where("objective_id", "=", choreId)
      .all()
      .filter((a) => OPEN_PHASES.includes(a.phase)).length > 0
  );
}

export interface ChoreRefusal extends Refusal {
  readonly at: string;
  readonly since: string;
  readonly passes: number;
}

export function choreRefusal(db: DatabaseSync, choreId: number): ChoreRefusal | null {
  const row = queries(db).selectFrom(refusal).where("chore_id", "=", choreId).get();
  // `chore_id AS id`, in TypeScript: a Refusal is an id and a sentence whatever table the
  // sentence is kept in, and the rename is the only reason this is not the row itself.
  return row === null ? null : { id: row.chore_id, why: row.why, at: row.at, since: row.since, passes: row.passes };
}
