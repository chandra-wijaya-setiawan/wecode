import { inverted, plain, coloured, GREEN, RED, YELLOW } from "./force-color.js";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { List, columnWidths, type ListProps, type Row } from "../src/list.js";

const row = (id: number, what: string, state = "ready", detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

/** The frame as written, escapes and all — colour is part of what a list draws. */
const frame = (props: ListProps): string =>
  render(createElement(List, props)).lastFrame() ?? "";

const list = (
  rows: readonly Row[],
  height: number,
  cursor: number | null,
  width: number,
  widths?: readonly number[],
): string =>
  frame(widths === undefined ? { rows, height, cursor, width } : { rows, height, cursor, width, widths });

/** The lines a reader sees. An empty list draws nothing at all, which is one empty line. */
const lines = (...args: Parameters<typeof list>): string[] => {
  const text = plain(list(...args));
  return text === "" ? [] : text.split("\n");
};

afterEach(cleanup);

describe("the row contract", () => {
  it("is a code, then a state, then a description, in that order", () => {
    const rows = [row(7, "cut the worktree", "running", "claude-1")];

    expect(lines(rows, 5, null, 80)).toEqual(["#7  running  cut the worktree · claude-1"]);
  });

  it("says the kind in the code where the screen does not say it", () => {
    // The board marks a row whose kind the screen cannot supply by putting the kind, and
    // nothing else, in the detail: a roadmap box and a node's children both mix kinds.
    const rows = [row(3, "the cockpit", "open", "epic"), row(4, "a list", "open", "story")];

    expect(lines(rows, 5, null, 80)).toEqual([
      "epic #3   open  the cockpit",
      "story #4  open  a list",
    ]);
  });

  it("says a two-word kind the way a person would say it aloud", () => {
    expect(lines([row(9, "it must line up", "met", "acceptance_criteria")], 5, null, 80)).toEqual([
      "acceptance criteria #9  met  it must line up",
    ]);
  });

  it("never lets a screen choose its own columns", () => {
    const rows = [row(1, "a", "ready", "claude-1")];
    // A caller naming columns is honoured in nothing: the three are drawn as they always are.
    const out = plain(frame({ rows, columns: ["description"], height: 5, cursor: null, width: 80 }));

    expect(out).toBe("#1  ready  a · claude-1");
  });

  it("draws nothing when there is no height", () => {
    expect(lines([row(1, "a")], 0, null, 80)).toEqual([]);
  });
});

describe("the list's columns", () => {
  it("pads the code and the state so the columns line up whatever the id's width", () => {
    const rows = [row(1, "a", "ready"), row(2222, "longer", "running")];

    expect(lines(rows, 5, null, 80)).toEqual([
      "#1     ready    a",
      "#2222  running  longer",
    ]);
  });

  it("lines up against widths from off its own screen when it is given them", () => {
    const rows = [row(1, "a", "ready")];
    const widths = columnWidths([row(1, "a", "ready"), row(2222, "b", "in_progress")]);

    expect(lines(rows, 5, null, 80, widths)).toEqual([
      // Five columns for an id it does not have, eleven for a state it does not have.
      "#1     ready        a",
    ]);
  });
});

describe("the list's width", () => {
  it("truncates the description, which is the column that gives way", () => {
    const out = lines([row(1, "a very long thing indeed", "ready")], 5, null, 20);

    expect(out).toEqual(["#1  ready  a very l…"]);
    expect(out[0]).toHaveLength(20);
  });

  it("leaves a line that already fits alone", () => {
    expect(lines([row(1, "short", "ready")], 5, null, 40)).toEqual(["#1  ready  short"]);
  });

  it("truncates the tally too", () => {
    const rows = [row(1, "a"), row(2, "b"), row(3, "c")];

    expect(lines(rows, 2, null, 6)).toEqual(["#1  r…", "… and…"]);
  });
});

describe("the rows the height hides", () => {
  it("counts them on the last line", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`));

    expect(lines(rows, 3, null, 80)).toEqual([
      "#1  ready  thing 1",
      "#2  ready  thing 2",
      "… and 3 more",
    ]);
  });

  it("says nothing when every row fits", () => {
    const rows = [row(1, "a"), row(2, "b")];

    expect(lines(rows, 2, null, 80)).toEqual(["#1  ready  a", "#2  ready  b"]);
    expect(lines(rows, 9, null, 80)).toEqual(["#1  ready  a", "#2  ready  b"]);
  });

  it("gives the whole height to the tally when nothing else fits", () => {
    expect(lines([row(1, "a"), row(2, "b")], 1, null, 80)).toEqual(["… and 2 more"]);
  });
});

describe("the list's cursor", () => {
  it("inverts that row and no other, and costs no column to do it", () => {
    const rows = [row(1, "a"), row(2, "b"), row(3, "c")];
    const out = list(rows, 5, 1, 80);

    expect(inverted(out)).toEqual(["#2  ready  b"]);
    // No gutter: the rows start at the first column whether the cursor is on them or not.
    expect(plain(out).split("\n")).toEqual(["#1  ready  a", "#2  ready  b", "#3  ready  c"]);
  });

  it("inverts nothing when the cursor is null", () => {
    expect(inverted(list([row(1, "a"), row(2, "b")], 5, null, 80))).toEqual([]);
  });

  it("scrolls so a cursor past the fold is still on a visible line", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`));
    const out = list(rows, 3, 4, 80);

    expect(plain(out).split("\n")).toEqual([
      "#4  ready  thing 4",
      "#5  ready  thing 5",
      "… and 3 more",
    ]);
    expect(inverted(out)).toEqual(["#5  ready  thing 5"]);
  });
});

describe("the list's colour", () => {
  it("is the row's state and nothing else", () => {
    const rows = [
      row(1, "gave up", "failed"),
      row(2, "waits", "waiting"),
      row(3, "shipped", "delivered"),
      row(4, "going", "in_progress"),
    ];
    const out = list(rows, 5, null, 80);

    expect(coloured(out, RED)).toEqual(["#1  failed       gave up"]);
    expect(coloured(out, YELLOW)).toEqual(["#2  waiting      waits"]);
    expect(coloured(out, GREEN)).toEqual(["#3  delivered    shipped"]);
    // A state with nothing to say about itself is drawn plain, and so is the tally.
    expect(plain(out).split("\n")[3]).toBe("#4  in_progress  going");
    expect(out).toContain("#4  in_progress  going");
  });

  it("leaves the tally uncoloured, whatever the rows it counts were", () => {
    const rows = [1, 2, 3].map((i) => row(i, `t${i}`, "failed"));
    const out = list(rows, 2, null, 80);

    expect(coloured(out, RED)).toEqual(["#1  failed  t1"]);
    expect(out).toContain("… and 2 more");
  });
});
