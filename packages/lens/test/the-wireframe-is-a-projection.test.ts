/** The wireframe draws the tree it was handed, at the coordinates the tree states.
 *
 *  The claim under test is a negative one: nothing between the tree and the SVG moves a
 *  box. That cannot be proved by one happy picture, because a renderer that centred its
 *  children would still agree with a fixture whose children happen to be centred. So the
 *  fixture below is deliberately lopsided — a child hard against its parent's left edge, a
 *  sibling below it at an x nothing would have chosen, a root that does not start at 0,0 —
 *  and every assertion reads the numbers back out of the markup and compares them with the
 *  numbers that went in.
 *
 *  What is asserted about appearance is kept to the little this module actually owns: that
 *  a box is an outline, that a title is text, that a child is written after the parent it
 *  sits in. Stroke colours and font stacks are not a contract. */
import { describe, expect, it } from "vitest";
import { wireframe, WireframeError, type Box, type Cell } from "../src/wireframe.js";

/** A one-to-one cell, so the picture's own `width`/`height` are the root's numbers and the
 *  assertions below stay about the tree. The cell never reaches a coordinate — that is
 *  the-wireframe-is-legible's claim to prove, and it is the reason this file can keep
 *  ignoring it. */
const UNIT: Cell = { width: 1, height: 1 };

/** A root at an offset, two children at coordinates no layout would have produced: the
 *  first flush to the parent's top left, the second lower down and inset by an odd amount,
 *  with a grandchild inside it. */
const TREE: Box = {
  at: { x: 10, y: 4, width: 200, height: 120 },
  title: "Board",
  children: [
    { at: { x: 10, y: 4, width: 60, height: 20 }, title: "Needs you" },
    {
      at: { x: 37, y: 61, width: 90, height: 50 },
      title: "Queue",
      children: [{ at: { x: 40, y: 80, width: 20, height: 10 } }],
    },
  ],
};

const svg = (): string => wireframe(TREE, UNIT);

/** Every `<rect>`, as the four numbers it states. */
const rects = (markup: string): number[][] =>
  [...markup.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .map((m) => m.slice(1, 5).map(Number));

const boxes = (box: Box): Box[] => [box, ...(box.children ?? []).flatMap(boxes)];

describe("the wireframe", () => {
  it("draws every box in the tree, once", () => {
    expect(rects(svg()).length).toBe(boxes(TREE).length);
  });

  it("puts each box at the coordinates the tree states", () => {
    const stated = boxes(TREE).map((b) => [b.at.x, b.at.y, b.at.width, b.at.height]);
    expect(rects(svg())).toEqual(stated);
  });

  it("treats a child's coordinates as absolute, not as an offset from its parent", () => {
    /** The grandchild is at 40,80 in the tree. A renderer adding parent origins would put
     *  it at 87,145 — outside the root entirely. */
    expect(rects(svg())).toContainEqual([40, 80, 20, 10]);
  });

  it("does not slide a root that starts away from the origin into the corner", () => {
    expect(svg()).toContain('viewBox="10 4 200 120"');
    expect(rects(svg())[0]).toEqual([10, 4, 200, 120]);
  });

  it("sizes the picture to the root box", () => {
    expect(svg()).toContain('width="200" height="120"');
  });

  it("writes a parent before the children that sit in it", () => {
    const markup = svg();
    const at = (x: number): number => markup.indexOf(`<rect x="${x}"`);
    expect(at(10)).toBeLessThan(at(37));
    expect(at(37)).toBeLessThan(at(40));
  });

  it("draws a box as an outline and not a fill", () => {
    for (const rect of svg().match(/<rect [^>]*>/g) ?? []) {
      expect(rect).toContain('fill="none"');
    }
  });

  it("says each box's title where the box is", () => {
    const text = [...svg().matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)</g)];
    expect(text.map((m) => m[3])).toEqual(["Board", "Needs you", "Queue"]);
    /** Each title is inside the box it names — the only thing this module is free to
     *  decide is how far in. */
    for (const [, x, y, title] of text) {
      const box = boxes(TREE).find((b) => b.title === title);
      expect(Number(x)).toBeGreaterThanOrEqual(box?.at.x ?? 0);
      expect(Number(y)).toBeGreaterThan(box?.at.y ?? 0);
    }
  });

  it("gives a box with no title no text at all", () => {
    const bare = wireframe({ at: { x: 0, y: 0, width: 5, height: 5 } }, UNIT);
    expect(bare).not.toContain("<text");
  });

  it("is a single SVG document", () => {
    expect(svg().startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg().trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("draws the same tree the same way twice", () => {
    expect(wireframe(TREE, UNIT)).toBe(wireframe(TREE, UNIT));
  });

  it("does not let a title close the markup it sits in", () => {
    const drawn = wireframe(
      { at: { x: 0, y: 0, width: 9, height: 9 }, title: `</text><a href="x">&` },
      UNIT,
    );
    expect(drawn).toContain("&lt;/text&gt;&lt;a href=&quot;x&quot;&gt;&amp;");
    expect(drawn.match(/<text/g)?.length).toBe(1);
  });
});

describe("a tree it cannot draw honestly", () => {
  it("refuses a child that hangs outside its parent", () => {
    const over: Box = {
      at: { x: 0, y: 0, width: 10, height: 10 },
      children: [{ at: { x: 5, y: 0, width: 10, height: 10 } }],
    };
    expect(() => wireframe(over, UNIT)).toThrow(WireframeError);
  });

  it("refuses a negative size rather than clamping it", () => {
    expect(() => wireframe({ at: { x: 0, y: 0, width: -1, height: 10 } }, UNIT)).toThrow(
      WireframeError,
    );
  });

  it("refuses a coordinate that is not a number", () => {
    expect(() => wireframe({ at: { x: NaN, y: 0, width: 1, height: 1 } }, UNIT)).toThrow(
      WireframeError,
    );
  });

  it("allows a child flush with its parent's edges", () => {
    const flush: Box = {
      at: { x: 0, y: 0, width: 10, height: 10 },
      children: [{ at: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    expect(() => wireframe(flush, UNIT)).not.toThrow();
  });
});
