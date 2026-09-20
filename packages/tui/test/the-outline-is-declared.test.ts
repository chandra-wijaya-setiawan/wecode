/** design.yaml declares the outline page too, not only the cockpit and the detail page.
 *
 *  The tree was the one screen with no design: what a row of it says was whatever
 *  outline.tsx happened to say, which is the description first with the id, the entity and
 *  the state behind however long it ran, and the description cut at the right edge. This
 *  file holds the declaration that replaces that — the row's order, the connector that
 *  carries depth into every row, and the description keeping the rest of the line. Losing
 *  any of the three is a red test and not a smaller design.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Record<string, any>;

const outline = design.outline as Record<string, any>;

/** What the row is written in, in order — the three scanned columns and then the prose. */
const ORDER = ["id", "entity", "state", "description"];

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

  it("writes a row id, entity, state, then description, in that order", () => {
    expect(outline.row.order).toEqual(ORDER);
    expect(outline.row.leads_with).toBe("id");
  });

  it("writes the entry in the order it declared, and names every part once", () => {
    const entry = outline.row.entry as string;
    for (const part of ORDER) expect(entry).toContain(`{${part}}`);
    const at = ORDER.map((part) => entry.indexOf(`{${part}}`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(entry.match(/\{[a-z_]+\}/g)).toEqual(ORDER.map((part) => `{${part}}`));
  });

  it("gives the description the rest of the line and the other three their own width", () => {
    const columns = outline.row.columns as Record<string, any>;
    expect(Object.keys(columns).sort()).toEqual([...ORDER].sort());
    expect(columns.description.width).toBe("rest");
    for (const part of ORDER.filter((p) => p !== "description")) {
      expect(columns[part].width, part).toBe("longest");
    }
  });

  it("wraps the description rather than cutting it at the right edge", () => {
    expect(outline.row.overflow).toBe("wrap");
    expect(outline.row.wrap_under).toBe("description");
    expect(outline.row.truncate).toBe(false);
  });

  it("carries depth as a connector in every row, not as bare indentation", () => {
    expect(outline.depth.as).toBe("connector");
    expect(outline.depth.every_row).toBe(true);
    expect(outline.depth.indent).toBe(2);
  });

  it("draws the connector in the description, where the prose is", () => {
    expect(outline.depth.in).toBe("description");
    expect(outline.row.order.indexOf(outline.depth.in)).toBe(ORDER.length - 1);
  });

  it("joins a child to its parent by a tee, and the last of them by an elbow", () => {
    const depth = outline.depth as Record<string, string>;
    expect(depth.tee).not.toBe(depth.elbow);
    for (const glyph of [depth.tee, depth.elbow, depth.rail]) {
      expect(glyph).toMatch(/[├└│]/);
    }
    expect(depth.clear.trim()).toBe("");
  });

  it("spends the same columns on every level, connector or blank", () => {
    const depth = outline.depth as Record<string, string>;
    for (const glyph of [depth.tee, depth.elbow, depth.rail, depth.clear]) {
      expect([...glyph]).toHaveLength(outline.depth.indent);
    }
  });

  it("hangs nothing off a root, which is a tree of its own", () => {
    expect(outline.depth.root).toBe("flush");
  });
});
