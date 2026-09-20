/** The cockpit, run through the gate `@wecode/ui` already owns: expected, diff and check.
 *
 *  the-cockpit-matches-its-design.test.ts holds the frame to config/design.yaml, and it
 *  does it in substrings of joined lines — the only vocabulary a test of a terminal screen
 *  has ever had here. A substring says a word was printed somewhere. It cannot say the
 *  Queue box is still the third thing down the page, still eighty columns wide, still the
 *  one box opening on `q`, or that the row under it was not also printed under Cooking.
 *
 *  `@wecode/ui` has those words already: `check` reads a capture for the four faults true
 *  of any screen, `expected` turns a written-down design into a capture, and `against`
 *  diffs the two under `gone` / `arrived` / `moved` / `changed`. Nothing here re-proves a
 *  rule — packages/ui's own suite does that. What is proven here is that the cockpit is a
 *  screen that gate can be pointed at: that a capture of the real frame is clean, that the
 *  design below is a clean capture too, that the screen is the screen the design asks for,
 *  and — four times over — that moving, renaming, resizing or refilling a box is caught.
 *
 *  The design is of the seeded cockpit at a fixed width and a fixed clock, because a diff
 *  is exact by construction: there is no "roughly there" and no "any rows here", and a
 *  design that declined to say what a box holds could not be read as a tree at all.
 */
import { plain } from "./force-color.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { check, type CapturedNode } from "@wecode/ui";
// By path, because index.ts re-exports `check` and not yet the design half beside it. The
// package is declared in this package's devDependencies all the same: the dependency is
// real, it is the published surface that is one export short.
import { against, expected, type Design } from "@wecode/ui/dist/expected.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { seed, T } from "./seed.js";

/** The terminal the design is a design of. Wide enough that no row is elided, tall enough
 *  that no box is clipped away — a box missing because the terminal ran out of rows is a
 *  different fault from one the screen never drew. */
const WIDTH = 80;
const HEIGHT = 30;

/** Two hours after the seed, so the one row that counts elapsed time counts the same
 *  number on every run. */
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse(T) + 2 * 60 * 60 * 1000);
});
afterAll(() => {
  vi.useRealTimers();
  cleanup();
});

let app: App;

beforeEach(() => {
  const db = open(":memory:");
  seed(db);
  app = new App(db, loadViews(), loadMachines());
});

const frame = (): string[] =>
  plain(
    render(createElement(Cockpit, { app, width: WIDTH, height: HEIGHT })).lastFrame() ?? "",
  ).split("\n");

/** A head, read back off the line that drew it: the name in it, and the letter that opens
 *  the box, if it is one. Read off the frame rather than out of views.yaml on purpose — a
 *  capture that consulted the config could not report a box drawn under the wrong name. */
const HEAD = /^──\s(?:\S\s)?(.+?)\s(?:\[(\S)\]\s)?─/;

/** What the cockpit drew, as a capture.
 *
 *  A dashboard section is a rule with its body under it, so a section owns the full width
 *  from its head down to the next one, and what it holds is the lines between. The bar is
 *  the last line and is a box of its own; the blank the body stops short of the bar with
 *  is the page's slack and belongs to nobody. */
function capture(out: readonly string[]): CapturedNode {
  const heads = out.flatMap((line, at) => (HEAD.test(line) ? [at] : []));
  const children = heads.map((at, i): CapturedNode => {
    const [, name = "", key] = HEAD.exec(out[at] ?? "") ?? [];
    const until = heads[i + 1] ?? out.length;
    const under = out.slice(at + 1, until);
    const blank = under.indexOf("");
    const body = blank === -1 ? under : under.slice(0, blank);
    return {
      name,
      at: { x: 0, y: at, width: WIDTH, height: body.length + 1 },
      ...(key === undefined ? {} : { key }),
      rows: body,
    };
  });
  return {
    name: "Cockpit",
    at: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    children: [
      ...children,
      {
        name: "Key bar",
        at: { x: 0, y: HEIGHT - 1, width: WIDTH, height: 1 },
        rows: [out.at(-1) ?? ""],
      },
    ],
  };
}

/** The cockpit as it ought to be drawn: eight sections down the page in the order
 *  views.yaml puts them, the services above the board, and the bar on the last line.
 *
 *  Every number and every row here was written by a person. Nothing in this tree is read
 *  off the screen it is about — that is the whole of what makes it a design. */
const COCKPIT: Design = {
  name: "Cockpit",
  width: WIDTH,
  height: HEIGHT,
  parts: [
    {
      name: "SERVICES",
      at: { y: 0 },
      width: WIDTH,
      height: 6,
      rows: [
        "pulse   storefront  still      0 running · 1 queued · 0 stuck · moved 2h0m ago",
        "runner  workspace   none       no runner holds this workspace · 1 queued",
        "schema  workspace   current    database 14 · this build understands 14",
        "fleet   workspace   short      no engineer for 1 ready",
        "doctor  workspace   not built  0.0.2 · healing and collection",
      ],
    },
    { name: "NEEDS YOU", at: { y: 6 }, width: WIDTH, height: 2, key: "n", rows: ["nothing waits on you"] },
    { name: "RUNNING", at: { y: 8 }, width: WIDTH, height: 2, key: "r", rows: ["nothing is running"] },
    {
      name: "QUEUE",
      at: { y: 10 },
      width: WIDTH,
      height: 2,
      key: "q",
      rows: ["  #1  ready  send the reset mail · engineer"],
    },
    { name: "COOKING", at: { y: 12 }, width: WIDTH, height: 2, key: "c", rows: ["nothing is stuck"] },
    { name: "PLANNED", at: { y: 14 }, width: WIDTH, height: 2, key: "p", rows: ["nothing is planned"] },
    {
      name: "DELIVERED",
      at: { y: 16 },
      width: WIDTH,
      height: 2,
      key: "d",
      rows: ["nothing is waiting to land"],
    },
    { name: "DROPPED", at: { y: 18 }, width: WIDTH, height: 2, key: "x", rows: ["nothing has been dropped"] },
    {
      name: "Key bar",
      at: { y: HEIGHT - 1 },
      width: WIDTH,
      height: 1,
      rows: ["j/k move  g/G top/end  enter open  v box  v t outline  a act  r refresh  q quit"],
    },
  ],
};

/** The same design with one box edited, which is how every way of breaking it below is
 *  written: a fault stated as a change to the intent, never as a hand-built tree that
 *  could drift from the real one. */
const edited = (name: string, patch: Partial<Design>): Design => ({
  ...COCKPIT,
  parts: (COCKPIT.parts ?? []).map((part) => (part.name === name ? { ...part, ...patch } : part)),
});

describe("the cockpit is a capture the four rules can read", () => {
  it("draws no row twice, hangs no box off its parent and binds no letter twice", () => {
    expect(check(capture(frame()))).toEqual([]);
  });

  it("gives every box a letter of its own, which is what `v` then opens", () => {
    const keys = (capture(frame()).children ?? []).flatMap((box) => box.key ?? []);
    expect(keys).toEqual(["n", "r", "q", "c", "p", "d", "x"]);
  });
});

describe("the design is a capture like any other", () => {
  it("passes the same four rules, because a design is a claim and a claim can be wrong", () => {
    expect(check(expected(COCKPIT))).toEqual([]);
  });

  it("is placed where it says: the boxes come out at absolute coordinates, in order", () => {
    const placed = expected(COCKPIT).children ?? [];
    expect(placed.map((box) => [box.name, box.at.y])).toEqual([
      ["SERVICES", 0],
      ["NEEDS YOU", 6],
      ["RUNNING", 8],
      ["QUEUE", 10],
      ["COOKING", 12],
      ["PLANNED", 14],
      ["DELIVERED", 16],
      ["DROPPED", 18],
      ["Key bar", HEIGHT - 1],
    ]);
  });

  it("faults a box designed outside the screen it is designed on", () => {
    const over = expected(edited("QUEUE", { width: WIDTH + 40 }));
    expect(check(over)).toEqual([
      {
        rule: "clipped",
        node: "Cockpit > QUEUE",
        says: `drawn at 0,10 ${WIDTH + 40}x2, outside its parent at 0,0 ${WIDTH}x${HEIGHT}`,
      },
    ]);
  });
});

describe("the screen against the design", () => {
  it("is the screen the design asks for, box for box and row for row", () => {
    expect(against(COCKPIT, capture(frame()))).toEqual([]);
  });

  it("says `gone` about a box the design asks for and the cockpit does not draw", () => {
    const wanted: Design = {
      ...COCKPIT,
      parts: [...(COCKPIT.parts ?? []), { name: "PROJECTS", at: { y: 20 }, width: WIDTH, height: 2, key: "#" }],
    };
    expect(against(wanted, capture(frame()))).toEqual([
      { kind: "gone", node: "Cockpit > PROJECTS", says: `was at 0,20 ${WIDTH}x2` },
    ]);
  });

  it("says `arrived` about a box the cockpit draws that no design asked for", () => {
    const shorter: Design = {
      ...COCKPIT,
      parts: (COCKPIT.parts ?? []).filter((part) => part.name !== "DROPPED"),
    };
    expect(against(shorter, capture(frame()))).toEqual([
      { kind: "arrived", node: "Cockpit > DROPPED", says: `drawn at 0,18 ${WIDTH}x2` },
    ]);
  });

  it("says `moved` about a box drawn somewhere other than where it was designed", () => {
    expect(against(edited("QUEUE", { at: { y: 11 } }), capture(frame()))).toEqual([
      { kind: "moved", node: "Cockpit > QUEUE", says: `was at 0,11 ${WIDTH}x2, now 0,10 ${WIDTH}x2` },
    ]);
  });

  it("says `moved` about a box drawn narrower than it was designed", () => {
    const narrow = capture(frame());
    const boxes = (narrow.children ?? []).map((box) =>
      box.name === "QUEUE" ? { ...box, at: { ...box.at, width: 40 } } : box,
    );
    expect(against(COCKPIT, { ...narrow, children: boxes })).toEqual([
      { kind: "moved", node: "Cockpit > QUEUE", says: `was at 0,10 ${WIDTH}x2, now 0,10 40x2` },
    ]);
  });

  it("says `changed` about a box in its place holding something other than its design", () => {
    const rows = ["  #1  ready  send the reset mail · engineer", "  #2  ready  send it again"];
    expect(against(edited("QUEUE", { height: 3, rows }), capture(frame()))).toEqual([
      { kind: "moved", node: "Cockpit > QUEUE", says: `was at 0,10 ${WIDTH}x3, now 0,10 ${WIDTH}x2` },
      { kind: "changed", node: "Cockpit > QUEUE", says: "held 2 rows, now holds 1" },
    ]);
  });

  it("says `changed` about a box that opens on a letter the design did not give it", () => {
    expect(against(edited("QUEUE", { key: "u" }), capture(frame()))).toEqual([
      { kind: "changed", node: "Cockpit > QUEUE", says: "opened on u, now q" },
    ]);
  });

  it("reads a renamed box as the box that went and the box that came, and says both", () => {
    expect(against(edited("QUEUE", { name: "WAITING" }), capture(frame())).map((c) => c.kind)).toEqual([
      "gone",
      "arrived",
    ]);
  });
});
