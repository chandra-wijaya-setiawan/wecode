/** No section of the dashboard is drawn inside a box.
 *
 *  Eight sections, each with a border, spent sixteen of the terminal's lines saying where
 *  one section stopped and the next began — more height than the Cooking box is allowed to
 *  draw — and two columns of every row's width on top of that. A rule with the section's
 *  name in it says the same thing in one line and no columns.
 *
 *  So this file holds two claims and they are separate: the dashboard draws no box-drawing
 *  corner or side anywhere, and what replaces them is still a named, countable, keyed
 *  section a reader can find. A page that simply stopped drawing borders would pass the
 *  first and fail the second.
 *
 *  It is asserted against the rendered frame, because every other way of asking — the
 *  components, views.yaml, App.lines() — answers about a screen nobody is looking at. */
import { plain } from "./force-color.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { loadViews } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { seed, T, ins } from "./seed.js";

const views = loadViews();
const services = loadServices();
const machines = loadMachines();

/** Every corner and side a box is made of. The rule keeps `─`, which is why it is not in
 *  this list: what a box costs is the two lines and the two columns, and those are these. */
const BOX = ["┌", "┐", "└", "┘", "│", "├", "┤"] as const;

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  tree = seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

/** Tall enough that nothing is clipped: a section missing because the terminal ran out of
 *  rows is a different fault from a section that was never drawn. */
const lines = (width = 100, height = 90): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The eight names the dashboard heads a section with: the services block, then the seven
 *  boxes views.yaml orders. */
const HEADS: readonly string[] = [services.title, ...views.map((v) => v.title)];

/** Where the section titled `title` is headed, or -1. A head is a rule with the name in
 *  it and nothing before the name but the rule. */
const headed = (out: readonly string[], title: string): number =>
  out.findIndex((l) => new RegExp(`^──+ ${title}[ (]`).test(l));

/** The lines under a section's head, up to the next head or the end of the body. */
function under(out: readonly string[], title: string): string[] {
  const at = headed(out, title);
  expect(at, `nothing heads ${title}`).toBeGreaterThanOrEqual(0);
  const rest = out.slice(at + 1);
  const next = rest.findIndex((l) => l.startsWith("──"));
  return (next < 0 ? rest : rest.slice(0, next)).map((l) => l.trimEnd());
}

describe("no section of the dashboard is boxed", () => {
  it("draws no corner and no side, anywhere on the page", () => {
    const out = lines();
    for (const glyph of BOX) {
      const drawn = out.filter((l) => l.includes(glyph));
      expect(drawn, `the dashboard drew ${glyph} on ${drawn.length} lines`).toEqual([]);
    }
  });

  /** The height the borders were costing, counted rather than described. Eight sections at
   *  two lines each was the sixteen; it is eight now. And no line of chrome is blank, which
   *  is what a border's bottom edge would have become had the rule simply been dropped. */
  it("spends one line of chrome on a section, where a box spent two", () => {
    const out = lines();
    const chrome = out.filter((l) => l.startsWith("──"));
    expect(chrome).toHaveLength(HEADS.length);
    expect(HEADS.length * 2 - chrome.length).toBe(8);
    for (const line of chrome) expect(line.trim()).not.toBe("");
  });

  it("starts every row at the left edge, with no column given to a border", () => {
    const out = lines();
    // The queue holds the seed's one ready task, so this is a real row and not a blank.
    const row = under(out, "Queue")[0] ?? "";
    expect(row).toContain("send the reset mail");
    expect(row.startsWith(" ")).toBe(false);
    // And the rule reaches the full width, so the section is as wide as the terminal.
    expect((out[headed(out, "Queue")] ?? "").length).toBe(100);
  });
});

describe("a section is still a section", () => {
  it("heads each of the eight, in the page's order, and heads nothing else", () => {
    const out = lines();
    const at = HEADS.map((t) => headed(out, t));
    expect(at.every((i) => i >= 0), `missing: ${HEADS.filter((t, i) => at[i] === -1).join(", ")}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(out.filter((l) => l.startsWith("──"))).toHaveLength(HEADS.length);
  });

  it("carries each box's count and the letter that opens it in its head", () => {
    const out = lines().join("\n");
    for (const view of views) {
      const count = view.name === "queued" ? 1 : 0;
      expect(out).toContain(`── ${view.title} (${count}) [${view.key ?? ""}] ─`);
    }
  });

  it("keeps each section's rows under its own head and out of the next", () => {
    expect(under(lines(), "Queue")[0]).toContain("send the reset mail");
    expect(under(lines(), "Cooking").join("\n")).not.toContain("send the reset mail");
  });

  it("says what an empty section is empty of, in that section's own words", () => {
    expect(under(lines(), "Needs you")).toEqual(["nothing waits on you"]);
  });

  /** A section that ran out of room says so on its last line, the way the box did. The
   *  height a section declares is its rows' now — the border is not taking two of them. */
  it("trims a section to the rows views.yaml declares for it", () => {
    for (let i = 0; i < 12; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    const declared = views.find((v) => v.name === "planned")?.rows ?? 0;
    const rows = under(lines(), "Planned");
    expect(rows).toHaveLength(declared);
    expect(rows.at(-1)).toContain(`… and ${12 - (declared - 1)} more`);
  });

  /** The cursor is the one thing a border was never doing, and the proof it still works is
   *  that the row it is on is the row it was on. */
  it("keeps the cursor on the row it is on", () => {
    app.cursor = app.lines().findIndex((r) => r.what === "send the reset mail");
    expect(under(lines(), "Queue")[0]).toContain("send the reset mail");
    app.key("enter");
    expect(app.screen).toMatchObject({ kind: "node" });
  });
});

/** The decision is the dashboard's. A screen given the whole terminal for one thing spends
 *  two lines once, not sixteen, and the border is what tells that page from the bar under
 *  it — so the box pages keep theirs, and this is where that is written down. */
describe("a page that is one thing keeps its border", () => {
  it("draws the box page bordered", () => {
    app.key("v");
    app.key("q");
    expect(app.screen).toMatchObject({ kind: "box" });
    const out = lines(100, 12);
    expect(out[0]?.startsWith("┌")).toBe(true);
    expect(out.some((l) => l.startsWith("└"))).toBe(true);
  });
});
