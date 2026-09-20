/** What the ink adapter drew, read back as a capture.
 *
 *  The terminal was the one renderer nothing could be checked against: check.ts and
 *  diff.ts read captures, and until now a capture of a terminal screen had to be written
 *  out by hand beside the screen it was a capture of — two statements of one thing, which
 *  is the defect those modules exist to catch. `inkCapture` reads the frame the adapter
 *  returned, so the capture is what was drawn rather than what was meant.
 *
 *  That is what most of the assertions below are about: the read-back is held against
 *  `indexLines` and against the frame ink actually prints, never against a second copy of
 *  the fixture. What is asserted literally is only what the capture adds — the geometry of
 *  a column of text, and the letter each box opens on — and the one property that makes it
 *  worth having: a frame with a fault in it comes back with the fault, so check.ts and
 *  diff.ts can see it. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Box, Text } from "ink";

import { check } from "../src/check.js";
import { diff } from "../src/diff.js";
import { indexLines, type ViewIndexScreen } from "../src/ports.js";
import { inkCapture, inkViewIndex } from "../src/adapters/ink.js";

/** The same three boxes the other two adapters are held against. */
const SCREEN: ViewIndexScreen = {
  title: "Views",
  views: [
    { key: "n", title: "Needs you" },
    { key: "q", title: "Queue" },
    { key: "o", title: "Open", note: "off page" },
  ],
};

const capture = (screen: ViewIndexScreen = SCREEN) => inkCapture(inkViewIndex.draw(screen));

/** Every line the capture says was drawn, root first, in drawing order. */
const lines = (): string[] => {
  const root = capture();
  return [...(root.rows ?? []), ...(root.children ?? []).flatMap((c) => c.rows ?? [])];
};

describe("what the ink adapter drew, read back", () => {
  it("comes back as the lines the port asked for, in order", () => {
    expect(lines()).toEqual(indexLines(SCREEN));
  });

  it("names the screen and one box per view", () => {
    const root = capture();
    expect(root.name).toBe("Views");
    expect((root.children ?? []).map((c) => c.name)).toEqual([
      "Needs you",
      "Queue",
      "Open       off page",
    ]);
  });

  it("says which letter each box opens on", () => {
    expect((capture().children ?? []).map((c) => c.key)).toEqual(["n", "q", "o"]);
  });

  it("gives each box the line it occupies, and the screen the lines it holds", () => {
    const root = capture();
    expect(root.at).toEqual({ x: 0, y: 0, width: 22, height: 4 });
    expect((root.children ?? []).map((c) => c.at)).toEqual([
      { x: 0, y: 1, width: 12, height: 1 },
      { x: 0, y: 2, width: 8, height: 1 },
      { x: 0, y: 3, width: 22, height: 1 },
    ]);
  });

  it("reads back a screen check.ts has no fault with", () => {
    expect(check(capture())).toEqual([]);
  });

  it("reads back a frame's faults rather than the screen's intentions", () => {
    /** A frame the adapter would never draw: two boxes on the same letter, one of them
     *  holding a line the other holds too. A read-back that went through `indexLines`
     *  again could not produce this, and check.ts would never see it. */
    const row = (text: string) => createElement(Text, { key: text }, text);
    const faulty = createElement(
      Box,
      { flexDirection: "column" },
      createElement(Text, { key: "title" }, "Views"),
      row("n  Needs you"),
      row("n  Needs you"),
    );
    expect(check(inkCapture(faulty)).map((f) => f.rule).sort()).toEqual([
      "key bound twice",
      "placed twice",
    ]);
  });

  it("has nothing to say between two frames of the same screen", () => {
    expect(diff(capture(), capture())).toEqual([]);
  });

  it("names the box a redrawn screen lost, and what the rest of them did", () => {
    const after = capture({
      title: "Views",
      views: [
        { key: "n", title: "Needs you" },
        { key: "o", title: "Open", note: "off page" },
      ],
    });
    expect(diff(capture(), after).map((c) => ({ kind: c.kind, node: c.node }))).toEqual([
      /** The screen is one line shorter, so the screen itself moved. */
      { kind: "moved", node: "Views" },
      { kind: "gone", node: "Views > Queue" },
      { kind: "moved", node: "Views > Open       off page" },
    ]);
  });
});
