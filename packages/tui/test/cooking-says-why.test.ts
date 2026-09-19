/** A cooking row says why it is cooking. The why, the mark, the grouping and the colours are
 *  all declared in config/views.yaml — so what is proved here is twice over: that a row is
 *  drawn grouped, marked and with its why, and that none of the words doing it live in a
 *  .tsx file. */
import { GREEN, RED, YELLOW, coloured, plain } from "./force-color.js";

/** chalk's `gray` is the bright-black foreground, closed by the same reset any other
 *  colour is — so `coloured` reads it like the rest. */
const DIM = 90;
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import {
  CookingError,
  List,
  cooking,
  cookingLines,
  forgetCooking,
  groupCooking,
  groupOf,
  loadCooking,
  mark,
  stateColour,
  why,
  type Row,
} from "../src/list.js";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));

const row = (id: number, what: string, state: string, detail = ""): Row => ({
  id,
  what,
  state,
  detail,
});

const texts = (
  rows: readonly Row[],
  height = rows.length,
  cursor: number | null = null,
  width = 80,
): string[] => cookingLines(rows, height, cursor, width).map((l) => l.text);

/** A views.yaml with `cooking:` replaced by whatever this case is about. */
function withCooking(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cooking-"));
  const path = join(dir, "views.yaml");
  const base = readFileSync(CONFIG, "utf8").replace(/^cooking:\n(?:[ \t-].*\n|\n)*/m, "");
  writeFileSync(path, `${base}\n${yaml}`);
  return path;
}

beforeEach(forgetCooking);
afterEach(() => {
  cleanup();
  forgetCooking();
});

describe("every cooking row has a why", () => {
  it("answers for every state a group claims", () => {
    for (const group of cooking().groups) {
      for (const state of group.states) {
        expect(why(row(1, "t", state))).toBe(group.why);
      }
    }
  });

  it("falls back to the state's own word when no group claims it", () => {
    expect(why(row(1, "t", "in_review"))).toBe("in review");
  });

  it("draws the why at the end of the row", () => {
    expect(texts([row(7, "ship it", "running")])[0]).toMatch(/ship it.*a worker has it$/);
  });

  it("gives a why to a row no group claims too", () => {
    expect(texts([row(7, "ship it", "ready")])[0]).toMatch(/ship it.*ready$/);
  });
});

describe("cooking rows are grouped", () => {
  it("gathers the rows by their why, in the order views.yaml declares", () => {
    const rows = [
      row(1, "a", "running"),
      row(2, "b", "failed"),
      row(3, "c", "delivered"),
      row(4, "d", "waiting"),
    ];
    expect(groupCooking(rows).map((r) => r.id)).toEqual([2, 4, 1, 3]);
  });

  it("keeps the rows a group shares in the order they arrived", () => {
    const rows = [row(9, "a", "failed"), row(3, "b", "dropped"), row(5, "c", "failed")];
    expect(groupCooking(rows).map((r) => r.id)).toEqual([9, 3, 5]);
  });

  it("puts the rows no group claims last", () => {
    const rows = [row(1, "a", "ready"), row(2, "b", "waiting")];
    expect(groupCooking(rows).map((r) => r.id)).toEqual([2, 1]);
  });

  it("draws them grouped, so equal whys sit together", () => {
    const whys = texts([
      row(1, "a", "running"),
      row(2, "b", "failed"),
      row(3, "c", "running"),
    ]).map((t) => t.replace(/^.*  /, ""));
    expect(whys).toEqual(["gave up", "a worker has it", "a worker has it"]);
  });
});

describe("cooking rows are marked", () => {
  it("marks a row with its group's mark", () => {
    for (const group of cooking().groups) {
      for (const state of group.states) {
        expect(mark(row(1, "t", state))).toBe(group.mark);
      }
    }
  });

  it("leads every drawn row with the mark", () => {
    const rows = [row(1, "a", "failed"), row(2, "b", "waiting"), row(3, "c", "running")];
    expect(texts(rows).map((t) => t[0])).toEqual(["x", "!", ">"]);
  });

  it("spends the ungrouped mark on a row no group claims", () => {
    expect(mark(row(1, "t", "ready"))).toBe(cooking().ungrouped.mark);
    expect(texts([row(1, "a", "ready")])[0]?.[0]).toBe(" ");
  });

  it("marks the rows but not the tally that counts the ones it hid", () => {
    const rows = [row(1, "a", "failed"), row(2, "b", "failed"), row(3, "c", "failed")];
    expect(texts(rows, 2).at(-1)).toBe("… and 2 more");
  });
});

describe("the columns hold still", () => {
  it("lines the whys up down the list, whatever the rows are wide", () => {
    const drawn = texts([row(1, "a", "failed"), row(2, "a much longer label", "running")]);
    expect(drawn[0]?.indexOf("gave up")).toBe(drawn[1]?.indexOf("a worker has it"));
  });

  it("keeps the why column where it is when the list scrolls", () => {
    const rows = [
      row(1, "a", "failed"),
      row(2, "b", "failed"),
      row(3, "c", "nothing_claims_this_long_state"),
    ];
    // The widest why belongs to the ungrouped row, and that row is below the fold at the top
    // of the list — a column sized to the visible slice would slide when it scrolled into
    // view. Both frames must start the why at the same column.
    expect(texts(rows, 2, 0)[0]?.indexOf("gave up")).toBe(
      texts(rows, 2, 2)[0]?.indexOf("nothing claims this long state"),
    );
  });

  it("never draws wider than the width it is given", () => {
    for (const width of [10, 20, 40]) {
      for (const text of texts([row(1, "a longish label", "waiting")], 1, null, width)) {
        expect(text.length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("the colours are configuration", () => {
  it("holds no colour of its own — every one comes off the file", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/list.tsx", import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    for (const colour of ["red", "yellow", "green", "blue", "cyan", "magenta"]) {
      expect(code).not.toMatch(new RegExp(`["'\`]${colour}["'\`]`));
    }
  });

  it("colours a state the way its group declares", () => {
    for (const group of cooking().groups) {
      for (const state of group.states) {
        expect(stateColour(state)).toBe(group.colour);
      }
    }
    expect(stateColour("ready")).toBe(cooking().ungrouped.colour);
  });

  it("still draws the board's colours, now that they come from the file", () => {
    const rows = [row(1, "ask", "approval"), row(2, "waits", "waiting"), row(3, "s", "delivered")];
    const out = render(
      createElement(List, { rows, height: 3, cursor: null, width: 40 }),
    ).lastFrame() ?? "";
    // Red is the ask, dim is the settled row, and green is nowhere on the board.
    expect(coloured(out, RED)).toEqual([plain(out).split("\n")[0]]);
    expect(coloured(out, YELLOW)).toEqual([plain(out).split("\n")[1]]);
    expect(coloured(out, DIM)).toEqual([plain(out).split("\n")[2]]);
    expect(coloured(out, GREEN)).toEqual([]);
  });

  it("takes a new state into a group without a line of code changing", () => {
    const path = withCooking(
      'cooking:\n' +
        '  groups:\n' +
        '    - name: gave_up\n      why: gave up\n      mark: "x"\n      colour: red\n' +
        '      states: [failed, in_review]\n' +
        '  ungrouped:\n    mark: " "\n    colour: ""\n',
    );
    expect(groupOf("in_review")).toBeUndefined(); // the shipped file claims no such state
    expect(loadCooking(path).groups[0]).toMatchObject({ why: "gave up", colour: "red" });
    expect(loadCooking(path).groups[0]?.states).toContain("in_review");
  });
});

describe("a cooking config that cannot be drawn is refused", () => {
  const bad = (yaml: string): (() => unknown) => {
    const path = withCooking(yaml);
    return () => loadCooking(path);
  };

  it("refuses a file with no cooking at all", () => {
    expect(bad("")).toThrow(CookingError);
  });

  it("refuses a group missing a why", () => {
    expect(
      bad('cooking:\n  groups:\n    - name: a\n      mark: "x"\n      colour: red\n      states: [failed]\n  ungrouped:\n    mark: " "\n    colour: ""\n'),
    ).toThrow(/why must be a string/);
  });

  it("refuses a group with no states", () => {
    expect(
      bad('cooking:\n  groups:\n    - name: a\n      why: w\n      mark: "x"\n      colour: red\n  ungrouped:\n    mark: " "\n    colour: ""\n'),
    ).toThrow(/states must be a list of strings/);
  });

  it("refuses a state that two groups claim, rather than letting file order pick", () => {
    expect(
      bad(
        'cooking:\n  groups:\n' +
          '    - name: a\n      why: w\n      mark: "x"\n      colour: red\n      states: [failed]\n' +
          '    - name: b\n      why: v\n      mark: "!"\n      colour: yellow\n      states: [failed]\n' +
          '  ungrouped:\n    mark: " "\n    colour: ""\n',
      ),
    ).toThrow(/failed is in more than one group/);
  });
});
