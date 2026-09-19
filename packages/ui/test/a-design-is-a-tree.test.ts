/** A design is written down, becomes a tree, and the diff reads it against a screen.
 *
 *  BOARD is a design of a cockpit: four boxes inside a board, each placed relative to the
 *  board rather than to the screen. DRAWN is a capture of a screen that was built from it
 *  and got four things wrong — Running was never drawn, Delivered is half as wide as it
 *  was designed, Queue holds a row the design did not ask for, and a Detail box nobody
 *  designed is on the screen. Every other box matches, so a fifth difference would be the
 *  module reporting on a box that is exactly what it should be.
 *
 *  What is asserted is the word and the box, never the wording of `says`, for the reason
 *  two-captures-are-compared.test.ts gives: the detail is for the person reading. */
import { describe, expect, it } from "vitest";
import type { CapturedNode } from "../src/check.js";
import { check } from "../src/check.js";
import type { Change, Difference } from "../src/diff.js";
import { against, expected, type Design } from "../src/expected.js";

const BOARD: Design = {
  name: "Board",
  at: { x: 10, y: 5 },
  width: 300,
  height: 200,
  parts: [
    { name: "Needs you", width: 150, height: 100, key: "n", rows: ["task-7"] },
    { name: "Queue", at: { x: 150 }, width: 150, height: 100, key: "q", rows: ["task-8"] },
    { name: "Running", at: { y: 100 }, width: 150, height: 100, key: "r" },
    {
      name: "Delivered",
      at: { x: 150, y: 100 },
      width: 150,
      height: 100,
      key: "d",
      rows: ["task-1"],
    },
  ],
};

const DRAWN: CapturedNode = {
  name: "Board",
  at: { x: 10, y: 5, width: 300, height: 200 },
  children: [
    { name: "Needs you", at: { x: 10, y: 5, width: 150, height: 100 }, key: "n", rows: ["task-7"] },
    {
      name: "Queue",
      at: { x: 160, y: 5, width: 150, height: 100 },
      key: "q",
      rows: ["task-8", "task-9"],
    },
    {
      name: "Delivered",
      at: { x: 160, y: 105, width: 75, height: 100 },
      key: "d",
      rows: ["task-1"],
    },
    { name: "Detail", at: { x: 10, y: 105, width: 150, height: 100 }, key: "x", rows: ["task-3"] },
  ],
};

const only = (changes: readonly Change[], kind: Difference): string[] =>
  changes.filter((c) => c.kind === kind).map((c) => c.node);

describe("a design is a tree", () => {
  it("places each box inside its parent rather than on the screen", () => {
    const tree = expected(BOARD);

    expect(tree.at).toEqual({ x: 10, y: 5, width: 300, height: 200 });
    expect(tree.children?.map((child) => child.at)).toEqual([
      { x: 10, y: 5, width: 150, height: 100 },
      { x: 160, y: 5, width: 150, height: 100 },
      { x: 10, y: 105, width: 150, height: 100 },
      { x: 160, y: 105, width: 150, height: 100 },
    ]);
  });

  it("moves every box under a box that moves, and nothing else", () => {
    const moved = expected({ ...BOARD, at: { x: 20, y: 5 } });
    const still = expected(BOARD);

    expect(moved.children?.map((c) => c.at.x)).toEqual([20, 170, 20, 170]);
    expect(moved.children?.map((c) => c.at.y)).toEqual(still.children?.map((c) => c.at.y));
    expect(moved.children?.map((c) => c.at.width)).toEqual([150, 150, 150, 150]);
  });

  it("keeps the names, the keys and the rows the design wrote", () => {
    const tree = expected(BOARD);

    expect(tree.children?.map((child) => child.name)).toEqual([
      "Needs you",
      "Queue",
      "Running",
      "Delivered",
    ]);
    expect(tree.children?.map((child) => child.key)).toEqual(["n", "q", "r", "d"]);
    expect(tree.children?.[1]?.rows).toEqual(["task-8"]);
  });

  it("says a box designed to hold nothing holds an empty line", () => {
    const tree = expected(BOARD);

    expect(tree.children?.[2]?.rows).toEqual([""]);
  });

  it("holds no rows of its own for a box that speaks through its parts", () => {
    const tree = expected(BOARD);

    expect(tree.rows).toBeUndefined();
  });

  it("is a capture check reads, and a sound design is clean", () => {
    expect(check(expected(BOARD))).toEqual([]);
  });

  it("is a capture check faults when the design hangs a box off its parent", () => {
    const over: Design = {
      ...BOARD,
      parts: [{ name: "Wide", at: { x: 200 }, width: 150, height: 100, rows: ["task-7"] }],
    };

    expect(check(expected(over)).map((f) => [f.rule, f.node])).toEqual([
      ["clipped", "Board > Wide"],
    ]);
  });

  it("reports a screen that is its design as no differences at all", () => {
    expect(against(BOARD, expected(BOARD))).toEqual([]);
  });

  it("calls a designed box the screen does not draw gone", () => {
    expect(only(against(BOARD, DRAWN), "gone")).toEqual(["Board > Running"]);
  });

  it("calls a box the design never asked for arrived", () => {
    expect(only(against(BOARD, DRAWN), "arrived")).toEqual(["Board > Detail"]);
  });

  it("calls a box drawn somewhere other than where it was designed moved", () => {
    expect(only(against(BOARD, DRAWN), "moved")).toEqual(["Board > Delivered"]);
  });

  it("calls a box holding something other than what it was designed to hold changed", () => {
    expect(only(against(BOARD, DRAWN), "changed")).toEqual(["Board > Queue"]);
  });

  it("reports nothing about the boxes the screen got right", () => {
    expect(against(BOARD, DRAWN)).toHaveLength(4);
  });

  it("reads the design as the before, so the words point at the screen", () => {
    const backwards = against({ ...BOARD, parts: [] }, DRAWN);

    expect(only(backwards, "arrived")).toHaveLength(4);
    expect(only(backwards, "gone")).toEqual([]);
  });
});
