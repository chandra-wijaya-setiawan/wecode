/** The board is four panels. Eight boxes of machine-side detail is eight places to look
 *  for the one row that has stopped moving, which is why `cooking` in core/board.ts folds
 *  the machine's own panels into one list — see the MACHINE_SIDE comment there.
 *
 *  Asserted against the rendered lines rather than against `loadViews()` or `board()`: a
 *  test over the functions that feed the screen passes on a screen that draws nothing. The
 *  panel a person can see is the border with the title in it, so that is what is counted.
 *
 *  Which four they are is views.yaml's to say and is not written out here — the board is
 *  configuration, and a test that hardcodes the titles makes renaming a panel an edit to a
 *  `.ts` file. What is pinned is the number, that the file and the frame agree exactly (so
 *  a fifth panel cannot hide below the fold of a short terminal), that the fold is one of
 *  the four, and that folding lost no row. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
// Off the module rather than off the package: `cooking` and the list of what it folds are
// board.ts's own, and the three have to be read from one place or they answer from two.
import { MACHINE_SIDE, board, cooking } from "../../core/src/board.js";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { ins, seed, T } from "./seed.js";

const PANELS = 4;

const views = loadViews();
const services = loadServices();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;
let tree: ReturnType<typeof seed>;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

/** Tall enough that nothing the dashboard draws is clipped: a panel missing because the
 *  terminal ran out of rows is a different fault from a panel that was never declared. */
const lines = (width = 100, height = 90): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** Every panel the frame draws, titled, top to bottom. A panel is a top border with its
 *  title sat in it — `┌─ Cooking (1) [c] ───┐` — and the count and the letter come off,
 *  because what is counted here is the panels, not what is in them. */
const drawn = (out: readonly string[]): string[] =>
  out
    .filter((l) => l.startsWith("┌"))
    .map((l) => /─ (.*?) ─/.exec(l)?.[1] ?? "")
    .map((t) =>
      t
        .replace(/ \(\d+\)/, "")
        .replace(/ \[.\]$/, "")
        .trim(),
    );

/** The services box sits on the dashboard and is not a panel of the board: it is no filter,
 *  `v` does not open it, and it holds no row the cursor can reach. */
const panels = (out: readonly string[]): string[] =>
  drawn(out).filter((t) => t !== services.title);

describe("the board draws four panels", () => {
  it("draws four panels and no more", () => {
    const titles = panels(lines());
    expect(titles.length, `the board drew ${titles.join(", ")}`).toBe(PANELS);
  });

  /** Both directions at once. Equality against views.yaml's own order catches the panel
   *  declared and never drawn, and the panel drawn from somewhere other than the file. */
  it("draws exactly the panels views.yaml declares, in its order", () => {
    expect(views.length, `views.yaml declares ${views.map((v) => v.name).join(", ")}`).toBe(PANELS);
    expect(panels(lines())).toEqual(views.map((v) => v.title));
  });

  it("draws each of them as a closed box, titled, with its count and its key", () => {
    const out = lines();
    for (const view of views) {
      const at = out.findIndex((l) => l.startsWith(`┌─ ${view.title} (`));
      expect(at, `no panel titled ${view.title}`).toBeGreaterThanOrEqual(0);
      expect(out[at]).toMatch(new RegExp(`^┌─ ${view.title} \\(\\d+\\) \\[.\\] ─+┐$`));
      // A title over lines that never close is not a panel. Four sides, or it is not a box.
      let bottom = at + 1;
      while (out[bottom]?.startsWith("│")) bottom += 1;
      expect(out[bottom]?.startsWith("└"), `${view.title} has no bottom border`).toBe(true);
      for (const line of out.slice(at + 1, bottom)) expect(line.endsWith("│")).toBe(true);
    }
  });

  /** Four panels only pay for themselves if the rows the folded ones held are still on the
   *  screen, so the fold has to be one of the four and it has to be carrying them. The
   *  seed's queued task is a machine-side row: it belongs to the fold, not to a person. */
  it("gives one of the four to the fold, and draws the folded rows in it", () => {
    const out = lines();
    const fold = views.find((v) => v.filter === "cooking");
    expect(
      fold,
      `no panel filters on cooking: ${views.map((v) => v.filter).join(", ")}`,
    ).toBeDefined();

    const at = out.findIndex((l) => l.startsWith(`┌─ ${fold?.title} (`));
    const end = out.findIndex((l, i) => i > at && l.startsWith("└"));
    expect(out.slice(at + 1, end).join("\n")).toContain("send the reset mail");
  });

  /** Which four they are is views.yaml's, but *that running is one of them* is not a
   *  rename — it is the fold's shape, and it is the same decision MACHINE_SIDE records.
   *  Asserted on the filters rather than the titles: a filter is a name the code knows. */
  it("spends one of the four on running, and none of them on projects", () => {
    const filters = views.map((v) => v.filter);
    expect(filters, `the page is ${filters.join(", ")}`).toContain("running");
    expect(filters).not.toContain("projects");
  });

  /** And it draws rows, not just a border: the worker holding a row is what the box is
   *  read for, and a running row that only the fold had was sorted by how long it had sat
   *  — the far end of the list from where anyone looked for it. */
  it("draws the running assignment in the running panel, with the worker that holds it", () => {
    const worker = ins(db, "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)", "claude-1", "claude-1", "engineer", "agent", T, T);
    ins(
      db,
      `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      "a1", "task", tree.task, worker, "{}", "{}", "/tmp/wt", "running", "{}", T, T,
    );
    app.refresh();

    const title = views.find((v) => v.filter === "running")?.title;
    const out = lines();
    const at = out.findIndex((l) => l.startsWith(`┌─ ${title} (1)`));
    expect(at, `no running panel with a row in it`).toBeGreaterThanOrEqual(0);
    const end = out.findIndex((l, i) => i > at && l.startsWith("└"));
    const box = out.slice(at + 1, end).join("\n");
    expect(box).toContain("send the reset mail");
    expect(box).toContain("claude-1");

    // And it is that panel's row, not the fold's: the fold is what nobody is holding.
    expect(board(db).cooking.some((r) => r.state === "running")).toBe(false);
  });

  it("loses no row to the fold: each is drawn once, on one panel", () => {
    const body = lines().filter((l) => l.startsWith("│"));
    const holding = body.filter((l) => l.includes("send the reset mail"));
    expect(holding.length, `drawn on ${holding.length} panels`).toBe(1);
  });

  /** The cut is only a cut if what left the page went into the fold. Every machine-side
   *  panel is off the board now, and `board().cooking` is exactly their rows — so nothing
   *  was dropped on the way, and no panel is both folded and drawn. */
  it("folds every machine-side panel, and draws none of them beside the fold", () => {
    const b = board(db);
    expect(b.cooking.length).toBe(MACHINE_SIDE.reduce((n, p) => n + b[p].length, 0));
    expect(b.cooking).toEqual(cooking(db));
    for (const filter of views.map((v) => v.filter)) {
      expect(MACHINE_SIDE as readonly string[], `${filter} is drawn and folded`).not.toContain(
        filter,
      );
    }
  });

  /** A panel is only a panel if the cursor can go through it. The fold holds five panels'
   *  rows and so holds three kinds of entity at once, which is the whole of what app.ts
   *  has to answer: the seed's queued row is a task, and `enter` on it has to descend to
   *  that task and not to a story of the same id. */
  it("opens a folded row as the entity the panel it came from names", () => {
    const at = app.lines().findIndex((r) => r.what === "send the reset mail");
    expect(at, `the fold drew ${app.lines().map((r) => r.what).join(", ")}`).toBeGreaterThanOrEqual(0);

    app.cursor = at;
    app.key("enter");

    expect(app.status).toBe(`task #${tree.task}`);
    expect(app.screen).toEqual({ kind: "node", entity: "task", id: tree.task });
  });

  /** Nothing the fold carries is unopenable. A row that reaches app.ts with no entity, or
   *  with one no node answers to, is a dead row on the one box that now holds most of the
   *  board — and it says so rather than doing nothing. */
  it("leaves no folded row that says nothing to open", () => {
    for (const row of board(db).cooking) {
      const at = app.lines().findIndex((r) => r.id === row.id && r.what === row.what);
      if (at < 0) continue;
      app.cursor = at;
      app.key("enter");
      expect(app.status, `${row.what} is a dead row`).not.toBe("nothing to open");
      if (app.screen.kind === "node") app.key("esc");
    }
  });
});
