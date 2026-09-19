/** The summary block at the top of a record's screen, asserted on the lines it draws
 *  rather than on the props it was handed: the block exists to be read, so what it is
 *  worth is what comes out of the renderer. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit, tally } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

const lines = (width = 100, height = 60): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The block is the first box on the screen, so its rows are the lines between the top
 *  border and the first line that is not a bordered row. */
function summary(out: string[]): string[] {
  const rows: string[] = [];
  for (const line of out.slice(1)) {
    if (!line.startsWith("│")) break;
    rows.push(line.slice(1, -1).trimEnd());
  }
  return rows;
}

/** Where a project is reached from. The dashboard has no projects box — its four boxes are
 *  what waits on you, the open work, what is running and the fold — and the outline is the
 *  way out to the whole workspace, so every chain that starts at a project starts here. */
const fromTheOutline = (): void => {
  app.key("v");
  app.key("t");
  expect(app.screen).toMatchObject({ kind: "outline" });
};

/** Down the chain, the way the other screen tests do it. `endsWith` because an outline row
 *  leads with the tree guide it is drawn under; a node's children list does not. */
const descendTo = (...steps: string[]): void => {
  for (const step of steps) {
    const at = app.lines().findIndex((r) => r.what === step || r.what.endsWith(` ${step}`));
    expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
  }
};

/** The chain from the dashboard down to the acceptance test the extra tasks hang off. */
const TO_TEST = [
  "storefront",
  "1.0.0",
  "account recovery",
  "password reset",
  "one link, one change",
  "a link is emailed",
  "the mail arrives",
] as const;

/** More tasks under the story's acceptance test, so a record has children in more than
 *  one state for the block to add up. */
function crowd(db: DatabaseSync, states: readonly string[]): void {
  const test = (
    db.prepare("SELECT id FROM acceptance_test WHERE slug = 'mail-arrives'").get() as { id: number }
  ).id;
  states.forEach((state, i) =>
    ins(
      db,
      "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      `extra-${i}`,
      test,
      `extra task ${i}`,
      JSON.stringify({ write: ["src/**"], tools: ["bash"] }),
      "engineer",
      JSON.stringify({ tokens: 1000, seconds: 60 }),
      state,
      T,
      T,
    ),
  );
}

describe("the summary block a record's screen opens with", () => {
  beforeEach(fromTheOutline);

  it("names the record one field to a line, and how its children stand on the title", () => {
    descendTo("storefront");
    const out = lines();
    expect(out[0]).toContain(`─ project #${tree.project} · in_progress 1`);
    expect(summary(out)).toEqual([
      "entity    project",
      `id        #${tree.project}`,
      "children  1",
    ]);
  });

  it("sits above the children, which get a box of their own", () => {
    descendTo("storefront");
    const out = lines();
    const children = out.findIndex((l) => l.includes("─ children (1)"));
    expect(children).toBeGreaterThan(summary(out).length);
  });

  it("counts the children by state rather than listing them one by one", () => {
    crowd(db, ["ready", "done", "ready"]);
    app.refresh();
    descendTo(...TO_TEST);
    const out = lines();
    expect(out[0]).toContain("─ acceptance_test #1 · ready 3 · done 1");
    expect(summary(out)).toEqual(["entity    acceptance_test", "id        #1", "children  4"]);
  });

  it("says so with a dash when the record has nothing under it", () => {
    descendTo(...TO_TEST, "send the reset mail", "the mailer is called");
    const out = lines();
    expect(out[0]).toContain("─ task_test #1 · —");
    expect(summary(out)[2]).toBe("children  0");
  });

  it("is drawn whole before the children get a line, however short the terminal", () => {
    descendTo("storefront");
    for (const height of [8, 10, 24]) {
      const out = lines(100, height);
      expect(out).toHaveLength(height);
      expect(summary(out)).toHaveLength(3);
      expect(out[0]).toContain("· in_progress 1");
    }
  });

  it("never draws a line wider than the terminal", () => {
    crowd(db, ["ready", "done", "blocked", "failed"]);
    app.refresh();
    descendTo(...TO_TEST);
    for (const line of lines(28, 40)) expect(line.length).toBeLessThanOrEqual(28);
  });
});

describe("the tally the block's title is written with", () => {
  const row = (state: string) => ({ id: 1, what: "x", state, detail: "task" });

  it("orders the states by how many there are, and ties by name", () => {
    expect(tally(["done", "ready", "ready", "blocked"].map(row))).toBe(
      "ready 2 · blocked 1 · done 1",
    );
  });

  it("is a dash rather than a blank when there are no children", () => {
    expect(tally([])).toBe("—");
  });
});
