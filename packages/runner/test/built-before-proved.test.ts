import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner, UNPREPARED } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let story: number;
let criteria: number;
/** Where the ledger lives. Never the tree under examination, so nothing the examiner does
 *  to a tree can be confused with what it did to the database. */
let home: string;
let tree: string;
let worker: number;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const outputOf = (table: string, id: number): string =>
  (db.prepare(`SELECT last_output FROM ${table} WHERE id = ?`).get(id) as { last_output: string | null })
    .last_output ?? "";

const git = (...args: string[]): string => execFileSync("git", args, { cwd: tree, encoding: "utf8" }).trim();

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

/** What the tree says makes itself runnable. Written as the project's own config, which is
 *  where the command belongs: the examiner reads it, it does not know it. */
const prepares = (command: string): void => {
  mkdirSync(join(tree, "config"), { recursive: true });
  writeFileSync(join(tree, "config", "project.yaml"), `stack: pnpm\ntest: run-the-suite\nprepare: ${command}\n`);
};

beforeEach(() => {
  home = tmp("wecode-built-");
  db = open(join(home, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", home);
  const p = make.project(ws, "s", home);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  story = make.story(e, "s");
  const req = make.requirement(story, "r");
  criteria = make.criteria(req, "c");
  worker = make.worker("claude-1", "engineer", "agent");
  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", story],
    ["requirement", req],
    ["acceptance_criteria", criteria],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }

  tree = tmp("wecode-built-tree-");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(tree, "README.md"), "seed\n");
  commit("seed");
});

/** Distinguishes two tasks that prove the same thing: slugs are unique, and more than one
 *  test of this file wants the same artefact twice. */
let nth = 0;

function readyTask(artefact: string, acceptance = "true"): { task: number; taskTest: number; acceptance: number } {
  const name = `${++nth}-${artefact}`;
  const at = make.acceptanceTest(criteria, `proof-${name}`, "script", acceptance);
  const task = make.task(at, `do-${name}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${name}`, "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  recordRed(db, at);
  attempt(task);
  return { task, taskTest, acceptance: at };
}

/** The attempt the task was worked on, and the sha it left. A task finishes on its own
 *  commit, and `taskFinishesOnItsOwnWork` reads that off the record alone — so a fixture
 *  whose task has to reach `done` before an acceptance_test may run has to write one. */
function attempt(task: number): void {
  const id = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: [] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: tree,
  });
  db.prepare("UPDATE assignment SET phase = 'succeeded', commit_sha = ? WHERE id = ?").run(git("rev-parse", "HEAD"), id);
}

describe("the tree is prepared before anything is proved in it", () => {
  it("runs the prepare command first, so a test needing the build passes", async () => {
    prepares("mkdir -p dist && echo built > dist/app.js");
    commit("configure");
    const { task, taskTest } = readyTask("test -f dist/app.js");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(stateOf("task_test", taskTest)).toBe("passed");
  });

  it("prepares the tree the test runs in, not the runner's own", async () => {
    prepares(`echo "$PWD" > prepared-in`);
    commit("configure");
    const { task } = readyTask("true");

    await new Examiner(db).runTaskTests(task, tree);

    expect(readFileSync(join(tree, "prepared-in"), "utf8").trim()).toBe(tree);
    expect(existsSync(join(home, "prepared-in"))).toBe(false);
  });

  it("prepares a story tree before an acceptance_test proves a criteria in it", async () => {
    prepares("mkdir -p dist && echo built > dist/app.js");
    commit("configure");
    const { task, acceptance } = readyTask("true", "test -f dist/app.js");

    await new Examiner(db).runTaskTests(task, tree);
    await new Examiner(db).runAcceptanceTests(story, tree);

    expect(stateOf("acceptance_test", acceptance)).toBe("passed");
  });

  it("runs the test unchanged in a tree that names no prepare command", async () => {
    const { task, taskTest } = readyTask("test -f README.md");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(r.unrunnable).toEqual([]);
  });
});

describe("an unbuilt tree is never read as a failing test", () => {
  /** What a fresh worktree does to a real suite: the run dies on an import it cannot
   *  resolve, and exits non-zero exactly as a broken suite would. */
  const UNBUILT = "echo 'Cannot find package react' >&2; exit 1";

  it("leaves every test as it stands when the tree could not be prepared", async () => {
    prepares(UNBUILT);
    commit("configure");
    const { task, taskTest } = readyTask("exit 1");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.unrunnable).toContain(taskTest);
    expect(r.failed).toEqual([]);
    expect(r.passed).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("ready");
    expect(stateOf("task", task)).toBe("ready");
  });

  it("says the tree was the problem, in the build's own words", async () => {
    prepares(UNBUILT);
    commit("configure");
    const { task, taskTest } = readyTask("exit 1");

    await new Examiner(db).runTaskTests(task, tree);

    expect(outputOf("task_test", taskTest)).toContain(UNPREPARED);
    expect(outputOf("task_test", taskTest)).toContain("Cannot find package react");
  });

  it("does not run the test at all, so nothing it printed can be read as a verdict", async () => {
    const log = join(home, "runs.log");
    writeFileSync(log, "");
    prepares(UNBUILT);
    commit("configure");
    const { task } = readyTask(`echo ran >> ${log}; exit 1`);

    await new Examiner(db).runTaskTests(task, tree);

    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("takes no verdict against an unprepared story tree either", async () => {
    prepares("true");
    commit("configure");
    const { task, acceptance } = readyTask("true", "exit 1");
    await new Examiner(db).runTaskTests(task, tree);

    prepares(UNBUILT);
    commit("break the build");
    const r = await new Examiner(db).runAcceptanceTests(story, tree);

    expect(r.unrunnable).toContain(acceptance);
    expect(r.failed).toEqual([]);
    expect(stateOf("acceptance_test", acceptance)).toBe("ready");
    expect(stateOf("story", story)).toBe("in_progress");
  });

  it("judges the test once the tree builds, with no stale verdict in the way", async () => {
    prepares(UNBUILT);
    commit("configure");
    const { task, taskTest } = readyTask("test -f dist/app.js");
    const examiner = new Examiner(db);
    await examiner.runTaskTests(task, tree);
    expect(stateOf("task_test", taskTest)).toBe("ready");

    prepares("mkdir -p dist && echo built > dist/app.js");
    commit("fix the build");

    const r = await examiner.runTaskTests(task, tree);
    expect(r.passed).toContain(taskTest);
  });
});

describe("preparing a tree is done once, not once per test", () => {
  let log: string;
  const preparations = (): number => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;

  beforeEach(() => {
    log = join(home, "prepared.log");
    writeFileSync(log, "");
    prepares(`echo prepared >> ${log}`);
    commit("configure");
  });

  it("prepares once for a pass that judges several tests", async () => {
    const one = readyTask("true");
    const two = readyTask("true");
    // A pass judges one task's tests, and the daemon holds one examiner across a tick, so
    // the count that matters is builds per tree per tip and not builds per pass.
    const examiner = new Examiner(db);
    await examiner.runTaskTests(one.task, tree);
    expect(preparations()).toBe(1);
    await examiner.runTaskTests(two.task, tree);
    expect(preparations()).toBe(1);
  });

  it("prepares again once the tree has a new commit", async () => {
    const { task } = readyTask("true");
    const examiner = new Examiner(db);
    await examiner.runTaskTests(task, tree);

    writeFileSync(join(tree, "fix.ts"), "x\n");
    commit("fix");
    db.prepare("UPDATE task_test SET state = 'ready' WHERE id = ?").run(
      (db.prepare("SELECT id FROM task_test").get() as { id: number }).id,
    );

    await examiner.runTaskTests(task, tree);
    expect(preparations()).toBe(2);
  });
});
