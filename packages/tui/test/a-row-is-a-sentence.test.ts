/** A row is a sentence indented by its depth. No columns, and no rail.
 *
 *  The outline drew four columns — a tree cell with a rail down it, an id, a four-letter
 *  type and a four-letter state — and each of them cost the whole tree's width on every
 *  row. A project at the top paid the deepest task_test's indent, the type and state had
 *  to be cut to four characters to fit their columns at all, and the rail spent two
 *  columns a level saying the thing the indent was already saying.
 *
 *  These tests hold the line to prose: leading spaces and then a sentence, the words in
 *  full, nothing padded, and no box-drawing character anywhere on it. They supersede
 *  outline-columns, outline-columns-before-prose, a-marker-sits-against-its-id and
 *  the-tree-cell-is-contiguous, which held the columns this replaces.
 *
 *  What the outline holds *behind* the screen is unchanged and still tested by
 *  outline-connectors: `outlineRows` writes the guide into `what` because the cursor, the
 *  search and the fold keys read it. It is the depth written down, and the drawing reads
 *  the depth back off it rather than counting a second way. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { plain } from "./force-color.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { depthOf, INDENT, loadOutline, OUTLINE, outlineLines, sentence } from "../src/outline.js";
import { seed } from "./seed.js";
import type { Row } from "../src/list.js";

afterEach(cleanup);

const row = (over: Partial<Row> = {}): Row => ({
  id: 7,
  what: "├─- storefront",
  state: "in_progress",
  detail: "story · 3 under · 2 planned",
  ...over,
});

/** Four rows, three levels deep, so a shallow row and a deep one are on the same screen. */
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

/** Where the sentence starts: the indent is the only leading blank there is. */
const indentOf = (line: string): number => line.length - line.trimStart().length;

describe("the depth of a drawn row", () => {
  it("is read off the guide, one level per two columns", () => {
    expect(depthOf("")).toBe(0);
    expect(depthOf("-")).toBe(0);
    expect(depthOf("├─-")).toBe(1);
    expect(depthOf("│ └─+")).toBe(2);
    expect(depthOf("    ├─ ")).toBe(3);
  });
});

describe("a row as a sentence", () => {
  it("indents it by its depth and by nothing else", () => {
    expect(indentOf(sentence(row({ what: "- storefront" })))).toBe(0);
    expect(indentOf(sentence(row({ what: "├─- 1.0.0" })))).toBe(INDENT);
    expect(indentOf(sentence(row({ what: "│ └─- checkout" })))).toBe(2 * INDENT);
  });

  it("leads with the fold marker and the label, so the row still says what to press", () => {
    expect(sentence(row({ what: "├─+ storefront" }))).toMatch(/^ +\+ storefront · /);
    expect(sentence(row({ what: "- storefront" }))).toMatch(/^- storefront · /);
  });

  it("says the label, the id, the kind, the state and the rollup, in that order", () => {
    expect(sentence(row())).toBe("  - storefront · #7 · story · in_progress · 3 under · 2 planned");
  });

  it("says the kind and the state in full, having no column to cut them to", () => {
    const line = sentence(row({ what: "- x", detail: "acceptance_test" }));
    expect(line).toContain("acceptance_test");
    expect(line).toContain("in_progress");
    expect(line).not.toMatch(/\batst\b|\bwork\b/);
  });

  it("leaves out a part the row does not have rather than spacing out an empty one", () => {
    expect(sentence(row({ what: "- x", detail: "" }))).toBe("- x · #7 · in_progress");
  });

  it("carries the marks outlineRows put on the row, orphans and the next task alike", () => {
    const line = sentence(row({ detail: "story · orphaned · next to run" }));
    expect(line).toContain("orphaned");
    expect(line).toContain("next to run");
  });

  it("costs a long label the line it is on and no other", () => {
    const long = sentence(row({ what: "├─- an unusually long name for a release" }));
    const short = sentence(row({ what: "├─- 1.0.0" }));
    expect(indentOf(long)).toBe(indentOf(short));
  });
});

describe("the lines it draws", () => {
  it("pads nothing: a line is as long as it has something to say", () => {
    for (const line of drawn()) expect(line, line).toBe(line.trimEnd());
    // Two rows at the same depth with different labels start their id at different columns
    // — the id is in the sentence, not in a column of its own.
    const at = drawn().map((l) => l.indexOf("#"));
    expect(new Set(at).size).toBeGreaterThan(1);
  });

  it("draws no rail, no tee and no elbow — the indent is the whole of the guide", () => {
    for (const line of drawn()) expect(line, line).not.toMatch(/[│├└─]/);
  });

  it("steps one level in for one level down, and back out again", () => {
    // Measured from the label rather than from the first non-blank: a childless row's
    // marker is itself a blank, and it holds the label's column all the same.
    const lines = drawn();
    const at = (label: string): number =>
      (lines.find((l) => l.includes(label)) as string).indexOf(label) - 2;
    expect(["storefront", "1.0.0", "account recovery", "checkout"].map(at))
      .toEqual([0, INDENT, 2 * INDENT, 2 * INDENT]);
  });

  it("keeps the state on the line for colour, so a row is still coloured by its state", () => {
    expect(outlineLines(ROWS, 10, null, 200)[1]?.state).toBe("planned");
  });

  it("marks the cursor's row and no other", () => {
    const marked = outlineLines(ROWS, 10, 1, 200).filter((l) => l.cursor);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toContain("1.0.0");
  });

  it("reports what the height hid, and scrolls the cursor into what is left", () => {
    expect(outlineLines(ROWS, 2, null, 200).at(-1)?.text).toBe("… and 3 more");
    expect(outlineLines(ROWS, 2, 3, 200)[0]?.text).toContain("checkout");
  });

  it("cuts a line too wide for the box rather than wrapping it", () => {
    // The indent and the start of the label survive the cut: a line too narrow for the
    // whole sentence is still a line whose place in the tree can be read.
    expect(outlineLines(ROWS, 10, null, 8)[1]?.text).toBe("  - 1.0…");
  });
});

describe("what the config still declares", () => {
  it("declares nothing about the shape of a line, there being no columns to order", () => {
    expect(Object.keys(loadOutline()).sort()).toEqual(["depth", "empty", "key", "title"]);
  });
});

describe("on the real tree", () => {
  let lines: string[];

  beforeEach(() => {
    lines = screen();
    expect(lines.length).toBeGreaterThan(3);
  });

  it("draws every row as a sentence: an indent, then words", () => {
    for (const line of lines) expect(line, line).toMatch(/^ *[-+ ]? ?[^\s│├└─].* · #\d+ · /);
  });

  it("puts no box-drawing character inside the box", () => {
    for (const line of lines) expect(line, line).not.toMatch(/[│├└─]/);
  });

  it("indents a child past its parent, down the whole tree", () => {
    const at = (what: string): number =>
      indentOf(lines.find((l) => l.includes(what)) as string);
    expect(at("storefront")).toBe(0);
    expect(at("1.0.0")).toBe(INDENT);
    expect(at("account recovery")).toBe(2 * INDENT);
    expect(at("password reset")).toBe(3 * INDENT);
  });

  it("says every kind and state in full, no reader having to learn four-letter words", () => {
    const storefront = lines.find((l) => l.includes("storefront")) as string;
    expect(storefront).toMatch(/^- storefront · #\d+ · project · in_progress · /);
    for (const line of lines) expect(line, line).not.toMatch(/\bproj\b|\bstor\b|\brequ\b/);
  });
});
