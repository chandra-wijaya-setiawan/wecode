import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@wecode/core";
import { run } from "../src/run.js";
import { recordRed, seed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

let out: string[];
let err: string[];
let db: DatabaseSync;
let ids: ReturnType<typeof seed>;

beforeEach(() => {
  const path = join(tmp("wecode-doctor-"), "wecode.db");
  process.env["WECODE_DB"] = path;
  db = open(path);
  ids = seed(db);
  // The seed leaves its acceptance_test ready with nobody having watched it fail, which is
  // itself an invariant. Record the red run so each test below breaks only its own sentence.
  recordRed(db, ids.acceptance);
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const said = (): string => out.join("");

const T = "2026-09-14T00:00:00.000Z";

/** The lander's own table, created beside the record the way the runner creates it. A
 *  workspace that has landed nothing has no such table at all. */
const recordLanded = (taskId: number): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id INTEGER PRIMARY KEY, branch TEXT NOT NULL, sha TEXT NOT NULL, merged_at TEXT NOT NULL)`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?,?,?,?)")
    .run(taskId, "story/reset", "abc1234", T);
};

const setState = (table: string, id: number, state: string): void => {
  db.prepare(`UPDATE ${table} SET state = ? WHERE id = ?`).run(state, id);
};

/** The seed's whole chain put into its own success state. A story is only quietly delivered
 *  when the work under it finished too; leaving the seed's `ready` task and task_test open
 *  under a delivered story is a different piece of drift — one the upward invariant names —
 *  and the tests that want silence have to not create it. */
const settleUnderTheStory = (): void => {
  setState("requirement", ids.requirement, "met");
  setState("acceptance_criteria", ids.criteria, "accepted");
  setState("acceptance_test", ids.acceptance, "passed");
  setState("task", ids.task, "done");
  db.prepare("UPDATE task_test SET state = 'passed' WHERE parent_id = ?").run(ids.task);
};

describe("wecode doctor", () => {
  it("says nothing and exits zero when the record holds", () => {
    expect(run(["doctor"])).toBe(0);
    expect(said()).toBe("");
    expect(err.join("")).toBe("");
  });

  it("names the invariant and the entity for a delivered story nothing recorded landing", () => {
    setState("story", ids.story, "delivered");

    expect(run(["doctor"])).not.toBe(0);
    expect(said()).toContain("delivered_story_has_landed");
    expect(said()).toContain(`story #${ids.story}`);
    expect(said()).toContain("reset");
  });

  it("is quiet about a delivered story once something under it is recorded as landed", () => {
    setState("story", ids.story, "delivered");
    settleUnderTheStory();
    recordLanded(ids.task);

    expect(run(["doctor"])).toBe(0);
    expect(said()).toBe("");
  });

  it("reports several broken invariants at once, grouped, with every entity that breaks one", () => {
    // A criteria whose test failed, with no open task under it.
    setState("acceptance_test", ids.acceptance, "failed");
    setState("task", ids.task, "done");
    // A requirement that is met though every criteria under it is dropped.
    setState("requirement", ids.requirement, "met");
    setState("acceptance_criteria", ids.criteria, "dropped");
    // A second story, in_progress, with nothing under it at all.
    db.prepare(
      "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("empty-shape", ids.epic, "a shape with nothing in it", "in_progress", T, T);
    const empty = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

    expect(run(["doctor"])).not.toBe(0);
    const text = said();

    expect(text).toContain("failing_criteria_has_an_open_task");
    expect(text).toContain(`acceptance_criteria #${ids.criteria}`);

    expect(text).toContain("all_children_dropped_is_not_success");
    expect(text).toContain(`requirement #${ids.requirement}`);

    expect(text).toContain("story_in_progress_has_a_requirement");
    expect(text).toContain(`story #${empty}`);
    // The story that does have a requirement under it is not accused of being empty.
    expect(text).not.toContain(`story #${ids.story}`);

    // Dropping the criteria leaves its failed acceptance_test open beneath it, and marking
    // the task done leaves its task_test open beneath that: two children of settled parents,
    // named one each, which is what the upward check is for.
    expect(text).toContain("nothing_is_open_under_a_settled_parent");
    expect(text).toContain(`acceptance_test #${ids.acceptance}`);
    expect(text).toContain("task_test #");

    // Grouped: each invariant is named once, with its entities beneath it.
    expect(text.match(/story_in_progress_has_a_requirement/g)).toHaveLength(1);
    expect(text.match(/nothing_is_open_under_a_settled_parent/g)).toHaveLength(1);
    expect(text).toContain("5 entities breaking 4 invariants");
  });

  it("names the role of a ready task when nobody fills it", () => {
    setState("task", ids.task, "ready");

    expect(run(["doctor"])).not.toBe(0);
    expect(said()).toContain("role_with_ready_work_has_a_worker");
    expect(said()).toContain("engineer");
  });

  it("is quiet about a ready task once its role has a worker", () => {
    setState("task", ids.task, "ready");
    db.prepare("INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("ada", "ada", "engineer", "agent", T, T);

    expect(run(["doctor"])).toBe(0);
    expect(said()).toBe("");
  });

  it("names a ready acceptance_test nobody has watched fail", () => {
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = NULL WHERE id = ?").run(ids.acceptance);

    expect(run(["doctor"])).not.toBe(0);
    expect(said()).toContain("ready_acceptance_test_was_red_at_base");
    expect(said()).toContain(`acceptance_test #${ids.acceptance}`);
  });

  it("names a ready task whose only task_test is still planned", () => {
    setState("task", ids.task, "ready");
    setState("task_test", ids.taskTest, "planned");
    db.prepare("INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("ada", "ada", "engineer", "agent", T, T);

    expect(run(["doctor"])).not.toBe(0);
    expect(said()).toContain("ready_task_has_a_ready_task_test");
    expect(said()).toContain(`task #${ids.task}`);
  });

  it("reports a schema_version this build does not understand", () => {
    db.exec("DELETE FROM schema_version");
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(999);

    expect(run(["doctor"])).not.toBe(0);
    expect(said()).toContain("schema_version_is_understood");
    expect(said()).toContain("999");
  });

  it("writes nothing to the database it is inspecting", () => {
    setState("story", ids.story, "delivered");
    const before = db.prepare("SELECT count(*) AS n FROM ledger").get() as { n: number };

    expect(run(["doctor"])).not.toBe(0);

    const after = db.prepare("SELECT count(*) AS n FROM ledger").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect((db.prepare("SELECT state FROM story WHERE id = ?").get(ids.story) as { state: string }).state)
      .toBe("delivered");
  });

  it("exits non-zero without a database rather than creating one", () => {
    process.env["WECODE_DB"] = join(tmp("wecode-doctor-none-"), "nothing.db");

    expect(run(["doctor"])).not.toBe(0);
    expect(err.join("")).toContain("no workspace");
  });
});
