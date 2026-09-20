/** The ViewIndex port and the ink adapter behind it, both held against one fixture screen.
 *
 *  One fixture, not two. A port is only worth the file it is in if an adapter cannot
 *  quietly answer differently from it, so the text below is written out once and both the
 *  contract (`indexLines`) and the renderer (`inkViewIndex`) are asserted to produce it —
 *  a reflow, a stray pad or a dropped column shows up as the same diff whichever side
 *  caused it.
 *
 *  The fixture is a screen and not a real board: the index is a keyboard, and what it has
 *  to get right — a letter per box, titles in a column, notes in a column of their own, in
 *  the order it was handed — is the same whether there are seven boxes or two. */
import { afterEach, describe, expect, it, vi } from "vitest";

/** chalk decides once, as it is imported, whether anything it is asked to colour is going
 *  to a terminal. Hoisted, because the import of ink below is hoisted too. */
vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "1";
});

import { cleanup, render } from "ink-testing-library";
import { indexLines, type ViewIndexScreen } from "../src/ports.js";
import { inkViewIndex } from "../src/adapters/ink.js";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const plain = (frame: string): string => frame.replace(ANSI, "");

/** Bold, as chalk writes it. The letter is the part a reader is hunting for, so the
 *  adapter's one decision of its own is that it is emphasised. */
const BOLD = `${ESC}[1m`;

/** Three boxes: two the page draws and one reached only by its letter, with titles of
 *  different lengths so the note column has something to line up against. `Queue` is
 *  shorter than `Needs you` and `Open` shorter still — a screen that padded to each line's
 *  own width instead of the longest would pass on a fixture where they matched. */
const SCREEN: ViewIndexScreen = {
  title: "Views",
  views: [
    { key: "n", title: "Needs you" },
    { key: "q", title: "Queue" },
    { key: "o", title: "Open", note: "off page" },
  ],
};

/** The screen, as a person sees it. */
const FIXTURE = [
  "Views",
  "n  Needs you",
  "q  Queue",
  "o  Open       off page",
];

const drawn = (): string[] => {
  const { lastFrame } = render(inkViewIndex.draw(SCREEN));
  return plain(lastFrame() ?? "").split("\n");
};

afterEach(cleanup);

describe("the ViewIndex port", () => {
  it("draws the fixture screen", () => {
    expect(indexLines(SCREEN)).toEqual(FIXTURE);
  });

  it("gives a box with no note no note column at all", () => {
    const [, needsYou] = indexLines(SCREEN);
    expect(needsYou).toBe("n  Needs you");
  });

  it("keeps the order it was handed", () => {
    const reversed = { ...SCREEN, views: [...SCREEN.views].reverse() };
    expect(indexLines(reversed).slice(1).map((l) => l[0])).toEqual(["o", "q", "n"]);
  });

  it("lines the notes up under each other", () => {
    const two: ViewIndexScreen = {
      title: "Views",
      views: [
        { key: "n", title: "Needs you", note: "5 rows" },
        { key: "o", title: "Open", note: "off page" },
      ],
    };
    const [, first, second] = indexLines(two);
    expect(first?.indexOf("5 rows")).toBe(second?.indexOf("off page"));
  });
});

describe("the ink adapter behind it", () => {
  it("draws the same fixture screen", () => {
    expect(drawn()).toEqual(FIXTURE);
  });

  it("spends no width the port did not ask for", () => {
    /** ink lays out boxes, and a box that grew would show as padding on the right of every
     *  line. The frame is the text and nothing else. */
    expect(drawn().every((l) => l === l.trimEnd())).toBe(true);
  });

  it("emphasises the letter each box opens on", () => {
    const { lastFrame } = render(inkViewIndex.draw(SCREEN));
    for (const key of ["n", "q", "o"]) {
      expect(lastFrame() ?? "").toContain(`${BOLD}${key}`);
    }
  });
});
