/** A heading is a mark and a name in capitals, and a row is a glyph and a row.
 *
 *  Eight rules down a page all opened `── ` and then a word in the same case as the words
 *  under them. A reader looking for where a section starts had to read the words to find
 *  out, which is the one thing chrome exists to save them. So a head carries two things
 *  before its name: the glyph that section is marked with, and the name in capitals — one
 *  answered without reading, one answered without parsing.
 *
 *  The rows take the same trade. Every row now leads with the glyph of the group its state
 *  is in, the same vocabulary views.yaml already gave the Cooking box, so `+` means settled
 *  whether it is read on a head or on a row. That is the claim worth testing: not that some
 *  characters appear, but that the mark on a section and the glyph on its rows come from
 *  one place, and that place is the config file and not a .tsx.
 *
 *  Asserted against the rendered frame, because every other way of asking answers about a
 *  screen nobody is looking at. */
import { plain } from "./force-color.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { cleanup, render } from "ink-testing-library";
import { loadMachines, open } from "@wecode/core";
import { App } from "../src/app.js";
import { Cockpit } from "../src/screens.js";
import { cooking, sectionMark, mark, type Row } from "../src/list.js";
import { loadViews } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { seed, T, ins } from "./seed.js";

const CONFIG = fileURLToPath(new URL("../config/views.yaml", import.meta.url));
const views = loadViews();
const services = loadServices();
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

/** Tall enough that nothing is clipped: a section missing because the terminal ran out of
 *  rows is a different fault from one that was never drawn. */
const lines = (width = 100, height = 90): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

const heads = (out: readonly string[]): string[] => out.filter((l) => l.startsWith("──"));

/** The rows under the section whose name is `title`, up to the next head. */
function under(out: readonly string[], title: string): string[] {
  const at = out.findIndex((l) => l.startsWith("──") && l.includes(` ${title.toUpperCase()} `));
  expect(at, `nothing heads ${title}`).toBeGreaterThanOrEqual(0);
  const rest = out.slice(at + 1);
  const next = rest.findIndex((l) => l.startsWith("──"));
  return (next < 0 ? rest : rest.slice(0, next)).map((l) => l.trimEnd());
}

describe("a section's head is its mark and then its name", () => {
  it("heads every section with the glyph views.yaml gives it, and no section with none", () => {
    const out = heads(lines());
    const marked = [sectionMark("services"), ...views.map((v) => sectionMark(v.name))];
    expect(out).toHaveLength(marked.length);
    out.forEach((line, i) => {
      expect(line.startsWith(`── ${marked[i] as string} `), line).toBe(true);
    });
    // And none of them is the space a section that declared nothing would fall back to.
    expect(marked.filter((m) => m.trim() === "")).toEqual([]);
  });

  it("says the name in capitals, and leaves the letter a person types alone", () => {
    const out = lines().join("\n");
    for (const view of views) {
      expect(out).toContain(` ${view.title.toUpperCase()} (`);
      expect(out).toContain(`[${view.key ?? ""}] ─`);
      // The name it used to say, in the case it used to say it in, is gone from the head.
      expect(heads(lines()).some((l) => l.includes(` ${view.title} `))).toBe(false);
    }
    expect(out).toContain(`── ${sectionMark("services")} ${services.title.toUpperCase()} ─`);
  });

  it("still rules to the full width, and still carries the count", () => {
    for (const line of heads(lines())) expect(line).toHaveLength(100);
    expect(lines().join("\n")).toContain("QUEUE (1) [q]");
  });

  /** The mark is not in the code. Change the file and the head changes: that is the whole
   *  of what makes it configuration rather than a character somebody typed into a .tsx. */
  it("reads every mark off views.yaml and holds none of its own", () => {
    const doc = parse(readFileSync(CONFIG, "utf8")) as Record<string, Record<string, unknown>>;
    const declared = { ...doc["views"], services: doc["services"] } as Record<
      string,
      { readonly mark?: string }
    >;
    for (const name of [...views.map((v) => v.name), "services"]) {
      expect(sectionMark(name), `${name} declares no mark`).toBe(declared[name]?.mark);
    }
  });
});

describe("a row's glyph is the one its state has earned", () => {
  /** Every row the seed puts on the board, drawn with the group mark for its state. The
   *  queue's task is `ready`, which no group claims, so it leads with the blank the
   *  ungrouped mark is — a column held open, not a column spent. */
  it("leads a row with its group's mark, and an unclaimed state with a blank", () => {
    const queued = under(lines(), "Queue")[0] ?? "";
    expect(queued).toContain("send the reset mail");
    expect(queued.startsWith("  #")).toBe(true);
    expect(cooking().ungrouped.mark).toBe(" ");
  });

  it("marks a settled row the way the settled group is marked", () => {
    ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", "shipped", tree.epic, "the board says more", "delivered", T, T);
    app.refresh();
    const settled = cooking().groups.find((g) => g.name === "settled");
    const row = under(lines(), "Delivered")[0] ?? "";
    expect(row).toContain("the board says more");
    expect(row.startsWith(`${settled?.mark as string} `)).toBe(true);
    // The same glyph the Delivered section is headed with: one vocabulary, not two.
    expect(sectionMark("delivered")).toBe(settled?.mark);
  });

  it("gives every row the same two columns, so the codes stay a column", () => {
    for (let i = 0; i < 3; i += 1) {
      ins(db, "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)", `s${i}`, tree.epic, `story ${i}`, "planned", T, T);
    }
    app.refresh();
    const rows = under(lines(), "Planned");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.slice(1, 2)).toBe(" ");
    expect(new Set(rows.map((r) => r.indexOf("#")))).toHaveLength(1);
  });

  /** The glyph is the row's, so it is the row's width it comes off — a section is no
   *  narrower for having one, and nothing is drawn past the terminal. */
  it("costs the row two columns and the section none", () => {
    for (const line of lines(60)) expect(line.length).toBeLessThanOrEqual(60);
    const [head] = heads(lines(60));
    expect(head).toHaveLength(60);
  });

  it("marks what the board says wants a person, in the mark that group declares", () => {
    const wants = cooking().groups.find((g) => g.name === "wants_you");
    const state = wants?.states[0] as string;
    const rows: Row[] = app.lines();
    expect(rows.length).toBeGreaterThan(0);
    expect(mark({ ...(rows[0] as Row), state })).toBe(wants?.mark);
  });
});
