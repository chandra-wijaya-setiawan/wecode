import type { DatabaseSync } from "node:sqlite";

/** Fixture writes that stand behind a guard, rather than behind an accessor.
 *
 *  `task.finish` asks two questions: every task_test settled, and the task's branch holding
 *  a commit of its own. The second is read off the attempt record — `assignment` rows with a
 *  `commit_sha` against the task — so a fixture that means a task to finish has to write one.
 *  Kept here rather than in helpers.ts because it is the record of work, not the tree. */

const T = "2026-09-13T00:00:00.000Z";

let n = 0;

/** Record that an attempt on this task committed, the way the runner records a landed
 *  attempt. Returns the sha it wrote, so a caller can assert on the branch's own commit. */
export function recordAttemptCommit(db: DatabaseSync, taskId: number, sha = "c0ffee0"): string {
  const slug = `attempt-${(n += 1)}`;
  db.prepare(
    "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(slug, slug, "engineer", "agent", T, T);
  const worker = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO assignment" +
      " (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,commit_sha,created_at,updated_at)" +
      " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(slug, "task", taskId, worker, "{}", "{}", "/tmp/wt", "succeeded", "{}", sha, T, T);
  return sha;
}
