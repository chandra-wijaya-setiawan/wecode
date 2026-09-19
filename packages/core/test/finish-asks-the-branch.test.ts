import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { loadMachines, Repo, registry } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** The branch guard, registered where a task finishes.
 *
 *  `a-task-finishes-on-its-own-work.test.ts` proves the guard itself over a stub. This
 *  proves it is wired to `task.finish`, reading the record a real repository holds: the
 *  task's slug names the branch, and the attempt rows say what was committed. */

const T = "2026-09-20T00:00:00.000Z";

let db: DatabaseSync;
let ids: ReturnType<typeof seed>;
let repo: Repo;

const set = loadMachines();

const INSERT_ASSIGNMENT =
  "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,commit_sha,created_at,updated_at)" +
  " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";

/** The worker every attempt here is made by, created once. */
const workerId = (): number => {
  db.prepare("INSERT OR IGNORE INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run("claude", "claude", "engineer", "agent", T, T);
  return (db.prepare("SELECT id FROM worker WHERE slug = ?").get("claude") as { id: number }).id;
};

/** An attempt on the task, committing `sha` — or writing nothing, when it is null. */
const attempt = (slug: string, sha: string | null): void => {
  db.prepare(INSERT_ASSIGNMENT)
    .run(slug, "task", ids.task, workerId(), "{}", "{}", "/tree", "succeeded", "{}", sha, T, T);
};

/** Settle every task_test, so the only question left is the branch. */
const settleTests = (): void => {
  db.prepare("UPDATE task_test SET state = 'passed' WHERE parent_id = ?").run(ids.task);
};

const finish = () => {
  const guard = registry(repo).every_task_test_settled;
  if (guard === undefined) throw new Error("no guard is registered for task.finish");
  return guard({ entity: "task", id: ids.task });
};

beforeEach(() => {
  db = freshDb();
  ids = seed(db);
  repo = new Repo(db);
  db.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(ids.task);
});

describe("finish asks the branch", () => {
  it("is the guard machines.yaml names on task.finish", () => {
    expect(set.task.states).toContain("done");
    expect(set.task.transitions.find((t) => t.verb === "finish")?.guard).toBe("every_task_test_settled");
  });

  it("lets a task finish when its tests settled and an attempt committed", () => {
    settleTests();
    attempt("send-mail-1", "9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345");
    expect(finish()).toEqual({ ok: true });
  });

  it("refuses a task whose attempts wrote nothing, and names the branch", () => {
    settleTests();
    attempt("send-mail-1", null);
    const r = finish();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("task/send-mail");
    expect(!r.ok && r.why).toContain("no commit of its own");
  });

  it("refuses a task nobody attempted, so an empty branch cannot finish", () => {
    settleTests();
    const r = finish();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("task/send-mail");
  });

  it("refuses a task whose every test was dropped but whose branch is empty", () => {
    // Dropped is settled: without the branch question this task would finish on nothing.
    db.prepare("UPDATE task_test SET state = 'dropped' WHERE parent_id = ?").run(ids.task);
    expect(finish().ok).toBe(false);
  });

  it("still asks the tests first, so an unsettled test is the answer given", () => {
    attempt("send-mail-1", "9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345");
    const r = finish();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).not.toContain("no commit of its own");
  });

  it("reads the attempts of this task and not of another", () => {
    settleTests();
    db.prepare(INSERT_ASSIGNMENT)
      .run("other-1", "story", ids.story, workerId(), "{}", "{}", "/tree", "succeeded", "{}", "abc1234", T, T);
    expect(finish().ok).toBe(false);
  });
});
