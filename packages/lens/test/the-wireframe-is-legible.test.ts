/** A wireframe of a terminal screen is a picture a person is meant to read.
 *
 *  Two things stood between the tree and that. A tree of a screen counts in cells — 80
 *  across, 30 down — and a picture 80 units wide is a postage stamp. And a box drawn as an
 *  outline with a title is a picture of a filing cabinet: what a reviewer signs a design
 *  off on is the words in the boxes, and the tree has been carrying them all along.
 *
 *  So this file asserts the two claims the projection's file deliberately does not: that a
 *  cell decides how big the picture is drawn, and that the rows a box holds are drawn where
 *  that box is, in order, one per row of the grid. The second is what makes the first worth
 *  having — legible boxes with nothing in them are no more use than illegible ones.
 *
 *  The sharpest thing asserted here is where the scale is *not*: the cell changes the
 *  document's `width`/`height` and leaves the `viewBox` and every coordinate under it in
 *  the tree's own units. A renderer that multiplied the boxes instead would pass a test
 *  that only looked at the picture's size, and would have made the cell into a layout
 *  decision — so the test below draws the same tree at two cells and demands the markup
 *  inside the document be character-for-character the same.
 *
 *  What is not asserted is anything a font would decide: type size, the inset of a line
 *  from its box's left edge, the face itself. What is a contract is that a row lands inside
 *  the box that holds it, on the row below the one before it. */
import { describe, expect, it } from "vitest";
import { wireframe, CELL, type Box, type Cell } from "../src/wireframe.js";

/** A small screen, in cells: a board holding two boxes that each say something. Every
 *  number here is a count of cells, which is what a terminal's box model deals in. */
const SCREEN: Box = {
  at: { x: 0, y: 0, width: 40, height: 12 },
  title: "Board",
  children: [
    {
      at: { x: 1, y: 2, width: 18, height: 4 },
      title: "Needs you",
      rows: ["#402 scope", "#417 design"],
    },
    { at: { x: 21, y: 2, width: 18, height: 4 }, title: "Queue", rows: ["nothing waiting"] },
  ],
};

const CUBE: Cell = { width: 10, height: 20 };
const UNIT: Cell = { width: 1, height: 1 };

/** Every `<text>`, as the numbers and the words it states. */
const text = (markup: string): { x: number; y: number; row: number; says: string }[] =>
  [
    ...markup.matchAll(/<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*data-row="(\d+)"[^>]*>([^<]*)</g),
  ].map((m) => ({ x: Number(m[1]), y: Number(m[2]), row: Number(m[3]), says: m[4] }));

/** The document's own tag, and everything under it. */
const opens = (markup: string): string => markup.split("\n")[0];
const inside = (markup: string): string => markup.split("\n").slice(1).join("\n");

describe("a tree counted in cells", () => {
  it("draws the screen as big as a terminal of that cell, not as big as its cell count", () => {
    expect(opens(wireframe(SCREEN, CUBE))).toContain('width="400" height="240"');
  });

  it("keeps the picture's own units the tree's, so nothing inside it is a scaled number", () => {
    expect(opens(wireframe(SCREEN, CUBE))).toContain('viewBox="0 0 40 12"');
  });

  it("puts the scale on the document and nowhere else", () => {
    /** The same tree at a 1x1 cell and at a 10x20 one: two sizes of the same drawing. */
    expect(inside(wireframe(SCREEN, CUBE))).toBe(inside(wireframe(SCREEN, UNIT)));
    expect(opens(wireframe(SCREEN, UNIT))).toContain('width="40" height="12"');
  });

  it("takes a cell's width and height separately, because a terminal cell is not square", () => {
    expect(opens(wireframe(SCREEN, { width: 10, height: 30 }))).toContain(
      'width="400" height="360"',
    );
  });

  it("gives a caller that says nothing a cell a terminal font fits in", () => {
    expect(CELL.width).toBeGreaterThan(1);
    expect(CELL.height).toBeGreaterThan(CELL.width);
    expect(wireframe(SCREEN)).toBe(wireframe(SCREEN, CELL));
  });

  it("sets type small enough that a row clears the row under it", () => {
    const size = Number(/font-size="([\d.]+)"/.exec(wireframe(SCREEN, CUBE))?.[1]);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(1);
  });

  it("refuses a cell that is not a size rather than drawing an invisible picture", () => {
    const wrong = [
      { width: 0, height: 16 },
      { width: 8, height: -16 },
      { width: NaN, height: 1 },
    ];
    for (const cell of wrong) expect(() => wireframe(SCREEN, cell)).toThrow(/cell/);
  });
});

describe("the rows a box holds", () => {
  it("says every row of every box, in the order the tree holds them", () => {
    expect(text(wireframe(SCREEN, CUBE)).map((t) => t.says)).toEqual([
      "Board",
      "Needs you",
      "#402 scope",
      "#417 design",
      "Queue",
      "nothing waiting",
    ]);
  });

  it("puts a box's rows under its own title and not under the screen's", () => {
    const drawn = text(wireframe(SCREEN, CUBE));
    const said = (s: string): { x: number; y: number } => drawn.find((t) => t.says === s)!;
    /** `Needs you` sits at cell 1,2 — its rows are at that x, on the rows below it. */
    expect(said("#402 scope").x).toBe(said("Needs you").x);
    expect(said("#402 scope").y).toBe(said("Needs you").y + 1);
    expect(said("#417 design").y).toBe(said("#402 scope").y + 1);
    /** And `Queue`'s one row is over in `Queue`'s column, not in the left-hand box. */
    expect(said("nothing waiting").x).toBe(said("Queue").x);
    expect(said("nothing waiting").x).toBeGreaterThan(said("#402 scope").x);
  });

  it("keeps every row inside the box that holds it", () => {
    const of = (t: { x: number }): Box =>
      SCREEN.children?.find((b) => b.at.x <= t.x && t.x < b.at.x + b.at.width) ?? SCREEN;
    for (const t of text(wireframe(SCREEN, CUBE))) {
      const box = t.says === "Board" ? SCREEN : of(t);
      expect(t.x).toBeGreaterThanOrEqual(box.at.x);
      expect(t.y).toBeGreaterThan(box.at.y);
      expect(t.y).toBeLessThanOrEqual(box.at.y + box.at.height);
    }
  });

  it("gives a row the width in cells that its characters take on the screen", () => {
    /** Otherwise the picture's text stops short of where the screen's text stops, and the
     *  two cannot be read against each other — which is the whole use of the picture. */
    const drawn = wireframe(SCREEN, CUBE);
    for (const says of ["#402 scope", "nothing waiting"]) {
      expect(drawn).toContain(`textLength="${says.length}"`);
    }
  });

  it("numbers the rows of a box from its own top, so a reader can tell which line is which", () => {
    const rows = text(wireframe(SCREEN, CUBE)).filter((t) => t.says.startsWith("#"));
    expect(rows.map((t) => t.row)).toEqual([1, 2]);
  });

  it("draws a box with rows and no title from its top row", () => {
    const bare = wireframe({ at: { x: 0, y: 4, width: 8, height: 2 }, rows: ["one", "two"] }, CUBE);
    expect(text(bare).map((t) => [t.row, t.says])).toEqual([
      [0, "one"],
      [1, "two"],
    ]);
    expect(text(bare)[1].y - text(bare)[0].y).toBe(1);
  });

  it("says an empty row as an empty line rather than dropping it", () => {
    const gap = wireframe({ at: { x: 0, y: 0, width: 8, height: 3 }, rows: ["one", "", "two"] });
    expect(text(gap).map((t) => t.says)).toEqual(["one", "", "two"]);
  });

  it("does not let a row close the markup it sits in", () => {
    const drawn = wireframe({
      at: { x: 0, y: 0, width: 9, height: 9 },
      rows: [`</text><a href="x">&`],
    });
    expect(drawn).toContain("&lt;/text&gt;&lt;a href=&quot;x&quot;&gt;&amp;");
    expect(drawn.match(/<text/g)?.length).toBe(1);
  });

  it("draws a row that is wider than its box rather than truncating it", () => {
    /** A row that overruns is something check.ts reports as a finding; a picture that
     *  trimmed it would hide the fault it exists to show. */
    const over = wireframe({ at: { x: 0, y: 0, width: 3, height: 1 }, rows: ["far too long"] });
    expect(text(over)[0].says).toBe("far too long");
  });
});
