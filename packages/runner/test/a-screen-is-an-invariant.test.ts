import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  capturedScreens,
  faults,
  screenInvariant,
  SCREENS_CHECK,
  SCREENS_DIR,
  type Finding,
  type Screen,
} from "../src/screens-check.js";
import type { Snapshot } from "@wecode/core";
// By path and not by `@wecode/ui`, which is the fact this slice is honest about: the runner
// does not depend on the ui package, so the rules can be run beside the reporting here but
// cannot yet be handed to it in production. A built `packages/ui` is a precondition of this
// file, as it already is of that package's own suite.
import { check, type CapturedNode } from "../../ui/dist/check.js";

/** A screen that draws wrongly is drift, and the doctor is where drift is said out loud.
 *
 *  `packages/ui/src/check.ts` already knows what wrong looks like — a row in two boxes, a
 *  box outside its parent, a key bound twice, a box collapsed to a frame — and already has
 *  its own suite proving each rule. Nothing here re-proves a rule. What is proven here is
 *  the half that was missing: that the findings become violations of one named invariant,
 *  that they name the screen and the file a person has to open, and that a repository which
 *  captures nothing is quiet rather than broken.
 *
 *  So the checker is a stub in most of these cases. A stub is the point: it is what says the
 *  doctor repeats whatever rule it is handed rather than keeping a list of its own. The last
 *  block hands in the real `check` instead, so the two halves are shown to fit. */

const tmp: string[] = [];

/** A tree on disk with captures in it: `{ board: <capture> }`, written as JSON, plus any
 *  files that are to be there verbatim — which is how an unparseable one is planted. */
function treeOf(captures: Readonly<Record<string, unknown>>, raw: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "screens-"));
  tmp.push(root);
  mkdirSync(join(root, SCREENS_DIR), { recursive: true });
  for (const [name, capture] of Object.entries(captures)) {
    writeFileSync(join(root, SCREENS_DIR, `${name}.json`), JSON.stringify(capture));
  }
  for (const [file, text] of Object.entries(raw)) writeFileSync(join(root, SCREENS_DIR, file), text);
  return root;
}

afterAll(() => {
  for (const root of tmp) rmSync(root, { recursive: true, force: true });
});

/** The check takes no notice of the record; it is handed one anyway, because that is the
 *  shape every invariant has. */
const EMPTY: Snapshot = { nodes: [], workers: [], schema_version: 0 };

const screen = (name: string, capture: unknown): Screen<unknown> => ({
  name,
  path: `${SCREENS_DIR}/${name}.json`.split("\\").join("/"),
  capture,
});

const CLIPPED: Finding = {
  rule: "clipped",
  node: "Board > Delivered",
  says: "drawn at 0,100 320x50, outside its parent at 0,0 300x200",
};
const EMPTY_BOX: Finding = { rule: "empty box", node: "Board > Running", says: "holds no rows and no empty line" };

/** A checker that reports what it was told to report, whatever it is handed. */
const finds =
  (...found: readonly Finding[]) =>
  (): readonly Finding[] =>
    found;

describe("a finding becomes a violation", () => {
  const [violation] = faults([screen("board", {})], finds(CLIPPED));

  it("is reported under one named invariant, so a view can ask for exactly these", () => {
    expect(violation?.invariant).toBe(SCREENS_CHECK);
  });

  it("is about a screen, which is not a row of the record and so has no id", () => {
    expect(violation?.entity).toBe("screen");
    expect(violation?.id).toBeNull();
  });

  it("is slugged by the screen, so two faults on one screen are two lines about it", () => {
    expect(faults([screen("board", {})], finds(CLIPPED, EMPTY_BOX)).map((v) => v.slug)).toEqual(["board", "board"]);
  });

  it("says the box, the rule and the checker's own words", () => {
    expect(violation?.detail).toContain("Board > Delivered");
    expect(violation?.detail).toContain("clipped");
    expect(violation?.detail).toContain("outside its parent at 0,0 300x200");
  });

  it("names the file a person has to open to see it", () => {
    expect(violation?.detail).toContain("docs/screens/board.json");
  });

  it("repeats a rule the doctor has never heard of, rather than dropping it", () => {
    const strange = { rule: "drawn upside down", node: "Board", says: "y grows up here" };
    expect(faults([screen("board", {})], finds(strange))[0]?.detail).toContain("drawn upside down");
  });

  it("says nothing about a screen the checker is happy with", () => {
    expect(faults([screen("board", {})], finds())).toEqual([]);
  });

  it("keeps the screens in the order they were read, so two passes read identically", () => {
    const both = faults([screen("board", {}), screen("detail", {})], finds(CLIPPED));
    expect(both.map((v) => v.slug)).toEqual(["board", "detail"]);
  });

  it("hands the checker the capture it was given, and does not read it itself", () => {
    const seen: unknown[] = [];
    faults([screen("board", { what: "a tree the runner knows nothing about" })], (c) => {
      seen.push(c);
      return [];
    });
    expect(seen).toEqual([{ what: "a tree the runner knows nothing about" }]);
  });
});

describe("the captures it reads", () => {
  it("finds every capture under the screens directory, named for its file", () => {
    const root = treeOf({ board: { name: "Board" }, detail: { name: "Detail" } });
    const { screens } = capturedScreens<{ name: string }>(root);
    expect(screens.map((s) => s.name)).toEqual(["board", "detail"]);
    expect(screens.map((s) => s.capture)).toEqual([{ name: "Board" }, { name: "Detail" }]);
  });

  it("names each capture's file the way a violation will print it", () => {
    const { screens } = capturedScreens(treeOf({ board: {} }));
    expect(screens[0]?.path).toBe("docs/screens/board.json");
  });

  it("reads them in name order, whatever order the filesystem offers", () => {
    const root = treeOf({ zoo: {}, board: {}, detail: {} });
    expect(capturedScreens(root).screens.map((s) => s.name)).toEqual(["board", "detail", "zoo"]);
  });

  it("ignores what is not a capture", () => {
    const root = treeOf({ board: {} }, { "notes.md": "how the board is meant to look\n" });
    expect(capturedScreens(root).screens.map((s) => s.name)).toEqual(["board"]);
  });

  it("finds nothing in a tree that captures nothing, rather than failing", () => {
    const bare = mkdtempSync(join(tmpdir(), "screens-"));
    tmp.push(bare);
    expect(capturedScreens(bare)).toEqual({ screens: [], broken: [] });
  });

  it("reports a capture that will not parse rather than throwing over it", () => {
    const root = treeOf({}, { "board.json": "{ not json" });
    const { screens, broken } = capturedScreens(root);
    expect(screens).toEqual([]);
    expect(broken.map((v) => ({ invariant: v.invariant, entity: v.entity, slug: v.slug }))).toEqual([
      { invariant: SCREENS_CHECK, entity: "screen", slug: "board" },
    ]);
    expect(broken[0]?.detail).toContain("docs/screens/board.json");
  });

  it("keeps reading the captures beside an unreadable one", () => {
    const root = treeOf({ detail: { name: "Detail" } }, { "board.json": "{ not json" });
    const { screens, broken } = capturedScreens(root);
    expect(screens.map((s) => s.name)).toEqual(["detail"]);
    expect(broken.map((v) => v.slug)).toEqual(["board"]);
  });
});

describe("the invariant, over a real tree", () => {
  const root = treeOf({ board: { name: "Board" }, detail: { name: "Detail" } });

  it("is named so the report and the board say the same thing", () => {
    expect(screenInvariant(root, finds()).name).toBe(SCREENS_CHECK);
  });

  it("reports a fault on each captured screen the checker faults", () => {
    const found = screenInvariant<unknown>(root, finds(CLIPPED)).check(EMPTY);
    expect(found.map((v) => v.slug)).toEqual(["board", "detail"]);
  });

  it("says nothing at all about a tree that captures nothing", () => {
    const bare = mkdtempSync(join(tmpdir(), "screens-"));
    tmp.push(bare);
    expect(screenInvariant(bare, finds(CLIPPED)).check(EMPTY)).toEqual([]);
  });

  it("reports an unreadable capture alongside the faults of the readable ones", () => {
    const mixed = treeOf({ detail: {} }, { "board.json": "{ not json" });
    const found = screenInvariant<unknown>(mixed, finds(CLIPPED)).check(EMPTY);
    expect(found.map((v) => v.slug)).toEqual(["detail", "board"]);
    expect(found.every((v) => v.invariant === SCREENS_CHECK)).toBe(true);
  });

  it("takes no notice of the record, because the record cannot say where a box was drawn", () => {
    const loaded: Snapshot = { nodes: [{ entity: "task", id: 1, slug: "t", state: "ready" }], workers: [] };
    const over = screenInvariant<unknown>(root, finds(CLIPPED));
    expect(over.check(loaded)).toEqual(over.check(EMPTY));
  });
});

/** The two halves, fitted together over the capture the ui suite plants its faults in. This
 *  is the only place the real rules run, and it proves the one thing a stub cannot: that
 *  `check.ts`'s findings are the shape this module reports, so the wiring left to do is a
 *  call and not a translation. */
describe("with the rules that hold for every screen", () => {
  const FAULTY: CapturedNode = {
    name: "Board",
    at: { x: 0, y: 0, width: 300, height: 200 },
    children: [
      { name: "Needs you", at: { x: 0, y: 0, width: 150, height: 60 }, key: "n", rows: ["task-7"] },
      { name: "Queue", at: { x: 150, y: 0, width: 150, height: 60 }, key: "q", rows: ["task-7"] },
      { name: "Running", at: { x: 0, y: 60, width: 300, height: 40 }, key: "r" },
      { name: "Delivered", at: { x: 0, y: 100, width: 320, height: 50 }, key: "d", rows: ["task-2"] },
      { name: "Detail", at: { x: 0, y: 150, width: 300, height: 50 }, key: "d", rows: ["task-9"] },
    ],
  };

  const found = screenInvariant<CapturedNode>(treeOf({ board: FAULTY }), check).check(EMPTY);

  it("reports each of the four rules as a violation of the one invariant", () => {
    expect(found).toHaveLength(4);
    expect(new Set(found.map((v) => v.invariant))).toEqual(new Set([SCREENS_CHECK]));
  });

  it("names every rule the checker found, in the doctor's own sentence", () => {
    const said = found.map((v) => v.detail).join("\n");
    for (const rule of ["placed twice", "clipped", "key bound twice", "empty box"]) {
      expect(said).toContain(rule);
    }
  });

  it("points at the capture, so the screen that drew wrongly can be looked at", () => {
    expect(found.every((v) => v.slug === "board" && v.detail.includes("docs/screens/board.json"))).toBe(true);
  });

  it("says nothing about the same screen once it is repaired", () => {
    const CLEAN: CapturedNode = {
      ...FAULTY,
      children: [
        { name: "Needs you", at: { x: 0, y: 0, width: 150, height: 60 }, key: "n", rows: ["task-7"] },
        { name: "Queue", at: { x: 150, y: 0, width: 150, height: 60 }, key: "q", rows: ["task-8"] },
        { name: "Running", at: { x: 0, y: 60, width: 300, height: 40 }, key: "r", rows: [""] },
        { name: "Delivered", at: { x: 0, y: 100, width: 300, height: 50 }, key: "d", rows: ["task-2"] },
        { name: "Detail", at: { x: 0, y: 150, width: 300, height: 50 }, key: "e", rows: ["task-9"] },
      ],
    };
    expect(screenInvariant<CapturedNode>(treeOf({ board: CLEAN }), check).check(EMPTY)).toEqual([]);
  });
});
