/** Red means it wants you, and means nothing else.
 *
 *  The board had it spent twice over in the wrong places. `gave_up` — failed and dropped —
 *  was red, and that is the machine's own bucket: a task out of attempts is retried,
 *  re-queued or dropped by the runner without anybody being told, so an alarm there is an
 *  alarm nobody can answer. `settled` was green, which made twenty finished rows the
 *  brightest thing on a screen whose whole job is to show you the one row that is not
 *  finished. Meanwhile the one row that genuinely cannot move without a person — an
 *  assignment parked on a question — was drawn in the plain foreground, because the state
 *  a Needs you row carries is the *kind* of question it asks and no group claimed those
 *  words.
 *
 *  So: red on the ask kinds and nowhere else, cooking's own states plain with their mark
 *  carrying the meaning, settled dim. Asserted against a rendered dashboard holding one
 *  row of each of the three at once, because which line on the screen is red is the whole
 *  of what this story decides; and asserted against views.yaml too, because the colours are
 *  configuration and a screen that hard-coded the right answer would pass the first half.
 *
 *  "The board" is the seven box sections and not the whole dashboard. Nothing is boxed any
 *  more — a row used to be found by the `│` it sat between, and there is none — so a row is
 *  found by the section head above it instead, the glyph-and-capitals head
 *  config/design.yaml's `proposal.head` writes. That draws the line in the right place as
 *  well as being the only one left: the lead section holds each project's pulse, and a
 *  pulse is red when the project has stopped moving, which is a-project-has-a-pulse's
 *  decision and not this file's. A pulse is a project, not a row anybody can open.
 */
import { GREEN, RED, coloured, plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { ASK_KINDS, loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { cooking, cookingLines, forgetCooking, mark, sectionMark, stateColour } from "../src/list.js";
import { loadViews } from "../src/views.js";
import { ins, seed, T } from "./seed.js";

/** chalk's `gray` is the bright-black foreground, and it closes with the same reset any
 *  other colour does — so `coloured` reads it like the rest. Dim is a colour here rather
 *  than ink's `dimColor` because a group declares one string and that string is a colour. */
const DIM = 90;

const views = loadViews();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;

/** Minutes ago, as the record writes a timestamp. */
const ago = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

/** The three rows this story is about, by the text each is drawn under. Filled in by the
 *  seed, because the Needs you row is known by the id of the assignment's objective. */
let wants: string;
const GAVE_UP = "ran out of attempts";
const SETTLED = "shipped last week";

beforeEach(() => {
  forgetCooking();
  db = open(":memory:");
  const tree = seed(db);
  const parent = (
    db.prepare("SELECT acceptance_test_id AS at FROM task WHERE id = ?").get(tree.task) as { at: number }
  ).at;

  // One row that gave up: the fold's own, and the one that used to shout.
  ins(
    db,
    "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    "gave-up", parent, GAVE_UP, "{}", "engineer", "{}", "failed", T, T,
  );

  // One row that is settled and waiting on a landing.
  ins(
    db,
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    "shipped", tree.epic, SETTLED, "delivered", T, ago(30),
  );

  // One row that wants a person. Fresh on purpose: a waiting assignment older than the
  // staleness threshold is also a stuck row, and this case is about the colour of the one
  // that is only waiting.
  const person = ins(
    db,
    "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    "ada", "ada", "lead", "human", T, T,
  );
  ins(
    db,
    `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,spent,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "ask-ada", "task", tree.task, person, "{}", "{}", "/tmp/wt", "waiting", "approval", "land it?", "{}", T, ago(1),
  );
  wants = `task #${tree.task}`;
  // The kind of question the assignment asks is the word the Needs you box puts in its
  // state column, and so the word the colour is a fact about.
  STATE[wants] = "approval";

  app = new App(db, views, machines);
});

afterEach(() => {
  cleanup();
  forgetCooking();
});

/** The dashboard, drawn tall enough that none of the three rows falls below a fold. */
const frame = (): string =>
  render(createElement(Cockpit, { app, width: 100, height: 90 })).lastFrame() ?? "";

/** How the design opens a section's head: its glyph in column zero, its name in capitals. */
const opening = (name: string, title: string): string => `${sectionMark(name)} ${title.toUpperCase()}`;

const OPENINGS = views.map((v) => opening(v.name, v.title));

const isHead = (line: string): boolean => OPENINGS.some((o) => line.startsWith(o));

/** Every row the seven boxes draw, from the first box head to the end of the page. The
 *  lines above it are the lead section's — four services and a pulse per project — and
 *  none of them is a row of the board. */
function boardRows(out: string): string[] {
  const all = plain(out).split("\n");
  const first = all.findIndex(isHead);
  expect(first, "no box is headed").toBeGreaterThanOrEqual(0);
  return all.slice(first).filter((l) => !isHead(l) && l.trim() !== "");
}

/** The one drawn row holding `what`, without its padding. */
function lineFor(out: string, what: string): string {
  const found = boardRows(out).filter((l) => l.includes(what));
  expect(found.length, `${what} is drawn on ${found.length} lines`).toBe(1);
  return (found[0] ?? "").trim();
}

/** Whether the row holding `what` carries `code` — which, since only the state word is
 *  coloured (see test/only-the-state-word-is-coloured.test.ts), means the state word on
 *  that row stands in a run the terminal painted in `code`. The three rows here are in
 *  three different states on purpose, so a run naming one names no other. */
function painted(out: string, code: number, what: string): boolean {
  const state = STATE[what] as string;
  expect(lineFor(out, what), `${what} does not say ${state}`).toContain(state);
  return coloured(out, code).includes(state);
}

/** The state word each of the three rows is drawn under. */
const STATE: Record<string, string> = {
  [GAVE_UP]: "failed",
  [SETTLED]: "delivered",
};

describe("red is spent on the row that wants a person", () => {
  it("paints the needs you row red", () => {
    const out = frame();
    expect(lineFor(out, wants)).toContain("approval");
    expect(painted(out, RED, wants), `${wants} is not red`).toBe(true);
  });

  /** Every red run the terminal painted, against the rows of the seven boxes. A run that
   *  lands on no row of the board is the pulse's alarm and is not this file's to judge. */
  it("paints nothing else on the board red", () => {
    const out = frame();
    const rows = boardRows(out);
    for (const run of coloured(out, RED)) {
      for (const line of rows.filter((l) => l.includes(run.trim()))) {
        expect(line, `${run.trim()} is red`).toContain(wants);
      }
    }
    // And the row that does want a person is one of them, so the loop above judged something.
    expect(rows.filter((l) => l.includes(wants))).toHaveLength(1);
  });
});

describe("the machine's own buckets do not shout", () => {
  /** The decision itself: the fold holds what stopped moving, and the runner is what moves
   *  it next, so the row is drawn plain and its `x` is what says it gave up. */
  it("draws a failed row in neither red nor green", () => {
    const out = frame();
    expect(lineFor(out, GAVE_UP)).toContain("failed");
    expect(painted(out, RED, GAVE_UP), `${GAVE_UP} is red`).toBe(false);
    expect(painted(out, GREEN, GAVE_UP), `${GAVE_UP} is green`).toBe(false);
  });

  /** The colour left; the mark stayed. Read off the cooking box's own lines rather than
   *  off the dashboard, which draws every box through the plain list — the mark is what the
   *  fold spends its first column on, and it is the whole of what says a row gave up now. */
  it("keeps the mark that carried the meaning all along", () => {
    const row = { id: 1, what: GAVE_UP, state: "failed", detail: "" };
    expect(mark(row)).toBe("x");
    expect(cookingLines([row], 1, null, 60)[0]?.text.startsWith("x"), "the fold drew no mark").toBe(true);
  });

  it("draws a delivered row dim, in neither red nor green", () => {
    const out = frame();
    expect(lineFor(out, SETTLED)).toContain("delivered");
    expect(painted(out, RED, SETTLED), `${SETTLED} is red`).toBe(false);
    expect(painted(out, GREEN, SETTLED), `${SETTLED} is green`).toBe(false);
    expect(painted(out, DIM, SETTLED), `${SETTLED} is not dim`).toBe(true);
  });

  it("paints nothing on the board green", () => {
    const out = frame();
    const rows = boardRows(out);
    for (const run of coloured(out, GREEN)) {
      expect(rows.filter((l) => l.includes(run.trim())), `${run.trim()} is green`).toEqual([]);
    }
  });
});

describe("which colour means what is configuration", () => {
  it("gives red to every kind of ask a row can carry, and to no other state", () => {
    for (const kind of ASK_KINDS) expect(stateColour(kind), kind).toBe("red");
    const red = cooking().groups.filter((g) => g.colour === "red");
    expect(red.map((g) => g.name)).toHaveLength(1);
    expect([...(red[0]?.states ?? [])].sort()).toEqual([...ASK_KINDS].sort());
  });

  it("declares the settled states dim and the ones that gave up plain", () => {
    expect(cooking().groups.find((g) => g.name === "settled")?.colour).toBe("gray");
    expect(cooking().groups.find((g) => g.name === "gave_up")?.colour).toBe("");
    expect(stateColour("delivered")).toBe("gray");
    expect(stateColour("failed")).toBe("");
  });

  /** A group with no colour is a group drawn in the foreground the terminal already had —
   *  not a group with a colour this file forgot to name. */
  it("leaves green in no group at all", () => {
    for (const group of cooking().groups) expect(group.colour, group.name).not.toBe("green");
    expect(readFileSync(fileURLToPath(new URL("../config/views.yaml", import.meta.url)), "utf8"))
      .not.toMatch(/colour: green/);
  });
});
