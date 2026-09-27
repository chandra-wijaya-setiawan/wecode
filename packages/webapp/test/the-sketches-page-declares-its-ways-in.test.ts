/** A sketch has two ways into it, and each of them offers the same two readings: the acts at
 *  the end of a row, and the switch the opened header wears. Both are declared rather than
 *  spelled in a page.
 *
 *  They were markup. `pages/sketches.ts` wrote one word — `open` — into a row's template,
 *  and that was the whole of what a reader could do to a sketch from the list. `open` named
 *  a reading that had no sibling; beside `edit` it reads as the opposite of closed rather
 *  than the opposite of editing, so the word goes and `view` and `edit` take its place. Both
 *  of them are words a reader meets that nobody could read off a file — the same thing the
 *  bar's two acts were before `config/ui.yaml` took them. So `ui.yaml` now holds what each
 *  way in says, the name it carries, and the query it puts on this page, and `design.yaml`
 *  holds the look each is drawn in, under the block this page's rules are scoped to.
 *
 *  What this file holds the two files to:
 *    - the declaration is words — a name, a word, a reading and a target per way in, under
 *      this page's own node — and never a path, because which reading `/sketches` is showing
 *      is the query's answer and not a route's;
 *    - the two ways in are two offers of one pair: the same readings, in the same order, at
 *      the same targets, so there is one answer to where a reading of a sketch is and not
 *      two that can drift apart;
 *    - the look they are drawn in is the design's, scoped where only this page's markup
 *      reaches, reaches the sheet a browser is served, and spends no colour the signed
 *      palette does not already hold.
 *
 *  What it does not hold: the drawing. Taking the declaration in is a change to
 *  `src/pages/sketches.ts` and `src/drawing.ts`, which this work may not make — the page
 *  still spells `open` in a row today. `a-sketch-opens-to-read-or-to-annotate.test.ts` is
 *  where the drawing is held to this file; here the words and the targets are pinned so that
 *  change is a rewiring rather than a rewrite. The one name the markup already carries —
 *  the way back out, `sketches.open.back` — is checked against the document, because a
 *  declaration that names a node nobody draws is a declaration nobody can trust. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Sketch } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { loadLook, stylesheet } from "../src/pages/shell.js";
import { PARAM, sketchesList } from "../src/pages/sketches.js";

/** A way in, as the declaration spells one: the name it carries into the markup, the word a
 *  reader is offered it under, the reading it asks for, and the query it puts on this page. */
interface Way {
  readonly id: string;
  readonly mode: string;
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
    mode: { param: string; default: string };
    row: { acts: readonly Way[] };
    open: { modes: { id: string; says: string; of: readonly Way[] }; back: Way };
  };
};
const SKETCHES = said.sketches;
/** The reading a target asks for, and the one it is showing when it asks for none. */
const MODE = SKETCHES.mode;
/** The first way in: what a row offers at its end. */
const ROW_ACTS: readonly Way[] = SKETCHES.row.acts;
/** The second: the switch an opened sketch wears in its header. */
const SWITCH = SKETCHES.open.modes;
/** Both of them, flattened, wherever this file says "every way in". */
const WAYS_IN: readonly Way[] = [...ROW_ACTS, ...SWITCH.of];
/** The two readings, in the order the declaration offers them. */
const READINGS = ["view", "edit"] as const;

const LOOK = loadLook();
const RULES = LOOK.pages["sketches"] as Record<string, string>;
const ROOT = (LOOK.roots["sketches"] as readonly string[])[0] as string;
const SHEET = stylesheet();

/** The shapes the two ways in are drawn by, each named by what it draws. */
const ACT_RULES = [
  "section.sketches .row-acts",
  "section.sketches .row-acts a",
  "section.sketches .row-acts a + a::before",
  "section.sketches .row-acts a:hover",
];
const SWITCH_RULES = [
  "section.sketches .open .opened-head",
  "section.sketches .open .modes",
  "section.sketches .open .modes a",
  "section.sketches .open .modes a + a",
  "section.sketches .open .modes a:hover",
  "section.sketches .open .modes a[aria-current]",
];
const WAYS_IN_RULES = [...ACT_RULES, ...SWITCH_RULES];

/** Every `id` anywhere under this page's node, however deep, so "no two the same" is asked
 *  of the whole page and not only of the two ways in. */
function namesUnder(held: unknown): readonly string[] {
  if (Array.isArray(held)) return held.flatMap(namesUnder);
  if (held === null || typeof held !== "object") return [];
  const block = held as Record<string, unknown>;
  const mine = typeof block["id"] === "string" ? [block["id"] as string] : [];
  return [...mine, ...Object.entries(block).flatMap(([at, v]) => (at === "id" ? [] : namesUnder(v)))];
}

/** A target with the record's own column filled in, the way the bar's clauses are filled. */
const filled = (goes: string, id: number): string => goes.replace(/%id%/g, String(id));

/** Where a target lands, read the way a browser reads it. */
const landing = (goes: string, id = 112): URL =>
  new URL(`http://localhost/sketches${filled(goes, id)}`);

describe("the two ways into a sketch are declared as words", () => {
  it("declares what a row offers at its end, and what the opened header's switch says", () => {
    expect(Array.isArray(ROW_ACTS), "sketches.row.acts is not a list of acts").toBe(true);
    expect(Array.isArray(SWITCH.of), "sketches.open.modes.of is not a list of readings").toBe(true);
    for (const way of WAYS_IN) {
      for (const field of ["id", "mode", "says", "goes"] as const) {
        expect(typeof way[field], `${way.id ?? "a way in"}.${field}`).toBe("string");
        expect(way[field].length, `${way.id}.${field} says nothing`).toBeGreaterThan(0);
      }
    }
    // The switch is a pair and says what the pair is, for a reader without a screen.
    expect(typeof SWITCH.says).toBe("string");
    expect(SWITCH.says.length).toBeGreaterThan(0);
  });

  it("says view and edit, in that order, on both of them", () => {
    // Reading comes before annotating: a reader who has not seen a drawing has nothing to
    // say about it, and the row and the switch offer the pair in one order, not two.
    expect(ROW_ACTS.map((a) => a.says)).toEqual([...READINGS]);
    expect(SWITCH.of.map((a) => a.says)).toEqual([...READINGS]);
    expect(ROW_ACTS.map((a) => a.mode)).toEqual([...READINGS]);
    expect(SWITCH.of.map((a) => a.mode)).toEqual([...READINGS]);
  });

  it("says open on neither, because the word named a reading that had no sibling", () => {
    for (const way of WAYS_IN) expect(way.says, way.id).not.toBe("open");
    // Not under a name either: `sketches.row.open` was what this page declared before, and a
    // name left behind is a word that comes back the next time somebody reads the file.
    for (const name of namesUnder(SKETCHES)) expect(name, name).not.toMatch(/\.open$/);
  });

  it("names every way in under this page's own node, and no two of them the same", () => {
    const names = namesUnder(SKETCHES);
    for (const id of names) expect(id.startsWith("sketches."), id).toBe(true);
    expect(names.length, names.join(" ")).toBe(new Set(names).size);
    for (const way of ROW_ACTS) expect(way.id.startsWith("sketches.row."), way.id).toBe(true);
    for (const way of SWITCH.of) expect(way.id.startsWith("sketches.open."), way.id).toBe(true);
  });

  it("puts each way in on this page's own query, and never on a path of its own", () => {
    // Which reading `/sketches` is showing is the query's answer. A way in that spelled a
    // path would be a second answer to where a drawing is, and would walk a board served
    // from anywhere else off its own surface.
    for (const way of [...WAYS_IN, SKETCHES.open.back]) {
      expect(way.goes.startsWith("?"), `${way.id} goes to ${way.goes}`).toBe(true);
      expect(way.goes, way.id).not.toContain("/");
      expect(way.goes, way.id).not.toContain("://");
    }
  });
});

describe("the targets are the two readings of one sketch", () => {
  it("names which sketch in the param the page already reads one off", () => {
    // One name for which drawing, so the link the page builds and the link a person could
    // have typed are the same link — `PARAM` is what `opened()` reads today, and every link
    // already sent carries it.
    for (const way of WAYS_IN) {
      expect(landing(way.goes).searchParams.get(PARAM), way.id).toBe("112");
      expect(way.goes, way.id).toContain(`${PARAM}=%id%`);
    }
  });

  it("names which reading in a second param beside it, and never in the first", () => {
    expect(MODE.param).not.toBe(PARAM);
    for (const way of WAYS_IN) {
      const at = landing(way.goes);
      // `open` says which drawing and never which reading: the id is the id and nothing else.
      expect(at.searchParams.get(PARAM), way.id).toBe("112");
      const asked = at.searchParams.get(MODE.param);
      expect(asked === null ? MODE.default : asked, way.id).toBe(way.mode);
    }
  });

  it("leaves the default reading to the absent parameter", () => {
    // `?open=1` and `?open=1&mode=view` are one document, the way `tree.filter` already
    // works, so a link sent before edit existed still opens the drawing it always opened.
    expect(MODE.default).toBe(READINGS[0]);
    for (const way of WAYS_IN) {
      if (way.mode !== MODE.default) continue;
      expect(landing(way.goes).searchParams.has(MODE.param), `${way.id} spells its default`)
        .toBe(false);
    }
    // …and the other reading is never the absent one, or there would be no way to ask for it.
    for (const way of WAYS_IN) {
      if (way.mode === MODE.default) continue;
      expect(landing(way.goes).searchParams.get(MODE.param), way.id).toBe(way.mode);
    }
  });

  it("gives one answer to where a reading is, not one per way in", () => {
    // The row and the switch offer the same two readings of the same sketch. If they could
    // spell different targets, a reader would arrive somewhere else depending on where they
    // pressed, and the second target would be one nobody remembered to change.
    for (const reading of READINGS) {
      const from = WAYS_IN.filter((w) => w.mode === reading).map((w) => w.goes);
      expect(from.length, reading).toBe(2);
      expect(new Set(from).size, `${reading} is two targets: ${from.join(" and ")}`).toBe(1);
    }
  });

  it("keeps the way back out as the query emptied, which is the list", () => {
    const back = SKETCHES.open.back;
    expect(landing(back.goes).searchParams.get(PARAM)).toBeNull();
    expect(landing(back.goes).searchParams.get(MODE.param)).toBeNull();
    // It is a way out and not one of the two ways in, so it asks for no reading.
    expect((back as { mode?: string }).mode).toBeUndefined();
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

  it("writes every one of them into the sheet a browser is served", () => {
    // A rule declared and not built is a look nobody is drawn in.
    for (const shape of WAYS_IN_RULES) {
      expect(SHEET, shape).toContain(`${shape} { ${RULES[shape] as string} }`);
    }
  });

  it("spends no colour the palette does not already hold", () => {
    const declared = new Set([...Object.keys(LOOK.palette), ...Object.keys(LOOK.type)]);
    for (const [shape, rule] of Object.entries(RULES)) {
      expect(rule, `${shape} spells a colour of its own`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(rule, `${shape} spells a colour of its own`).not.toMatch(/\brgba?\(/);
      for (const [, name] of rule.matchAll(/var\(--([a-z-]+)\)/g)) {
        expect(declared.has(name as string), `${shape} spends --${name}, which nobody signed`)
          .toBe(true);
      }
    }
    // Which is worth saying of the signed sketch's own switch in particular: it fills the
    // held side with `#fff`, and the palette holds no white. The surface's paper is what it
    // already has, and that is what the word on the fill is set in.
    expect(RULES["section.sketches .open .modes a[aria-current]"]).toContain("var(--mark)");
    expect(RULES["section.sketches .open .modes a[aria-current]"]).toContain("var(--page)");
  });

  it("draws both acts of a row alike, and neither louder than the other", () => {
    // The signed sketch draws `edit` in the mark and in bold — a proposal calling out the
    // word it adds. On the page they are peers on every row, and a list of thirty rows with
    // thirty bold links down it is a list nobody reads down.
    expect(RULES["section.sketches .row-acts a"]).toContain("var(--faint)");
    expect(RULES["section.sketches .row-acts a:hover"]).toContain("var(--mark)");
    for (const shape of Object.keys(RULES)) {
      expect(shape, "an act is drawn by which word it is").not.toMatch(/\.row-acts a\.[a-z-]+/);
    }
  });

  it("says the space between two acts once, on the row of them", () => {
    // A margin on each act is the same decision made once per act, and made in the wrong
    // place: what separates two acts is the gap of the row they sit in.
    expect(RULES["section.sketches .row-acts"]).toContain("display: flex");
    expect(RULES["section.sketches .row-acts"]).toMatch(/gap: [.\d]+rem/);
    expect(RULES["section.sketches .row-acts a"], "an act spaces itself").not.toContain("margin");
  });

  it("keeps the dot between them the look's, rather than a character the page spells", () => {
    const between = RULES["section.sketches .row-acts a + a::before"] as string;
    expect(between).toMatch(/content: "[^"]+"/);
    // Drawn in the rule the grid is drawn in, so it separates without being read as a word.
    expect(between).toContain("var(--rule)");
    // And only between: a column that opened with a dot would be a column with a stray mark
    // in it on a row offering one act.
    expect(Object.keys(RULES)).not.toContain("section.sketches .row-acts a::before");
  });

  it("draws the switch as one box in two halves, with the held side filled", () => {
    const box = RULES["section.sketches .open .modes"] as string;
    expect(box).toContain("display: inline-flex");
    expect(box).toContain("border: 1px solid var(--rule)");
    // Ruled down the middle, so the pair reads as one switch rather than as two links that
    // happen to sit beside each other.
    expect(RULES["section.sketches .open .modes a + a"]).toContain("border-left");
    // The held side comes last, so it keeps its fill under a pointer instead of offering to
    // become what it already is — the two shapes weigh the same, and the later one wins.
    const order = Object.keys(RULES);
    expect(order.indexOf("section.sketches .open .modes a[aria-current]")).toBeGreaterThan(
      order.indexOf("section.sketches .open .modes a:hover"),
    );
  });

  it("pushes the switch to the far end of the header it is worn on", () => {
    // The name reads from the left; a control that changes the whole view sits at the other
    // end of the line, out of the way of a name long enough to wrap.
    expect(RULES["section.sketches .open .opened-head"]).toContain("display: flex");
    expect(RULES["section.sketches .open .modes"]).toContain("margin-left: auto");
  });
});

describe("a declared name is a name the markup carries", () => {
  /** A fixed now, so what a row says of its age is read rather than raced. */
  const NOW = Date.parse("2026-09-23T12:00:00.000Z");
  const drawing = (id: number): Sketch => ({
    id, name: `sketch ${id}`, kind: "ui", says: "one line saying what it is for", story_id: null,
    html: `/nowhere/sketch-${id}.html`, created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW - 60_000).toISOString(),
  });
  const listOf = (query = ""): string =>
    sketchesList([drawing(112)], new URL(`http://localhost/sketches${query}`), undefined, NOW);

  it("gives the opened view the way back out, by the declared name and word", () => {
    const back = SKETCHES.open.back;
    const open = listOf(`?${PARAM}=112`);
    expect(open).toContain(`<a href="${back.goes}" data-ui="${back.id}">${back.says}</a>`);
    // Once: two ways back are two places a reader has to decide between for one act.
    expect([...open.matchAll(new RegExp(`data-ui="${back.id}"`, "g"))]).toHaveLength(1);
  });

  it("wears it on a target that named a sketch the record has not got, too", () => {
    // A reader who followed a stale link is the reader who most needs the way back.
    const back = SKETCHES.open.back;
    expect(listOf(`?${PARAM}=999`)).toContain(`data-ui="${back.id}">${back.says}</a>`);
  });

  it("offers it on no list, because the list is what it goes back to", () => {
    expect(listOf()).not.toContain(SKETCHES.open.back.id);
  });
});
