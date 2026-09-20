/** design.yaml declares the detail page, not only the cockpit.
 *
 *  The board had a design to be gated against; a record's own screen had none, so the only
 *  way to ask what a detail page is supposed to show was to read the code that shows it.
 *  This file holds the declaration to two things: that every screen the cockpit can reach
 *  is named in design.yaml, and that the block the declaration describes is the block
 *  screens.tsx actually builds — the layout rules are checked against `fieldLines` and
 *  `fit` themselves, so a design that drifts from the drawing is red here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { COLUMNS, fieldLines, fit } from "../src/screens.js";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const detail = design.detail as Record<string, any>;

describe("every screen is declared", () => {
  it("declares the detail page beside the cockpit rather than only the board", () => {
    expect(detail).toBeTruthy();
    expect(design.proposal).toBeTruthy();
    expect(detail.screens).toEqual(["node", "assignment"]);
  });

  it("leaves no screen the cockpit draws undeclared", () => {
    const drawn = new Set<string>([
      design.page.lead,
      ...(design.pages.bordered as string[]),
      "dashboard",
    ]);
    for (const screen of detail.screens as string[]) {
      expect(drawn.has(screen), `${screen} is not a page the frame knows`).toBe(true);
    }
    // Every bordered page is either a list of rows or a record's own screen; a record's
    // screen with no fields declared would be a page this file claims to cover and does not.
    for (const page of ["node", "assignment"]) {
      expect(detail.fields[page].length, `${page} has no fields`).toBeGreaterThan(0);
    }
  });

  it("keeps a detail page inside the same border the other pages get", () => {
    expect(detail.chrome).toBe("border");
    expect(detail.chrome).toBe(design.pages.chrome);
    for (const screen of detail.screens as string[]) {
      expect(design.pages.bordered).toContain(screen);
    }
  });

  it("names a page after its work and its state, never after its key alone", () => {
    expect(detail.title.node).toBe("{what} · {state}");
    expect(detail.title.node).not.toContain("{id}");
    expect(detail.title.assignment).toContain("{id}");
    for (const title of Object.values(detail.title as Record<string, string>)) {
      expect(title).toContain("{state}");
    }
  });

  it("says what each record is worth saying, without one half restating the other", () => {
    expect(detail.fields.node).toEqual(["entity", "id", "title", "state", "children"]);
    expect(detail.fields.assignment).toEqual([
      "entity",
      "id",
      "objective",
      "state",
      "budget",
      "beat",
      "worktree",
      "detail",
    ]);
    for (const names of Object.values(detail.fields as Record<string, string[]>)) {
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("lays the block out as the drawing lays it out: a gutter as wide as the longest name", () => {
    expect(detail.block.entry).toBe("{name}  {value}");
    expect(detail.block.gutter).toBe("longest_name");
    expect(detail.block.align).toBe("left");
    const fields: [string, string][] = [
      ["id", "#3"],
      ["objective", "ship it"],
    ];
    const [short, long] = fieldLines(fields, 80);
    const gutter = "objective".length + 2;
    expect(short).toBe(`${"id".padEnd(gutter - 2)}  #3`);
    expect(long.indexOf("ship it")).toBe(gutter);
    expect(short.indexOf("#3")).toBe(gutter);
  });

  it("wraps the assignment's values under the value and clips the node's", () => {
    expect(detail.block.overflow.assignment).toBe("wrap");
    expect(detail.block.overflow.node).toBe("clip");
    expect(detail.block.wrap_under).toBe("value");
    const fields: [string, string][] = [["beat", "alive and saying so at some length here"]];
    const wrapped = fieldLines(fields, 20, true);
    expect(wrapped.length).toBeGreaterThan(1);
    const gutter = "beat".length + 2;
    for (const line of wrapped.slice(1)) {
      expect(line.slice(0, gutter)).toBe(" ".repeat(gutter));
      expect(line.trimStart()).not.toBe("");
    }
    const clipped = fieldLines(fields, 20);
    expect(clipped).toHaveLength(1);
    expect(clipped[0].length).toBeLessThanOrEqual(20);
  });

  it("gives the node its children list and the assignment none", () => {
    expect(detail.children.of).toBe("node");
    expect(detail.children.title).toContain("{count}");
    expect(detail.children.title).toContain("{tally}");
    expect(detail.children.columns).toEqual([...COLUMNS]);
    expect(detail.children.empty).toBeTruthy();
    expect(detail.fields.assignment).not.toContain("children");
  });

  it("drops and counts what will not fit rather than drawing past the border", () => {
    expect(detail.overrun).toContain("{count}");
    const kept = fit(["a", "b", "c", "d"], 2, 40);
    expect(kept).toHaveLength(2);
    expect(kept[1]).toBe(detail.overrun.replace("{count}", "3"));
  });
});
