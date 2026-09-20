/** The glyph a section is headed with is the design's, not a stand-in for it.
 *
 *  design.yaml's `proposal.marks` says what each section is in one character — a flag for
 *  what wants you, a filled circle for what is running, an hourglass for what is waiting,
 *  a check for what is done. views.yaml answered the same question with `?`, `>`, `-`, `*`,
 *  `.`, `+`, `x`, and the board drew those. So the signed proposal said one thing and the
 *  screen said another, and the ascii was not a fallback anybody had chosen: it was written
 *  before the design was, and never read again.
 *
 *  Two claims, and both are about the drawn frame rather than about a loader:
 *
 *  1. No head begins with a dash. `proposal.head` spends none, and a rule out to the width
 *     was chrome saying where a head began that the glyph in column zero already says.
 *  2. Each section the design marks is headed with *that* glyph, in column zero.
 *
 *  The expected glyphs are read out of design.yaml rather than typed here. A literal would
 *  be a second copy of the proposal, and the point of the change is that there is one. */
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
import { sectionMark } from "../src/list.js";
import { loadViews } from "../src/views.js";
import { loadServices } from "../src/services.js";
import { seed } from "./seed.js";

const design = parse(
  readFileSync(fileURLToPath(new URL("../config/design.yaml", import.meta.url)), "utf8"),
) as { readonly proposal: { readonly head: Record<string, unknown>; readonly marks: Record<string, string> } };

const HEAD = design.proposal.head;
/** What the proposal says each section is, in one glyph, keyed by what the section is. */
const MARKS = design.proposal.marks;

/** A section's key in `proposal.marks` is its title said as one word: the design names the
 *  thing (`queue`), views.yaml names the box that keeps it (`queued`), and the title is
 *  what the two have in common. */
const keyOf = (title: string): string => title.toLowerCase().replace(/ /g, "_");

const views = loadViews();
const services = loadServices();
const machines = loadMachines();

let db: DatabaseSync;
let app: App;

beforeEach(() => {
  db = open(":memory:");
  seed(db);
  app = new App(db, views, machines);
});

afterEach(cleanup);

/** Tall enough that nothing is clipped: a head missing because the terminal ran out of rows
 *  is a different fault from one drawn with the wrong glyph. */
const lines = (width = 100, height = 90): string[] =>
  plain(render(createElement(Cockpit, { app, width, height })).lastFrame() ?? "").split("\n");

/** The line that heads a section, found by its name in capitals rather than by its mark —
 *  the mark is the thing under test, so looking for it would be asking the question with
 *  the answer already in it. */
function head(out: readonly string[], title: string): string {
  const said = HEAD["case"] === "upper" ? title.toUpperCase() : title;
  const line = out.find((l) => l.trimStart().startsWith(said) || l.includes(` ${said}`));
  expect(line, `nothing heads ${title}`).toBeDefined();
  return line as string;
}

/** Every section drawn on the board: the lead, which is no filter, then the boxes. */
const SECTIONS = [services.title, ...views.map((v) => v.title)];

describe("the marks on the board are the design's", () => {
  it("declares a glyph for every section the design names, and none is ascii", () => {
    expect(Object.keys(MARKS).length).toBeGreaterThanOrEqual(6);
    for (const [name, glyph] of Object.entries(MARKS)) {
      expect(glyph, `${name} is marked with nothing`).toHaveLength(1);
      // An ascii stand-in is exactly what this file exists to keep off the board.
      expect(/^[\x20-\x7e]$/.test(glyph), `${name} is marked with ascii ${glyph}`).toBe(false);
    }
  });

  it("heads each marked section with that glyph, in column zero", () => {
    const out = lines();
    const marked = SECTIONS.filter((t) => MARKS[keyOf(t)] !== undefined);
    // The six the design names, at least — every box on the page but the lead.
    expect(marked.length).toBeGreaterThanOrEqual(6);
    for (const title of marked) {
      const glyph = MARKS[keyOf(title)] as string;
      const line = head(out, title);
      expect(line.startsWith(`${glyph} `), `${title} is headed ${JSON.stringify(line)}`).toBe(true);
    }
  });

  it("begins no head with a dash, of any width", () => {
    expect(HEAD["dashes"]).toBe("none");
    expect(HEAD["begins_at_column"]).toBe(0);
    for (const title of SECTIONS) {
      const line = head(lines(), title);
      expect(/^[-─—–]/.test(line), `${title} is headed ${JSON.stringify(line)}`).toBe(false);
      expect(line).not.toContain("──");
    }
  });

  /** The glyph is not typed into a .tsx and not typed into this file either: the board asks
   *  `sectionMark` and `sectionMark` answers out of the proposal. */
  it("reads the board's glyphs back off the design and not off a literal", () => {
    for (const title of SECTIONS) {
      const view = [...views].find((v) => v.title === title);
      const name = view?.name ?? "services";
      const glyph = MARKS[keyOf(title)];
      if (glyph !== undefined) expect(sectionMark(name), `${name}`).toBe(glyph);
    }
  });
});
