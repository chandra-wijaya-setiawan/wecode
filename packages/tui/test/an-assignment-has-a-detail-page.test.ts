/** Enter on an assignment row reaches a page of its own.
 *
 *  What each test here can only pass when the work is done: enter on a running row lands
 *  on an assignment screen rather than on the refusal the tree used to give it, the page
 *  draws the row's own facts, esc comes back to the row you left, and a waiting approval
 *  gets the same page with its question on it. A test that only asserted the status line
 *  changed would pass against a screen that drew nothing.
 */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, Maker, open, raiseApproval } from "@wecode/core";
import { App } from "../src/app.js";
import { Assignment, Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { ins, seed, T } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

/** A worker to hold the assignment, named so the running row's detail can be checked
 *  against a name rather than against the `?` a missing worker draws. */
function claude(d: DatabaseSync): number {
  const make = new Maker(d);
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  return make.worker("claude", "engineer", "agent");
}

/** An assignment an agent is working, which is what puts a row in the running box. */
function running(worker: number, phase = "running"): number {
  return ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "send-mail-1",
    "task",
    tree.task,
    worker,
    JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }),
    JSON.stringify({ tokens: 1000, seconds: 60 }),
    "/wt/send-mail",
    phase,
    2000,
    T,
    T,
  );
}

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
});

afterEach(cleanup);

const lines = (width = 100, height = 40): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The rows of the first box on screen, without its borders. */
function summary(out: string[]): string[] {
  const rows: string[] = [];
  for (const line of out.slice(1)) {
    if (!line.startsWith("│")) break;
    rows.push(line.slice(1, -1).trimEnd());
  }
  return rows;
}

/** Put the cursor on the dashboard row for this assignment and open it. */
function openAssignment(id: number): void {
  const at = app.lines().findIndex((r) => r.id === id && r.what.includes("reset mail"));
  expect(at, `no assignment row for #${id}`).toBeGreaterThanOrEqual(0);
  app.cursor = at;
  app.key("enter");
}

describe("enter on an assignment row reaches the assignment", () => {
  it("opens the assignment screen rather than refusing it for having nothing under it", () => {
    const id = running(claude(db));
    app = new App(db, views, machines);

    openAssignment(id);

    expect(app.screen).toMatchObject({ kind: "assignment", id });
    expect(app.status).toBe(`assignment #${id}`);
  });

  it("draws the record it was opened from, one field to a line", () => {
    const id = running(claude(db));
    app = new App(db, views, machines);
    // The board's own row, so the page is asserted against what the dashboard says rather
    // than against a second reading of the database that could drift from it.
    const row = app.lines().find((r) => r.id === id && r.what.includes("reset mail"));
    expect(row, "no assignment row").toBeDefined();

    openAssignment(id);

    const out = lines();
    expect(out[0]).toContain(`─ assignment #${id} · running`);
    expect(summary(out)).toEqual([
      "entity     assignment",
      `id         #${id}`,
      "objective  send the reset mail",
      "state      running",
      `detail     ${row?.detail}`,
    ]);
    expect(row?.detail).toContain("claude");
  });

  it("holds no rows, so the cursor has nothing to move over and enter opens nothing", () => {
    const id = running(claude(db));
    app = new App(db, views, machines);
    openAssignment(id);

    expect(app.lines()).toEqual([]);

    app.key("j");
    app.key("enter");

    expect(app.screen).toMatchObject({ kind: "assignment", id });
    expect(app.status).toBe("nothing to open");
  });

  it("comes back on esc to the row it was opened from", () => {
    const id = running(claude(db));
    app = new App(db, views, machines);
    const at = app.lines().findIndex((r) => r.id === id && r.what.includes("reset mail"));
    openAssignment(id);

    app.key("esc");

    expect(app.screen).toEqual({ kind: "dashboard" });
    expect(app.cursor).toBe(at);
    expect(app.lines()[at]?.id).toBe(id);
  });

  it("puts a waiting approval's question on the page", () => {
    const make = new Maker(db);
    make.role("operator", { write: [], tools: [] }, "human");
    const worker = make.worker("dana", "operator", "human");
    const approval = raiseApproval(db, {
      objective_type: "task",
      objective_id: tree.task,
      worker_id: worker,
      question: "ship the reset mail to production?",
    });
    app = new App(db, views, machines);
    const at = app.lines().findIndex((r) => r.detail.includes("ship the reset"));
    expect(at, "no needs-you row").toBeGreaterThanOrEqual(0);
    app.cursor = at;

    app.key("enter");

    const out = lines();
    expect(app.screen).toMatchObject({ kind: "assignment", id: approval.id });
    // The needs-you box states the row by the kind of answer it wants, and the page says
    // the same word: what it is waiting for is the first thing to read off it.
    expect(out[0]).toContain(`─ assignment #${approval.id} · approval`);
    expect(summary(out)).toContain("state      approval");
    expect(summary(out)).toContain("detail     ship the reset mail to production?");
  });

  it("says so with a dash rather than leaving a blank line when the row has no detail", () => {
    const screen = {
      kind: "assignment",
      id: 7,
      row: { id: 7, what: "task #3", state: "input", detail: "" },
    } as const;

    const out = plain(
      render(createElement(Assignment, { screen, width: 40 })).lastFrame() ?? "",
    ).split("\n");

    expect(summary(out)).toContain("detail     —");
  });

  it("never draws a line wider than the terminal", () => {
    const id = running(claude(db));
    app = new App(db, views, machines);
    openAssignment(id);

    for (const line of lines(28, 20)) expect(line.length).toBeLessThanOrEqual(28);
  });

  it("offers esc on its key bar, because the screen is one you came down to", () => {
    const id = running(claude(db));
    app = new App(db, views, machines);
    openAssignment(id);

    const bar = lines().at(-1) ?? "";
    expect(bar).toContain("esc back");
    expect(bar).toContain("enter open");
  });
});
