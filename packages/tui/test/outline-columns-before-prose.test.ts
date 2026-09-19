/** The label is out of the tree cell. A cell holding the guide, the marker and the label is
 *  a cell as wide as the longest name anywhere in the tree, and every repeating column after
 *  it is then read at whatever column that name happens to end at. Split out, the tree cell
 *  costs the depth and nothing else, the id follows it at one column down the whole tree,
 *  and the label leads the prose at the end of the line — the one part whose width is
 *  nobody's business but its own. */
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { plain } from "./force-color.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { OUTLINE, outlineCells, outlineLines, splitTree } from "../src/outline.js";
import { seed } from "./seed.js";
import type { Row } from "../src/list.js";

afterEach(cleanup);

const row = (over: Partial<Row> = {}): Row => ({
  id: 7,
  what: "├─- storefront",
  state: "in_progress",
  detail: "story · 3 under",
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

describe("splitting a drawn row", () => {
  it("cuts it at the fold marker: guide and marker one side, label the other", () => {
    expect(splitTree("├─- storefront")).toEqual(["├─-", "storefront"]);
    expect(splitTree("│   └─+ password reset")).toEqual(["│   └─+", "password reset"]);
  });

  it("keeps a root's marker, which is all the guide a root has", () => {
    expect(splitTree("- storefront")).toEqual(["-", "storefront"]);
    expect(splitTree("  storefront")).toEqual([" ", "storefront"]);
  });

  it("leaves a string that is no drawn row alone rather than eating its first word", () => {
    expect(splitTree("storefront")).toEqual(["", "storefront"]);
  });
});

describe("the tree cell", () => {
  it("holds no label, whatever the label is", () => {
    for (const label of ["a", "an unusually long name for a story"]) {
      expect(outlineCells(row({ what: `├─- ${label}` }))[0]).toBe("├─-");
    }
  });

  it("grows with the depth and with nothing else", () => {
    const at = (what: string): number => (outlineCells(row({ what }))[0] ?? "").length;
    expect(at("- storefront")).toBe(1);
    expect(at("└─- 1.0.0")).toBe(3);
    expect(at("  └─- account recovery")).toBe(5);
  });
});

describe("the prose the columns leave", () => {
  it("is led by the label", () => {
    expect(outlineCells(row()).at(-1)).toBe("storefront · 3 under");
  });

  it("is the label alone where the row has no rollup to add", () => {
    expect(outlineCells(row({ detail: "story" })).at(-1)).toBe("storefront");
  });
});

describe("down the drawn tree", () => {
  const rows: readonly Row[] = [
    row({ id: 1, what: "- storefront", detail: "project · 2 under" }),
    row({ id: 22, what: "├─- an unusually long name for a release", detail: "release" }),
    row({ id: 333, what: "└─  checkout", detail: "task" }),
  ];

  it("starts the label at one column, so the long name costs its own line only", () => {
    const at = outlineLines(rows, 10, null, 200).map((l) => l.text.indexOf("#"));
    expect(new Set(at).size).toBe(1);
    expect(at[0]).toBeLessThan("an unusually long name for a release".length);
  });

  it("puts the id, type and state between the guide and the label on the real tree", () => {
    for (const line of screen()) {
      expect(line, line).toMatch(/^[│ ]*(?:[├└]─)? *[-+ ] {2}#\d+\s+\w{3,4}\s+\w{3,4}\s+\S/);
    }
  });
});
