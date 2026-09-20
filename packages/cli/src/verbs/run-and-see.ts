/** The verbs that act: worker, plan, land, ask, answer, onboard — and the context every one
 *  of them is handed.
 *
 *  Where `verbs/tree.ts` and `verbs/work.ts` hold the rungs `create` makes, these are the
 *  words that are not about making a row at all. The five that only look — board, doctor,
 *  delivered, explore, design — are in `verbs/see.ts`; what is left here is the half that
 *  writes. `plan` stays because it makes rows. These bodies were in run.ts.
 *
 *  Of that half, only `land` is spelled out here: it is the one that moves a git ref rather
 *  than a row, and the six together are half again the ceiling. The other four are in
 *  `verbs/act.ts` and re-exported below, so run.ts sees no difference.
 *
 *  Nothing in this file decides what the arguments mean. run.ts parses argv and owns the
 *  record — the table declarations, the database handle, `fail` — and hands both in, so
 *  what is left in run.ts is argument parsing and the dispatch table. The context is an
 *  interface rather than an import because importing run.ts back would be a cycle. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
// The landing rules are a module of their own in core, deliberately outside the barrel: no
// git, no clock, no filesystem, so the command half and the runner half can be held to the
// same words. Addressed through the package's build output, the way its barrel is.
import { type BaseState, refuseDirtyBase, reportAbort, reportLeftover } from "@wecode/core/dist/land.js";
import { open, type Actor } from "@wecode/core";
import { excluded, queries, type TableDef } from "@wecode/core/dist/db.js";
import type {
  AcceptanceTestRow,
  AssignmentRow,
  CriteriaRow,
  LandedRow,
  ProjectRow,
  RequirementRow,
  StoryRow,
  TaskRow,
  WorkerRow,
  WorkspaceRow,
} from "../run.js";
export { plan } from "../plan.js";

type Conn = ReturnType<typeof open>;

/** The tables these verbs read and write. Declared once in run.ts, because `show` prints a
 *  whole record and so needs every column of every table; passed in rather than declared
 *  again here, since two copies of a schema with no check between them is the defect. */
export interface Tables {
  readonly workspace: TableDef<WorkspaceRow>;
  readonly project: TableDef<ProjectRow>;
  readonly story: TableDef<StoryRow>;
  readonly requirement: TableDef<RequirementRow>;
  readonly criteria: TableDef<CriteriaRow>;
  readonly acceptanceTest: TableDef<AcceptanceTestRow>;
  readonly task: TableDef<TaskRow>;
  readonly worker: TableDef<WorkerRow>;
  readonly assignment: TableDef<AssignmentRow>;
  readonly landedBranch: TableDef<LandedRow>;
}

/** What run.ts knows and these verbs need: the argv tail, the workspace, and the two ways
 *  of answering — `fail` to standard error with exit 1, or writing and returning 0. */
export interface See {
  readonly args: readonly string[];
  /** The workspace database, or a throw naming the directory that has none. */
  readonly conn: () => Conn;
  readonly fail: (why: string) => number;
  /** The project this repository is, or null when you are standing outside all of them. */
  readonly hereProject: () => { id: number; name: string } | null;
  /** Whose name a change is recorded under. */
  readonly actor: () => Actor;
  readonly tables: Tables;
}

// The four verbs that only write rows — worker, ask, answer, onboard — are in `verbs/act.ts`,
// because the six together are half again the ceiling. They are re-exported here so run.ts
// imports the same names from the same module it always did.
export { answer, ask, onboard, worker, type Hand } from "./act.js";
// `land` refuses an unattributed merge by the same reading `onboard` refuses an unattributed
// repository, so the one function that asks git is imported rather than written twice.
import { gitConfig } from "./act.js";

// ─── land ────────────────────────────────────────────────────────────────────────────────

/** `wecode land <story>` — merge a delivered story into the branch you have checked out.
 *
 *  The operator runs this, not the runner. Landing moves the branch the operator is sitting
 *  on; a background process doing that under them would rewrite their working tree without
 *  asking. Shipping is a decision, and so is this. */
export function land(at: See): number {
  const id = Number(at.args[0]);
  if (!Number.isInteger(id)) return at.fail("wecode land <story>");
  const conn = at.conn();
  const found = queries(conn).selectFrom(at.tables.story).select(["slug", "state"]).where("id", "=", id).get();
  if (found === null) return at.fail(`no story #${id}`);
  if (found.state !== "delivered") {
    return at.fail(`story #${id} is ${found.state}. Only a delivered story lands.`);
  }

  const branch = `story/${found.slug}`;
  const base = headBranch();

  // The landing commit is the operator's, so it needs the operator's identity. wecode signs
  // an agent's attempt; it does not sign a person's merge.
  const who = gitConfig("user.name");
  const email = gitConfig("user.email");
  if (who === "" || email === "") {
    return at.fail(
      'this repository has no git identity, so the merge would be unattributed.\n' +
        '  git config user.name "Your Name" && git config user.email you@example.com',
    );
  }

  let sha: string;
  try {
    // A dirty base is refused by name, not by a general "your tree has changes": the merge
    // would commit the operator's unrelated edits inside the landing commit, and the rule
    // that says so lives in core so the runner half can be held to the same words.
    const filthy = refuseDirtyBase(baseState(base));
    if (filthy !== null) return at.fail(filthy);
    // A delivered story whose branch is gone has nothing to merge, and calling that a
    // landing is the reported defect. It is a failure, not a quiet success: the work is
    // somewhere else, or nowhere.
    if (!hasRef(branch)) return at.fail(nothingToLand(branch, base, "no-branch"));
    // git answers "Already up to date" and exit 0 for a branch the base already holds, and
    // that was indistinguishable, afterwards, from a merge that happened.
    if (isAncestor(branch, "HEAD")) {
      process.stdout.write(`${nothingToLand(branch, base, "already-ancestor")}\n`);
      return 0;
    }
    const before = headSha();
    try {
      execFileSync("git", ["merge", "--no-ff", "-m", `land ${branch}`, branch], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // A half-finished merge is the hazard: left in the tree, the next thing to commit —
      // an agent, a hook, a person in a hurry — commits the conflict markers onto master.
      // So the tree goes back exactly as it was found, and the conflict becomes a chore.
      const conflicted = unmerged();
      abortMerge();
      const why = conflicted.length > 0
        ? `${branch} conflicts with your branch in:\n${conflicted.map((f) => `  ${f}`).join("\n")}`
        : `${branch} would not merge:\n${((err as { stderr?: string }).stderr ?? (err as Error).message).trim()}`;
      return at.fail(`${why}\n${reportAbort(baseState(base), branch)}`);
    }
    sha = headSha();
    if (sha === before) {
      process.stdout.write(`${nothingToLand(branch, base, "already-ancestor")}\n`);
      return 0;
    }
  } catch (err) {
    return at.fail(`git: ${(err as Error).message}`);
  }

  recordLanding(conn, at.tables, id, branch, sha);
  process.stdout.write(`${branch} landed on ${base}: ${sha.slice(0, 12)}\n`);
  // The landing is recorded either way — it happened — but a base left dirty by the merge
  // (a hook that writes, a merge driver that stages) is the next operator's mystery, so it
  // is said out loud and the command does not report success.
  const left = reportLeftover(baseState(base));
  return left === null ? 0 : at.fail(`${branch} landed, but the base was not left clean.\n${left}`);
}

/** The base checkout as the rule in core wants to see it. Read twice per landing: once
 *  before the merge and once after, because the whole promise is about the difference. */
function baseState(base: string): BaseState {
  const here = gitSay(["rev-parse", "--show-toplevel"]);
  const gitDir = gitSay(["rev-parse", "--git-dir"]);
  return {
    here,
    base,
    // Tracked changes only. An untracked file does not affect a merge, and git refuses on
    // its own if one would be overwritten — counting them here blocked a landing over
    // wecode's own config directory.
    dirty: gitSay(["status", "--porcelain", "-uno"]).split("\n").filter((l) => l !== ""),
    merging: gitDir !== "" && existsSync(join(gitDir, "MERGE_HEAD")),
  };
}

/** Why nothing happened. Same two reasons, and the same words, as the runner's own
 *  `landingReport`: an operator reading one and a log line from the other must not have to
 *  work out whether they mean the same thing. */
function nothingToLand(branch: string, base: string, why: "no-branch" | "already-ancestor"): string {
  return why === "no-branch"
    ? `nothing to land: there is no ${branch}`
    : `nothing to land: ${branch} is already in ${base}`;
}

/** The branch the operator is standing on, or the sha when they are detached. */
function headBranch(): string {
  const named = gitSay(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return named === "" ? headSha().slice(0, 12) : named;
}

const headSha = (): string => gitSay(["rev-parse", "HEAD"]);

const hasRef = (ref: string): boolean => gitSay(["rev-parse", "--verify", "--quiet", ref]) !== "";

/** True when the base already holds every commit on `ref`. */
function isAncestor(ref: string, of: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ref, of], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitSay(args: readonly string[]): string {
  try {
    return execFileSync("git", [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The landing, where a query can see it. The doctor's first invariant reads `landed_branch`
 *  through the story's tasks, and it reported stories unlanded that were sitting in the base
 *  because this path merged and recorded nothing. Written here, on the path that actually
 *  merges, and nowhere else. */
function recordLanding(conn: Conn, tables: Tables, storyId: number, branch: string, sha: string): void {
  // The runner owns this table and creates it on its first merge; a repository landed by
  // hand may never have run a tick. DDL is the one statement here that is not a query, and
  // the dialect compiles queries — so this stays as schema text, and is the only SQL left.
  conn.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  // The four-table join the SQL spelled, composed instead: the dialect has neither JOIN nor
  // IN, and it is one link of the tree per step — requirement to criteria to acceptance_test
  // to task — which is the same walk `projectOf` makes in the other direction.
  const q = queries(conn);
  const reqs = new Set(
    q.selectFrom(tables.requirement).select(["id"]).where("story_id", "=", storyId).all().map((r) => r.id),
  );
  const crits = new Set(
    q.selectFrom(tables.criteria).select(["id", "requirement_id"]).all()
      .filter((r) => reqs.has(r.requirement_id))
      .map((r) => r.id),
  );
  const tests = new Set(
    q.selectFrom(tables.acceptanceTest).select(["id", "parent_id"]).all()
      .filter((r) => crits.has(r.parent_id))
      .map((r) => r.id),
  );
  const tasks = q
    .selectFrom(tables.task)
    .select(["id", "acceptance_test_id"])
    .all()
    .filter((r) => tests.has(r.acceptance_test_id))
    .map((r) => r.id);

  const at = new Date().toISOString();
  for (const taskId of tasks) {
    q.insertInto(tables.landedBranch, { task_id: taskId, branch, sha, merged_at: at })
      .onConflict(["task_id"], {
        branch: excluded<LandedRow>("branch"),
        sha: excluded<LandedRow>("sha"),
        merged_at: excluded<LandedRow>("merged_at"),
      })
      .run();
  }
}

/** The paths git left with conflict markers, read before the merge is undone. */
function unmerged(): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" });
    return out.split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** Best effort: if the merge never started there is nothing to abort, and saying so helps nobody. */
function abortMerge(): void {
  try {
    execFileSync("git", ["merge", "--abort"], { stdio: "ignore" });
  } catch {
    /* no merge in progress */
  }
}
