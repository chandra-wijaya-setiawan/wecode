/** `t e` and `t f` on the outline: one keystroke pair that moves the depth of the *whole*
 *  tree, and a status line that says which level it now stands at. The depth walk itself is
 *  held by outline-depth.test.ts; this holds the keys onto it — that they move every branch
 *  rather than the row under the cursor, that both ends are walls, and that the screen says
 *  where you are, because after a whole-tree step nothing on screen tells you. */
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { loadMachines, open, tree } from "@wecode/core";
import { App } from "../src/app.js";
import { loadViews } from "../src/views.js";
import { openWork, OUTLINE, treeDepth } from "../src/outline.js";
import { seed } from "./seed.js";

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;
let bottom: number;

beforeEach(() => {
  db = open(":memory:");
  seed(db);
  app = new App(db, views, machines);
  bottom = treeDepth(tree(db));
  expect(bottom).toBeGreaterThan(1);
});

const openOutline = (): void => {
  app.key("v");
  app.key(OUTLINE.key);
};

const step = (dir: "e" | "f"): void => {
  app.key(OUTLINE.key);
  app.key(dir);
};

const rows = (): number => app.lines().length;

/** The level the status line claims, read back off it. */
const said = (): number => {
  const at = /level (\d+) of (\d+)/.exec(app.status);
  expect(at, `no level in ${app.status}`).not.toBeNull();
  expect(Number(at?.[2])).toBe(bottom);
  return Number(at?.[1]);
};

/** Walk all the way out, so a test starts from a known level rather than the config's. */
const toRoots = (): void => {
  for (let i = 0; i <= bottom; i += 1) step("f");
  expect(said()).toBe(0);
};

describe("the depth keys are the outline's own letter", () => {
  it("arms on the outline, offering both directions and the level it stands at", () => {
    openOutline();
    app.key(OUTLINE.key);
    expect(app.status).toContain("e in");
    expect(app.status).toContain("f out");
    // The outline opens folded to the config's entity, so the prompt reports that level.
    expect(said()).toBeGreaterThanOrEqual(0);
  });

  it("says where to find the outline when pressed anywhere else", () => {
    app.key(OUTLINE.key);
    expect(app.status).toBe(`${OUTLINE.key} moves the outline's depth — v ${OUTLINE.key}`);
    expect(app.screen.kind).toBe("dashboard");
  });

  it("refuses a letter that names neither direction, and moves nothing", () => {
    openOutline();
    const before = rows();
    app.key(OUTLINE.key);
    app.key("z");
    expect(app.status).toBe("no depth on z");
    expect(rows()).toBe(before);
  });
});

describe("a step moves the whole tree", () => {
  beforeEach(openOutline);

  it("opens every branch of the next level, not the one under the cursor", () => {
    toRoots();
    const roots = rows();
    step("e");
    // Every root has its children under it now, so the row count is the whole level, and
    // the cursor — still on the first root — had nothing to do with it.
    expect(app.cursor).toBe(0);
    expect(rows()).toBeGreaterThan(roots);
    expect(said()).toBe(1);
  });

  it("walks from the roots to the bottom one level per keystroke", () => {
    toRoots();
    for (let d = 1; d <= bottom; d += 1) {
      step("e");
      expect(said()).toBe(d);
    }
  });

  it("steps back out one level per keystroke", () => {
    toRoots();
    for (let i = 0; i < bottom; i += 1) step("e");
    for (let d = bottom; d >= 1; d -= 1) {
      expect(said()).toBe(d);
      const wide = rows();
      step("f");
      expect(said()).toBe(d - 1);
      expect(rows()).toBeLessThan(wide);
    }
  });
});

describe("the two ends are walls", () => {
  beforeEach(openOutline);

  it("stepping in at the bottom draws the same rows and says so", () => {
    toRoots();
    for (let i = 0; i < bottom; i += 1) step("e");
    expect(said()).toBe(bottom);
    const all = app.lines().map((r) => r.what);
    step("e");
    expect(said()).toBe(bottom);
    expect(app.status).toContain("no further");
    expect(app.lines().map((r) => r.what)).toEqual(all);
  });

  it("stepping out at the roots does not wrap back to the bottom", () => {
    toRoots();
    const roots = rows();
    step("f");
    expect(said()).toBe(0);
    expect(app.status).toContain("no further");
    expect(rows()).toBe(roots);
  });
});

describe("the level it stands at", () => {
  beforeEach(openOutline);

  it("counts against the depth of the tree, so the reader knows how far is left", () => {
    toRoots();
    expect(app.status).toBe(`${OUTLINE.title} — level 0 of ${bottom} · no further`);
    step("e");
    expect(app.status).toBe(`${OUTLINE.title} — level 1 of ${bottom}`);
  });

  it("reads back a hand-folded outline rather than a number kept beside it", () => {
    toRoots();
    app.cursor = 0;
    // `+` opens one node. The depth prompt reports the deepest row on show, so the next
    // step in takes the rest of the tree to that same level rather than jumping past it.
    app.key("+");
    app.key(OUTLINE.key);
    expect(said()).toBe(1);
  });

  it("counts within the narrowed scope when the outline is narrowed", () => {
    app.key("f");
    app.key("o");
    const narrowed = treeDepth(openWork(tree(db)));
    app.key(OUTLINE.key);
    const at = /level \d+ of (\d+)/.exec(app.status);
    expect(Number(at?.[1])).toBe(narrowed);
  });
});
