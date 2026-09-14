/** The one-of-everything the cockpit's tests are drawn from: a project and a queued task
 *  on the dashboard, and the chain underneath for a node screen to walk. */
import type { DatabaseSync } from "node:sqlite";

export const T = "2026-09-13T00:00:00.000Z";

export const ins = (db: DatabaseSync, sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** The same one-of-everything the App's own tests use: a project and a queued task on the
 *  dashboard, and the chain underneath for a node screen to walk. */
export function seed(db: DatabaseSync) {
  const ws = ins(db, "INSERT INTO workspace (slug,name,path,created_at,updated_at) VALUES (?,?,?,?,?)", "acme", "acme", "/acme", T, T);
  const project = ins(db, "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "storefront", ws, "storefront", "/repo", "in_progress", T, T);
  const release = ins(db, "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "v1", project, "1.0.0", "in_progress", T, T);
  const epic = ins(db, "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "recovery", release, "account recovery", "in_progress", T, T);
  const story = ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "reset", epic, "password reset", "in_progress", T, T);
  const requirement = ins(db, "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "one-change", story, "one link, one change", "in_progress", T, T);
  const criteria = ins(db, "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "emailed", requirement, "a link is emailed", "in_progress", T, T);
  const acceptance = ins(db, "INSERT INTO acceptance_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mail-arrives", criteria, "the mail arrives", "script", "bash test/mail.sh", "planned", T, T);
  const task = ins(db, "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "send-mail", acceptance, "send the reset mail", JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "ready", T, T);
  ins(db, "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", "mailer-called", task, "the mailer is called", "script", "vitest run mail", "ready", T, T);
  return { project, epic, story, task };
}
