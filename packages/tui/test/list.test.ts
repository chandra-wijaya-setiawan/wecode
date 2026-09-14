import { inverted, plain, coloured, GREEN, RED, YELLOW } from "./force-color.js";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { List, columnWidths, type Column, type ListProps, type Row } from "../src/list.js";

const row = (id: number, what: string, state = "ready", detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

const ALL: Column[] = ["#", "what", "state", "detail"];

/** The frame as written, escapes and all — colour is part of what a list draws. */
const frame = (props: ListProps): string =>
  render(createElement(List, props)).lastFrame() ?? "";

const list = (
  rows: readonly Row[],
  columns: readonly Column[],
  height: number,
  cursor: number | null,
  width: number,
  widths?: readonly number[],
): string =>
  frame(widths === undefined ? { rows, columns, height, cursor, width } : { rows, columns, height, cursor, width, widths });

/** The lines a reader sees. An empty list draws nothing at all, which is one empty line. */
const lines = (...args: Parameters<typeof list>): string[] => {
  const text = plain(list(...args));
  return text === "" ? [] : text.split("\n");
};

afterEach(cleanup);

describe("the list's columns", () => {
  it("draws them in the order given and no others", () => {
    const rows = [row(1, "cut the worktree", "running", "claude-1")];

    expect(lines(rows, ["what", "#"], 5, null, 80)).toEqual(["cut the worktree  1"]);
    expect(lines(rows, ["#"], 5, null, 80)).toEqual(["1"]);
  });

  it("pads each column to its widest cell so they line up", () => {
    const rows = [row(1, "a", "ready"), row(20, "longer", "running")];

    expect(lines(rows, ["#", "what", "state"], 5, null, 80)).toEqual([
      "1   a       ready",
      "20  longer  running",
    ]);
  });

  it("lines up against widths from off its own screen when it is given them", () => {
    const rows = [row(1, "a", "ready")];
    const widths = columnWidths([row(1, "a"), row(2222, "a much longer thing")], ["#", "what"]);

    expect(lines(rows, ["#", "what"], 5, null, 80, widths)).toEqual([
      // Four columns for an id it does not have, nineteen for a title it does not have.
      "1     a",
    ]);
  });

  it("draws nothing when there is no height or no column", () => {
    expect(lines([row(1, "a")], ALL, 0, null, 80)).toEqual([]);
    expect(lines([row(1, "a")], [], 5, null, 80)).toEqual([]);
  });
});

describe("the list's width", () => {
  it("truncates with an ellipsis rather than wrapping", () => {
    const out = lines([row(1, "a very long thing indeed")], ["what"], 5, null, 12);

    expect(out).toEqual(["a very long…"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(12);
  });

  it("leaves a line that already fits alone", () => {
    expect(lines([row(1, "short")], ["what"], 5, null, 40)).toEqual(["short"]);
  });

  it("truncates the tally too", () => {
    const rows = [row(1, "a"), row(2, "b"), row(3, "c")];

    expect(lines(rows, ["what"], 2, null, 6)).toEqual(["a", "… and…"]);
  });
});

describe("the rows the height hides", () => {
  it("counts them on the last line", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`));

    expect(lines(rows, ["what"], 3, null, 80)).toEqual(["thing 1", "thing 2", "… and 3 more"]);
  });

  it("says nothing when every row fits", () => {
    const rows = [row(1, "a"), row(2, "b")];

    expect(lines(rows, ["what"], 2, null, 80)).toEqual(["a", "b"]);
    expect(lines(rows, ["what"], 9, null, 80)).toEqual(["a", "b"]);
  });

  it("gives the whole height to the tally when nothing else fits", () => {
    const rows = [row(1, "a"), row(2, "b")];

    expect(lines(rows, ["what"], 1, null, 80)).toEqual(["… and 2 more"]);
  });
});

describe("the list's cursor", () => {
  it("inverts that row and no other, and costs no column to do it", () => {
    const rows = [row(1, "a"), row(2, "b"), row(3, "c")];
    const out = list(rows, ["what"], 5, 1, 80);

    expect(inverted(out)).toEqual(["b"]);
    // No gutter: the rows start at the first column whether the cursor is on them or not.
    expect(plain(out).split("\n")).toEqual(["a", "b", "c"]);
  });

  it("inverts nothing when the cursor is null", () => {
    expect(inverted(list([row(1, "a"), row(2, "b")], ["what"], 5, null, 80))).toEqual([]);
  });

  it("scrolls so a cursor past the fold is still on a visible line", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`));
    const out = list(rows, ["what"], 3, 4, 80);

    expect(plain(out).split("\n")).toEqual(["thing 4", "thing 5", "… and 3 more"]);
    expect(inverted(out)).toEqual(["thing 5"]);
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
    const out = list(rows, ["what"], 5, null, 80);

    expect(coloured(out, RED)).toEqual(["gave up"]);
    expect(coloured(out, YELLOW)).toEqual(["waits"]);
    expect(coloured(out, GREEN)).toEqual(["shipped"]);
    // A state with nothing to say about itself is drawn plain, and so is the tally.
    expect(plain(out).split("\n")[3]).toBe("going");
    expect(out).toContain("going");
  });

  it("leaves the tally uncoloured, whatever the rows it counts were", () => {
    const rows = [1, 2, 3].map((i) => row(i, `t${i}`, "failed"));
    const out = list(rows, ["what"], 2, null, 80);

    expect(coloured(out, RED)).toEqual(["t1"]);
    expect(out).toContain("… and 2 more");
  });
});
