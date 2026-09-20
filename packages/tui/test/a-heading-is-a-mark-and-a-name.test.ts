/** A heading is a mark and a name in capitals, and a row is a glyph and a row.
 *
 *  Eight rules down a page all opened `── ` and then a word in the same case as the words
 *  under them. A reader looking for where a section starts had to read the words to find
 *  out, which is the one thing chrome exists to save them. So a head carries two things
 *  before its name: the glyph that section is marked with, and the name in capitals — one
 *  answered without reading, one answered without parsing.
 *
 *  The `── ` itself is gone with them. config/design.yaml's `proposal.head` puts the glyph
 *  in column zero and spends no dashes: the mark was already saying where a head began, and
 *  the rule out to the width was a second answer to a question nobody asks twice. What
 *  stands at the far end is the count, with the letter that opens the box raised onto it.
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
import { Cockpit, raised } from "../src/screens.js";
import { cooking, sectionMark, mark, type Row } from "../src/list.js";
import { loadViews } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { seed, T, ins } from "./seed.js";

interface Design {
  readonly proposal: {
    readonly head: {
      readonly opens_with: string;
      readonly begins_at_column: number;
      readonly dashes: string;
      readonly case: string;
      readonly line: string;
      readonly count: string;
    };
  };
}

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as Design;

const HEAD = design.proposal.head;

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

/** How the design writes a head's opening: the section's mark, then its name in capitals. */
const opening = (name: string, title: string): string =>
  HEAD.line
    .replace("{mark}", sectionMark(name))
    .replace("{title}", HEAD.case === "upper" ? title.toUpperCase() : title);

const OPENINGS = [
  opening("services", services.title),
  ...views.map((v) => opening(v.name, v.title)),
];

const heads = (out: readonly string[]): string[] =>
  out.filter((l) => OPENINGS.some((o) => l.startsWith(o)));

/** The rows under the section whose name is `title`, up to the next head. */
function under(out: readonly string[], title: string): string[] {
  const view = views.find((v) => v.title === title);
  expect(view, `no view titled ${title}`).toBeDefined();
  const opens = opening(view?.name ?? "", title);
  const at = out.findIndex((l) => l.startsWith(opens));
  expect(at, `nothing heads ${title}`).toBeGreaterThanOrEqual(0);
  const rest = out.slice(at + 1);
  const next = rest.findIndex((l) => heads([l]).length > 0);
  return (next < 0 ? rest : rest.slice(0, next)).map((l) => l.trimEnd());
}

describe("a section's head is its mark and then its name", () => {
  it("heads every section with the glyph views.yaml gives it, and no section with none", () => {
    expect(HEAD.opens_with).toBe("mark");
    expect(HEAD.begins_at_column).toBe(0);
    const out = heads(lines());
    const marked = [sectionMark("services"), ...views.map((v) => sectionMark(v.name))];
    expect(out).toHaveLength(marked.length);
    out.forEach((line, i) => {
      // In column zero, with nothing in front of it — no dashes, no indent.
      expect(line.startsWith(`${marked[i] as string} `), line).toBe(true);
    });
    // And none of them is the space a section that declared nothing would fall back to.
    expect(marked.filter((m) => m.trim() === "")).toEqual([]);
  });

  it("says the name in capitals, and puts the letter a person types on the count", () => {
    expect(HEAD.case).toBe("upper");
    const out = lines();
    for (const view of views) {
      const line = out.find((l) => l.startsWith(opening(view.name, view.title))) ?? "";
      expect(line, `${view.title} is not headed`).not.toBe("");
      // The letter is no longer beside the name: it rides the count at the far end.
      expect(line).not.toContain(`[${view.key ?? ""}]`);
      expect(line.endsWith(raised(view.key)), line).toBe(true);
      // The name in the case it used to be said in is gone from the head.
      expect(heads(out).some((l) => l.includes(` ${view.title} `))).toBe(false);
    }
    // The lead section is no filter and has no letter, so its head is its opening and no more.
    expect(out[0]).toBe(opening("services", services.title));
  });

  it("spends no dashes, and stands every count at the width", () => {
    expect(HEAD.dashes).toBe("none");
    const out = heads(lines());
    for (const line of out) expect(line, line).not.toContain("─");
    // A box's head reaches the width because its count is what ends it there.
    const counted = out.filter((l) => /\d/.test(l));
    expect(counted).toHaveLength(views.length);
    for (const line of counted) expect(line).toHaveLength(100);
    const queue = HEAD.count.replace("{count}", "1").replace("{key}", raised("q"));
    expect(out.some((l) => l.startsWith(opening("queued", "Queue")) && l.endsWith(queue))).toBe(true);
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
    // The lead section counts nothing, so nothing holds its head out to the width; a box's
    // head is held there by the count standing at its right edge.
    const [head] = heads(lines(60)).filter((l) => /\d/.test(l));
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
