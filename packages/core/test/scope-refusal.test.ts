import { describe, expect, it } from "vitest";
import {
  board,
  Engine,
  recordScopeRefusal,
  scopeRefusals,
  setTaskScope,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** Seven tasks on 15 Sep burned every attempt on a file outside their write scope, and the
 *  board said only 'out of attempts'. The refusal existed — in the attempt's own output,
 *  which is the one place nobody reads. These are the three things that has to become. */
describe("a write the scope refused", () => {
  it("is recorded against the task", () => {
    const db = freshDb();
    const tree = seed(db);

    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);

    expect(scopeRefusals(db, tree.task)).toEqual(["config/views.yaml"]);
  });

  it("accumulates across attempts, and the same path twice is one ask", () => {
    const db = freshDb();
    const tree = seed(db);

    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);
    recordScopeRefusal(db, tree.task, ["config/views.yaml", "packages/tui/src/views.ts"]);

    expect(scopeRefusals(db, tree.task)).toEqual([
      "config/views.yaml",
      "packages/tui/src/views.ts",
    ]);
  });

  it("is cleared when the scope is widened to include it", () => {
    const db = freshDb();
    const tree = seed(db);
    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);

    setTaskScope(db, tree.task, { write: ["src/mail/**", "config/**"], tools: ["bash"] });

    expect(scopeRefusals(db, tree.task)).toEqual([]);
  });

  it("stands until the scope covers it: a widening elsewhere changes nothing", () => {
    const db = freshDb();
    const tree = seed(db);
    recordScopeRefusal(db, tree.task, ["config/views.yaml", "packages/tui/src/views.ts"]);

    setTaskScope(db, tree.task, { write: ["src/mail/**", "packages/tui/src/**"], tools: ["bash"] });

    expect(scopeRefusals(db, tree.task)).toEqual(["config/views.yaml"]);
  });

  it("says so on the board where a task out of attempts said nothing", () => {
    const db = freshDb();
    const tree = seed(db);
    // Out of attempts, as the runner leaves it: the state and the count together are what
    // makes the board say 'out of attempts'.
    db.prepare("UPDATE task SET state = 'failed', attempts = max_retry WHERE id = ?").run(tree.task);
    recordScopeRefusal(db, tree.task, ["config/views.yaml"]);

    const row = board(db).failed.find((r) => r.id === tree.task);

    expect(row?.detail).toContain("refused a write to config/views.yaml");
    // Still the sentence it was: what to do about it is the other half of the answer.
    expect(row?.detail).toContain("out of attempts");
    expect(row?.detail).toContain("retry it with a reason, or drop it");
  });

  it("says so beside the refusal that kept it queued", () => {
    const db = freshDb();
    const tree = seed(db);
    new Engine(db).apply("task", tree.task, "start", "chief");
    recordScopeRefusal(db, tree.task, ["packages/core/test/chore.test.ts"]);

    const row = board(db).queued.find((r) => r.id === tree.task);

    expect(row?.detail).toContain("refused a write to packages/core/test/chore.test.ts");
  });

  it("leaves the detail alone when nothing was refused", () => {
    const db = freshDb();
    const tree = seed(db);
    new Engine(db).apply("task", tree.task, "start", "chief");

    expect(board(db).queued.find((r) => r.id === tree.task)?.detail).toBe("engineer");
  });
});
