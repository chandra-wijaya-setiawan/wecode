/** The outline is drawn the way config/design.yaml says it is.
 *
 *  the-outline-row-is-one-string holds the declaration; this holds the drawing against it.
 *  Without this pair the design gates nothing: a file saying a row is a sentence and a
 *  screen drawing it as four padded columns would both be green, and the design would be a
 *  note rather than a contract.
 *
 *  Everything asserted here is read out of design.yaml rather than written down twice.
 *  Changing what a row looks like is an edit there, and a red test here until outline.tsx
 *  follows. */
import { plain } from "./force-color.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import type { Row } from "../src/list.js";
import {
  labelAt,
  OUTLINE,
  outlineId,
  outlineLines,
  outlineRow,
  sentence,
  splitHead,
} from "../src/outline.js";
import { seed } from "./seed.js";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const declared = design.outline as Record<string, any>;
const row_ = declared.row as Record<string, any>;
const depth = declared.depth as Record<string, any>;
const mark = declared.marker as Record<string, any>;

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  seed(db);
  app = new App(db, views, machines);
  app.key("v");
  app.key(OUTLINE.key);
  // The declaration is about every row of the tree, so the tree is opened all the way
  // down and widened to all work before it is read.
  app.key("f");
  app.key("a");
  for (let i = 0; i < 9; i += 1) app.key("+");
});

afterEach(cleanup);

const frame = (width = 120, height = 40): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The rows inside the box, without the border columns and without the blank ones. The
 *  indent is a row's depth, so it is kept: only the right-hand padding is trimmed. */
const inside = (width = 120, height = 40): string[] =>
  frame(width, height)
    .filter((l) => l.startsWith("│"))
    .map((l) => l.slice(1, -1).trimEnd())
    .filter((l) => l !== "");

const rowFor = (what: string): string => {
  const hit = inside().find((l) => l.includes(what));
  expect(hit, `no row for ${what}`).toBeDefined();
  return hit as string;
};

/** Where a row's label starts, which is the column the indent has moved it to. */
const labelCol = (what: string): number => rowFor(what).indexOf(what);

/** A row of the shared contract, for the drawing asked without a screen. */
const make = (over: Partial<Row> = {}): Row =>
  ({ id: 7, what: "- storefront", state: "in_progress", detail: "project", ...over }) as Row;

describe("the frame design.yaml gives the page", () => {
  it("borders it, because a whole-terminal page is what a border is affordable on", () => {
    expect(declared.chrome).toBe("border");
    expect(frame()[0]?.startsWith("┌")).toBe(true);
    expect(frame().filter((l) => l.startsWith("└"))).toHaveLength(1);
  });
});

describe("the sentence design.yaml writes a row as", () => {
  it("writes the parts in the declared order, the label leading", () => {
    expect(row_.as).toBe("sentence");
    expect(row_.order).toEqual(["marker", "label", "id", "kind", "state", "rollup"]);
    expect(row_.leads_with).toBe("label");
    const line = rowFor("password reset");
    const at = (s: string): number => line.indexOf(s);
    // The label leads; the id, the kind and the state follow it, in that order.
    expect(at("password reset")).toBeLessThan(at("#"));
    expect(at("#")).toBeLessThan(at("story"));
    expect(at("story")).toBeLessThan(at("in_progress"));
  });

  it("writes them as the declared entry writes them, joined by its separator", () => {
    expect(row_.entry).toBe("{marker} {label} · #{id} · {kind} · {state} · {rollup}");
    expect(row_.join).toBe(" · ");
    const row = make({ id: 12, what: "  - password reset", state: "in_progress", detail: "story" });
    expect(sentence(row)).toBe(["password reset", "#12", "story", "in_progress"].join(row_.join));
    expect(rowFor("password reset")).toContain(sentence(app.lines()[3] as Row).slice(0, 20));
  });

  it("pads nothing to anything: no column is held open for a wider row", () => {
    expect(row_.columns).toBe("none");
    expect(row_.pad).toBe(false);
    const wide = outlineRow(make({ id: 12345, detail: "acceptance_criteria" }), 200)[0] as string;
    const thin = outlineRow(make({ id: 4, detail: "task" }), 200)[0] as string;
    // Neither row is written into the other's width: past the mark, the only runs of
    // spaces are the single ones the separator and the words bring.
    for (const line of [wide, thin]) expect(line.slice(2), line).not.toMatch(/ {2}/);
    // And a narrow id does not push its neighbours where a wide one would put them.
    expect(thin.indexOf("in_progress")).toBeLessThan(wide.indexOf("in_progress"));
  });

  it("drops a part with nothing to say rather than writing it empty", () => {
    expect(row_.omit_empty).toBe(true);
    // No kind and no rollup: the row is its label, its id and its state, and no separator
    // stands where the missing parts were.
    expect(sentence(make({ detail: "" }))).toBe("storefront · #7 · in_progress");
    for (const line of inside()) expect(line, line).not.toMatch(/ · +·|· *$/);
  });

  it("says every row's id, kind and state in full words, never abbreviated", () => {
    expect(rowFor("storefront")).toMatch(/^- storefront · #\d+ · project · in_progress/);
    expect(outlineId(make())).toBe("#7");
    for (const line of inside()) expect(line, line).not.toMatch(/\bproj\b|\bstor\b|\brequ\b/);
  });
});

describe("the depth design.yaml indents rather than draws", () => {
  it("indents every row by its depth, at the declared columns a level", () => {
    expect(depth.as).toBe("indent");
    expect(depth.every_row).toBe(true);
    expect(depth.indent).toBe(2);
    expect(labelCol("1.0.0")).toBe(labelCol("storefront") + depth.indent);
    expect(labelCol("account recovery")).toBe(labelCol("1.0.0") + depth.indent);
    expect(labelCol("password reset")).toBe(labelCol("account recovery") + depth.indent);
  });

  it("draws no rail, tee or elbow: the indent is the whole of the depth", () => {
    for (const line of inside()) expect(line, line).not.toMatch(/[│├└─]/);
  });

  it("leaves a root flush, because a root hangs off nothing", () => {
    expect(depth.root).toBe("flush");
    expect(labelCol("storefront")).toBe(labelAt(splitHead("- storefront")));
    expect(rowFor("storefront").startsWith("- ")).toBe(true);
  });
});

describe("the mark design.yaml puts at the head of a row", () => {
  it("leads the row with it, one column wide, on every row", () => {
    expect(mark.leads_row).toBe(true);
    expect(mark.width).toBe(1);
    const glyphs = [mark.open, mark.closed, mark.leaf].join("");
    for (const line of inside()) {
      if (line.startsWith("…")) continue;
      expect(line, line).toMatch(new RegExp(`^ *[${glyphs.replace("-", "\\-")}] \\S`));
    }
  });

  it("marks an open parent and a closed one differently, and a leaf not at all", () => {
    expect(splitHead(`${mark.open} storefront`).marker).toBe(mark.open);
    expect(splitHead(`  ${mark.closed} 1.0.0`).marker).toBe(mark.closed);
    expect(splitHead(`  ${mark.leaf} 1.0.0`).marker).toBe(mark.leaf);
    // A leaf's label still starts where a marked row's does: the mark is a column, not
    // a word the label is pushed along by.
    expect(labelAt(splitHead(`  ${mark.leaf} x`))).toBe(labelAt(splitHead(`  ${mark.open} x`)));
  });
});

describe("the overflow design.yaml refuses to cut", () => {
  const long = "a release name that runs on for a good deal longer than the line it is on";

  it("wraps a sentence rather than truncating it", () => {
    expect(row_.overflow).toBe("wrap");
    expect(row_.truncate).toBe(false);
    const drawn = outlineRow(make({ what: `  - ${long}` }), 60);
    expect(drawn.length).toBeGreaterThan(1);
    // Nothing is cut: every word of it is still on the screen, and no elision is.
    const said = drawn.join(" ").replace(/\s+/g, " ");
    for (const word of long.split(" ")) expect(said, word).toContain(word);
    for (const line of drawn) expect(line, line).not.toContain(row_.elide);
  });

  it("continues under where the label began, never under the mark", () => {
    expect(row_.wrap_under).toBe("label");
    const row = make({ what: `  - ${long}` });
    const at = labelAt(splitHead(row.what));
    const [first, ...rest] = outlineRow(row, 60);
    expect(rest.length).toBeGreaterThan(0);
    for (const line of rest) {
      expect(line.slice(0, at), line).toBe(" ".repeat(at));
      expect(line.slice(at).startsWith(" "), line).toBe(false);
    }
    expect(first).toBe(`  - ${long.slice(0, 56)}`.trimEnd());
  });

  it("stops at the declared number of lines, and ends that one in the elision", () => {
    expect(row_.max_lines).toBe(3);
    expect(row_.elide).toBe("…");
    const drawn = outlineRow(make({ what: `  - ${long}` }), 30);
    expect(drawn).toHaveLength(row_.max_lines);
    expect(drawn.at(-1)?.endsWith(row_.elide), drawn.at(-1)).toBe(true);
    // Only the last line carries it, and it is the sign there was more rather than a
    // line the row could have said in full.
    expect(drawn.slice(0, -1).join("")).not.toContain(row_.elide);
    expect(outlineRow(make({ what: `  - ${long}` }), 200).join("")).not.toContain(row_.elide);
  });

  it("keeps no line past the width it was given", () => {
    for (const width of [20, 40, 60, 80, 120]) {
      for (const line of outlineRow(make({ what: `  - ${long}` }), width)) {
        expect(line.length, `${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("counts a wrapped row against the height as the lines it really costs", () => {
    const rows = [make({ what: `- ${long}` }), make({ id: 8, what: "- short" })];
    const lines = outlineLines(rows, 3, null, 40);
    expect(lines.length).toBeLessThanOrEqual(3);
    // The first row alone outruns the height, so the second is reported rather than drawn
    // past the border.
    expect(lines.at(-1)?.text).toBe("… and 1 more");
  });

  it("colours and marks every line of a wrapped row as the one row it is", () => {
    const lines = outlineLines([make({ what: `- ${long}`, state: "planned" })], 10, 0, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.state).toBe("planned");
      expect(line.cursor).toBe(true);
    }
  });
});
