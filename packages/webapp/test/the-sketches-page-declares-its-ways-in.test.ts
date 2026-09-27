/** The sketches page has two ways in, and both of them are declared rather than drawn from
 *  memory: the acts a row offers at its end, and the switch the opened header wears.
 *
 *  They were markup. `pages/sketches.ts` wrote an `open` into a row's template and an
 *  `← every sketch` into the opened view's, and both were words a reader meets that nobody
 *  could read off a file — the same thing the bar's two acts were before `config/ui.yaml`
 *  took them. So `ui.yaml` now holds what each way in says, the name it carries, and the
 *  query it puts on this page, and `design.yaml` holds the look each is drawn in, under the
 *  block this page's rules are scoped to.
 *
 *  What this file holds the two files and the page to:
 *    - the declaration is words — a name, a word and a target, per way in, under this page's
 *      own node, and never a path, because which of the page's two readings is showing is
 *      the query's answer and not a route's;
 *    - what the page draws is what the declaration says: the same words at the same targets,
 *      on a row and in the opened view, so an edited word that the drawing has not caught up
 *      with is a red test rather than a page that disagrees with its own file;
 *    - the look they are drawn in is the design's, scoped where only this page's markup
 *      reaches, and spends no colour the signed palette does not already hold.
 *
 *  One name is not yet asked of the markup. The switch already carries `sketches.open.back`
 *  into the document; a row's act carries no `data-ui` at all, because the page spells the
 *  link itself and taking the declaration in is a change to `src/pages/sketches.ts`, which
 *  this work may not make. The word and the target are held to the file here, which is what
 *  makes that change a rewiring rather than a rewrite. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Sketch } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { loadLook } from "../src/pages/shell.js";
import { loadUi, PARAM, sketchesList } from "../src/pages/sketches.js";

/** A way in, as the declaration spells one: the name it carries into the markup, the word a
 *  reader is offered it under, and the query it puts on this page. */
interface Way {
  readonly id: string;
  readonly says: string;
  readonly goes: string;
}

/** The declaration, read off the file with the parser the page reads it with — the one
 *  `@wecode/tui` owns, which is how `sketches.ts` and `shell.ts` both reach for it. */
const UI_YAML = fileURLToPath(new URL("../config/ui.yaml", import.meta.url));
const here = createRequire(import.meta.url);
const { parse } = createRequire(here.resolve("@wecode/tui"))("yaml") as {
  parse: (text: string) => unknown;
};

const said = parse(readFileSync(UI_YAML, "utf8")) as {
  sketches: {
    row: { acts: readonly Way[] };
    open: { back: Way };
  };
};
const ROW_ACTS: readonly Way[] = said.sketches.row.acts;
const SWITCH: Way = said.sketches.open.back;
/** Both ways in, which is what "the two ways in" means wherever this file says it. */
const WAYS_IN: readonly Way[] = [...ROW_ACTS, SWITCH];

const LOOK = loadLook();
const RULES = LOOK.pages["sketches"] as Record<string, string>;
const ROOT = (LOOK.roots["sketches"] as readonly string[])[0] as string;
/** The rules that draw the two ways in, by the shape each names. */
const WAYS_IN_RULES = [
  "section.sketches .row-acts",
  "section.sketches .row-acts a",
  "section.sketches .row-acts a:hover",
  "section.sketches .open p.back",
  "section.sketches .open p.back a",
  "section.sketches .open p.back a:hover",
];

/** A fixed now, so what a row says of its age is read rather than raced. */
const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const UI = loadUi();

const drawing = (id: number, over: Partial<Sketch> = {}): Sketch => ({
  id, name: `sketch ${id}`, kind: "ui", says: "one line saying what it is for", story_id: null,
  html: `/nowhere/sketch-${id}.html`, created_at: new Date(NOW).toISOString(),
  updated_at: new Date(NOW - 60_000).toISOString(), ...over,
});

const listOf = (all: readonly Sketch[], query = ""): string =>
  sketchesList(all, new URL(`http://localhost/sketches${query}`), UI, NOW);

/** One row's own markup, and the run of it that holds the acts. */
function rowOf(body: string, id: number): string {
  const at = body.indexOf(`<li id="sketch-${id}"`);
  expect(at, `no row for #${id}`).toBeGreaterThan(-1);
  return body.slice(at, body.indexOf("</li>", at));
}

function actsOf(body: string, id: number): string {
  const row = rowOf(body, id);
  const at = row.indexOf(`<span class="row-acts">`);
  expect(at, `#${id} offers no acts`).toBeGreaterThan(-1);
  return row.slice(at, row.indexOf("</span>", row.indexOf(">", at)) + "</span>".length);
}

/** Every link in a run of markup, as the pair a reader meets: where it goes and what it
 *  says. A way in is both of those and neither on its own. */
const linksIn = (markup: string): readonly (readonly [string, string])[] =>
  [...markup.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(
    (m) => [m[1] as string, m[2] as string] as const,
  );

/** A target with the record's own column filled in, the way the bar's clauses are filled. */
const filled = (goes: string, id: number): string => goes.replace(/%id%/g, String(id));

describe("the two ways in are declared as words", () => {
  it("declares what a row offers at its end, and what the opened header's switch says", () => {
    expect(Array.isArray(ROW_ACTS), "sketches.row.acts is not a list of acts").toBe(true);
    expect(ROW_ACTS.length).toBeGreaterThan(0);
    for (const way of WAYS_IN) {
      for (const field of ["id", "says", "goes"] as const) {
        expect(typeof way[field], `${way.id ?? "a way in"}.${field}`).toBe("string");
        expect(way[field].length, `${way.id}.${field} says nothing`).toBeGreaterThan(0);
      }
    }
    // The words themselves, so a silent re-wording is a red test and not a quiet one.
    expect(ROW_ACTS.map((a) => a.says)).toEqual(["open"]);
    expect(SWITCH.says).toBe("← every sketch");
  });

  it("names every way in under this page's own node, and no two of them the same", () => {
    const names = WAYS_IN.map((w) => w.id);
    for (const id of names) expect(id.startsWith("sketches."), id).toBe(true);
    expect(names.length, names.join(" ")).toBe(new Set(names).size);
    // The switch's name is the one the markup already carries, so the declaration names the
    // node that is drawn rather than a node beside it.
    expect(SWITCH.id).toBe("sketches.open.back");
  });

  it("puts each way in on this page's own query, and never on a path of its own", () => {
    // Which of the two readings `/sketches` is showing is the query's answer. A way in that
    // spelled a path would be a second answer to where a drawing is, and would walk a board
    // served from anywhere else off its own surface.
    for (const way of WAYS_IN) {
      expect(way.goes.startsWith("?"), `${way.id} goes to ${way.goes}`).toBe(true);
      expect(way.goes, way.id).not.toContain("/");
      expect(way.goes, way.id).not.toContain("://");
    }
  });

  it("names the drawing in the same param the page reads an opened one off", () => {
    // One name for the target, so the link the page builds and the link a person types are
    // the same link — `PARAM` is what `opened()` reads, and this is what the row offers.
    const held = new URL(`http://localhost/sketches${filled(ROW_ACTS[0]?.goes ?? "", 112)}`);
    expect(held.searchParams.get(PARAM)).toBe("112");
    // …and the switch is that same query emptied, which is the list.
    expect(new URL(`http://localhost/sketches${SWITCH.goes}`).searchParams.get(PARAM)).toBeNull();
  });
});

describe("the page draws the declared words, at the declared targets", () => {
  const all = [drawing(112), drawing(111, { story_id: 491 })];
  const body = listOf(all);

  it("offers every row the acts the declaration holds, in its words and at its target", () => {
    for (const s of all) {
      expect(linksIn(actsOf(body, s.id)), `#${s.id}`).toEqual(
        ROW_ACTS.map((a) => [filled(a.goes, s.id), a.says] as const),
      );
    }
  });

  it("offers a row no way in the declaration does not hold", () => {
    // The count and not just the contents: a link the file never declared is exactly what
    // this holds the page to, and a row that grew one silently would still pass the above.
    for (const s of all) expect(linksIn(actsOf(body, s.id)).length, `#${s.id}`).toBe(ROW_ACTS.length);
  });

  it("gives the opened view the switch, by the declared name, saying the declared word", () => {
    const open = listOf(all, `?${PARAM}=112`);
    expect(open).toContain(`<a href="${SWITCH.goes}" data-ui="${SWITCH.id}">${SWITCH.says}</a>`);
    // Once: two ways back are two places a reader has to decide between for one act.
    expect([...open.matchAll(new RegExp(`data-ui="${SWITCH.id}"`, "g"))]).toHaveLength(1);
  });

  it("wears it above the name, which is where a reader looks for the way out", () => {
    const open = listOf(all, `?${PARAM}=112`);
    expect(open.indexOf(SWITCH.id)).toBeGreaterThan(-1);
    expect(open.indexOf(SWITCH.id)).toBeLessThan(open.indexOf("<h3"));
  });

  it("wears it on a target that named a sketch the record has not got, too", () => {
    // A reader who followed a stale link is the reader who most needs the way back.
    const stale = listOf(all, `?${PARAM}=999`);
    expect(stale).toContain(`<a href="${SWITCH.goes}" data-ui="${SWITCH.id}">${SWITCH.says}</a>`);
  });

  it("offers the switch on no list and the acts in no opened view", () => {
    // One reading at a time: the list gives way to the drawing, so the way out is not on the
    // page it goes back to, and the row's acts go with the rows.
    expect(body).not.toContain(SWITCH.id);
    expect(listOf(all, `?${PARAM}=112`)).not.toContain(`class="row-acts"`);
  });
});

describe("the look the two ways in are drawn in is the design's", () => {
  it("declares a shape for each of them, under this page's own block", () => {
    for (const shape of WAYS_IN_RULES) {
      expect(RULES[shape], `the look draws nothing for ${shape}`).toBeDefined();
      expect((RULES[shape] as string).length, shape).toBeGreaterThan(0);
    }
  });

  it("scopes them where only this page's markup reaches", () => {
    expect(ROOT).toBe("section.sketches");
    for (const shape of WAYS_IN_RULES) expect(shape.startsWith(ROOT), shape).toBe(true);
  });

  it("names shapes the page actually carries, so no rule draws nothing", () => {
    const body = listOf([drawing(112)]);
    expect(body).toContain(`<span class="row-acts">`);
    const open = listOf([drawing(112)], `?${PARAM}=112`);
    expect(open).toContain(`<div class="open"`);
    expect(open.slice(open.indexOf(`class="open"`))).toContain(`<p class="back">`);
  });

  it("spends no colour the palette does not already hold", () => {
    const declared = new Set([...Object.keys(LOOK.palette), ...Object.keys(LOOK.type)]);
    for (const [shape, rule] of Object.entries(RULES)) {
      expect(rule, `${shape} spells a colour of its own`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      for (const [, name] of rule.matchAll(/var\(--([a-z-]+)\)/g)) {
        expect(declared.has(name as string), `${shape} spends --${name}, which nobody signed`)
          .toBe(true);
      }
    }
    // The two the ways in spend, named: quiet in the page, marked when pointed at.
    expect(RULES["section.sketches .row-acts a"]).toContain("var(--faint)");
    expect(RULES["section.sketches .row-acts a:hover"]).toContain("var(--mark)");
    expect(RULES["section.sketches .open p.back a"]).toContain("var(--faint)");
    expect(RULES["section.sketches .open p.back a:hover"]).toContain("var(--mark)");
  });

  it("says the space between two acts once, on the row of them", () => {
    // A margin on each act is the same decision made once per act, and it is made in the
    // wrong place: what separates two acts is the gap of the row they sit in.
    expect(RULES["section.sketches .row-acts"]).toContain("display: flex");
    expect(RULES["section.sketches .row-acts"]).toMatch(/gap: [.\d]+rem/);
    expect(RULES["section.sketches .row-acts a"], "an act spaces itself").not.toContain("margin");
  });

  it("leaves the browser no spacing to choose on the switch's own line", () => {
    // `.open` is a grid that rules its rows apart. A paragraph that kept the margin a
    // browser gives a paragraph would space itself twice, and every other line of the
    // opened view already says so.
    expect(RULES["section.sketches .open p.back"]).toContain("margin: 0");
    for (const [shape, rule] of Object.entries(RULES)) {
      if (!/^section\.sketches \.open p\.[a-z-]+$/.test(shape)) continue;
      expect(rule, `${shape} leaves its margin to the browser`).toContain("margin");
    }
  });
});
