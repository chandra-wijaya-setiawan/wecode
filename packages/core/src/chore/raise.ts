import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import {
  choreAttempts,
  choreById,
  choreFor,
  ChoreVerbs,
  clearChoreRefusal,
  insertChore,
  outOfAttempts,
  writeChoreRefusal,
  type Chore,
  type ChoreOutcome,
  type ChoreSpec,
} from "../chore.js";
import { queries, table } from "../db.js";

const exec = promisify(execFile);

interface SweepStory {
  readonly slug: string;
  readonly state: string;
}

interface Checkout {
  readonly path: string;
  readonly branch: string | null;
}

const stories = table<SweepStory>("story", ["slug", "state"]);

const git = async (repo: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await exec("git", [...args], { cwd: repo, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const checkouts = async (repo: string): Promise<readonly Checkout[]> => {
  const listing = await git(repo, ["worktree", "list", "--porcelain"]);
  return listing.split("\n\n").flatMap((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path === undefined) return [];
    return [{ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null }];
  });
};

const mergedInto = async (repo: string, branch: string, base: string): Promise<boolean> => {
  try {
    await git(repo, ["merge-base", "--is-ancestor", branch, base]);
    return true;
  } catch {
    return false;
  }
};

/** What the landed-story cleanup did. Paths and branch names are separate entries so the
 *  caller can say exactly what disappeared rather than printing a count. */
export interface LandedSweep {
  readonly removed: readonly string[];
  readonly left: readonly { readonly what: string; readonly why: string }[];
  readonly notice: string;
}

/** Remove the old story trees after landing has made their branches disposable.
 *
 *  This is deliberately a chore-shaped operation, not part of landing itself. Landing is
 *  allowed to move the base and record that fact; this pass is level-triggered and can find
 *  leftovers from landings made before it existed. The database supplies the first half of
 *  the condition (`delivered`), and git supplies the second (`story/x` is an ancestor of
 *  `master`). A non-delivered story, or a delivered story whose branch has not landed, is
 *  left alone.
 *
 *  A branch is deleted only after its checkout is gone. Ordinary `worktree remove` and
 *  `branch -d` are intentional: a dirty tree or a branch git cannot safely delete is named
 *  in `left`, never thrown away. `notice` is part of the result so a caller cannot perform
 *  this destructive chore silently. */
export async function sweepLandedStories(
  db: DatabaseSync,
  repo: string,
  base = "master",
): Promise<LandedSweep> {
  const removed: string[] = [];
  const left: { what: string; why: string }[] = [];
  const trees = await checkouts(repo);
  const delivered = queries(db).selectFrom(stories).where("state", "=", "delivered").all();

  for (const story of delivered.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const branch = `story/${story.slug}`;
    if (!(await mergedInto(repo, branch, base))) continue;
    const attached = trees.filter((checkout) => checkout.branch === branch);
    let blocked = false;
    for (const tree of attached) {
      try {
        await git(repo, ["worktree", "remove", tree.path]);
        removed.push(tree.path);
      } catch (err) {
        left.push({ what: tree.path, why: (err as Error).message });
        blocked = true;
      }
    }
    if (blocked) continue;
    try {
      await git(repo, ["branch", "-d", branch]);
      removed.push(branch);
    } catch (err) {
      left.push({ what: branch, why: (err as Error).message });
    }
  }

  const notice = removed.length === 0
    ? "sweep removed nothing"
    : `sweep removed:\n${removed.map((name) => `  ${name}`).join("\n")}`;
  return { removed, left, notice };
}

/** docs/design/18: when wecode owes itself a chore, when it owes it again, and when it
 *  stops owing it.
 *
 *  Three conditions and nothing else. The rest of chore.ts is the record — the machine, the
 *  verbs, the tables, the board — and this is the level-triggered layer over it: the runner
 *  re-reads the world each tick and says what it found, and these three turn that into a
 *  row, a reprove, or a close. They are together because they are one rule read three ways:
 *  a chore's state is a claim about the world now, never a memo about the past.
 *
 *  It imports chore.ts and chore.ts re-exports it. The cycle is a module cycle only — every
 *  binding here is read inside a function body, never while the module is evaluating — and
 *  the alternative is `ensureChore` living apart from the `chore` table it inserts into or
 *  the table being declared twice. */

/** The chore for this condition, creating it if it is not there yet.
 *
 *  Idempotent on purpose. The runner is level-triggered: it re-reads the condition on every
 *  tick, and the condition stays true until the chore is done. Returning the chore that is
 *  already there — rather than throwing, or inserting a second — is what makes "a story
 *  that will not merge" one row instead of one row a tick. */
export function ensureChore(db: DatabaseSync, spec: ChoreSpec, by = "runner"): Chore {
  const found = choreFor(db, spec.kind, spec.target_type, spec.target_id);
  if (found === null) return insertChore(db, spec);

  // The one place a settled chore stops being a dead end. Being here at all is the caller
  // saying the condition is true — that is what `ensureChore` means — so the chore goes
  // back to `planned` and is raised again. `done` as much as `failed`: a chore that was
  // discharged and whose condition has come back is the same chore with a second pass, not
  // a memo about the merge that worked in March. Never on a timer, and never quietly: the
  // reraise is a ledger row, and the attempts behind it stay on the record.
  if (found.state === "failed" || found.state === "done") reraiseChore(db, found.id, by);
  return choreById(db, found.id) ?? found;
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
