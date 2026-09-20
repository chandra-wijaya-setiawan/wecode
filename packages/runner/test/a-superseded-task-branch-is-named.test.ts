import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open, type Violation } from "@wecode/core";
import {
  Doctor,
  RUNNER_INVARIANTS,
  SUPERSEDED_CHECK,
  runChecks,
  snapshot,
  taskBranchIsNotSuperseded,
  violations,
  worldOf,
  type Git,
} from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A task branch the story branch has already got.
 *
 *  The lander retries a done task's merge until `landed_branch` records it, and it remembers
 *  a conflict only by the pair of tips it was attempted between. So a branch whose work
 *  reached the story by another route — cherry-picked, recut, merged by a person — is merged
 *  again every time either tip moves, and git refuses it every time, at the cost of a
 *  worktree and a merge per tick and a conflict line that reads like work still to do.
 *
 *  Nothing on the branch the story does not already hold is what superseded means. The
 *  doctor names it, so the answer is a sentence rather than another merge. */

let dir: string;
let db: DatabaseSync;
let make: Maker;
let worker: number;
let story: number;
let criteria: number;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** git as the check may read it: argv in, stdout out, the real repository behind it. */
const real: Git = (args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** A git that answers nothing, so every ref is a ref nobody can resolve. */
const silent: Git = () => {
  throw new Error("no repository");
};

beforeEach(() => {
  dir = tmp("wecode-superseded-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@localhost");
  writeFileSync(join(dir, "README.md"), "the base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");

  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  const release = make.release(make.project(make.workspace("acme", dir), "storefront", dir), "1.0.0");
  story = make.story(make.epic(release, "recovery"), "password reset");
  criteria = make.criteria(make.requirement(story, "it works"), "accepted");
  worker = make.worker("engineer-1", "engineer", "agent");
});

const slugOf = (table: "task" | "story", id: number): string =>
  (db.prepare(`SELECT slug FROM ${table} WHERE id = ?`).get(id) as { slug: string }).slug;

/** A done task with a commit recorded against it: exactly the set the lander retries. */
function aDoneTask(title: string): number {
  const test = make.acceptanceTest(criteria, `${title} proved`, "script", "bash a.sh");
  const task = make.task(test, title, { role: "engineer" });
  db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(task);
  const assignment = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: [] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: "",
  });
  db.prepare("UPDATE assignment SET phase = 'succeeded', commit_sha = 'cafe1234' WHERE id = ?").run(assignment);
  return task;
}

/** One commit on `main`, so a branch can be pointed at something. */
function aCommit(what: string): string {
  writeFileSync(join(dir, `${what}.ts`), `export const ${what} = true;\n`);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", what);
  return git(dir, "rev-parse", "HEAD");
}

const branch = (name: string, at: string): void => void git(dir, "branch", "-f", name, at);

/** The marker the lander writes when a merge goes through. */
function landed(task: number, name: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?, ?, ?, ?)").run(
    task,
    name,
    "cafe1234",
    "2026-01-01T00:00:00Z",
  );
}

const found = (g: Git = real): readonly Violation[] =>
  runChecks(snapshot(db), worldOf(g, "main"), [taskBranchIsNotSuperseded(db, g)]);

const named = (g: Git = real): number[] => found(g).map((v) => v.id as number);

describe("the check on a task branch that will not move", () => {
  it("names a done task whose story branch already holds every commit on it", () => {
    const task = aDoneTask("send the mail");
    const tip = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);

    expect(found()).toEqual([
      {
        invariant: SUPERSEDED_CHECK,
        entity: "task",
        id: task,
        slug: slugOf("task", task),
        detail:
          `done, and story/${slugOf("story", story)} already holds every commit on ` +
          `task/${slugOf("task", task)} — the merge is retried every tick and can move ` +
          `nothing: the branch is superseded, not unmerged`,
      },
    ]);
  });

  /** The shape it is usually in: the branch was cut, the story moved past it, and the work
   *  reached the story by another route. Behind the story is still in the story. */
  it("names a branch the story has moved past, not only one at the same tip", () => {
    const task = aDoneTask("send the mail");
    const cut = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, cut);
    branch(`story/${slugOf("story", story)}`, aCommit("more"));

    expect(named()).toEqual([task]);
  });

  it("says nothing about a branch carrying a commit the story has not got", () => {
    const task = aDoneTask("send the mail");
    branch(`story/${slugOf("story", story)}`, git(dir, "rev-parse", "HEAD"));
    branch(`task/${slugOf("task", task)}`, aCommit("mail"));

    expect(found()).toEqual([]);
  });

  /** The ordinary end of a merge: the branch is in the story because wecode put it there,
   *  and the marker says so. Naming that would name every task that ever landed. */
  it("says nothing once the lander has recorded the merge", () => {
    const task = aDoneTask("send the mail");
    const tip = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);
    landed(task, `task/${slugOf("task", task)}`);

    expect(found()).toEqual([]);
  });

  it("says nothing about a task no branch exists for", () => {
    aDoneTask("send the mail");

    expect(found()).toEqual([]);
  });

  /** A repository nobody can read answers `no-branch` for every ref, which is
   *  indistinguishable from a branch that is gone. Silence is the honest answer. */
  it("accuses nothing when git cannot be asked at all", () => {
    const task = aDoneTask("send the mail");
    const tip = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);

    expect(found(silent)).toEqual([]);
  });

  it("says nothing about a task the record does not call done", () => {
    const task = aDoneTask("send the mail");
    const tip = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);
    db.prepare("UPDATE task SET state = 'in_progress' WHERE id = ?").run(task);

    expect(found()).toEqual([]);
  });

  it("names every such task, in the order the record holds them", () => {
    const first = aDoneTask("send the mail");
    const second = aDoneTask("log the send");
    const tip = aCommit("mail");
    for (const t of [first, second]) branch(`task/${slugOf("task", t)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);

    expect(named()).toEqual([first, second]);
  });
});

describe("the pass that runs it", () => {
  it("records the drift where a view reads it", () => {
    const task = aDoneTask("send the mail");
    const tip = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);

    new Doctor(db, [taskBranchIsNotSuperseded(db, real)], real, "main").check();

    expect(violations(db).map((v) => ({ invariant: v.invariant, id: v.id }))).toEqual([
      { invariant: SUPERSEDED_CHECK, id: task },
    ]);
  });

  it("is one of the checks the tick runs by default", () => {
    const task = aDoneTask("send the mail");
    const tip = aCommit("mail");
    branch(`task/${slugOf("task", task)}`, tip);
    branch(`story/${slugOf("story", story)}`, tip);

    const drift = new Doctor(db).check();

    expect(drift.filter((v) => v.invariant === SUPERSEDED_CHECK).map((v) => v.id)).toEqual([task]);
  });

  /** It reads the world rather than the record, so it is the Doctor's own default and not
   *  in the pure set `wecode doctor` shares with the tick. */
  it("is not in the pure set", () => {
    expect(RUNNER_INVARIANTS.map((i) => i.name)).not.toContain(SUPERSEDED_CHECK);
  });
});
