import { describe, expect, it } from "vitest";
import { CreateError, Engine, Maker } from "../src/index.js";
import { freshDb, stateOf } from "./helpers.js";

describe("rows start where their machine says", () => {
  it("builds a tree, each node in its initial state", () => {
    const db = freshDb();
    const make = new Maker(db);
    const ws = make.workspace("acme", "/acme");
    const project = make.project(ws, "storefront", "/repo");
    const release = make.release(project, "1.0.0");
    const epic = make.epic(release, "account recovery");
    const story = make.story(epic, "password reset");

    expect(stateOf(db, "project", project)).toBe("planned");
    expect(stateOf(db, "release", release)).toBe("planned");
    expect(stateOf(db, "epic", epic)).toBe("planned");
    expect(stateOf(db, "story", story)).toBe("planned");
  });

  it("an assignment starts pending, with nothing spent", () => {
    const db = freshDb();
    const make = new Maker(db);
    const worker = make.worker("claude-1", "engineer", "agent");
    const id = make.assignment({
      objective_type: "task",
      objective_id: 1,
      worker_id: worker,
      scope: { write: ["src/**"], tools: ["bash"] },
      budget: { tokens: 100, seconds: 10 },
      worktree: "/tmp/wt",
    });
    const row = db.prepare("SELECT phase, spent FROM assignment WHERE id = ?").get(id) as {
      phase: string;
      spent: string;
    };
    expect(row.phase).toBe("pending");
    expect(JSON.parse(row.spent)).toEqual({ tokens: 0, seconds: 0 });
    expect(new Engine(db).may("assignment", id, "start").ok).toBe(true);
  });

  it("a task with no scope cannot start, and says which command fixes it", () => {
    const db = freshDb();
    const make = new Maker(db);
    const ws = make.workspace("acme", "/acme");
    const p = make.project(ws, "s", "/r");
    const rel = make.release(p, "1.0.0");
    const e = make.epic(rel, "e");
    const s = make.story(e, "s");
    const req = make.requirement(s, "r");
    const c = make.criteria(req, "c");
    const at = make.acceptanceTest(c, "a", "script", "bash x.sh");
    const t = make.task(at, "do the thing");
    const r = new Engine(db).apply("task", t, "start", "chief");
    expect(!r.ok && r.why).toContain("wecode task scope");
  });
});

describe("a slug that is already taken says who holds it", () => {
  const tree = (make: Maker): number => {
    const p = make.project(make.workspace("acme", "/acme"), "storefront", "/r");
    const c = make.criteria(make.requirement(make.story(make.epic(make.release(p, "1.0.0"), "e"), "s"), "r"), "c");
    return make.acceptanceTest(c, "a", "script", "bash x.sh");
  };
  // Titles long enough that the slug is truncated: this is how two different titles that
  // only start alike end up as one slug.
  const first = "rewrite the mailer so a reset link authenticates exactly one change";
  const second = "rewrite the mailer so a reset link authenticates one change only";

  it("names the task holding the slug, and says a dropped task still holds it", () => {
    const db = freshDb();
    const make = new Maker(db);
    const at = tree(make);
    const held = make.task(at, first);
    expect(new Engine(db).apply("task", held, "drop", "chief").ok).toBe(true);

    expect(() => make.task(at, second)).toThrow(CreateError);
    let why = "";
    try {
      make.task(at, second);
    } catch (err) {
      why = (err as Error).message;
    }
    expect(why).toContain("task:");
    expect(why).toContain(JSON.stringify("rewrite-the-mailer-so-a-reset-link-authenticates"));
    expect(why).toContain(`#${held}`);
    expect(why).toContain("dropped");
    expect(why).toContain("A dropped row still holds its slug.");
    expect(why).toMatch(/different title/);
  });

  it("refuses a colliding slug under the same parent", () => {
    const db = freshDb();
    const make = new Maker(db);
    const task = make.task(tree(make), "send the reset mail");
    const held = make.taskTest(task, first, "script", "vitest run a");
    expect(() => make.taskTest(task, second, "script", "vitest run b")).toThrow(
      new RegExp(`task_test: slug .* is already taken by task_test #${held}`),
    );
  });

  it("allows the same slug under a different parent", () => {
    const db = freshDb();
    const make = new Maker(db);
    const at = tree(make);
    const one = make.task(at, "send the reset mail");
    const two = make.task(at, "send the welcome mail");
    make.taskTest(one, first, "script", "vitest run a");
    expect(() => make.taskTest(two, second, "script", "vitest run b")).not.toThrow();
  });
});

describe("a release version is major.minor.patch", () => {
  it("takes 0.0.1 and 2.0.0-rc.1", () => {
    const db = freshDb();
    const make = new Maker(db);
    const p = make.project(make.workspace("a", "/a"), "p", "/r");
    expect(() => make.release(p, "0.0.1")).not.toThrow();
    expect(() => make.release(p, "2.0.0-rc.1")).not.toThrow();
  });

  it("refuses 0.1, and says what it wanted", () => {
    const db = freshDb();
    const make = new Maker(db);
    const p = make.project(make.workspace("a", "/a"), "p", "/r");
    expect(() => make.release(p, "0.1")).toThrow(/major\.minor\.patch/);
  });
});
