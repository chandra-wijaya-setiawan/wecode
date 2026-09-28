/** The swimlanes beside one row of the tree.
 *
 *  Everything here is one function's output read as a drawing rather than as a string: the
 *  markup is parsed and the lanes, the node and the turn are asked where they are, because
 *  an assertion on a substring proves the file was written the way the test was written and
 *  nothing about where a line ends up.
 *
 *  Four things are proved. The geometry is the sketch's — `the-tree-you-can-read`, which
 *  took it from VS Code's own graph: lanes 11 apart, a row 22 tall, the node halfway down at
 *  radius 4, a corner of 5, a stroke of 1.6. The five questions the caller answers each move
 *  the drawing: depth moves the lane, a dead ancestor lane is not drawn, the last row on a
 *  lane ends it at the node, the first row on one begins it there, and a row with children
 *  turns down into the next lane. The rails of two rows meet — a parent's turn ends exactly
 *  where its child's lane begins, which is the whole reason one row at a time is enough. And
 *  no colour is decided here: the node wears what the caller handed over, escaped, and every
 *  line takes the page's. */
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { rail, type Rail } from "../src/pages/rail.js";

/** A document to parse into. The window is made here rather than asked for as the test
 *  environment, because this module's own imports run under node — a page of the surface
 *  reads files at startup, and a browser's globals are not what it wants. */
const doc = new Window().document;
type El = ReturnType<typeof doc.createElement>;

/** A row of nothing in particular: depth 0, no lane above it, a row above feeding its own
 *  lane and more rows to come on it, nothing under it. Every test below is this with one
 *  answer changed, so what moved the drawing is the thing the test names. */
const PLAIN: Rail = { depth: 0, live: [], last: false, first: false, children: false, fill: "teal" };

const markupOf = (row: Partial<Rail> = {}): string => rail({ ...PLAIN, ...row });

/** The drawing, parsed. */
function drawn(row: Partial<Rail> = {}): El {
  const host = doc.createElement("div");
  host.innerHTML = markupOf(row);
  const svg = host.firstElementChild;
  expect(svg?.tagName.toLowerCase(), "the rail is one svg").toBe("svg");
  expect(host.children).toHaveLength(1);
  return svg as El;
}

const lanes = (svg: El): El[] => [...svg.querySelectorAll("path")] as El[];
const pathOf = (svg: El, lane: number): El | undefined =>
  lanes(svg).find((p) => p.getAttribute("data-lane") === String(lane));
const dOf = (svg: El, lane: number): string | undefined =>
  pathOf(svg, lane)?.getAttribute("d") ?? undefined;
const nodeOf = (svg: El): El => {
  const found = svg.querySelectorAll("circle");
  expect(found, "one node per row").toHaveLength(1);
  return found[0] as El;
};
const at = (el: El, name: string): string => el.getAttribute(name) ?? "";

/** The depths a tree of this record reaches — story, requirement, criterion, test, and one
 *  deeper than anything drawn today, because the arithmetic is not a table of five. */
const DEPTHS = [0, 1, 2, 3, 4, 9];

describe("the rail beside one row", () => {
  it("is one svg a row tall, as wide as its own lane and the one under it", () => {
    const svg = drawn();
    expect(at(svg, "height")).toBe("22");
    expect(at(svg, "width")).toBe("22");
    expect(at(svg, "viewBox")).toBe("0 0 22 22");
  });

  it("gains a lane's width per level, so every row's lanes sit at the same x", () => {
    for (const depth of DEPTHS) {
      const svg = drawn({ depth });
      expect(at(svg, "width"), `depth ${depth}`).toBe(String(11 * (depth + 2)));
      expect(at(svg, "viewBox"), `depth ${depth}`).toBe(`0 0 ${11 * (depth + 2)} 22`);
      expect(at(svg, "height"), `depth ${depth}`).toBe("22");
    }
  });

  it("puts the node on its own lane, halfway down the row", () => {
    for (const depth of DEPTHS) {
      const node = nodeOf(drawn({ depth }));
      expect(at(node, "cx"), `depth ${depth}`).toBe(String(11 * (depth + 1)));
      expect(at(node, "cy"), `depth ${depth}`).toBe("11");
      expect(at(node, "r"), `depth ${depth}`).toBe("4");
    }
  });

  it("draws the lanes above it that are still live, straight through the row", () => {
    const svg = drawn({ depth: 3, live: [0, 2] });
    expect(dOf(svg, 0)).toBe("M 11 0 V 22");
    expect(dOf(svg, 2)).toBe("M 33 0 V 22");
  });

  it("draws nothing in an ancestor lane whose last row is already behind us", () => {
    const svg = drawn({ depth: 3, live: [0, 2] });
    expect(dOf(svg, 1), "lane 1 is done with").toBeUndefined();
    expect(lanes(svg).map((p) => at(p, "data-lane"))).toEqual(["0", "2", "3"]);
  });

  it("draws the lanes in lane order, whatever order it was handed them in", () => {
    const svg = drawn({ depth: 4, live: [3, 0, 2] });
    expect(lanes(svg).map((p) => at(p, "data-lane"))).toEqual(["0", "2", "3", "4"]);
    expect(lanes(svg).map((p) => at(p, "d"))[0]).toBe("M 11 0 V 22");
  });

  it("draws a lane above it once, and never one at or past its own", () => {
    const svg = drawn({ depth: 1, live: [0, 0, 1, 5] });
    expect(lanes(svg).map((p) => at(p, "data-lane"))).toEqual(["0", "1"]);
    expect(dOf(svg, 0)).toBe("M 11 0 V 22");
  });

  it("runs its own lane through the row when more of it is coming", () => {
    for (const depth of [0, 2]) {
      expect(dOf(drawn({ depth, last: false }), depth)).toBe(`M ${11 * (depth + 1)} 0 V 22`);
    }
  });

  it("ends its own lane at the node when it is the last row on it", () => {
    for (const depth of [0, 2]) {
      expect(dOf(drawn({ depth, last: true }), depth)).toBe(`M ${11 * (depth + 1)} 0 V 11`);
    }
  });

  /** The other end of the same question, and the one the caller alone can answer: a lane is
   *  drawn from the top edge because something above it put it there — the turn its parent
   *  made, or the lane the row above passed through. The first row of the outermost lane has
   *  neither, and a line to the top edge there reads as a lane whose parent scrolled off. */
  it("begins its own lane at the node when nothing above it feeds that lane", () => {
    for (const depth of [0, 2]) {
      expect(dOf(drawn({ depth, first: true }), depth), `depth ${depth}`)
        .toBe(`M ${11 * (depth + 1)} 11 V 22`);
    }
  });

  it("draws a lane that both begins and ends on its row as the node alone", () => {
    expect(dOf(drawn({ first: true, last: true }), 0)).toBe("M 11 11 V 11");
    expect(at(nodeOf(drawn({ first: true, last: true })), "cy"), "which is where the node is")
      .toBe("11");
  });

  it("begins nothing else at the node: the lanes above and the turn are where they were", () => {
    const row = { depth: 2, live: [0, 1], children: true };
    const [fed, unfed] = [drawn(row), drawn({ ...row, first: true })];
    for (const lane of [0, 1, 3]) expect(dOf(unfed, lane), `lane ${lane}`).toBe(dOf(fed, lane));
    expect([dOf(fed, 2), dOf(unfed, 2)]).toEqual(["M 33 0 V 22", "M 33 11 V 22"]);
  });

  it("turns out of the node and down into the lane its children are drawn on", () => {
    expect(dOf(drawn({ depth: 1, children: true }), 2))
      .toBe("M 22 11 H 28 A 5 5 0 0 1 33 16 V 22");
    expect(dOf(drawn({ depth: 0, children: true }), 1))
      .toBe("M 11 11 H 17 A 5 5 0 0 1 22 16 V 22");
  });

  it("draws no turn under a row with nothing under it", () => {
    const svg = drawn({ depth: 1, live: [0], children: false });
    expect(dOf(svg, 2)).toBeUndefined();
    expect(lanes(svg).map((p) => at(p, "d")).join(" ")).not.toContain("A");
  });

  it("ends a parent's turn exactly where its child's own lane begins", () => {
    const parent = drawn({ depth: 1, children: true, last: true });
    const child = drawn({ depth: 2, last: true });
    const turn = dOf(parent, 2) as string;
    const ended = /V (\d+)$/.exec(turn)?.[1];
    const landed = / (\d+) 16 V/.exec(turn)?.[1];
    const began = /^M (\d+) (\d+)/.exec(dOf(child, 2) as string);
    expect(ended, "the turn runs to the bottom edge of the parent's row").toBe("22");
    expect(began?.[2], "and the child's lane from the top edge of its own").toBe("0");
    expect(began?.[1], "both in the lane the turn came down in").toBe(landed);
    expect(at(nodeOf(child), "cx"), "which the child's node sits on").toBe(landed);
    expect(at(parent, "width"), "and which is the edge of the parent's own svg").toBe(landed);
  });

  it("strokes every line at 1.6, rounded, and fills none of them", () => {
    for (const path of lanes(drawn({ depth: 2, live: [0, 1], children: true }))) {
      expect(at(path, "stroke-width")).toBe("1.6");
      expect(at(path, "stroke-linecap")).toBe("round");
      expect(at(path, "fill")).toBe("none");
    }
  });

  it("names the lane each line is in, so a sheet can give one hue per rung", () => {
    const svg = drawn({ depth: 2, live: [0, 1], children: true });
    expect(lanes(svg).map((p) => at(p, "data-lane"))).toEqual(["0", "1", "2", "3"]);
  });

  it("wears the fill the caller handed over, on the node and nowhere else", () => {
    const node = nodeOf(drawn({ depth: 1, live: [0], children: true, fill: "var(--st-done)" }));
    expect(at(node, "fill")).toBe("var(--st-done)");
    const markup = markupOf({ depth: 1, live: [0], children: true, fill: "var(--st-done)" });
    expect(markup.match(/var\(--st-done\)/g), "one colour, said once").toHaveLength(1);
  });

  it("decides no colour of its own: the lines take the page's", () => {
    const row = { depth: 2, live: [0, 1], children: true, fill: "var(--st-done)" };
    for (const path of lanes(drawn(row))) expect(at(path, "stroke")).toBe("currentColor");
    const rest = markupOf(row).split("var(--st-done)").join("");
    expect(rest, "no colour written here").not.toMatch(/#[0-9a-f]{3}|rgba?\(|hsla?\(|var\(--/i);
  });

  it("escapes what it is handed, so a fill cannot become markup", () => {
    const fill = `" onload="alert(1)`;
    const svg = drawn({ fill });
    expect(at(nodeOf(svg), "fill")).toBe(fill);
    expect(svg.hasAttribute("onload"), "nothing broke out of the attribute").toBe(false);
    expect(markupOf({ fill })).toContain("&quot;");
  });

  it("draws the node over the lines it sits on", () => {
    const svg = drawn({ depth: 1, live: [0], children: true });
    expect(svg.lastElementChild?.tagName.toLowerCase()).toBe("circle");
    expect(svg.children).toHaveLength(4);
  });

  it("is decoration: the depth it draws is the list's, and a reader is not read it", () => {
    expect(at(drawn(), "aria-hidden")).toBe("true");
  });
});
