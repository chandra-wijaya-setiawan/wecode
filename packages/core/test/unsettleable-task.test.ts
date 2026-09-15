/** A task that could never finish is refused before an agent is spent on it.
 *
 *  Observed on task 198, 15 Sep: it carried task_test 199 in `planned` beside 200 in
 *  `ready`. `task_may_be_attempted` asks only for one ready-or-passed test, so the task
 *  started and an agent worked; `finish` is guarded by `every_task_test_settled`, and
 *  `planned` is neither passed nor dropped, so the task was going to burn every retry with
 *  the board silent about the reason. Only reading the row found it.
 *
 *  So the refusal is raised at `start`, names the planned test, and says what to do with
 *  it. `dropped` is settled, so a dropped test is not an obstacle.
 */
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, commandOf } from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

const T = "2026-09-13T00:00:00.000Z";

describe("a task whose tests can never settle is refused before it starts", () => {
  let db: DatabaseSync;
  let tree: ReturnType<typeof seed>;

  /** A second task_test on the fixture's task, in the given state. */
  const extraTest = (state: string, slug: string): number => {
    db.prepare(
      "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(slug, tree.task, `the ${slug} path is covered`, "script", "vitest run other", state, T, T);
    return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  };

  const start = () => new Engine(db).apply("task", tree.task, "start", "operator");

  beforeEach(() => {
    db = freshDb();
    tree = seed(db);
  });

  it("refuses a task carrying a planned test, naming that test", () => {
    const planned = extraTest("planned", "token-expires");
    const out = start();

    expect(out.ok).toBe(false);
    const why = out.ok === false ? out.why : "";
    // The row the operator had to read by hand, in the refusal instead.
    expect(why).toContain(`#${planned}`);
    expect(why).toContain("planned");
    expect(why).toContain(commandOf("checks.task_may_be_attempted.planned_test"));
    expect(stateOf(db, "task", tree.task)).toBe("planned");
  });

  it("refuses it even though one test is ready — that is what hid the gap", () => {
    extraTest("planned", "token-expires");
    // task_test 200's equivalent: the fixture's own test is already `ready`, which is what
    // satisfied the old requirement and let the task dispatch.
    expect(stateOf(db, "task_test", tree.taskTest)).toBe("ready");
    expect(start().ok).toBe(false);
  });

  it("starts a task whose tests are all ready or passed", () => {
    extraTest("passed", "mail-sent");
    const out = start();

    expect(out.ok, out.ok === false ? out.why : "").toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("is not blocked by a dropped test — dropped is settled", () => {
    extraTest("dropped", "abandoned");
    const out = start();

    expect(out.ok, out.ok === false ? out.why : "").toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("still refuses a task with no ready or passed test at all", () => {
    // The existing requirement is kept: a dropped-only task proves nothing either.
    db.prepare("UPDATE task_test SET state = 'dropped' WHERE id = ?").run(tree.taskTest);
    const out = start();

    expect(out.ok).toBe(false);
    expect(out.ok === false ? out.why : "").toContain("no task_test is ready");
  });

  it("answers a task whose only test is planned with the nearer reason", () => {
    // Nothing is ready or passed, so the task cannot prove itself at all; that older
    // refusal is the one to read, and it is asked first.
    db.prepare("UPDATE task_test SET state = 'planned' WHERE id = ?").run(tree.taskTest);
    const out = start();

    expect(out.ok).toBe(false);
    expect(out.ok === false ? out.why : "").toContain("no task_test is ready");
  });

  it("the refusal's command is one the operator can actually run", () => {
    // Proved row-by-row in refusal-commands.test.ts; asserted here so the text this test
    // pins is the table's and not a hand-typed copy.
    expect(commandOf("checks.task_may_be_attempted.planned_test")).toBe("wecode task_test deliver <id>");
  });
});
