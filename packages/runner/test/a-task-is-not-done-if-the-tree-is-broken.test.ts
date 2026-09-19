import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A task whose every test already passed has nothing left to run. That is the one shape
 *  where a report of "no failures" is reached without the tree being touched at all — and
 *  a tree that does not build is exactly as broken whether or not a test is waiting on it.
 *  So the examiner asks the build first, and says so, before it can answer with nothing. */

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let story: number;
let criteria: number;
let home: string;
let tree: string;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: tree, encoding: "utf8" }).trim();

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

const prepares = (command: string): void => {
  mkdirSync(join(tree, "config"), { recursive: true });
  writeFileSync(join(tree, "config", "project.yaml"), `stack: pnpm\ntest: run-the-suite\nprepare: ${command}\n`);
};

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

/** What a fresh or half-merged worktree does to a real suite: nothing imports, and the
 *  build says why on stderr before exiting non-zero. */
const UNBUILT = "echo 'Cannot find package react' >&2; exit 1";

beforeEach(() => {
  home = tmp("wecode-broken-");
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

  tree = tmp("wecode-broken-tree-");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(tree, "README.md"), "seed\n");
  commit("seed");
});

let nth = 0;

function readyTask(artefact: string, acceptance = "true"): { task: number; taskTest: number; acceptance: number } {
  const name = `${++nth}`;
  const at = make.acceptanceTest(criteria, `proof-${name}`, "script", acceptance);
  const task = make.task(at, `do-${name}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${name}`, "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  recordRed(db, at);
  return { task, taskTest, acceptance: at };
}

describe("a task is not done if the tree is broken", () => {
  it("names the broken build even when no test is left to run", async () => {
    prepares("true");
    commit("configure");
    const { task, taskTest } = readyTask("true");
    const examiner = new Examiner(db);
    await examiner.runTaskTests(task, tree);
    expect(stateOf("task_test", taskTest)).toBe("passed");

    prepares(UNBUILT);
    commit("break the build");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.unprepared).toContain("Cannot find package react");
    expect(r.passed).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("says nothing about the build when the tree builds", async () => {
    prepares("true");
    commit("configure");
    const { task, taskTest } = readyTask("true");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(r.unprepared).toBeUndefined();
  });

  it("says nothing about the build in a tree that names no prepare command", async () => {
    const { task } = readyTask("true");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.unprepared).toBeUndefined();
  });

  it("carries the build's words on the report that leaves a waiting test unjudged", async () => {
    prepares(UNBUILT);
    commit("configure");
    const { task, taskTest } = readyTask("true");

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.unprepared).toContain("Cannot find package react");
    expect(r.unrunnable).toContain(taskTest);
    expect(stateOf("task_test", taskTest)).toBe("ready");
  });

  it("refuses the story tree the same way once its tasks have nothing left to run", async () => {
    prepares("true");
    commit("configure");
    const { task, acceptance } = readyTask("true");
    await new Examiner(db).runTaskTests(task, tree);

    prepares(UNBUILT);
    commit("break the build");

    const r = await new Examiner(db).runAcceptanceTests(story, tree);

    expect(r.unprepared).toContain("Cannot find package react");
    expect(stateOf("acceptance_test", acceptance)).not.toBe("passed");
  });

  it("does not run a single test of a task whose tree does not build", async () => {
    const log = join(home, "runs.log");
    writeFileSync(log, "");
    prepares(UNBUILT);
    commit("configure");
    const { task } = readyTask(`echo ran >> ${log}; true`);

    await new Examiner(db).runTaskTests(task, tree);

    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("answers cleanly again once the build is fixed", async () => {
    prepares(UNBUILT);
    commit("configure");
    const { task, taskTest } = readyTask("true");
    const examiner = new Examiner(db);
    expect((await examiner.runTaskTests(task, tree)).unprepared).toBeDefined();

    prepares("true");
    commit("fix the build");

    const r = await examiner.runTaskTests(task, tree);

    expect(r.unprepared).toBeUndefined();
    expect(r.passed).toContain(taskTest);
  });
});
