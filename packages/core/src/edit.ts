import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "./entities.js";
import { withinCeiling, type RoleConfig } from "./roles.js";
import { now, transact } from "./store.js";

export class EditError extends Error {}

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
  actor: string,
): { was: string; now: string; state: string } {
  const text = words.trim();
  if (text === "") throw new EditError(NO_WORDS);

  const col = RESTATABLE[entity];
  return transact(db, () => {
    const row = db.prepare(`SELECT ${col} AS words, state FROM ${entity} WHERE id = ?`).get(id) as
      | { words: string; state: string }
      | undefined;
    if (row === undefined) throw new EditError(`no ${entity} #${id}`);

    const at = now();
    db.prepare(`UPDATE ${entity} SET ${col} = ?, updated_at = ? WHERE id = ?`).run(text, at, id);
    // from_state and to_state are the same state, on purpose: nothing happened to this
    // record, someone only said what it was more accurately.
    db.prepare(
      `INSERT INTO ledger (entity, entity_id, verb, from_state, to_state, actor, at)
       VALUES (?, ?, 'restate', ?, ?, ?, ?)`,
    ).run(entity, id, row.state, row.state, `${actor}: was "${row.words}"`, at);
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
  const row = db.prepare("SELECT role FROM task WHERE id = ?").get(id) as { role: string } | undefined;
  if (row === undefined) throw new EditError(`no task #${id}`);

  if (roles !== null) {
    const def = roles.roles[row.role];
    if (def === undefined) throw new EditError(`no role named ${row.role || "(none)"}`);
    const within = withinCeiling(def.scope, scope);
    if (!within.ok) throw new EditError(within.why);
  }

  db.prepare("UPDATE task SET scope = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(scope),
    now(),
    id,
  );
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
  db.prepare(
    `INSERT INTO scope_refusal (task_id, paths, at) VALUES (?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET paths = excluded.paths, at = excluded.at`,
  ).run(id, JSON.stringify(merged), now());
}

/** What this task stands refused. Empty for a task with nothing recorded, and for a
 *  workspace whose database predates the table. */
export function scopeRefusals(db: DatabaseSync, id: number): string[] {
  if (!hasScopeRefusal(db)) return [];
  const row = db.prepare("SELECT paths FROM scope_refusal WHERE task_id = ?").get(id) as
    | { paths: string }
    | undefined;
  if (row === undefined) return [];
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
  if (left.length === 0) {
    db.prepare("DELETE FROM scope_refusal WHERE task_id = ?").run(id);
    return;
  }
  db.prepare("UPDATE scope_refusal SET paths = ?, at = ? WHERE task_id = ?").run(
    JSON.stringify(left),
    now(),
    id,
  );
}

const hasScopeRefusal = (db: DatabaseSync): boolean =>
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scope_refusal'")
    .get() !== undefined;

export function setTaskRole(db: DatabaseSync, id: number, role: string): void {
  const changed = db.prepare("UPDATE task SET role = ?, updated_at = ? WHERE id = ?").run(role, now(), id);
  if (changed.changes === 0n || changed.changes === 0) throw new EditError(`no task #${id}`);
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
export function setArtefact(
  db: DatabaseSync,
  entity: "acceptance_test" | "task_test",
  id: number,
  artefact: string,
): void {
  if (artefact.trim() === "") throw new EditError(NO_ARTEFACT);
  const changed = db
    .prepare(`UPDATE ${entity} SET artefact = ?, updated_at = ? WHERE id = ?`)
    .run(artefact, now(), id);
  if (changed.changes === 0n || changed.changes === 0) throw new EditError(`no ${entity} #${id}`);
  clearRedAtBase(db, entity, id);
}

/** Only an acceptance_test records one. The columns are the ledger's; the `red_at_base`
 *  table is the runner's own and exists only once a runner has created it, so it is
 *  cleared if it is there and not missed if it is not. */
function clearRedAtBase(db: DatabaseSync, entity: "acceptance_test" | "task_test", id: number): void {
  if (entity !== "acceptance_test") return;
  db.prepare(
    "UPDATE acceptance_test SET red_at_base_sha = NULL, red_at_base_at = NULL WHERE id = ?",
  ).run(id);
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'red_at_base'")
    .get();
  if (table !== undefined) db.prepare("DELETE FROM red_at_base WHERE test_id = ?").run(id);
}

/** Set where a test's script is meant to live, or clear it with null. This is spec, not a
 *  reading of the filesystem: the path may name a file that does not exist yet, and nothing
 *  here checks, because the answer differs per branch and would be stale by the next one. */
export function setScriptPath(
  db: DatabaseSync,
  entity: "acceptance_test" | "task_test",
  id: number,
  script_path: string | null,
): void {
  const changed = db
    .prepare(`UPDATE ${entity} SET script_path = ?, updated_at = ? WHERE id = ?`)
    .run(script_path, now(), id);
  if (changed.changes === 0n || changed.changes === 0) throw new EditError(`no ${entity} #${id}`);
}
