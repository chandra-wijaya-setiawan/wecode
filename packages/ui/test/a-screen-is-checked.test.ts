/** A screen is checked against rules that hold for every screen.
 *
 *  The defects this is answering for all passed a suite that asserts substrings of a joined
 *  frame, so the fixtures here are captures and not frames: boxes that state where they
 *  were drawn, which letter opens them and which rows they held. FAULTY holds exactly one
 *  of each fault and CLEAN is the same screen with all four repaired, so every assertion
 *  about a finding is answered by the pair — the fault is reported, and the repair of it
 *  is not.
 *
 *  What is asserted is the rule and the node, never the wording of `says`: a message is
 *  there for the person reading the report and changing it must not be a test failure. */
import { describe, expect, it } from "vitest";
import { check, type CapturedNode, type Finding, type Rule } from "../src/check.js";

/** A cockpit-shaped capture with one of each fault planted in it:
 *
 *    - `task-7` is drawn in both Needs you and Queue — one row, two boxes;
 *    - Delivered's box runs to x=320, past the root's right edge at x=300 — the id clipped
 *      off the right edge, which is how it reached master the first time;
 *    - Detail binds `d`, and Delivered already binds `d`;
 *    - Running holds nothing at all — no rows, and no empty line saying so, which is the
 *      panel that folded away.
 *
 *  Everything else about the tree is honest, so a check that reported five findings would
 *  be failing on a box that is fine. */
const FAULTY: CapturedNode = {
  name: "Board",
  at: { x: 0, y: 0, width: 300, height: 200 },
  children: [
    {
      name: "Needs you",
      at: { x: 0, y: 0, width: 150, height: 60 },
      key: "n",
      rows: ["task-7", "task-9"],
    },
    {
      name: "Queue",
      at: { x: 150, y: 0, width: 150, height: 60 },
      key: "q",
      rows: ["task-7"],
    },
    {
      name: "Running",
      at: { x: 0, y: 60, width: 300, height: 40 },
      key: "r",
    },
    {
      name: "Delivered",
      at: { x: 0, y: 100, width: 320, height: 50 },
      key: "d",
      rows: ["task-2"],
    },
    {
      name: "Detail",
      at: { x: 0, y: 150, width: 300, height: 50 },
      key: "d",
      rows: ["task-9 — waiting on review"],
    },
  ],
};

/** The same screen with all four repaired: the duplicate row gone, Delivered back inside
 *  the root, Detail on its own letter, and Running saying it has nothing with an empty
 *  line rather than by collapsing. */
const CLEAN: CapturedNode = {
  ...FAULTY,
  children: [
    { ...FAULTY.children![0]! },
    { ...FAULTY.children![1]!, rows: [""] },
    { ...FAULTY.children![2]!, rows: [""] },
    { ...FAULTY.children![3]!, at: { x: 0, y: 100, width: 300, height: 50 } },
    { ...FAULTY.children![4]!, key: "t" },
  ],
};

const of = (rule: Rule, found: readonly Finding[]): Finding[] =>
  found.filter((f) => f.rule === rule);

const one = (rule: Rule, found: readonly Finding[]): Finding => {
  const all = of(rule, found);
  expect(all).toHaveLength(1);
  return all[0]!;
};

describe("a captured screen", () => {
  it("reports one finding per fault and nothing else", () => {
    const found = check(FAULTY);
    expect(found).toHaveLength(4);
    expect(found.map((f) => f.rule).sort()).toEqual(
      ["clipped", "empty box", "key bound twice", "placed twice"].sort(),
    );
  });

  it("names the node on every finding", () => {
    for (const finding of check(FAULTY)) {
      expect(finding.node).not.toBe("");
      expect(finding.says).not.toBe("");
    }
  });

  it("names the row that was drawn in two boxes, and both boxes", () => {
    const placed = one("placed twice", check(FAULTY));
    expect(placed.node).toBe("task-7");
    expect(placed.says).toContain("Board > Needs you");
    expect(placed.says).toContain("Board > Queue");
  });

  it("names the box that left its parent", () => {
    expect(one("clipped", check(FAULTY)).node).toBe("Board > Delivered");
  });

  it("names the box whose key was already bound, not the one that got there first", () => {
    const bound = one("key bound twice", check(FAULTY));
    expect(bound.node).toBe("Board > Detail");
    expect(bound.says).toContain("d");
  });

  it("names the box that held no rows and no empty line", () => {
    expect(one("empty box", check(FAULTY)).node).toBe("Board > Running");
  });

  it("reports nothing about a clean capture", () => {
    expect(check(CLEAN)).toEqual([]);
  });
});

describe("each rule", () => {
  it("counts an empty line as something to say, and no rows as nothing", () => {
    const box = (rows: readonly string[]): CapturedNode => ({
      name: "Running",
      at: { x: 0, y: 0, width: 10, height: 10 },
      rows,
    });
    expect(of("empty box", check(box([""])))).toEqual([]);
    expect(of("empty box", check(box([])))).toHaveLength(1);
  });

  it("does not ask a box that holds boxes to hold rows of its own", () => {
    const parent: CapturedNode = {
      name: "Board",
      at: { x: 0, y: 0, width: 10, height: 10 },
      children: [{ name: "Queue", at: { x: 0, y: 0, width: 10, height: 10 }, rows: ["a"] }],
    };
    expect(check(parent)).toEqual([]);
  });

  it("treats a box flush against its parent's edge as drawn, not clipped", () => {
    const flush: CapturedNode = {
      name: "Board",
      at: { x: 10, y: 4, width: 100, height: 50 },
      children: [{ name: "Edge", at: { x: 10, y: 34, width: 100, height: 20 }, rows: ["a"] }],
    };
    expect(of("clipped", check(flush))).toEqual([]);
  });

  it("catches a grandchild that leaves the box it sits in, not just the root", () => {
    const deep: CapturedNode = {
      name: "Board",
      at: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        {
          name: "Queue",
          at: { x: 0, y: 0, width: 40, height: 40 },
          children: [{ name: "Row", at: { x: 0, y: 0, width: 60, height: 10 }, rows: ["a"] }],
        },
      ],
    };
    expect(of("clipped", check(deep))[0]!.node).toBe("Board > Queue > Row");
  });

  it("tells two boxes of the same name apart by the path to them", () => {
    const twins: CapturedNode = {
      name: "Board",
      at: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        {
          name: "Left",
          at: { x: 0, y: 0, width: 50, height: 100 },
          children: [{ name: "Rows", at: { x: 0, y: 0, width: 50, height: 50 } }],
        },
        {
          name: "Right",
          at: { x: 50, y: 0, width: 50, height: 100 },
          children: [{ name: "Rows", at: { x: 50, y: 0, width: 50, height: 50 }, rows: [""] }],
        },
      ],
    };
    expect(of("empty box", check(twins)).map((f) => f.node)).toEqual(["Board > Left > Rows"]);
  });

  it("reports a row in three boxes once, naming all three", () => {
    const thrice: CapturedNode = {
      name: "Board",
      at: { x: 0, y: 0, width: 90, height: 10 },
      children: ["A", "B", "C"].map((name, i) => ({
        name,
        at: { x: i * 30, y: 0, width: 30, height: 10 },
        rows: ["task-7"],
      })),
    };
    const placed = of("placed twice", check(thrice));
    expect(placed).toHaveLength(1);
    for (const name of ["A", "B", "C"]) expect(placed[0]!.says).toContain(`Board > ${name}`);
  });

  it("does not call two boxes with nothing to say one row in two places", () => {
    const quiet: CapturedNode = {
      name: "Board",
      at: { x: 0, y: 0, width: 20, height: 10 },
      children: [
        { name: "One", at: { x: 0, y: 0, width: 10, height: 10 }, rows: [""] },
        { name: "Two", at: { x: 10, y: 0, width: 10, height: 10 }, rows: [""] },
      ],
    };
    expect(check(quiet)).toEqual([]);
  });

  it("says nothing about a key that only one box binds", () => {
    const keyed: CapturedNode = {
      name: "Board",
      at: { x: 0, y: 0, width: 20, height: 10 },
      children: [
        { name: "One", at: { x: 0, y: 0, width: 10, height: 10 }, key: "a", rows: ["x"] },
        { name: "Two", at: { x: 10, y: 0, width: 10, height: 10 }, key: "b", rows: ["y"] },
      ],
    };
    expect(check(keyed)).toEqual([]);
  });
});
