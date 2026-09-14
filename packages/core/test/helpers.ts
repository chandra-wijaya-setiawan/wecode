import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { open } from "../src/index.js";
import { tmp } from "./tmpdir.js";

export const freshDb = (): DatabaseSync => open(join(tmp(), "wecode.db"));

const T = "2026-09-13T00:00:00.000Z";

const ins = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** A tree with one of everything, every node started, so a passing test can cascade all
 *  the way to a delivered epic. */
export function seed(db: DatabaseSync) {
  const ws = ins(db, "INSERT INTO workspace (slug,name,path,created_at,updated_at) VALUES (?,?,?,?,?)", "acme", "acme", "/acme", T, T);
  const project = ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "storefront", ws, "storefront", "/repo", "in_progress", T, T);
  const release = ins(db, "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "v1", project, "1.0", "in_progress", T, T);
  const epic = ins(db, "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "recovery", release, "account recovery", "in_progress", T, T);
  const story = ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "reset", epic, "password reset", "in_progress", T, T);
  const requirement = ins(db, "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "one-change", story, "a reset link authenticates exactly one change", "in_progress", T, T);
  const criteria = ins(db, "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "emailed", requirement, "a link is emailed within 60s", "in_progress", T, T);
  const acceptance = ins(db, "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mail-arrives", criteria, "the mail arrives with a link", "script", "bash test/mail.sh", "ready", T, T);
  const task = ins(db, "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "send-mail", acceptance, "send the reset mail", JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "planned", T, T);
  const taskTest = ins(db, "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mailer-called", task, "the mailer is called with the token", "script", "vitest run mail", "ready", T, T);
  return { ws, project, release, epic, story, requirement, criteria, acceptance, task, taskTest };
}

/** Record that somebody watched an acceptance_test fail at a base, the way the runner that
 *  observed the red run would. `test_has_been_red` reads this record and only this record,
 *  so a fixture that means to pass a test has to write it — one helper, shared by every
 *  package's fixtures, rather than a copy of this UPDATE in each of them. */
export const recordRed = (
  db: DatabaseSync,
  id: number,
  sha = "base0000",
  at = "2026-09-14T00:00:00.000Z",
): void => {
  db.prepare("UPDATE acceptance_test SET red_at_base_sha = ?, red_at_base_at = ? WHERE id = ?").run(sha, at, id);
};

export const stateOf = (db: DatabaseSync, table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;
