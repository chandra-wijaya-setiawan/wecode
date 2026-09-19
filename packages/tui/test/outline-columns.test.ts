/** Sixty rows of a tree are read down the left edge, and what is on that edge is what the
 *  outline is for: the guide, the marker and the label. These tests hold the order — the
 *  tree first, the repeating columns after it — and hold the two words that repeat on every
 *  row to four characters each, from views.yaml rather than from this file or that one. */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { plain } from "./force-color.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import {
  abbreviate,
  loadOutline,
  outlineCells,
  outlineLines,
  OUTLINE,
  OUTLINE_COLUMNS,
  type OutlineConfig,
} from "../src/outline.js";
import { seed } from "./seed.js";
import type { Row } from "../src/list.js";

afterEach(cleanup);

const row = (over: Partial<Row> = {}): Row => ({
  id: 7,
  what: "├─- storefront",
  state: "in_progress",
  detail: "story · 3 under · 2 planned",
  ...over,
});

/** The outline as a reader sees it: the rows inside the box, without the borders. */
const screen = (): string[] => {
  const db: DatabaseSync = open(":memory:");
  seed(db);
  const app = new App(db, loadViews(), loadMachines());
  app.key("v");
  app.key(OUTLINE.key);
  const frame = render(createElement(Cockpit, { app, width: 120, height: 40 })).lastFrame() ?? "";
  return plain(frame)
    .split("\n")
    .filter((l) => l.startsWith("│"))
    .map((l) => l.slice(1, -1).trimEnd())
    .filter((l) => l !== "");
};

describe("what the config declares", () => {
  it("names the columns, in the order they are drawn, with the tree first", () => {
    expect(OUTLINE.columns[0]).toBe("tree");
    expect(OUTLINE.columns).toEqual(["tree", "id", "type", "state"]);
  });

  it("carries the width the type and the state are cut to, and it is four", () => {
    expect(OUTLINE.abbreviate).toBe(4);
  });

  it("carries the short forms by hand, so the words a cut would not tell apart still do", () => {
    expect(OUTLINE.abbreviations["in_progress"]).toBe("work");
    expect(OUTLINE.abbreviations["acceptance_test"]).toBe("atst");
    expect(OUTLINE.abbreviations["task_test"]).toBe("ttst");
  });

  it("names only columns the code draws, so the config cannot ask for a line it cannot compose", () => {
    for (const c of loadOutline().columns) expect(OUTLINE_COLUMNS).toContain(c);
  });
});

describe("abbreviating a word", () => {
  const config: OutlineConfig = { ...OUTLINE, abbreviate: 4, abbreviations: { in_progress: "work" } };

  it("takes the hand-written form where the config gives one", () => {
    expect(abbreviate("in_progress", config)).toBe("work");
  });

  it("otherwise cuts the word to the declared width", () => {
    expect(abbreviate("project", config)).toBe("proj");
    expect(abbreviate("release", config)).toBe("rele");
    expect(abbreviate("ready", config)).toBe("read");
  });

  it("leaves a word already short enough alone", () => {
    expect(abbreviate("epic", config)).toBe("epic");
    expect(abbreviate("met", config)).toBe("met");
  });

  it("spends no more than the declared width on any word there is", () => {
    for (const word of ["project", "acceptance_test", "in_progress", "not_started", "delivered"]) {
      expect(abbreviate(word).length, word).toBeLessThanOrEqual(OUTLINE.abbreviate);
    }
  });

  it("tells the kinds apart from each other at that width", () => {
    const kinds = ["project", "release", "epic", "story", "requirement", "acceptance_test", "task"];
    expect(new Set(kinds.map((k) => abbreviate(k))).size).toBe(kinds.length);
  });
});

describe("the cells of a row", () => {
  it("puts the tree first, and it is the guide and the marker alone", () => {
    expect(outlineCells(row())[0]).toBe("├─-");
  });

  it("follows it with the id, the abbreviated type and the abbreviated state", () => {
    expect(outlineCells(row()).slice(1, 4)).toEqual(["#7", "stor", "work"]);
  });

  it("keeps the label and the rollup last, unabbreviated: read once, not down every row", () => {
    expect(outlineCells(row()).at(-1)).toBe("storefront · 3 under · 2 planned");
  });

  it("leaves the type empty where the row's detail names no kind", () => {
    expect(outlineCells(row({ detail: "" }))[2]).toBe("");
  });

  it("follows the config's order, so moving a column moves the cell", () => {
    const config: OutlineConfig = { ...OUTLINE, columns: ["state", "id", "tree"] };
    expect(outlineCells(row(), config).slice(0, 3)).toEqual(["work", "#7", "├─-"]);
  });
});

describe("the lines it draws", () => {
  const rows: readonly Row[] = [
    row({ id: 1, what: "- storefront", detail: "project · 2 under" }),
    row({ id: 22, what: "├─- 1.0.0", state: "planned", detail: "release" }),
    row({ id: 333, what: "└─  checkout", state: "ready", detail: "task" }),
  ];

  it("starts every line with the tree, so the guide runs down the left edge", () => {
    // A root has no guide to run, and its marker is held right against the id instead —
    // see a-marker-sits-against-its-id — so what leads its line is the padding.
    for (const line of outlineLines(rows, 10, null, 120)) {
      expect(/^[│ ]*(?:[├└]─)? *[-+ ] {2}#/.test(line.text), line.text).toBe(true);
    }
  });

  it("lines the id up down the whole tree, whatever the labels cost", () => {
    const lines = outlineLines(rows, 10, null, 120).map((l) => l.text);
    const at = lines.map((l) => l.indexOf("#"));
    expect(new Set(at).size).toBe(1);
  });

  it("spends four columns on the state, not eleven", () => {
    const line = outlineLines(rows, 10, null, 120)[0]?.text ?? "";
    expect(line).toContain("work");
    expect(line).not.toContain("in_progress");
  });

  it("keeps the state on the line for colour, so a row is still coloured by its state", () => {
    expect(outlineLines(rows, 10, null, 120)[1]?.state).toBe("planned");
  });

  it("marks the cursor's row and no other", () => {
    const marked = outlineLines(rows, 10, 1, 120).filter((l) => l.cursor);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.text).toContain("1.0.0");
  });

  it("reports what the height hid, and scrolls the cursor into what is left", () => {
    expect(outlineLines(rows, 2, null, 120).at(-1)?.text).toBe("… and 2 more");
    expect(outlineLines(rows, 2, 2, 120)[0]?.text).toContain("checkout");
  });

  it("cuts a line too wide for the box rather than wrapping it", () => {
    // The guide survives the cut and the label is what goes: a line too narrow for both is
    // still a line whose place in the tree can be read.
    expect(outlineLines(rows, 10, null, 8)[0]?.text).toBe("  -  #1…");
  });
});

describe("on the real tree", () => {
  it("draws the guide flush left and the abbreviated words after it", () => {
    const drawn = screen();
    const storefront = drawn.find((l) => l.includes("storefront")) ?? "";
    // A root's guide is empty, so what stands on the left edge is the padding its depth
    // did not spend; the marker it ends with sits against the id.
    expect(storefront).toMatch(/^ *[-+ ]\s+#\d+\s+proj\s+work\s+storefront/);
    expect(storefront).not.toContain("project #");
  });

  it("says no state in full on any row, having said them all in four", () => {
    for (const line of screen()) {
      // The rollup still says states in full: it is read on the row you are on, once.
      expect(line.split("·")[0], line).not.toContain("in_progress");
    }
  });
});
