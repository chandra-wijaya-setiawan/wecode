/** `t e` and `t f` take the whole outline one level further in and one level further out.
 *
 *  The depth walk itself is outline.tsx's and is tested there. What is proved here is the
 *  binding: that two keystrokes on the cockpit move the tree, and that what moved is the
 *  rows the screen is drawing — not a number kept beside them. So every assertion reads
 *  `app.lines()`, and the frame the Cockpit renders is checked to agree with them.
 *
 *  `+`/`-` open the node under the cursor. These are the other half of that: a tree read a
 *  node at a time is a tree nobody finishes reading. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open, tree, type Node } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { OUTLINE, treeDepth } from "../src/outline.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;
let forest: readonly Node[];

beforeEach(() => {
  db = open(":memory:");
  const seeded = seed(db);
  // A second story under the same epic, so "the whole next level" can be told apart from
  // "the branch under the cursor": one step in has to bring both stories, not the first.
  ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    "lockout",
    seeded.epic,
    "account lockout",
    "in_progress",
    T,
    T,
  );
  app = new App(db, views, machines);
  forest = tree(db);
  openOutline();
});

afterEach(cleanup);

const openOutline = (): void => {
  app.key("v");
  app.key(OUTLINE.key);
};

const frame = (width = 120, height = 44): string =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "");

/** The rows on screen, as drawn — guide, fold marker and label. */
const rows = (): string[] => app.lines().map((r) => r.what);

/** Every label an outline standing open to `depth` draws, in the tree's own order. */
const downTo = (nodes: readonly Node[], depth: number): string[] =>
  depth < 0 ? [] : nodes.flatMap((n) => [n.label, ...downTo(n.children, depth - 1)]);

/** What the rows say the outline is open to: the depth whose labels they are. A depth read
 *  off the screen rather than off the App, because the screen is the claim being tested. */
const shown = (): number => {
  for (let d = 0; d <= treeDepth(forest); d += 1) {
    const want = downTo(forest, d);
    const at = rows();
    if (at.length !== want.length) continue;
    if (want.every((label, i) => at[i]?.endsWith(label) === true)) return d;
  }
  throw new Error(`the rows are no whole depth of the tree:\n${rows().join("\n")}`);
};

const stepIn = (): void => {
  app.key("t");
  app.key("e");
};

const stepOut = (): void => {
  app.key("t");
  app.key("f");
};

describe("t e and t f", () => {
  it("open the outline at the depth its config folds to", () => {
    // The story's four levels: project, release, epic, story. Everything below is folded.
    expect(shown()).toBe(3);
  });

  it("step the whole tree one level in", () => {
    const was = shown();
    stepIn();
    expect(shown()).toBe(was + 1);
  });

  it("step the whole tree one level out", () => {
    const was = shown();
    stepOut();
    expect(shown()).toBe(was - 1);
  });

  it("bring every branch of the next level, not the one under the cursor", () => {
    app.cursor = 0;
    stepOut();
    // Standing on the epic, one step in owes both stories — the cursor is on neither.
    expect(rows().some((r) => r.includes("password reset"))).toBe(false);
    stepIn();
    expect(rows().filter((r) => r.includes("reset") || r.includes("lockout"))).toHaveLength(2);
  });

  it("walk from the roots to the leaves and back, one level per keystroke", () => {
    const bottom = treeDepth(forest);
    while (shown() > 0) stepOut();
    for (let d = 1; d <= bottom; d += 1) {
      stepIn();
      expect(shown()).toBe(d);
    }
    // Open to the bottom, the outline draws every node there is.
    expect(rows()).toHaveLength(downTo(forest, bottom).length);
    for (let d = bottom - 1; d >= 0; d -= 1) {
      stepOut();
      expect(shown()).toBe(d);
    }
  });

  it("wall at the bottom rather than wrapping to the top", () => {
    for (let i = 0; i <= treeDepth(forest); i += 1) stepIn();
    const bottom = rows();
    stepIn();
    expect(rows()).toEqual(bottom);
    expect(app.status).toContain("nothing further in");
  });

  it("wall at the top rather than wrapping to the bottom", () => {
    while (shown() > 0) stepOut();
    const roots = rows();
    expect(roots).toHaveLength(1);
    stepOut();
    expect(rows()).toEqual(roots);
    expect(app.status).toContain("nothing further out");
  });

  it("say how far open the tree stands, out of how far it goes", () => {
    stepIn();
    expect(app.status).toBe(`depth 4/${treeDepth(forest)}`);
  });

  it("prompt for the direction while t is armed, and leave the rows alone", () => {
    const before = rows();
    app.key("t");
    expect(app.status).toContain("e in");
    expect(app.status).toContain("f out");
    expect(rows()).toEqual(before);
  });

  it("refuse a key that is not a direction, without moving the tree", () => {
    const before = rows();
    app.key("t");
    app.key("z");
    expect(app.status).toBe("no depth on z");
    expect(rows()).toEqual(before);
  });

  it("do not arm off the outline, and say where the outline is", () => {
    app.key("esc");
    expect(app.screen.kind).toBe("dashboard");
    app.key("t");
    expect(app.status).toBe(`t e steps the outline in — v ${OUTLINE.key}`);
    // Nothing armed, so the next key is its own key and not a direction.
    app.key("e");
    expect(app.status).toBe("e does nothing here");
  });

  it("show on the rendered frame the rows a step in brought", () => {
    // `f` after `t` is the depth key, not the scope key: the outline opens on open work,
    // and stepping in must not have widened it back to all of it.
    stepOut();
    expect(frame()).not.toContain("one link, one change");
    stepIn();
    stepIn();
    expect(frame()).toContain("one link, one change");
    expect(frame()).toContain("account lockout");
  });
});
