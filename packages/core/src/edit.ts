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

export function setArtefact(
  db: DatabaseSync,
  entity: "acceptance_test" | "task_test",
  id: number,
  artefact: string,
): void {
  const changed = db
    .prepare(`UPDATE ${entity} SET artefact = ?, updated_at = ? WHERE id = ?`)
    .run(artefact, now(), id);
  if (changed.changes === 0n || changed.changes === 0) throw new EditError(`no ${entity} #${id}`);
}
