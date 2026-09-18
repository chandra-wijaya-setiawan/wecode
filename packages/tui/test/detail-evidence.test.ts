/** A task's detail screen says how it got where it is, and offers only what can be done
 *  to it from there. Two halves of one thing: the attempts and the wall are the evidence,
 *  and the wall is also why the engine refuses `give_up` until it is reached. */
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Engine, loadMachines, open, Verbs } from "@wecode/core";
import { App } from "../src/app.js";
import { loadViews } from "../src/views.js";
import { seed } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

/** The attempts column is a person's to reset, so a test may set it the same way. */
const attempted = (times: number): void => {
  db.prepare("UPDATE task SET attempts = ? WHERE id = ?").run(times, tree.task);
  app.refresh();
};

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

/** Down the chain to the task's own detail screen. */
const onTask = (): void => {
  for (const step of [
    "storefront",
    "1.0.0",
    "account recovery",
    "password reset",
    "one link, one change",
    "a link is emailed",
    "the mail arrives",
    "send the reset mail",
  ]) {
    const at = app.lines().findIndex((r) => r.what === step);
    expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
  }
};

const whats = (): string[] => app.lines().map((r) => r.what);

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

describe("the attempts and the wall, under the summary", () => {
  it("reads them above the children, so they sit directly under the record's fields", () => {
    attempted(2);
    onTask();

    expect(app.screen).toMatchObject({ kind: "node", entity: "task", id: tree.task });
    expect(whats()).toEqual([
      "2 of 3 attempts used",
      "1 left before it gives up",
      "the mailer is called",
    ]);
  });

  it("says the wall is reached rather than counting nothing left", () => {
    attempted(3);
    onTask();

    expect(whats()).toEqual([
      "3 of 3 attempts used",
      "out of attempts — retry, or drop it",
      "the mailer is called",
    ]);
  });

  it("lists nothing for a task nobody has attempted: zero is not evidence of anything", () => {
    onTask();

    expect(whats()).toEqual(["the mailer is called"]);
  });

  it("lists nothing under a record that has no attempts to count", () => {
    const at = app.lines().findIndex((r) => r.what === "storefront");
    app.cursor = at;
    app.key("enter");

    expect(whats()).toEqual(["1.0.0"]);
  });

  it("carries the task's own id, because the fact is about the task above", () => {
    attempted(1);
    onTask();

    expect(app.lines().slice(0, 2)).toEqual([
      { id: tree.task, what: "1 of 3 attempts used", state: "", detail: "" },
      { id: tree.task, what: "2 left before it gives up", state: "", detail: "" },
    ]);
  });

  it("is not a row anything may be done to, or opened", () => {
    attempted(2);
    onTask();
    app.cursor = 0;

    expect(app.verbs()).toEqual([]);
    expect(app.offered()).toEqual([]);

    app.key("a");
    expect(app.status).toBe("nothing may be done to this row");

    app.key("enter");
    expect(app.status).toBe("nothing to open");
    expect(app.screen).toMatchObject({ kind: "node", entity: "task" });
  });
});

describe("only the verbs the engine permits", () => {
  /** The cursor on the queued task, on the dashboard. */
  const onQueuedTask = (): void => {
    app.cursor = app.lines().findIndex((r) => r.what === "send the reset mail");
    expect(app.cursor).toBeGreaterThanOrEqual(0);
  };

  it("drops a verb the state has but a guard holds back", () => {
    onQueuedTask();

    // The machine's table is unchanged: `give_up` is a verb a ready task has.
    expect(app.verbs()).toContain("give_up");
    // The engine refuses it until the attempts run out, so it is not offered.
    expect(app.offered()).toEqual(["drop"]);
  });

  it("offers it once the wall is reached", () => {
    attempted(3);
    onQueuedTask();

    expect(app.offered()).toEqual(["give_up", "drop"]);
  });

  it("arms only the letters it offers", () => {
    onQueuedTask();
    app.key("a");

    expect(app.status).toBe("verb? d drop");
  });

  it("names the wall when the held-back letter is pressed, and writes nothing", () => {
    onQueuedTask();
    app.key("a");
    app.key("g");

    // The guard's own words, which is what the facade would have answered.
    const out = new Verbs(new Engine(db, machines)).giveUpTask(tree.task, "operator");
    expect(out.ok).toBe(false);
    expect(app.status).toBe(out.why);
    expect(stateOf("task", tree.task)).toBe("ready");
  });

  it("applies the verb once the engine permits it", () => {
    attempted(3);
    onQueuedTask();
    app.key("a");
    app.key("g");

    expect(stateOf("task", tree.task)).toBe("failed");
    expect(app.status).toBe(`task #${tree.task} give_up → failed`);
  });

  it("still refuses a letter no verb of the row begins with", () => {
    onQueuedTask();
    app.key("a");
    app.key("z");

    expect(app.status).toBe("no verb on z");
    expect(stateOf("task", tree.task)).toBe("ready");
  });
});
