import { inverted, plain } from "./force-color.js";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { RunningList, gauge, wrap, type ListProps, type Row, type Spend } from "../src/list.js";

/** A running row as the board builds one: the detail is the worker, the age and the spend,
 *  and the budget rides alongside for the gauge. */
const row = (id: number, what: string, detail: string, spent?: Spend, budget?: Spend): Row => ({
  id,
  what,
  state: "running",
  detail,
  ...(spent === undefined ? {} : { spent }),
  ...(budget === undefined ? {} : { budget }),
});

const frame = (props: ListProps): string =>
  render(createElement(RunningList, props)).lastFrame() ?? "";

/** The lines a reader sees, trailing space and all removed — an empty line of a row is
 *  held open by a space, and ink strips that space only from the frame's last line. What
 *  is on the line is the assertion; whether the space survived to the edge is not. */
const seen = (text: string): string[] =>
  text === "" ? [] : text.split("\n").map((line) => line.trimEnd());

const lines = (rows: readonly Row[], height: number, cursor: number | null, width: number): string[] =>
  seen(plain(frame({ rows, height, cursor, width })));

afterEach(cleanup);

describe("a running row", () => {
  it("is three lines: the head, the title under it, then the gauge and the detail", () => {
    const rows = [
      row(
        7,
        "cut the worktree and hand it to the agent",
        "claude-1 · 12m · 2.0k",
        { tokens: 125000, seconds: 300 },
        { tokens: 250000, seconds: 3600 },
      ),
    ];

    expect(lines(rows, 9, null, 60)).toEqual([
      "#7  running  cut the worktree and hand it to the agent",
      "",
      "             [█████░░░░░] 50% tokens  claude-1 · 12m · 2.0k",
    ]);
  });

  it("wraps the title onto the second line rather than cutting it there", () => {
    const rows = [row(7, "cut the worktree and hand it to the agent", "claude-1")];

    expect(lines(rows, 9, null, 34)).toEqual([
      "#7  running  cut the worktree and",
      "             hand it to the agent",
      "             claude-1",
    ]);
  });

  it("marks a title too long for both its lines, so a cut title reads as one", () => {
    const rows = [row(7, "a b c d e f g h i j k l m n o p q r s t", "claude-1")];

    expect(lines(rows, 9, null, 25)).toEqual([
      "#7  running  a b c d e f",
      "             g h i j k l…",
      "             claude-1",
    ]);
  });

  it("gives the title the same two lines whether or not it needs them", () => {
    // Three lines a row, always — the gauge is on the third line of a short row too, so a
    // box of them does not reflow as a title gains a word.
    const rows = [row(7, "short", "claude-1"), row(8, "also short", "claude-2")];
    const out = lines(rows, 9, null, 60);

    expect(out).toHaveLength(6);
    expect(out[1]).toBe("");
    expect(out[2]).toBe("             claude-1");
    expect(out[4]).toBe("");
  });

  it("lines its heads up and starts every title at one column", () => {
    const rows = [row(7, "a", "claude-1"), { ...row(2222, "b", "claude-2"), state: "pending" }];

    expect(lines(rows, 9, null, 60).filter((l) => l !== "")).toEqual([
      "#7     running  a",
      "                claude-1",
      "#2222  pending  b",
      "                claude-2",
    ]);
  });
});

describe("a running row's spend gauge", () => {
  const budget: Spend = { tokens: 250000, seconds: 3600 };

  it("shows whichever of the two allowances is closest to running out", () => {
    // 10% of the tokens, but half the clock: the clock is what ends this run.
    expect(gauge(row(1, "a", "", { tokens: 25000, seconds: 1800 }, budget))).toBe(
      "[█████░░░░░] 50% time",
    );
    expect(gauge(row(1, "a", "", { tokens: 200000, seconds: 60 }, budget))).toBe(
      "[████████░░] 80% tokens",
    );
  });

  it("fills the bar but keeps counting past it, because an overspend is the thing to see", () => {
    expect(gauge(row(1, "a", "", { tokens: 300000, seconds: 0 }, budget))).toBe(
      "[██████████] 120% tokens",
    );
  });

  it("draws nothing when there is no allowance to draw against", () => {
    expect(gauge(row(1, "a", "", { tokens: 100, seconds: 1 }, { tokens: 0, seconds: 0 }))).toBe("");
    expect(gauge(row(1, "a", "", { tokens: 100, seconds: 1 }))).toBe("");
    expect(gauge(row(1, "a", ""))).toBe("");
  });

  it("leaves the row its detail and nothing more when it has no gauge", () => {
    const rows = [row(7, "a title", "claude-1 · 12m · 2.0k")];

    expect(lines(rows, 9, null, 60)[2]).toBe("             claude-1 · 12m · 2.0k");
  });
});

describe("the running box's fold", () => {
  const many = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`, `claude-${i}`));

  it("counts its fold in rows, never drawing part of one", () => {
    // Eight lines hold two whole rows and the tally, not two and two thirds.
    expect(lines(many, 8, null, 40)).toEqual([
      "#1  running  thing 1",
      "",
      "             claude-1",
      "#2  running  thing 2",
      "",
      "             claude-2",
      "… and 3 more",
    ]);
  });

  it("draws nothing at all when a whole row will not fit", () => {
    expect(lines(many, 2, null, 40)).toEqual(["… and 5 more"]);
    expect(lines(many, 0, null, 40)).toEqual([]);
  });

  it("says nothing about a fold when every row fits", () => {
    expect(lines(many.slice(0, 2), 6, null, 40)).toHaveLength(6);
    expect(lines(many.slice(0, 2), 40, null, 40)).toHaveLength(6);
  });

  it("scrolls a cursor past the fold into view, in whole rows", () => {
    const out = lines(many, 8, 4, 40);

    expect(out).toEqual([
      "#4  running  thing 4",
      "",
      "             claude-4",
      "#5  running  thing 5",
      "",
      "             claude-5",
      "… and 3 more",
    ]);
  });
});

describe("the running box's cursor", () => {
  it("inverts all three lines of the row it is on, and no line of any other", () => {
    const rows = [row(1, "a", "claude-1"), row(2, "b", "claude-2")];

    expect(inverted(frame({ rows, height: 9, cursor: 1, width: 40 })).map((l) => l.trimEnd())).toEqual([
      "#2  running  b",
      "",
      "             claude-2",
    ]);
  });

  it("inverts nothing when the cursor is null", () => {
    expect(inverted(frame({ rows: [row(1, "a", "c")], height: 9, cursor: null, width: 40 }))).toEqual(
      [],
    );
  });
});

describe("wrapping", () => {
  it("breaks at the spaces and never past the width", () => {
    expect(wrap("one two three four", 9, 3)).toEqual(["one two", "three", "four"]);
  });

  it("cuts a word that will not fit a line of its own", () => {
    expect(wrap("antidisestablishmentarianism now", 8, 2)).toEqual(["antidis…", "now"]);
  });

  it("marks the last line when there is more to say", () => {
    expect(wrap("one two three four", 9, 2)).toEqual(["one two", "three fo…"]);
  });

  it("has nothing to give when there is no room", () => {
    expect(wrap("one", 0, 2)).toEqual([]);
    expect(wrap("one", 9, 0)).toEqual([]);
  });
});
