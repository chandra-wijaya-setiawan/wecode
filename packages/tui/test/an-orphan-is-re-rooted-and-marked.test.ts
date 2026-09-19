/** Narrowing to open work draws only the open rows. A settled parent goes with the rest of
 *  the settled work, and what was open under it is lifted into its place and marked
 *  `orphaned` — the tree can no longer say where those rows sit, so the word says it. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open, type Node } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import {
  isOrphan,
  openWork,
  ORPHANED,
  OUTLINE,
  outlineRows,
  foldedToDepth,
} from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let id = 0;
const node = (state: string, label: string, children: readonly Node[] = []): Node => ({
  entity: "story",
  id: (id += 1),
  label,
  state,
  children,
  rollup: {} as Node["rollup"],
  folded: false,
});

const labels = (nodes: readonly Node[]): string[] => nodes.map((n) => n.label);

describe("openWork draws only the open rows", () => {
  it("drops a settled row even when open work hangs under it", () => {
    const kept = openWork([node("delivered", "epic", [node("in_progress", "story")])]);
    expect(labels(kept)).toEqual(["story"]);
  });

  it("re-roots what was under it where the settled row sat, in the tree's order", () => {
    const kept = openWork([
      node("in_progress", "release", [
        node("ready", "first"),
        node("delivered", "cut", [node("ready", "lifted"), node("ready", "also")]),
        node("ready", "last"),
      ]),
    ]);
    expect(labels(kept[0]?.children ?? [])).toEqual(["first", "lifted", "also", "last"]);
  });

  it("lifts to the roots when every row above was settled", () => {
    const kept = openWork([node("met", "epic", [node("delivered", "story", [node("ready", "task")])])]);
    expect(labels(kept)).toEqual(["task"]);
  });

  it("keeps the settled rows out from under a row it kept", () => {
    const kept = openWork([
      node("in_progress", "story", [node("met", "done-req"), node("ready", "open-req")]),
    ]);
    expect(labels(kept[0]?.children ?? [])).toEqual(["open-req"]);
  });

  it("drops a settled branch whole when nothing open is under it", () => {
    expect(openWork([node("delivered", "epic", [node("met", "story")])])).toEqual([]);
  });

  it("leaves the forest alone when everything in it is open", () => {
    const forest = [node("in_progress", "epic", [node("ready", "story")])];
    expect(openWork(forest)).toEqual(forest);
  });
});

describe("marking what was re-rooted", () => {
  it("marks the row it lifted", () => {
    const kept = openWork([node("delivered", "epic", [node("in_progress", "story")])]);
    expect(isOrphan(kept[0] as Node)).toBe(true);
  });

  it("leaves a row whose own parent survived unmarked", () => {
    const kept = openWork([node("in_progress", "epic", [node("ready", "story")])]);
    expect(isOrphan(kept[0] as Node)).toBe(false);
    expect(isOrphan(kept[0]?.children[0] as Node)).toBe(false);
  });

  it("marks only the lifted row, not what still hangs under it", () => {
    const kept = openWork([
      node("delivered", "epic", [node("in_progress", "story", [node("ready", "req")])]),
    ]);
    expect(isOrphan(kept[0] as Node)).toBe(true);
    expect(isOrphan(kept[0]?.children[0] as Node)).toBe(false);
  });

  it("keeps a row lifted twice marked once", () => {
    const kept = openWork([node("met", "epic", [node("delivered", "story", [node("ready", "task")])])]);
    expect(isOrphan(kept[0] as Node)).toBe(true);
  });

  it("says so on the row it draws, after the label", () => {
    const forest = openWork([node("delivered", "epic", [node("in_progress", "story")])]);
    const rows = outlineRows(forest, foldedToDepth(forest, 9), null);
    expect(rows[0]?.row.detail.split(" · ")).toEqual(["story", ORPHANED]);
  });

  it("says nothing on a row that kept its parent", () => {
    const forest = openWork([node("in_progress", "epic", [node("ready", "story")])]);
    const rows = outlineRows(forest, foldedToDepth(forest, 9), null);
    for (const r of rows) expect(r.row.detail).not.toContain(ORPHANED);
  });
});

describe("on the screen", () => {
  let db: DatabaseSync;
  let app: App;

  beforeEach(() => {
    db = open(":memory:");
    const tree = seed(db);
    // The epic lands while the story under it is still in progress: the story is open work
    // whose place in the tree has gone.
    db.prepare("UPDATE epic SET state='delivered' WHERE id=?").run(tree.epic);
    app = new App(db, views, machines);
    app.key("v");
    app.key(OUTLINE.key);
  });

  afterEach(cleanup);

  const frame = (): string =>
    plain(render(createElement(Cockpit, { app, width: 120, height: 44 })).lastFrame() ?? "");

  const row = (what: string): string =>
    frame()
      .split("\n")
      .find((l) => l.includes(what)) ?? "";

  it("draws the open story and not the epic that landed over it", () => {
    expect(row("password reset")).not.toBe("");
    expect(frame()).not.toContain("account recovery");
  });

  it("marks the re-rooted story on the screen", () => {
    expect(row("password reset")).toContain(ORPHANED);
  });

  it("leaves a row under a parent it still has unmarked", () => {
    expect(row("storefront")).not.toContain(ORPHANED);
    expect(row("1.0.0")).not.toContain(ORPHANED);
  });

  it("brings the parent back, and the mark goes with it, on f a", () => {
    app.key("f");
    app.key("a");
    expect(frame()).toContain("account recovery");
    expect(frame()).not.toContain(ORPHANED);
  });
});
