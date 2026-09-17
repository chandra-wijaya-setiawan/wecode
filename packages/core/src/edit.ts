import type { DatabaseSync } from "node:sqlite";
import { identity, NO_ACTOR, TWO_REASONS } from "./apply.js";
import { attributedTo, type Actor } from "./facade-gen.js";
import { excluded, queries, table, type Dialect } from "./db.js";
import type { Scope } from "./entities.js";
import { withinCeiling, type RoleConfig } from "./roles.js";
import { now, transact } from "./store.js";

export class EditError extends Error {}

/** Only the columns this module writes are declared. A table here is not a schema; it is
 *  the part of one the edit verbs speak about. */
interface Titled {
  readonly id: number;
  readonly title: string;
  readonly state: string;
  readonly updated_at: string;
}
interface Stated {
  readonly id: number;
  readonly statement: string;
  readonly state: string;
  readonly updated_at: string;
}
/** What both test tables carry that an edit may set. */
interface Test {
  readonly id: number;
  readonly artefact: string;
  readonly script_path: string | null;
  readonly updated_at: string;
}

const taskRow = table<{ id: number; role: string; scope: string; updated_at: string }>("task", [
  "id",
  "role",
  "scope",
  "updated_at",
]);
const scopeRefusal = table<{ task_id: number; paths: string; at: string }>("scope_refusal", [
  "task_id",
  "paths",
  "at",
]);
const ledger = table<{
  id?: number;
  entity: string;
  entity_id: number;
  verb: string;
  from_state: string;
  to_state: string;
  actor: string;
  at: string;
}>("ledger", ["id", "entity", "entity_id", "verb", "from_state", "to_state", "actor", "at"]);
/** The red-at-base verdict lives on the test row; the `red_at_base` table is the runner's
 *  own and is only there once a runner has made it. */
const acceptanceVerdict = table<{
  id: number;
  red_at_base_sha: string | null;
  red_at_base_at: string | null;
}>("acceptance_test", ["id", "red_at_base_sha", "red_at_base_at"]);
const redAtBase = table<{ test_id: number }>("red_at_base", ["test_id"]);
/** SQLite's own catalogue, declared like any other table so asking whether a table exists
 *  is a typed query rather than the one string that got to skip the check. */
const sqliteMaster = table<{ type: string; name: string }>("sqlite_master", ["type", "name"]);

const test = (name: string) => table<Test>(name, ["id", "artefact", "script_path", "updated_at"]);
const tests = { acceptance_test: test("acceptance_test"), task_test: test("task_test") };

type TestEntity = keyof typeof tests;

/** What restating one entity needs: its prose, read and written. The column is inside the
 *  closure rather than a name passed to a query, so it is checked against the table it
 *  belongs to at the point this lookup is written. */
interface Prose {
  readonly read: (q: Dialect, id: number) => { words: string; state: string } | null;
  readonly write: (q: Dialect, id: number, words: string, at: string) => void;
}

const titled = (name: string): Prose => {
  const t = table<Titled>(name, ["id", "title", "state", "updated_at"]);
  return {
    read: (q, id) => {
      const row = q.selectFrom(t).select(["title", "state"]).where("id", "=", id).get();
      return row === null ? null : { words: row.title, state: row.state };
    },
    write: (q, id, words, at) => {
      q.update(t).set({ title: words, updated_at: at }).where("id", "=", id).run();
    },
  };
};

const stated = (name: string): Prose => {
  const t = table<Stated>(name, ["id", "statement", "state", "updated_at"]);
  return {
    read: (q, id) => {
      const row = q.selectFrom(t).select(["statement", "state"]).where("id", "=", id).get();
      return row === null ? null : { words: row.statement, state: row.state };
    },
    write: (q, id, words, at) => {
      q.update(t).set({ statement: words, updated_at: at }).where("id", "=", id).run();
    },
  };
};

/** The entities that carry prose a person wrote, and the column it lives in. Anything not
 *  here has no words of its own to correct. */
export const RESTATABLE = {
  epic: "title",
  story: "title",
  requirement: "statement",
  acceptance_criteria: "statement",
  acceptance_test: "statement",
  task: "title",
  task_test: "statement",
} as const;

export type Restatable = keyof typeof RESTATABLE;

/** The same set, as the queries that reach each one's column. */
const PROSE: Record<Restatable, Prose> = {
  epic: titled("epic"),
  story: titled("story"),
  requirement: stated("requirement"),
  acceptance_criteria: stated("acceptance_criteria"),
  acceptance_test: stated("acceptance_test"),
  task: titled("task"),
  task_test: stated("task_test"),
};

export const isRestatable = (s: string): s is Restatable => s in RESTATABLE;

/** What the ledger row is refused for when there is nothing to say. */
export const NO_WORDS = "restate needs the new wording — there is nothing to say";

/** Rewrite the prose of a record in place, and put the old wording on the ledger.
 *
 *  This corrects words, never verdicts: the state column is read and written back
 *  unchanged, so the row the ledger gains has from_state === to_state and no reader of the
 *  history can mistake a correction for something having happened. There is deliberately no
 *  way to reach a state from here — `Engine.apply` is the only verb that moves one.
 *
 *  The slug is *not* recomputed. It is derived from the first wording and is the name of
 *  every worktree and branch cut for this record; a slug that followed the prose would
 *  orphan all of them, and that breakage is the reason the prose looked write-once in the
 *  first place. The slug names the record, the prose describes it, and only the second is
 *  a statement that can be wrong. */
export function restate(
  db: DatabaseSync,
  entity: Restatable,
  id: number,
  words: string,
  who: Actor,
): { was: string; now: string; state: string } {
  const text = words.trim();
  if (text === "") throw new EditError(NO_WORDS);

  // The actor is an identity here too. This verb's reason is the old wording and nothing
  // else, so a caller that packed a reason of its own is asking for one this row will not
  // keep — that is a refusal, not a silent second reason on the line.
  const said = identity(who);
  if (said.actor === "") throw new EditError(NO_ACTOR);
  if (said.reason !== null) throw new EditError(TWO_REASONS);

  const prose = PROSE[entity];
  const q = queries(db);
  return transact(db, () => {
    const row = prose.read(q, id);
    if (row === null) throw new EditError(`no ${entity} #${id}`);

    const at = now();
    prose.write(q, id, text, at);
    // Why this row exists, kept apart from who made it right up to the column that has to
    // hold both.
    const reason = `was "${row.words}"`;
    // from_state and to_state are the same state, on purpose: nothing happened to this
    // record, someone only said what it was more accurately.
    q.insertInto(ledger, {
      entity,
      entity_id: id,
      verb: "restate",
      from_state: row.state,
      to_state: row.state,
      actor: attributedTo(said.actor, reason),
      at,
    }).run();
    // What the prose was and is, and nothing more: `packages/core/test/typed-edit.test.ts`
    // holds this object exactly, and is outside this story's scope. The identity and the
    // reason are on the ledger row, which is where a reader of the history looks for them.
    return { was: row.words, now: text, state: row.state };
  });
}

/** Set a task's scope. Checked against its role's ceiling when one is loaded — a task may
 *  narrow a role and never exceed it. */
export function setTaskScope(
  db: DatabaseSync,
  id: number,
  scope: Scope,
  roles: RoleConfig | null = null,
): void {
  const q = queries(db);
  const row = q.selectFrom(taskRow).select(["role"]).where("id", "=", id).get();
  if (row === null) throw new EditError(`no task #${id}`);

  if (roles !== null) {
    const def = roles.roles[row.role];
    if (def === undefined) throw new EditError(`no role named ${row.role || "(none)"}`);
    const within = withinCeiling(def.scope, scope);
    if (!within.ok) throw new EditError(within.why);
  }

  q.update(taskRow).set({ scope: JSON.stringify(scope), updated_at: now() }).where("id", "=", id).run();
  // The refusal was a fact about the old scope. Whatever this one covers is no longer
  // something anybody is being refused, and a board still saying so sends the operator to
  // re-decide a decision they have just made.
  forgetCoveredRefusals(db, id, scope);
}

/** A path an attempt was refused permission to write, kept against the task.
 *
 *  Recorded, never acted on: widening a scope is the operator's verb, and the whole point
 *  is that they decide it knowing what was asked for. Repeated on every attempt, so the
 *  paths accumulate as a set and the same path twice is one row's worth of news.
 *
 *  The table arrives with migration 011; a workspace older than it has nothing to record
 *  against, which is not an error — see `scopeRefusals`. */
export function recordScopeRefusal(db: DatabaseSync, id: number, paths: readonly string[]): void {
  if (!hasScopeRefusal(db)) return;
  const wanted = paths.map((p) => p.trim()).filter((p) => p !== "");
  if (wanted.length === 0) return;
  const merged = [...new Set([...scopeRefusals(db, id), ...wanted])].sort();
  queries(db)
    .insertInto(scopeRefusal, { task_id: id, paths: JSON.stringify(merged), at: now() })
    .onConflict(["task_id"], {
      paths: excluded<{ paths: string }>("paths"),
      at: excluded<{ at: string }>("at"),
    })
    .run();
}

/** What this task stands refused. Empty for a task with nothing recorded, and for a
 *  workspace whose database predates the table. */
export function scopeRefusals(db: DatabaseSync, id: number): string[] {
  if (!hasScopeRefusal(db)) return [];
  const row = queries(db).selectFrom(scopeRefusal).select(["paths"]).where("task_id", "=", id).get();
  if (row === null) return [];
  const parsed: unknown = JSON.parse(row.paths);
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
}

/** Drop every recorded path this scope now covers, and the row with them when none is left.
 *
 *  Covered is asked of `withinCeiling` rather than of a second matcher: a path is a glob
 *  that matches itself, so "does this scope cover it" is exactly the question the ceiling
 *  check already answers, and two matchers that must agree is the defect. */
export function forgetCoveredRefusals(db: DatabaseSync, id: number, scope: Scope): void {
  if (!hasScopeRefusal(db)) return;
  const left = scopeRefusals(db, id).filter((p) => !withinCeiling(scope, { write: [p], tools: [] }).ok);
  const q = queries(db);
  if (left.length === 0) {
    q.deleteFrom(scopeRefusal).where("task_id", "=", id).run();
    return;
  }
  q.update(scopeRefusal).set({ paths: JSON.stringify(left), at: now() }).where("task_id", "=", id).run();
}

const hasTable = (db: DatabaseSync, name: string): boolean =>
  queries(db)
    .selectFrom(sqliteMaster)
    .select(["name"])
    .where("type", "=", "table")
    .where("name", "=", name)
    .get() !== null;

const hasScopeRefusal = (db: DatabaseSync): boolean => hasTable(db, "scope_refusal");

export function setTaskRole(db: DatabaseSync, id: number, role: string): void {
  const changed = queries(db)
    .update(taskRow)
    .set({ role, updated_at: now() })
    .where("id", "=", id)
    .run();
  if (changed.changes === 0) throw new EditError(`no task #${id}`);
}

/** What `artefact_resolves` says about a test with nothing to run. An empty artefact is
 *  refused here in the same words, because a test written with no command is the same
 *  unrunnable record whether it got that way at create time or by an edit. */
export const NO_ARTEFACT = "it has no artefact — there is nothing to run or to follow";

/** Set the command a test is proved by.
 *
 *  Changing it clears any recorded red-at-base verdict: that verdict was an observation
 *  about the old command, and says nothing about this one. Leaving it would let a test
 *  pass on the strength of a red run of something else. */
export function setArtefact(db: DatabaseSync, entity: TestEntity, id: number, artefact: string): void {
  if (artefact.trim() === "") throw new EditError(NO_ARTEFACT);
  const changed = queries(db)
    .update(tests[entity])
    .set({ artefact, updated_at: now() })
    .where("id", "=", id)
    .run();
  if (changed.changes === 0) throw new EditError(`no ${entity} #${id}`);
  clearRedAtBase(db, entity, id);
}

/** Only an acceptance_test records one. The columns are the ledger's; the `red_at_base`
 *  table is the runner's own and exists only once a runner has created it, so it is
 *  cleared if it is there and not missed if it is not. */
function clearRedAtBase(db: DatabaseSync, entity: TestEntity, id: number): void {
  if (entity !== "acceptance_test") return;
  const q = queries(db);
  q.update(acceptanceVerdict)
    .set({ red_at_base_sha: null, red_at_base_at: null })
    .where("id", "=", id)
    .run();
  if (hasTable(db, "red_at_base")) q.deleteFrom(redAtBase).where("test_id", "=", id).run();
}

/** Set where a test's script is meant to live, or clear it with null. This is spec, not a
 *  reading of the filesystem: the path may name a file that does not exist yet, and nothing
 *  here checks, because the answer differs per branch and would be stale by the next one. */
export function setScriptPath(
  db: DatabaseSync,
  entity: TestEntity,
  id: number,
  script_path: string | null,
): void {
  const changed = queries(db)
    .update(tests[entity])
    .set({ script_path, updated_at: now() })
    .where("id", "=", id)
    .run();
  if (changed.changes === 0) throw new EditError(`no ${entity} #${id}`);
}
