/** The guide says where the row sits, the marker says what pressing does to it, and the id
 *  says which row it is — three readings of the same row, so they have to draw as one thing.
 *  Holding the marker against the id closed the gap on the right and moved it inside the
 *  cell: `└─` then blank columns then `+`, which reads as a branch that stops and a marker
 *  belonging to nobody. These tests hold the run unbroken — the branch continues across the
 *  columns the depth did not spend, and arrives at the marker and the id. */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { plain } from "./force-color.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { OUTLINE, outlineLines, padTree } from "../src/outline.js";
import { seed } from "./seed.js";
import type { Row } from "../src/list.js";

afterEach(cleanup);

/** Four rows, three levels deep, so the tree column is wider than most of what goes in it. */
const ROWS: readonly Row[] = [
  { id: 1, what: "+ storefront", state: "in_progress", detail: "project · 3 under" },
  { id: 22, what: "└─- 1.0.0", state: "planned", detail: "release · 2 under" },
  { id: 333, what: "  ├─  account recovery", state: "ready", detail: "epic" },
  { id: 4444, what: "  └─  checkout", state: "ready", detail: "epic" },
];

const drawn = (rows: readonly Row[] = ROWS): string[] =>
  outlineLines(rows, 10, null, 200).map((l) => l.text);

/** The outline as a reader sees it, inside the box and without the borders. */
const screen = (): string[] => {
  const db: DatabaseSync = open(":memory:");
  seed(db);
  const app = new App(db, loadViews(), loadMachines());
  app.key("v");
  app.key(OUTLINE.key);
  const frame = render(createElement(Cockpit, { app, width: 120, height: 40 })).lastFrame() ?? "";
  return plain(frame)
    .split("\n")
    .filter((l) => l.startsWith("│"))
    .map((l) => l.slice(1, -1).trimEnd())
    .filter((l) => l !== "");
};

describe("filling the tree cell", () => {
  it("runs the branch on across the columns the depth did not spend", () => {
    expect(padTree("└─+", 5)).toBe("└───+");
    expect(padTree("├─-", 7)).toBe("├─────-");
  });

  it("carries the blank marker of a childless row the same way", () => {
    expect(padTree("  └─ ", 9)).toBe("  └───── ");
  });

  it("leaves a cell already as wide as its column alone", () => {
    expect(padTree("  └─ ", 5)).toBe("  └─ ");
    expect(padTree("├─-", 3)).toBe("├─-");
  });

  it("leaves a root blank, having no branch to continue", () => {
    expect(padTree("+", 5)).toBe("    +");
    expect(padTree(" ", 3)).toBe("   ");
  });

  it("fills a cell that is no drawn row with the column, having no marker to hold right", () => {
    expect(padTree("", 4)).toBe("    ");
  });
});

describe("the drawn line", () => {
  it("leaves no blank between the guide and the marker on any row that has a guide", () => {
    for (const line of drawn()) {
      const cell = line.slice(0, line.indexOf("#") - 2);
      if (!/^[│├└ ]*[├└]/.test(cell)) continue;
      expect(cell, line).toMatch(/^(?:[│ ] |[│ ]{2})*[├└]─+[-+ ]$/);
    }
  });

  it("still starts the guide flush left, so a rail sits in the column its parent drew it", () => {
    const lines = drawn();
    expect(lines[1]?.startsWith("└─")).toBe(true);
    expect(lines[2]?.startsWith("  ├─")).toBe(true);
    expect(lines[3]?.startsWith("  └─")).toBe(true);
  });

  it("still ends the run at the id, one gap past the marker, down the whole tree", () => {
    const at = drawn().map((l) => l.indexOf("#"));
    expect(new Set(at).size).toBe(1);
    for (const line of drawn()) expect(line.slice(0, at[0]), line).toMatch(/[-+ ] {2}$/);
  });

  it("spends the leader on the tree column and nothing else", () => {
    // Every horizontal on the line is inside the cell the guide and marker share.
    for (const line of drawn()) expect(line.lastIndexOf("─"), line).toBeLessThan(line.indexOf("#"));
  });

  it("costs the line nothing: the id is at the column it was already at", () => {
    expect(drawn()[0]?.indexOf("#")).toBe(7);
  });
});

describe("on the real tree", () => {
  it("draws every guided row as one run from its branch to its id", () => {
    const guided = screen().filter((l) => /^[│ ]*[├└]/.test(l));
    expect(guided.length).toBeGreaterThan(0);
    for (const line of guided) {
      expect(line, line).toMatch(/^(?:[│ ]{2})*[├└]─+[-+ ] {2}#\d+ {2}\w/);
    }
  });

  it("leaves the run unbroken however shallow the row, not only at the deepest", () => {
    // The deepest row spends the whole column on its depth and would read unbroken however
    // the cell were padded; the shallow one is the row the leader is for.
    const guided = screen().filter((l) => /^[├└]/.test(l));
    expect(guided.length).toBeGreaterThan(0);
    for (const line of guided) expect(line, line).not.toMatch(/[├└]─ +[-+ ] {2}#/);
  });
});
