import { describe, expect, it } from "vitest";
import { renderList, type Column, type Row } from "../src/list.js";

const row = (id: number, what: string, state = "ready", detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

const ALL: Column[] = ["#", "what", "state", "detail"];

describe("the list's columns", () => {
  it("draws them in the order given and no others", () => {
    const rows = [row(1, "cut the worktree", "running", "claude-1")];

    expect(renderList(rows, ["what", "#"], 5, null, 80)).toEqual([
      "  cut the worktree  1",
    ]);
    expect(renderList(rows, ["#"], 5, null, 80)).toEqual(["  1"]);
  });

  it("pads each column to its widest cell so they line up", () => {
    const rows = [row(1, "a", "ready"), row(20, "longer", "running")];

    expect(renderList(rows, ["#", "what", "state"], 5, null, 80)).toEqual([
      "  1   a       ready",
      "  20  longer  running",
    ]);
  });

  it("draws nothing when there is no height or no column", () => {
    expect(renderList([row(1, "a")], ALL, 0, null, 80)).toEqual([]);
    expect(renderList([row(1, "a")], [], 5, null, 80)).toEqual([]);
  });
});

describe("the list's width", () => {
  it("truncates with an ellipsis rather than wrapping", () => {
    const lines = renderList([row(1, "a very long thing indeed")], ["what"], 5, null, 12);

    expect(lines).toEqual(["  a very lo…"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(12);
  });

  it("leaves a line that already fits alone", () => {
    expect(renderList([row(1, "short")], ["what"], 5, null, 40)).toEqual(["  short"]);
  });

  it("truncates the tally too", () => {
    const rows = [row(1, "a"), row(2, "b"), row(3, "c")];

    expect(renderList(rows, ["what"], 2, null, 8)).toEqual(["  a", "  … and…"]);
  });
});

describe("the rows the height hides", () => {
  it("counts them on the last line", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`));

    expect(renderList(rows, ["what"], 3, null, 80)).toEqual([
      "  thing 1",
      "  thing 2",
      "  … and 3 more",
    ]);
  });

  it("says nothing when every row fits", () => {
    const rows = [row(1, "a"), row(2, "b")];

    expect(renderList(rows, ["what"], 2, null, 80)).toEqual(["  a", "  b"]);
    expect(renderList(rows, ["what"], 9, null, 80)).toEqual(["  a", "  b"]);
  });

  it("gives the whole height to the tally when nothing else fits", () => {
    const rows = [row(1, "a"), row(2, "b")];

    expect(renderList(rows, ["what"], 1, null, 80)).toEqual(["  … and 2 more"]);
  });
});

describe("the list's cursor", () => {
  it("marks that row and no other", () => {
    const rows = [row(1, "a"), row(2, "b"), row(3, "c")];

    expect(renderList(rows, ["what"], 5, 1, 80)).toEqual(["  a", "> b", "  c"]);
  });

  it("marks nothing when the cursor is null", () => {
    const rows = [row(1, "a"), row(2, "b")];

    expect(renderList(rows, ["what"], 5, null, 80).every((l) => l.startsWith("  "))).toBe(
      true,
    );
  });

  it("scrolls so a cursor past the fold is still on a visible line", () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(i, `thing ${i}`));

    expect(renderList(rows, ["what"], 3, 4, 80)).toEqual([
      "  thing 4",
      "> thing 5",
      "  … and 3 more",
    ]);
  });
});
