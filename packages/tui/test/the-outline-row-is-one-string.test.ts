/** The outline row, as design.yaml declares it: one string, three lines at most, and a
 *  mark only on the rows that have something to fold.
 *
 *  The row was four columns — a tree cell, an id, a kind and a state — and each was as
 *  wide as the widest row anywhere in the tree, so a shallow row paid the deepest row's
 *  width and the line it bought was mostly blank. The kind and the state only fit at four
 *  characters, which is the same cost again, paid by the reader. The declaration below
 *  retires all of it: no columns, no padding, the label leading because the label is what
 *  the row is, and the particulars after it in full words.
 *
 *  Three things have to survive together for that to be a design rather than a preference,
 *  and each is a section here. One string: the parts are written into a single entry, in
 *  the order `order` names, joined by the separator the rest of the screen's prose uses,
 *  with no width or alignment declared for any of them. Three lines: the line is not cut
 *  at the right edge — a sentence that is cut is not a sentence — it wraps under the
 *  label, and it stops at three, because a row allowed to run on can push the rest of the
 *  tree off the page. Parents marked: the mark says which of open and closed a row is, and
 *  a row with no children has nothing to fold and so carries no mark.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../config/design.yaml", import.meta.url)),
  "utf8",
);
const design = parse(SOURCE) as Record<string, any>;

const outline = design.outline as Record<string, any>;
const row = outline.row as Record<string, any>;
const marker = outline.marker as Record<string, any>;

/** The parts of the row, in the order the one string writes them. */
const ORDER = ["marker", "label", "id", "kind", "state", "rollup"];

/** A part's placeholder in the entry, as the entry writes it. */
const slot = (part: string) => `{${part}}`;

describe("the outline row is one string", () => {
  it("is declared as a sentence, and not as a set of columns", () => {
    expect(row.as).toBe("sentence");
    expect(row.columns).toBe("none");
    expect(row.pad).toBe(false);
  });

  it("writes every part it names into one entry, and names no part twice", () => {
    expect(row.order).toEqual(ORDER);
    const entry = row.entry as string;
    expect(entry.match(/\{[a-z_]+\}/g)).toEqual(ORDER.map(slot));
  });

  it("writes the parts in the order it declared them", () => {
    const entry = row.entry as string;
    const at = ORDER.map((part) => entry.indexOf(slot(part)));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("leads with the label, because the label is what the row is", () => {
    expect(row.leads_with).toBe("label");
    const entry = row.entry as string;
    // Only the mark, which is a mark and not a word, comes before it.
    expect(entry.indexOf(slot("label"))).toBeLessThan(entry.indexOf(slot("id")));
    expect(ORDER.slice(0, ORDER.indexOf("label"))).toEqual(["marker"]);
  });

  it("joins the particulars by the separator the rest of the screen's prose uses", () => {
    expect(row.join).toBe(" · ");
    const entry = row.entry as string;
    for (const part of ["kind", "state", "rollup"]) {
      expect(entry, part).toContain(`${row.join}${slot(part)}`);
    }
  });

  it("gives no part of the row a width or an alignment to be padded to", () => {
    for (const part of ORDER) {
      expect(row[part], part).toBeUndefined();
    }
    expect(SOURCE.slice(SOURCE.indexOf("\noutline:"))).not.toContain("width: longest");
  });

  it("drops a part with nothing to say rather than writing it empty", () => {
    expect(row.omit_empty).toBe(true);
  });
});

describe("the outline row is three lines at most", () => {
  it("wraps rather than cutting the line at the right edge", () => {
    expect(row.overflow).toBe("wrap");
    expect(row.truncate).toBe(false);
  });

  it("continues under the label, never under the mark", () => {
    expect(row.wrap_under).toBe("label");
    expect(row.wrap_under).not.toBe("marker");
  });

  it("stops at three lines", () => {
    expect(row.max_lines).toBe(3);
  });

  it("ends a row it had to stop in the elision, so the reader knows there was more", () => {
    expect(row.elide).toBe("…");
    expect([...(row.elide as string)]).toHaveLength(1);
  });
});

describe("the outline marks its parents", () => {
  it("marks the rows with children, and only those", () => {
    expect(marker.on).toBe("parents");
  });

  it("says which of open and closed a parent is, in two different glyphs", () => {
    expect(marker.open).toBe("-");
    expect(marker.closed).toBe("+");
    expect(marker.open).not.toBe(marker.closed);
  });

  it("marks a childless row with nothing, because it has nothing to fold", () => {
    expect(marker.leaf.trim()).toBe("");
  });

  it("spends one column on the mark, whichever of the three it is", () => {
    expect(marker.width).toBe(1);
    for (const glyph of [marker.open, marker.closed, marker.leaf]) {
      expect([...(glyph as string)]).toHaveLength(marker.width);
    }
  });

  it("puts the mark at the head of the row, where the fold key it names is pressed", () => {
    expect(marker.leads_row).toBe(true);
    expect(marker.says).toBe("fold_key");
    expect(row.order[0]).toBe("marker");
    expect((row.entry as string).indexOf(slot("marker"))).toBe(0);
  });
});
