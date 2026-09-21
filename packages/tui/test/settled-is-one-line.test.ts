/** A section of the board spends no more than one line on what is finished with, and no
 *  more than one line on holding nothing at all.
 *
 *  Fourteen lines of the board were finished work: the boxes that hold only settled rows
 *  drew one line each for rows nobody has to look at again, and the height went from the
 *  boxes that still want something. What is asserted here is the arithmetic — that a
 *  settled row costs a share of a tally rather than a line, and that a section with nothing
 *  in it costs one line and not its declared height.
 *
 *  Which states count as settled is not asserted against a list written here: it is read
 *  off config/views.yaml's `settled` group, because that is where it is declared. */
import { coloured, inverted, plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import {
  SectionList,
  cooking,
  forgetCooking,
  groupOf,
  isSettled,
  sectionLines,
  type Row,
} from "../src/list.js";

/** chalk's `gray` is the bright-black foreground, closed by the same reset any other
 *  colour is — so `coloured` reads it like the rest. */
const DIM = 90;

const row = (id: number, what: string, state: string, detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

/** The states views.yaml puts in the settled group, in the order it declares them. */
const SETTLED_STATES = cooking().groups.find((g) => g.name === "settled")?.states ?? [];

const texts = (
  rows: readonly Row[],
  height: number,
  cursor: number | null = null,
  width = 80,
  empty = "nothing is waiting to land",
): string[] => sectionLines(rows, height, cursor, width, empty).map((l) => l.text);

/** An open row leads with its own state's mark in its first two columns — views.yaml's
 *  cooking groups, the same vocabulary the heads are marked in. A state no group claims
 *  leads with a space. Written here so the expectations below say what a row says and not
 *  what its state's glyph happens to be today. */
const led = (state: string, rest: string): string => `${groupOf(state)?.mark ?? " "} ${rest}`;

/** The frame as written, escapes and all. */
const frame = (rows: readonly Row[], height: number, cursor: number | null = null): string =>
  render(
    createElement(SectionList, {
      rows,
      height,
      cursor,
      width: 80,
      empty: "nothing is waiting to land",
    }),
  ).lastFrame() ?? "";

beforeEach(forgetCooking);
afterEach(() => {
  cleanup();
  forgetCooking();
});

describe("which rows are settled", () => {
  it("is every state views.yaml puts in the settled group and no other", () => {
    expect(SETTLED_STATES.length).toBeGreaterThan(0);
    for (const state of SETTLED_STATES) expect(isSettled(state)).toBe(true);

    for (const state of ["running", "approval", "waiting", "failed", "in_progress"]) {
      expect(isSettled(state)).toBe(false);
    }
  });
});

describe("the settled rows are one tally", () => {
  it("counts them on one line however many of them there are", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `shipped ${i}`, "delivered"));

    expect(texts(rows, 5)).toEqual(["+ 5 settled"]);
  });

  it("counts a row in any settled state, not only the commonest one", () => {
    const rows = SETTLED_STATES.map((state, i) => row(i + 1, `a ${state} thing`, state));

    expect(texts(rows, 9)).toEqual([`+ ${SETTLED_STATES.length} settled`]);
  });

  it("gives the tally the group's own mark, which is declared in views.yaml", () => {
    const group = cooking().groups.find((g) => g.name === "settled");

    expect(texts([row(1, "a", "delivered")], 4)[0]).toBe(`${group?.mark} 1 settled`);
  });

  it("closes the list, after the rows that still want something", () => {
    const rows = [
      row(1, "land it?", "approval"),
      row(2, "shipped", "delivered"),
      row(3, "going", "running"),
      row(4, "also shipped", "released"),
    ];

    expect(texts(rows, 6)).toEqual([
      led("approval", "#1  approval  land it?"),
      led("running", "#3  running   going"),
      "+ 2 settled",
    ]);
  });

  /** List colour is applied to the state cell alone, so what the dim holds is the tally's
   *  own word — the mark and the number stand undimmed beside it. */
  it("is dim, because it is the one thing nobody has to look at again", () => {
    const out = frame([row(1, "going", "running"), row(2, "shipped", "delivered")], 4);

    expect(coloured(out, DIM)).toEqual(["settled"]);
    expect(plain(out).split("\n").at(-1)).toBe("+ 1 settled");
  });

  it("is what fourteen lines of finished work come to", () => {
    const rows = [...Array(14)].map((_, i) => row(i + 1, `done ${i + 1}`, "delivered"));

    expect(texts(rows, 14)).toEqual(["+ 14 settled"]);
  });

  it("is not drawn at all when there is nothing settled", () => {
    expect(texts([row(1, "going", "running")], 4)).toEqual([led("running", "#1  running  going")]);
  });
});

describe("an empty section is one line", () => {
  it("says the caller's sentence, and says it once", () => {
    expect(texts([], 8)).toEqual(["nothing is waiting to land"]);
  });

  it("takes one line of a height that would have held eight", () => {
    expect(sectionLines([], 8, null, 80, "nothing is planned")).toHaveLength(1);
  });

  it("clips that sentence to the width like any other line", () => {
    expect(texts([], 5, null, 12)).toEqual(["nothing is …"]);
  });

  it("draws nothing at all when there is no height", () => {
    expect(texts([], 0)).toEqual([]);
  });

  it("gives the line to the tally instead when the settled rows are the empty part", () => {
    // Nothing is open, so the section is empty of everything a person can act on — and a
    // count of what is finished says more than a sentence saying there is nothing to count.
    const rows = [1, 2, 3].map((i) => row(i, `shipped ${i}`, "delivered"));

    expect(texts(rows, 5)).toEqual(["+ 3 settled"]);
  });
});

describe("the height the tally gives back", () => {
  it("lets the open rows use every line but the tally's own", () => {
    const rows = [
      ...[1, 2, 3].map((i) => row(i, `open ${i}`, "running")),
      row(9, "shipped", "delivered"),
    ];

    expect(texts(rows, 4)).toEqual([
      led("running", "#1  running  open 1"),
      led("running", "#2  running  open 2"),
      led("running", "#3  running  open 3"),
      "+ 1 settled",
    ]);
  });

  it("folds the open rows, not the tally, when they still do not fit", () => {
    const rows = [
      ...[1, 2, 3, 4].map((i) => row(i, `open ${i}`, "running")),
      row(9, "shipped", "delivered"),
    ];

    expect(texts(rows, 3)).toEqual([
      led("running", "#1  running  open 1"),
      "… and 3 more",
      "+ 1 settled",
    ]);
  });

  it("gives the last line to the open rows when there is only one to give", () => {
    const rows = [row(1, "open", "running"), row(9, "shipped", "delivered")];

    expect(texts(rows, 1)).toEqual([led("running", "#1  running  open")]);
  });
});

describe("the cursor over a sectioned list", () => {
  it("indexes the open rows, so the settled ones cost it no positions", () => {
    const rows = [
      row(1, "shipped", "delivered"),
      row(2, "going", "running"),
      row(3, "also shipped", "released"),
      row(4, "waits", "waiting"),
    ];
    const out = frame(rows, 4, 1);

    expect(plain(out).split("\n")).toEqual([
      led("running", "#2  running  going"),
      led("waiting", "#4  waiting  waits"),
      "+ 2 settled",
    ]);
    expect(inverted(out)).toEqual([led("waiting", "#4  waiting  waits")]);
  });

  it("never lands on the tally, whatever it is set to", () => {
    const rows = [row(1, "going", "running"), row(2, "shipped", "delivered")];

    for (const cursor of [null, 0, 1, 5]) {
      const drawn = sectionLines(rows, 4, cursor, 80, "nothing");

      expect(drawn.filter((l) => l.cursor).map((l) => l.text)).not.toContain("+ 1 settled");
    }
  });
});
