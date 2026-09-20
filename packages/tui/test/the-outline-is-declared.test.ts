/** design.yaml declares the outline page too, not only the cockpit and the detail page.
 *
 *  The tree was the one screen with no design: what a row of it says was whatever
 *  outline.tsx happened to say. This file holds the declaration that replaces that — that
 *  the page exists beside the other two, that it keeps its border, and that depth is the
 *  indent and nothing else. What the row itself is written as is gated next door, by
 *  the-outline-row-is-one-string.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const outline = design.outline as Record<string, any>;

describe("the outline is declared", () => {
  it("declares an outline page at all, beside the cockpit and the detail page", () => {
    expect(outline).toBeTruthy();
    expect(design.detail).toBeTruthy();
    expect(outline).not.toEqual(design.detail);
  });

  it("keeps the border the bordered pages already carry", () => {
    expect(outline.chrome).toBe("border");
    expect(design.pages.bordered).toContain("outline");
  });

  it("carries depth as the indent, on every row, two columns a level", () => {
    expect(outline.depth.as).toBe("indent");
    expect(outline.depth.every_row).toBe(true);
    expect(outline.depth.indent).toBe(2);
  });

  it("hangs nothing off a root, which is a tree of its own", () => {
    expect(outline.depth.root).toBe("flush");
  });

  it("spends no columns on a rail: depth declares no box-drawing glyph at all", () => {
    const drawn = JSON.stringify(outline);
    for (const glyph of ["├", "└", "│", "┌", "┐", "┘", "┤"]) {
      expect(drawn, glyph).not.toContain(glyph);
    }
  });
});
