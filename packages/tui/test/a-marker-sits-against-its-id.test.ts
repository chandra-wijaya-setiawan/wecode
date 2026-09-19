/** The fold marker is a control, and a control is read with the row it acts on. The tree
 *  column is as wide as the deepest row there is, so padding it on the right left a shallow
 *  row's `+` stranded whole levels from its `#` — on the real tree a dozen blank columns
 *  between the key to press and the row it presses. These tests close that gap: the marker
 *  ends the tree cell, the id follows it one gap later, and the guide still starts flush
 *  left so a rail stays in the column its parent drew it in. */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { plain } from "./force-color.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { OUTLINE, outlineLines, padTree, type OutlineConfig } from "../src/outline.js";
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

/** Where the fold marker sits on a drawn line: the last character of the tree cell, which
 *  is the one before the gap that the id follows. */
const markerAt = (line: string): number => line.indexOf("#") - 3;

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

describe("padding the tree cell", () => {
  it("spends the padding between the guide and the marker, not after the marker", () => {
    expect(padTree("-", 5)).toBe("    -");
    expect(padTree("└─+", 5)).toBe("└─  +");
  });

  it("leaves a cell already as wide as its column alone", () => {
    expect(padTree("  └─ ", 5)).toBe("  └─ ");
  });

  it("keeps whatever the marker is, including the blank one a childless row has", () => {
    for (const marker of ["+", "-", " "]) expect(padTree(`├─${marker}`, 6).at(-1)).toBe(marker);
  });

  it("fills a cell that is no drawn row with the column, having no marker to hold right", () => {
    expect(padTree("", 4)).toBe("    ");
  });
});

describe("the drawn line", () => {
  it("puts the marker one gap before the id, on every row whatever its depth", () => {
    for (const line of drawn()) {
      expect(line.slice(markerAt(line)), line).toMatch(/^[-+ ] {2}#\d+/);
    }
  });

  it("reads the marker at one column down the whole tree, as the id already was", () => {
    expect(new Set(drawn().map(markerAt)).size).toBe(1);
  });

  it("leaves the guide flush left, so a rail still sits in the column its parent drew it", () => {
    const lines = drawn();
    expect(lines[1]?.startsWith("└─")).toBe(true);
    expect(lines[2]?.startsWith("  ├─")).toBe(true);
    expect(lines[3]?.startsWith("  └─")).toBe(true);
  });

  it("costs the line nothing: the columns after the tree are where they were", () => {
    const wide: readonly Row[] = ROWS.map((r) => ({ ...r }));
    const before = drawn(wide).map((l) => l.indexOf("#"));
    expect(new Set(before).size).toBe(1);
    // The tree column is still the depth and nothing else: four rows three levels deep
    // spend five columns on it, and the id follows two after that.
    expect(before[0]).toBe(7);
  });

  it("follows the tree wherever the config puts it", () => {
    const config: OutlineConfig = { ...OUTLINE, columns: ["id", "tree", "state"] };
    for (const line of outlineLines(ROWS, 10, null, 200, config)) {
      expect(line.text, line.text).toMatch(/^#\d+\s+[│├└─ ]*[-+ ] {2}\w/);
    }
  });
});

describe("on the real tree", () => {
  it("leaves no blank column between any row's marker and its id", () => {
    for (const line of screen()) {
      expect(line, line).toMatch(/[-+ ] {2}#\d+ {2}\w/);
      expect(line, line).not.toMatch(/[-+] {3,}#/);
    }
  });

  it("holds the root's marker against its id rather than out at the left edge", () => {
    const storefront = screen().find((l) => l.includes("storefront")) ?? "";
    expect(storefront).toMatch(/^ +[-+] {2}#\d+/);
  });
});
