import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { queries } from "@wecode/core/dist/db.js";
import type { Trees } from "../git.js";
import type { Refused, ScriptReport } from "../examiner.js";
// The table descriptors stay in `daemon.ts`, where `typed-daemon.test.ts` holds their column
// lists against the schema. Importing them back is a cycle on purpose: one definition of the
// columns beats a second copy that has to agree with the first.
import { tbl } from "../daemon.js";

/** An assignment nobody has finished with reads as open; these two have ended. The daemon
 *  keeps its own copy for the phases that still live there — this is the one this phase
 *  asks, and it moved with the phase. */
const ENDED_PHASES: readonly string[] = ["succeeded", "failed"];

const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

export interface Settled {
  readonly committed: number[];
  readonly scripts: ScriptReport;
}

/** What this phase needs of the runner, and nothing more. The walk up the ERD to a task's
 *  slugs, the trees and the examiner are shared with the other phases, so they are handed
 *  in rather than copied. */
export interface SettleHost {
  readonly db: DatabaseSync;
  readonly slugsFor: (taskId: number) => { task: string; story: string; repo: string } | null;
  readonly treesFor: (repo: string) => Trees;
  readonly runTaskTests: (task: number, tree: string, at: { attempt: number }) => Promise<ScriptReport>;
}

/** An attempt that has ended: commit whatever it wrote onto its task branch, then let the
 *  tree go. The branch is the surviving copy; the directory is a checkout held against a
 *  retry nobody has promised. */
export async function settleEnded(host: SettleHost): Promise<Settled> {
  const rows = queries(host.db)
    .selectFrom(tbl.assignment).select(["id", "worktree", "objective_id", "phase"]).where("objective_type", "=", "task").all()
    .filter((a) => ENDED_PHASES.includes(a.phase) && a.worktree !== "")
    .map((a) => ({ id: a.id, worktree: a.worktree, task: a.objective_id }));

  const committed: number[] = [];
  const passed: number[] = [];
  const failed: number[] = [];
  const skipped: number[] = [];
  const refused: Refused[] = [];

  for (const row of rows) {
    if (!existsSync(row.worktree)) continue;
    const slugs = host.slugsFor(row.task);
    if (slugs === null) continue;
    try {
      // The attempt is judged in the tree it wrote in, before that tree goes.
      // The assignment is what makes this attempt distinct: a retry cuts a fresh tree at
      // the same branch tip, so the tip alone would read as "already judged".
      const r = await host.runTaskTests(row.task, row.worktree, { attempt: row.id });
      passed.push(...r.passed);
      failed.push(...r.failed);
      skipped.push(...r.skipped);
      refused.push(...(r.refused ?? []));

      const trees = host.treesFor(slugs.repo);
      const sha = await trees.commitAttempt(row.worktree, `task/${slugs.task}`, `${slugs.task}: attempt`);
      if (sha === null) refundAttempt(host.db, row.task, row.id);
      else {
        queries(host.db).update(tbl.assignment).set({ commit_sha: sha }).where("id", "=", row.id).run();
        committed.push(row.id);
      }
      await trees.release(row.worktree);
    } catch {
      // leave the tree standing rather than lose work nobody has seen
    }
  }
  return { committed, scripts: { passed, failed, skipped, refused } };
}

/** Give back the retry the foreman counted, when the attempt committed nothing — once per
 *  branch tip, and the next empty attempt at that tip is counted. Refunding every one is a
 *  task that never exhausts: an agent that keeps writing nothing loops on a tip nobody
 *  moved. The tip moves only when an attempt commits, so the assignments after the last one
 *  with a `commit_sha` are this tip's empty run, and one of them has had the refund. */
function refundAttempt(db: DatabaseSync, task: number, attempt: number): void {
  const q = queries(db);
  const mine = q.selectFrom(tbl.assignment).select(["id", "objective_id", "commit_sha"]).where("objective_type", "=", "task").all().filter((a) => a.objective_id === task && a.id < attempt).sort(byId);
  if (mine.length > mine.findLastIndex((a) => (a.commit_sha ?? "") !== "") + 1) return;
  const t = q.selectFrom(tbl.task).select(["attempts"]).where("id", "=", task).get();
  if (t === null || t.attempts <= 0) return;
  q.update(tbl.task).set({ attempts: t.attempts - 1 }).where("id", "=", task).run();
}
