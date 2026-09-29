import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { queries } from "@wecode/core/dist/db.js";
import type { Trees } from "../git.js";
// The table descriptors stay in `daemon.ts`, where `typed-daemon.test.ts` holds their column
// lists against the schema. Importing them back is a cycle on purpose: one definition of the
// columns beats a second copy that has to agree with the first.
import { tbl, type StoryRow } from "../daemon.js";

const exec = promisify(execFile);

export interface RedAtBase {
  readonly proven: readonly number[];
  readonly unproven: readonly number[];
}

/** What this phase needs of the runner, and nothing more. The reads of the ledger that are
 *  shared with the other phases — the walk up the ERD, the two base-run rows — are still the
 *  runner's, and are handed in rather than copied. */
export interface RedAtBaseHost {
  readonly db: DatabaseSync;
  /** Only for tests: pretend every project lives here. */
  readonly repoRoot: string | undefined;
  readonly storyOfCriteria: (criteriaId: number) => StoryRow | null;
  readonly projectOf: (story: StoryRow) => { project: number; repo: string } | null;
  readonly treesFor: (repo: string) => Trees;
  readonly worktreeRoot: (repo: string) => string;
  readonly ranAtBase: (testId: number, base: string, artefact: string) => boolean;
  readonly recordBaseRun: (testId: number, base: string, artefact: string, green: boolean) => void;
}

/** A test nobody has seen fail proves nothing by passing. So each ready acceptance test is
 *  run once at the commit its story was cut from — the merge-base of the story branch and
 *  the integration branch — before any of its tasks has written a line. Red there is the
 *  proof, and is recorded. Green there is a test that cannot fail, and the reason it
 *  proves nothing is recorded against it instead. */
export async function proveRedAtBase(host: RedAtBaseHost): Promise<RedAtBase> {
  // `artefact IS NOT NULL` and `red_at_base_sha IS NULL` are spelled as comparisons with
  // null, which the dialect compiles to IS / IS NOT rather than to an `= NULL` that never
  // matches. The story's own state is the one condition that needs the walk up the ERD.
  const tests = queries(host.db)
    .selectFrom(tbl.test).select(["id", "artefact", "parent_id"])
    .where("state", "=", "ready").where("kind", "=", "script").where("artefact", "!=", null).where("red_at_base_sha", "=", null).all();

  const rows: { id: number; artefact: string; story: string; repo: string }[] = [];
  for (const test of tests) {
    if (test.artefact === null) continue;
    const story = host.storyOfCriteria(test.parent_id);
    if (story === null || story.state !== "in_progress") continue;
    const owner = host.projectOf(story);
    if (owner === null) continue;
    rows.push({ id: test.id, artefact: test.artefact, story: story.slug, repo: owner.repo });
  }

  const proven: number[] = [];
  const unproven: number[] = [];
  for (const row of rows) {
    const repo = host.repoRoot ?? row.repo;
    try {
      const trees = host.treesFor(repo);
      const tree = await trees.storyTree(row.story, join(host.worktreeRoot(repo), `story-${row.story}`));
      const base = await mergeBase(repo, `story/${row.story}`, await trees.integrationBranch());
      if (base === null || host.ranAtBase(row.id, base, row.artefact)) continue;
      const green = await runAtBase(host, { repo, story: row.story, tree, base, artefact: row.artefact });
      host.recordBaseRun(row.id, base, row.artefact, green);
      (green ? unproven : proven).push(row.id);
    } catch {
      // no branch, or no tree to be had: there is no base to prove anything against yet
    }
  }
  return { proven, unproven };
}

async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["merge-base", a, b], { cwd: repo });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True when the artefact passed at base. The story tree is put back on its branch either
 *  way: the merge and the ordinary prove-the-story pass both expect to find it there. */
async function runAtBase(
  host: RedAtBaseHost,
  at: { repo: string; story: string; tree: string; base: string; artefact: string },
): Promise<boolean> {
  await exec("git", ["checkout", "--detach", "-q", at.base], { cwd: at.tree });
  await exec("git", ["reset", "--hard", "-q", at.base], { cwd: at.tree });
  try {
    await exec("bash", ["-lc", at.artefact], { cwd: at.tree, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  } finally {
    await host.treesFor(at.repo).storyTree(at.story, at.tree);
  }
}
