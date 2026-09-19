/** Two captures are compared, and each box that is not the same in both is named.
 *
 *  BEFORE is a cockpit-shaped capture that check.ts has nothing to say about, and AFTER is
 *  the same screen one release later with exactly four things done to it: Running is no
 *  longer drawn, Delivered has been narrowed, Queue has lost a row, and a Detail box has
 *  appeared. Every other box is untouched, so a diff that reported a fifth difference would
 *  be failing on a box that did not change.
 *
 *  What is asserted is the word and the box, never the wording of `says`: the detail is
 *  there for the person reading the report and rewording it must not be a test failure. */
import { describe, expect, it } from "vitest";
import type { CapturedNode } from "../src/check.js";
import { check } from "../src/check.js";
import { diff, diffLines, type Change, type Difference } from "../src/diff.js";

const BEFORE: CapturedNode = {
  name: "Board",
  at: { x: 0, y: 0, width: 300, height: 200 },
  children: [
    {
      name: "Needs you",
      at: { x: 0, y: 0, width: 150, height: 100 },
      key: "n",
      rows: ["task-7"],
    },
    {
      name: "Queue",
      at: { x: 150, y: 0, width: 150, height: 100 },
      key: "q",
      rows: ["task-8", "task-9"],
    },
    {
      name: "Running",
      at: { x: 0, y: 100, width: 150, height: 100 },
      key: "r",
      rows: [""],
    },
    {
      name: "Delivered",
      at: { x: 150, y: 100, width: 150, height: 100 },
      key: "d",
      rows: ["task-1"],
    },
  ],
};

const AFTER: CapturedNode = {
  name: "Board",
  at: { x: 0, y: 0, width: 300, height: 200 },
  children: [
    {
      name: "Needs you",
      at: { x: 0, y: 0, width: 150, height: 100 },
      key: "n",
      rows: ["task-7"],
    },
    { name: "Queue", at: { x: 150, y: 0, width: 150, height: 100 }, key: "q", rows: ["task-8"] },
    {
      name: "Delivered",
      at: { x: 150, y: 100, width: 100, height: 100 },
      key: "d",
      rows: ["task-1"],
    },
    { name: "Detail", at: { x: 0, y: 100, width: 150, height: 100 }, key: "e", rows: ["task-8 is running"] },
  ],
};

const of = (changes: readonly Change[], kind: Difference): string[] =>
  changes.filter((c) => c.kind === kind).map((c) => c.node);

describe("two captures are compared", () => {
  it("has nothing to say about a capture and itself", () => {
    expect(diff(BEFORE, BEFORE)).toEqual([]);
    expect(diff(AFTER, AFTER)).toEqual([]);
  });

  it("names the box the after no longer draws", () => {
    expect(of(diff(BEFORE, AFTER), "gone")).toEqual(["Board > Running"]);
  });

  it("names the box only the after draws", () => {
    expect(of(diff(BEFORE, AFTER), "arrived")).toEqual(["Board > Detail"]);
  });

  it("names the box drawn in both at a different size", () => {
    expect(of(diff(BEFORE, AFTER), "moved")).toEqual(["Board > Delivered"]);
  });

  it("names the box that holds different rows", () => {
    expect(of(diff(BEFORE, AFTER), "changed")).toEqual(["Board > Queue"]);
  });

  it("says nothing about the boxes that did not change", () => {
    const named = diff(BEFORE, AFTER).map((c) => c.node);
    expect(named).not.toContain("Board");
    expect(named).not.toContain("Board > Needs you");
    expect(named).toHaveLength(4);
  });

  it("reads the before's boxes in the order they were drawn, and the new ones last", () => {
    expect(diff(BEFORE, AFTER).map((c) => c.kind)).toEqual([
      "changed",
      "gone",
      "moved",
      "arrived",
    ]);
  });

  it("calls a rename one box gone and one arrived, because a capture says nothing else", () => {
    const renamed: CapturedNode = {
      ...BEFORE,
      children: BEFORE.children!.map((c) =>
        c.name === "Queue" ? { ...c, name: "Up next" } : c,
      ),
    };
    const changes = diff(BEFORE, renamed);
    expect(of(changes, "gone")).toEqual(["Board > Queue"]);
    expect(of(changes, "arrived")).toEqual(["Board > Up next"]);
    expect(changes).toHaveLength(2);
  });

  it("tells a box that moved and changed both things", () => {
    const both: CapturedNode = {
      ...BEFORE,
      children: BEFORE.children!.map((c) =>
        c.name === "Queue" ? { ...c, at: { ...c.at, width: 80 }, rows: ["task-8"] } : c,
      ),
    };
    const changes = diff(BEFORE, both).filter((c) => c.node === "Board > Queue");
    expect(changes.map((c) => c.kind)).toEqual(["moved", "changed"]);
  });

  it("calls a box that swapped its letter changed, though it did not move", () => {
    const rekeyed: CapturedNode = {
      ...BEFORE,
      children: BEFORE.children!.map((c) => (c.name === "Queue" ? { ...c, key: "u" } : c)),
    };
    expect(diff(BEFORE, rekeyed)).toEqual([
      { kind: "changed", node: "Board > Queue", says: expect.any(String) },
    ]);
  });

  it("distinguishes an empty line from no rows at all", () => {
    const folded: CapturedNode = {
      ...BEFORE,
      children: BEFORE.children!.map((c) => (c.name === "Running" ? { ...c, rows: [] } : c)),
    };
    expect(of(diff(BEFORE, folded), "changed")).toEqual(["Board > Running"]);
  });

  it("tells the same name at two depths apart", () => {
    const nested = (rows: readonly string[]): CapturedNode => ({
      name: "Board",
      at: { x: 0, y: 0, width: 300, height: 200 },
      children: [{ name: "Board", at: { x: 0, y: 0, width: 150, height: 100 }, rows }],
    });
    expect(of(diff(nested(["a"]), nested(["b"])), "changed")).toEqual(["Board > Board"]);
  });

  it("writes one line per difference, naming the word and the box", () => {
    const lines = diffLines(diff(BEFORE, AFTER));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("gone");
    expect(lines[1]).toContain("Board > Running");
  });

  it("compares two captures check.ts has no fault with, because a diff is the only witness", () => {
    expect(check(BEFORE)).toEqual([]);
    expect(check(AFTER)).toEqual([]);
    expect(diff(BEFORE, AFTER)).not.toEqual([]);
  });
});
