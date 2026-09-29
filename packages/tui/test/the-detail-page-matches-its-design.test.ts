/** A record's own screen is drawn the way config/design.yaml says it is.
 *
 *  test/every-screen-is-declared.test.ts gated the declaration against the two helpers the
 *  block is laid out by. That leaves the half that matters unasserted: a page could lay its
 *  lines out exactly as declared and still put different fields on them, under a different
 *  title, with a different children box. So every claim here is read out of design.yaml and
 *  then asserted against the rendered frame — the title templates filled with the record's
 *  own facts, the field names in the declared order, the declared dash where a record says
 *  nothing, the declared overflow per screen, the children box only on the screen the design
 *  gives one, and the declared overrun line when the page runs out of border.
 *
 *  Nothing here restates a string design.yaml already carries. A test that wrote the title
 *  out again would pass against a page that had stopped reading the file.
 */
import { plain } from "./force-color.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, Maker, open } from "@wecode/core";
import { App } from "../src/app.js";
import { COLUMNS, Cockpit, tally } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { ins, seed, T } from "./seed.js";

interface Detail {
  readonly screens: readonly string[];
  readonly title: Record<string, string>;
  readonly block: {
    readonly empty: string;
    readonly gutter: string;
    readonly overflow: Record<string, string>;
  };
  readonly fields: Record<string, readonly string[]>;
  readonly children: { readonly of: string; readonly title: string; readonly empty: string };
  readonly overrun: string;
}

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as { readonly detail: Detail };
const DETAIL = design.detail;

/** A declared line with its holes filled, the way the drawing fills them. */
const fill = (t: string, vars: Record<string, string | number>): string =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

const frame = (width = 100, height = 40): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The rows of the page's first box, borders off and the room left over trimmed away. */
function block(out: readonly string[]): string[] {
  const rows: string[] = [];
  for (const line of out.slice(1)) {
    if (!line.startsWith("│")) break;
    rows.push(line.slice(1, -1).trimEnd());
  }
  while (rows.at(-1) === "") rows.pop();
  return rows;
}

/** Every border row on screen, which is where a bordered page writes its title. */
const heads = (out: readonly string[]): string[] => out.filter((l) => l.startsWith("┌"));

/** A worker, so an assignment has someone holding it. */
function claude(d: DatabaseSync): number {
  const make = new Maker(d);
  make.role("engineer", { write: ["src/**"], tools: ["bash"] }, "agent");
  return make.worker("claude", "engineer", "agent");
}

/** An assignment an agent is working, which is what puts a row in the running box. */
function running(worker: number, detail = "2000"): number {
  return ins(
    db,
    "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    "send-mail-1",
    "task",
    tree.task,
    worker,
    JSON.stringify({ write: ["src/mail/**"], tools: ["bash"] }),
    JSON.stringify({ tokens: 1000, seconds: 60 }),
    "/wt/send-mail",
    "running",
    Number(detail),
    T,
    T,
  );
}

/** Open the assignment page from the row the board draws for it. */
function openAssignment(): number {
  const id = running(claude(db));
  app = new App(db, views, machines);
  const at = app.lines().findIndex((r) => r.id === id && r.what.includes("reset mail"));
  expect(at, "no assignment row").toBeGreaterThanOrEqual(0);
  app.cursor = at;
  app.key("enter");
  expect(app.screen).toMatchObject({ kind: "assignment", id });
  return id;
}

/** Open the node page for the project, by way of the outline the whole tree hangs off. */
function openProject(): void {
  app.key("v");
  app.key("t");
  const at = app.lines().findIndex((r) => r.what.endsWith("storefront") || r.what === "storefront");
  expect(at, "no project row").toBeGreaterThanOrEqual(0);
  app.cursor = at;
  app.key("enter");
  expect(app.screen).toMatchObject({ kind: "node" });
}

/** The gutter the block declares: as wide as its longest name, plus the entry's two spaces. */
const gutterOf = (screen: string): number =>
  Math.max(...DETAIL.fields[screen].map((n) => n.length)) + 2;

describe("the fields a detail page says", () => {
  it("says exactly the fields design.yaml names for a node, in that order", () => {
    openProject();
    const rows = block(frame());
    const gutter = gutterOf("node");
    expect(rows.map((r) => r.slice(0, gutter).trim())).toEqual([...DETAIL.fields.node]);
  });

  it("says exactly the fields design.yaml names for an assignment, in that order", () => {
    openAssignment();
    const rows = block(frame());
    const gutter = gutterOf("assignment");
    // Only the lines that begin a field: a wrapped value continues in the gutter's spaces.
    const led = rows.filter((r) => r.slice(0, gutter).trim() !== "");
    expect(led.map((r) => r.slice(0, gutter).trim())).toEqual([...DETAIL.fields.assignment]);
  });

  /** A name left-aligned into the gutter, and a value that starts where the gutter ends. */
  const aligned = (rows: readonly string[], gutter: number): void => {
    for (const row of rows) {
      if (row.trim() === "") continue;
      expect(row.slice(0, gutter)).toBe(row.slice(0, gutter).trimEnd().padEnd(gutter));
      expect(row.charAt(gutter)).not.toBe(" ");
    }
  };

  it("aligns the node's values into the one gutter, as wide as its longest name", () => {
    expect(DETAIL.block.gutter).toBe("longest_name");
    openProject();
    aligned(block(frame()), gutterOf("node"));
  });

  it("aligns the assignment's values into the one gutter too", () => {
    openAssignment();
    aligned(block(frame()), gutterOf("assignment"));
  });

  it("draws the declared dash where the record says nothing at all", () => {
    openAssignment();
    db.prepare("UPDATE assignment SET worktree = ''").run();
    app.refresh();
    const gutter = gutterOf("assignment");
    const rows = block(frame());
    const worktree = rows.find((r) => r.slice(0, gutter).trim() === "worktree");
    expect(worktree?.slice(gutter)).toBe(DETAIL.block.empty);
  });
});

describe("the title a detail page carries", () => {
  it("titles the node page with the record's work and state, as the template says", () => {
    openProject();
    const out = frame();
    const row = (app.screen as { row: { what: string; state: string } }).row;
    expect(out[0]).toContain(fill(DETAIL.title.node, { what: row.what, state: row.state }));
  });

  it("titles the assignment page with its id and state, as the template says", () => {
    const id = openAssignment();
    const out = frame();
    const row = (app.screen as { row: { state: string } }).row;
    expect(out[0]).toContain(fill(DETAIL.title.assignment, { id, state: row.state }));
  });
});

describe("what a detail page does with a value too long for the line", () => {
  it("gives each screen the overflow design.yaml declares for it", () => {
    expect(DETAIL.block.overflow.node).toBe("clip");
    expect(DETAIL.block.overflow.assignment).toBe("wrap");
  });

  it("keeps a clipping screen at one line per field however narrow the terminal", () => {
    openProject();
    expect(block(frame(34))).toHaveLength(DETAIL.fields.node.length);
    for (const line of frame(34)) expect(line.length).toBeLessThanOrEqual(34);
  });

  it("gives a wrapping screen more lines than fields, continued under the value", () => {
    openAssignment();
    const gutter = gutterOf("assignment");
    const rows = block(frame(44));
    expect(rows.length).toBeGreaterThan(DETAIL.fields.assignment.length);
    const continued = rows.filter((r) => r.slice(0, gutter).trim() === "");
    expect(continued.length).toBeGreaterThan(0);
    for (const line of continued) {
      expect(line.slice(0, gutter)).toBe(" ".repeat(gutter));
      expect(line.trim()).not.toBe("");
    }
  });
});

describe("the children box the design gives one screen and not the other", () => {
  it("gives the node its children box, titled with the count and the tally", () => {
    expect(DETAIL.children.of).toBe("node");
    openProject();
    const rows = app.lines();
    const under = fill(DETAIL.children.title, { count: rows.length, tally: tally(rows) });
    expect(heads(frame()).some((h) => h.includes(under))).toBe(true);
  });

  it("says what the design says when a record holds nothing under it", () => {
    openProject();
    // Down to the leaf of the seeded chain: every step is a node page, and the last has
    // nothing under it for the children box to list.
    for (const step of [
      "1.0.0",
      "account recovery",
      "password reset",
      "one link, one change",
      "a link is emailed",
      "the mail arrives",
      "send the reset mail",
      "the mailer is called",
    ]) {
      const at = app.lines().findIndex((r) => r.what === step || r.what.endsWith(` ${step}`));
      expect(at, `no row ${step}`).toBeGreaterThanOrEqual(0);
      app.cursor = at;
      app.key("enter");
    }
    expect(app.lines()).toEqual([]);
    expect(frame().join("\n")).toContain(DETAIL.children.empty);
  });

  it("gives the assignment none: it is a leaf, and the design names only the node", () => {
    openAssignment();
    expect(heads(frame())).toHaveLength(1);
    expect(frame().join("\n")).not.toContain(DETAIL.children.empty);
    expect(DETAIL.fields.assignment).not.toContain("children");
  });
});

describe("what a detail page does with more than its border can hold", () => {
  it("drops the overflow and counts it in the declared line rather than drawing past", () => {
    openAssignment();
    const full = block(frame(44));
    const short = block(frame(44, 8));
    expect(short.length).toBeLessThan(full.length);
    expect(short.at(-1)).toBe(fill(DETAIL.overrun, { count: full.length - short.length + 1 }));
  });

  it("never draws a line past the border, whatever it was given", () => {
    openAssignment();
    for (const height of [6, 8, 12, 40]) {
      const out = frame(44, height);
      expect(out).toHaveLength(height);
      for (const line of out) expect(line.length).toBeLessThanOrEqual(44);
      cleanup();
    }
  });
});

describe("the page reads the design rather than agreeing with it", () => {
  /** screens.tsx with its prose taken out, so a word in a docstring is not read as a
   *  string the drawing says. */
  const code = readFileSync(fileURLToPath(new URL("../src/screens.tsx", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("keeps every word the design owns in design.yaml and nowhere in the drawing", () => {
    // A page that happens to agree with the design today is not gated by it: the next edit
    // to design.yaml would leave the drawing where it is and every assertion above green.
    // So the words themselves are asserted absent from the code that draws them.
    for (const word of [
      DETAIL.children.empty,
      DETAIL.block.empty,
      DETAIL.overrun.split("{")[0]!.trim(),
      DETAIL.children.title.split("{")[0]!.trim(),
      DETAIL.title.assignment.split("{")[0]!.trim(),
    ]) {
      expect(code, `${word} is written into screens.tsx`).not.toContain(word);
    }
  });

  it("names no field of its own: which facts a record says is the design's to change", () => {
    // Minus the two the board's own columns are called: `state` and `detail` name a column
    // in views.yaml's vocabulary as well as a field in this one, and COLUMNS is that list.
    const declared = [...DETAIL.fields.node, ...DETAIL.fields.assignment].filter(
      (name) => !(COLUMNS as readonly string[]).includes(name),
    );
    for (const name of new Set(declared)) {
      expect(code, `"${name}" is written into screens.tsx`).not.toContain(`"${name}"`);
    }
  });
});
