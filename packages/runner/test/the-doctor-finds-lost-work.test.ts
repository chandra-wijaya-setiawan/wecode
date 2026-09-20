import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open, type Violation } from "@wecode/core";
import { Doctor, taskWorkIsCommitted, violations, WORK_CHECK, snapshot, worldOf, runChecks, type Git } from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19, applied to the one thing a finished task is supposed to leave behind.
 *
 *  `task.finish` is guarded on the task's branch holding a commit the task wrote, but the
 *  guard only ever ran on the finishes that came after it. What it cannot see is a record
 *  already carrying tasks that say `done` while no attempt on them ever recorded a sha:
 *  work the record reports and no commit carries. That is drift, so the doctor names it. */

let dir: string;
let db: DatabaseSync;
let make: Maker;
let criteria: number;
let worker: number;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git that answers nothing. The world-facing half of the pass is another test's subject. */
const silent: Git = () => "";

beforeEach(() => {
  dir = tmp("wecode-lost-work-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@localhost");
  writeFileSync(join(dir, "README.md"), "the base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");

  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  const release = make.release(make.project(make.workspace("acme", dir), "storefront", dir), "1.0.0");
  const story = make.story(make.epic(release, "recovery"), "password reset");
  criteria = make.criteria(make.requirement(story, "it works"), "accepted");
  worker = make.worker("engineer-1", "engineer", "agent");
});

/** One task, in whatever state the case is about. Each gets its own acceptance test so the
 *  ids do not line up: a task found by the wrong column would still be a task. */
function aTask(title: string, state = "done"): number {
  const test = make.acceptanceTest(criteria, `${title} proved`, "script", "bash a.sh");
  const task = make.task(test, title, { role: "engineer" });
  db.prepare("UPDATE task SET state = ? WHERE id = ?").run(state, task);
  return task;
}

const slugOf = (task: number): string =>
  (db.prepare("SELECT slug FROM task WHERE id = ?").get(task) as { slug: string }).slug;

/** An attempt on a task, and what it committed. `null` is the attempt that wrote nothing. */
function anAttempt(task: number, sha: string | null): number {
  const id = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: [] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: "",
  });
  db.prepare("UPDATE assignment SET phase = 'succeeded', commit_sha = ? WHERE id = ?").run(sha, id);
  return id;
}

/** The check alone, over the record as it stands. */
const found = (): readonly Violation[] =>
  runChecks(snapshot(db), worldOf(silent), [taskWorkIsCommitted(db)]);

const named = (): number[] => found().map((v) => v.id as number);

describe("the check on a done task's work", () => {
  it("names a done task no attempt ever committed against", () => {
    const task = aTask("build it");

    expect(found()).toEqual([
      {
        invariant: WORK_CHECK,
        entity: "task",
        id: task,
        slug: slugOf(task),
        detail:
          `done, and task/${slugOf(task)} holds no commit of its own — no attempt on it recorded a ` +
          `sha, so the work the record reports is in no commit`,
      },
    ]);
  });

  it("says nothing about a done task whose attempt recorded a sha", () => {
    const task = aTask("build it");
    anAttempt(task, "cafe1234");

    expect(found()).toEqual([]);
  });

  /** A rejected attempt still commits, and a retry follows it. One sha anywhere among them
   *  is the work being on the branch: the check is about the commit, not about the verdict. */
  it("counts a sha from any attempt on the task, not only the last one", () => {
    const task = aTask("build it");
    anAttempt(task, "cafe1234");
    anAttempt(task, null);

    expect(found()).toEqual([]);
  });

  /** The column is text, and an attempt that wrote nothing has been seen to leave blanks
   *  rather than null. Blank is not a commit. */
  it("treats an empty sha as no commit at all", () => {
    const task = aTask("build it");
    anAttempt(task, "   ");

    expect(named()).toEqual([task]);
  });

  it("names only the tasks the record calls done", () => {
    const done = aTask("build it");
    for (const state of ["planned", "ready", "in_progress", "dropped", "blocked"]) aTask(`${state} one`, state);

    expect(named()).toEqual([done]);
  });

  /** The trap ids hide: an attempt is keyed by objective *and* type, so a task_test whose
   *  id is the task's would otherwise excuse a task nobody committed for. */
  it("does not count an attempt on something else that shares the task's id", () => {
    const first = aTask("build it");
    const second = aTask("check it");
    const unit = make.taskTest(first, "unit", "script", "vitest run");
    expect(unit).toBe(first);
    db.prepare("UPDATE assignment SET commit_sha = 'cafe1234' WHERE id = ?").run(
      make.assignment({
        objective_type: "task_test",
        objective_id: unit,
        worker_id: worker,
        scope: { write: ["src/**"], tools: [] },
        budget: { tokens: 1000, seconds: 60 },
        worktree: "",
      }),
    );

    expect(named()).toEqual([first, second]);
  });

  it("names every such task, in the order the record holds them", () => {
    const first = aTask("build it");
    const second = aTask("check it");
    anAttempt(second, null);

    expect(named()).toEqual([first, second]);
  });
});

describe("the pass that runs it", () => {
  const passed = (): readonly Violation[] => new Doctor(db, [taskWorkIsCommitted(db)], silent).check();

  it("records the drift where a view reads it", () => {
    const task = aTask("build it");

    passed();

    expect(violations(db).map((v) => ({ invariant: v.invariant, id: v.id }))).toEqual([
      { invariant: WORK_CHECK, id: task },
    ]);
  });

  it("is one of the checks the tick runs by default", () => {
    const task = aTask("build it");

    // The tick's own set, built from the record: the check is in it without being asked for.
    const drift = new Doctor(db, undefined, silent).check();

    expect(drift.filter((v) => v.invariant === WORK_CHECK).map((v) => v.id)).toEqual([task]);
  });

  it("leaves a quiet record quiet", () => {
    anAttempt(aTask("build it"), "cafe1234");

    expect(passed()).toEqual([]);
    expect(violations(db)).toEqual([]);
  });
});
