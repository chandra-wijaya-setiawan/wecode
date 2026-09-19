/** Enter on a record opens a page that says which record it is.
 *
 *  What each test here can only pass when the work is done: the screen carries the row it
 *  was opened from, the page's first line leads with that record's title and its state
 *  rather than with `task #3`, the title is the record's own and not the outline line it
 *  was drawn as, and the entity and the id are still on the block for anyone who needs the
 *  key. A test that only asserted `app.screen.row` existed would pass against a page that
 *  carried the record and then drew none of it.
 */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { seed } from "./seed.js";

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

const lines = (width = 100, height = 40): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The rows of the first box on the screen, which is the summary block. */
const summary = (out: string[]): string[] => {
  const rows: string[] = [];
  for (const line of out.slice(1)) {
    if (!line.startsWith("│")) break;
    rows.push(line.slice(1, -1).trimEnd());
  }
  return rows;
};

/** The outline is the way out to the whole tree: the dashboard has no projects box. */
const fromTheOutline = (): void => {
  app.key("v");
  app.key("t");
  expect(app.screen).toMatchObject({ kind: "outline" });
};

/** `endsWith` because an outline line leads with the guide it is drawn under, while a
 *  node's children list draws the label alone. */
const descendTo = (...steps: string[]): void => {
  for (const step of steps) {
    const at = app.lines().findIndex((r) => r.what === step || r.what.endsWith(` ${step}`));
    expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
    app.cursor = at;
    app.key("enter");
  }
};

const TO_TASK = [
  "storefront",
  "1.0.0",
  "account recovery",
  "password reset",
  "one link, one change",
  "a link is emailed",
  "the mail arrives",
  "send the reset mail",
] as const;

describe("the record a detail page was opened on", () => {
  beforeEach(fromTheOutline);

  it("goes with the screen, so the page holds the row and not just the key", () => {
    descendTo("storefront");
    expect(app.screen).toMatchObject({
      kind: "node",
      entity: "project",
      id: tree.project,
      row: { id: tree.project, what: "storefront", state: "in_progress" },
    });
  });

  it("is the record's own title, not the outline line it was drawn as", () => {
    const at = app.lines().findIndex((r) => r.what.endsWith(" storefront"));
    expect(app.lines()[at]?.what).not.toBe("storefront");
    app.cursor = at;
    app.key("enter");
    expect(app.screen).toMatchObject({ row: { what: "storefront" } });
    expect(lines()[0]).not.toContain("- storefront");
  });

  it("is carried again for the next record, rather than staying on the first", () => {
    descendTo("storefront");
    expect(lines()[0]).toContain("storefront · in_progress");
    descendTo("1.0.0");
    expect(app.screen).toMatchObject({ kind: "node", entity: "release", row: { what: "1.0.0" } });
    expect(lines()[0]).toContain("1.0.0 · ");
    expect(lines()[0]).not.toContain("storefront");
  });

  it("comes back with esc, title and all", () => {
    descendTo("storefront", "1.0.0");
    app.key("esc");
    expect(lines()[0]).toContain("storefront · in_progress");
  });
});

describe("the page a record's title and state lead", () => {
  beforeEach(fromTheOutline);

  it("names the record in the title bar, with its state after it", () => {
    descendTo(...TO_TASK);
    const out = lines();
    expect(out[0]).toContain("─ send the reset mail · ");
    expect(out[0]).toMatch(/─ send the reset mail · \w+ ─/);
  });

  it("does not lead with the entity and the id, which name a row of a table", () => {
    descendTo(...TO_TASK);
    expect(lines()[0]).not.toContain("task #");
  });

  it("keeps the entity and the id on the block, so the key is still reachable", () => {
    descendTo(...TO_TASK);
    const rows = summary(lines());
    expect(rows[0]).toBe("entity    task");
    expect(rows[1]).toBe(`id        #${tree.task}`);
  });

  it("puts the title and the state in the block too, where neither is clipped by a border", () => {
    descendTo(...TO_TASK);
    const rows = summary(lines());
    expect(rows).toContain("title     send the reset mail");
    expect(rows.some((r) => /^state {5}\w+$/.test(r))).toBe(true);
  });

  it("leaves how the children stand on the children box, next to the count it refines", () => {
    descendTo("storefront");
    const out = lines();
    expect(out.join("\n")).toContain("─ children (1) · in_progress 1");
    expect(out[0]).not.toContain("in_progress 1");
  });

  it("clips the title to the terminal rather than drawing past it", () => {
    descendTo(...TO_TASK);
    for (const line of lines(30, 24)) expect(line.length).toBeLessThanOrEqual(30);
  });
});
