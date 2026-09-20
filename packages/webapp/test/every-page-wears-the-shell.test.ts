/** Every page of the web surface comes out in the shell the design declares.
 *
 *  This file used to hold the move that took the pages' stylesheets away from them, and it
 *  held it by naming the rules that moved: `section li .code`, `article dd.open`,
 *  `ul.tree li .label`. Those were the strings three page files happened to spell before
 *  the look was declared. The look is `renderers.webapp.look` now, the shapes it scopes
 *  each page to are `look.roots`, and a gate that still reads the old page's selectors
 *  gates the wrong document — it goes red when the signed design is restyled, and green
 *  when a page stops wearing the shell at all.
 *
 *  So nothing below is written out. The design says what a document of this surface is and
 *  which shape each page draws; this file asks the design, mounts the whole surface the way
 *  `bin.ts` mounts it, and holds every page that comes back to those words:
 *    - the declared doctype, language, charset, viewport, title and banner, in every page;
 *    - the page's own markup inside the one declared element, and nowhere else;
 *    - one stylesheet per document, the declared one, identical across the surface;
 *    - every rule in it declared by the design and no rule that is not;
 *    - each page drawing the shape its own `roots` scope its rules to, and not another
 *      page's — which is what makes one sheet in every document safe rather than tidy.
 *
 *  `the-shell-is-the-signed-design.test.ts` holds the look's own statements; what is here
 *  is the documents.
 */
import { readdirSync } from "node:fs";
import type { Board, Node, Approval, Rollup } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { answer } from "../src/server.js";
import { discovered, pages, pathOf } from "../src/pages/discover.js";
import {
  document,
  loadBanner,
  loadLook,
  loadShell,
  shelled,
  stylesheet,
  type Rules,
} from "../src/pages/shell.js";

const SHELL = loadShell();
const LOOK = loadLook();
const SHEET = stylesheet(LOOK);

const NONE: Rollup = { done: 0, open: 0, failed: 0 };

const emptyBoard = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

const node = (entity: string, id: number, children: readonly Node[] = []): Node => ({
  entity, id, label: `a ${entity}`, state: "planned", folded: false, rollup: NONE, children,
} as Node);

/** A record deep enough that every page has something to draw. A page given nothing draws
 *  its one empty line, which wears the shell as faithfully as a full page and proves
 *  nothing about the shape the design scopes that page's rules to. */
const aTree = (): readonly Node[] => [node("project", 1, [node("story", 2, [node("task", 3)])])];

const anApproval = (): readonly Approval[] => [
  {
    id: 4, objective_type: "task", objective_id: 12, worker_id: 1, phase: "waiting",
    kind: "approval", question: "is it settled?", options: null, answer: null,
    answered_by: null,
    evidence: { type: "task", id: 12, statement: "widen the scope", state: "attempting" },
  },
];

/** The readings `bin.ts` offers, answered out of hand-made work rather than a database:
 *  what is being proved is the frame around a page, not its arithmetic. */
const readings = { record: aTree, board: emptyBoard, approvals: anApproval };

const NAMES = discovered(readdirSync(new URL("../src/pages", import.meta.url)));

/** Every page of the surface, mounted and fetched, by the name of its file. */
async function surface(): Promise<readonly (readonly [string, string])[]> {
  const routes = await pages(readings);
  return NAMES.map((name) => {
    const reply = answer(routes, "GET", pathOf(name));
    expect(reply.status, `${name} does not answer`).toBe(200);
    return [name, reply.body] as const;
  });
}

const SERVED = await surface();

/** The stylesheet a document came out with, and the only one it came out with. */
function styleOf(body: string): string {
  expect([...body.matchAll(/<style>/g)], "the document carries two sheets").toHaveLength(1);
  const open = body.indexOf("<style>");
  expect(open, "the document carries no stylesheet").toBeGreaterThan(-1);
  return body.slice(open + "<style>".length, body.indexOf("</style>", open));
}

/** Every selector the sheet spells, read off it a rule to a line — which is how `rulesOf`
 *  writes one — with a query's own rules counted and the query itself skipped. */
const spelled = (sheet: string): readonly string[] =>
  sheet
    .split("\n")
    .map((line) => /^\s*(.+?) \{ .* \}$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1] as string);

/** Every selector the design declares, queries unwrapped. */
const declared = (rules: Rules): readonly string[] =>
  Object.entries(rules).flatMap(([selector, held]) =>
    typeof held === "string" ? [selector] : declared(held as Rules),
  );

/** What one simple selector asks the markup for: a tag, carrying every class it names. */
function shape(simple: string): RegExp {
  const [tag, ...classes] = simple.split(".");
  const attr = classes.map((c) => `(?=[^>]*\\bclass="[^"]*\\b${c}\\b)`).join("");
  return new RegExp(`<${tag}\\b${attr}[\\s>]`);
}

/** The opening tag of each direct child of the shell's one element. A void element has no
 *  children and no close, but the surface writes none inside the frame; a self-closing tag
 *  is handled anyway, because guessing wrong here would be a silently generous gate. */
function children(inside: string): readonly string[] {
  const kids: string[] = [];
  let depth = 0;
  for (const tag of inside.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/g)) {
    const closing = tag[1] === "/";
    if (closing) depth -= 1;
    else if (depth === 1) kids.push(tag[0]);
    if (!closing && !(tag[3] as string).trimEnd().endsWith("/")) depth += 1;
  }
  return kids;
}

/** Whether a page's markup draws a root the design scopes rules to. `section.board` is
 *  drawn by writing that section anywhere inside the frame; `main > h2` only by writing an
 *  `h2` directly in the shell's one element, which is the whole point of the combinator —
 *  a page whose boxes carry headings is not drawing it. */
function draws(root: string, inside: string): boolean {
  const parts = root.split(">").map((s) => s.trim());
  const last = shape(parts[parts.length - 1] as string);
  if (parts.length === 1) return last.test(inside);
  expect(parts, `${root} is scoped under something that is not the shell's element`).toEqual([
    SHELL.body,
    parts[1],
  ]);
  return children(inside).some((kid) => last.test(kid));
}

describe("the surface is the one the directory holds", () => {
  it("has every discovered page mounted and answering", () => {
    expect(SERVED.map(([name]) => name)).toEqual([...NAMES]);
    expect(NAMES).toContain("board");
    expect(NAMES.length).toBeGreaterThan(1);
  });
});

describe("every page comes out in the declared shell", () => {
  it.each(SERVED)("opens %s with the declared doctype and language", (_name, body) => {
    expect(body.startsWith(`${SHELL.doctype}\n<html lang="${SHELL.lang}">`)).toBe(true);
    expect(body.trimEnd().endsWith("</html>")).toBe(true);
  });

  it.each(SERVED)("gives %s the declared head", (_name, body) => {
    expect(body).toContain(`<meta charset="${SHELL.charset}">`);
    expect(body).toContain(`<meta name="viewport" content="${SHELL.viewport}">`);
    expect(body).toContain(`<title>${SHELL.title}</title>`);
  });

  it.each(SERVED)("writes %s inside the one declared element, under the banner", (_name, body) => {
    const opens = [...body.matchAll(new RegExp(`<${SHELL.body}[\\s>]`, "g"))];
    expect(opens, "the declared element is opened twice").toHaveLength(1);
    expect(body).toContain(`</${SHELL.body}>`);
    const inside = body.slice(body.indexOf(`<${SHELL.body}>`), body.indexOf(`</${SHELL.body}>`));
    expect(inside).toContain(`<h1>${SHELL.banner}</h1>`);
    for (const tab of loadBanner()) expect(inside).toContain(`<a href="${tab.at}">${tab.says}</a>`);
  });

  it.each(SERVED)("dresses %s in the declared sheet, and in one", (_name, body) => {
    expect(styleOf(body)).toBe(SHEET);
  });
});

describe("the sheet in them is the design's, rule for rule", () => {
  const DECLARED = [":root", ...declared(LOOK.frame), ...Object.values(LOOK.pages).flatMap(declared)];

  it("spells every rule the design declares, and none it does not", () => {
    expect(spelled(SHEET)).toEqual(DECLARED);
  });

  it("keeps a page's retired stylesheet out of the document", () => {
    const retired = "ul.tree li { colour: what a page used to spell }";
    const served = document("<p>a page</p>", retired);
    expect(styleOf(served)).toBe(SHEET);
    expect(served).not.toContain("colour:");
  });

  it("asks a page for its markup and for nothing else", () => {
    // Arity is the contract: everything but the contents is defaulted off the design, so
    // there is no argument a page passes that changes how the surface looks.
    expect(document.length).toBe(1);
    expect(shelled.length).toBe(1);
    expect(styleOf(document(""))).toBe(SHEET);
  });
});

describe("each page draws the shape its rules are scoped to", () => {
  const rooted = SERVED.filter(([name]) => LOOK.roots[name] !== undefined);

  it("has the design scoping a page this file serves", () => {
    expect(rooted.length).toBeGreaterThan(1);
    expect(Object.keys(LOOK.roots).sort()).toEqual(rooted.map(([name]) => name).sort());
  });

  it.each(rooted)("draws one of %s's own roots", (name, body) => {
    const mine = LOOK.roots[name] as readonly string[];
    const inside = body.slice(body.indexOf(`<${SHELL.body}>`));
    expect(
      mine.filter((root) => draws(root, inside)),
      `${name} draws none of ${mine.join(" ")}, so none of its rules reach it`,
    ).not.toEqual([]);
  });

  it.each(rooted)("leaves %s drawing no other page's root", (name, body) => {
    const mine = LOOK.roots[name] as readonly string[];
    const inside = body.slice(body.indexOf(`<${SHELL.body}>`));
    for (const [other, roots] of Object.entries(LOOK.roots)) {
      if (other === name) continue;
      for (const root of roots) {
        if (mine.includes(root)) continue;
        expect(
          draws(root, inside),
          `${name} draws \`${root}\`, which is ${other}'s, so ${other}'s rules reach it`,
        ).toBe(false);
      }
    }
  });
});
