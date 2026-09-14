import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "./entities.js";
import { withinCeiling, type RoleConfig } from "./roles.js";
import { now } from "./store.js";

export class EditError extends Error {}

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
}

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
