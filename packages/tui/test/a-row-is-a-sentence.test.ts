/** What is left of "a row is a sentence" once the sentence went.
 *
 *  This file held the row to prose: an indent, then words, and no column anywhere. It
 *  imported `sentence` and `depthOf`, which outline.tsx does not export — the outline
 *  draws a row as columns (`outlineRow`, `OUTLINE_ROW`, `outlineLines`) — so the file
 *  failed to load and took 15 of its 20 with it.
 *
 *  Whether the drawn row *should* be a sentence is not settled here: config/design.yaml
 *  still signs `row.as: sentence` / `columns: none`, and the gap between that and the
 *  columns the code draws is the-outline-is-drawn-as-declared's red, a code defect. So
 *  nothing below takes a side. What is left is the part of `outlineLines` that is true
 *  whichever shape a row has and is proved nowhere else: which line the cursor is on, and
 *  what the height does when the rows outrun it.
 *
 *  Everything else this file used to assert is now proved elsewhere, and was dropped
 *  rather than rewritten:
 *    - the sentence, its order, its separator, its dropped empty parts and its fold
 *      marker — the-outline-row-is-one-string, read from design.yaml;
 *    - the drawn row's columns, widths, alignment, wrapping and per-line colour —
 *      the-outline-is-drawn-as-declared;
 *    - the guide and the depth it carries — outline-connectors, outline-depth. */
import { describe, expect, it } from "vitest";
import { outlineLines } from "../src/outline.js";
import type { Row } from "../src/list.js";

/** Four rows, three levels deep, so a shallow row and a deep one are on the same screen. */
const ROWS: readonly Row[] = [
  { id: 1, what: "+ storefront", state: "in_progress", detail: "project · 3 under" },
  { id: 22, what: "└─- 1.0.0", state: "planned", detail: "release · 2 under" },
  { id: 333, what: "  ├─  account recovery", state: "ready", detail: "epic" },
  { id: 4444, what: "  └─  checkout", state: "ready", detail: "epic" },
];

describe("the lines the outline draws", () => {
  it("marks the row the cursor is on and no other", () => {
    const lines = outlineLines(ROWS, 10, 1, 200);
    expect(lines.filter((l) => l.cursor)).toHaveLength(1);
    expect(lines.find((l) => l.cursor)?.text).toContain("1.0.0");
  });

  it("colours each line by the state of the row it is a line of", () => {
    expect(outlineLines(ROWS, 10, null, 200).map((l) => l.state)).toEqual([
      "in_progress",
      "planned",
      "ready",
      "ready",
    ]);
  });

  it("scrolls the cursor into what the height left, rather than drawing past the box", () => {
    const lines = outlineLines(ROWS, 2, 3, 200);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]?.text).toContain("checkout");
    expect(lines.filter((l) => l.cursor)).toHaveLength(1);
  });

  it("draws no row at all into a box with no height", () => {
    expect(outlineLines(ROWS, 0, 0, 200)).toEqual([]);
  });
});
