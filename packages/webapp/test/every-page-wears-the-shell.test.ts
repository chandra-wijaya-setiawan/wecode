/** The web surface has one stylesheet, and it is the shell's.
 *
 *  The shell already owned the document — the doctype, the banner, the one element a page
 *  goes inside — but each page still handed it a `STYLE` string of its own, and `document`
 *  took it. A page that can hand in rules is a page that can disagree with the frame about
 *  what a heading is: three `h2` rules in three files, and the day one of them changes the
 *  board's box titles stop matching the decisions page's card titles for no reason anybody
 *  decided. It is the same defect as three `<!doctype>`s, one layer down.
 *
 *  So the rules moved into `shell.ts` whole, and the door they came through is gone. This
 *  file holds that:
 *    - no page of the package carries a stylesheet, a rule or an inline style;
 *    - the shell cannot be given one — `document` and `shelled` take no such argument;
 *    - the three pages come out of the server with the one identical stylesheet;
 *    - that stylesheet still dresses each of the three, and each page's rules are selected
 *      narrowly enough not to reach into the other two.
 *
 *  The last point is what makes one sheet safe rather than merely tidy: the board's rows
 *  are flex and the tree's are not, and both are `li`.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Approval, Board, Node, Rollup } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, serve } from "../src/index.js";
import { boardAt, boardPage } from "../src/pages/board.js";
import { decisionsAt, decisionsPage } from "../src/pages/decisions.js";
import { document, shelled } from "../src/pages/shell.js";
import { treeAt, treePage } from "../src/pages/tree.js";

const PAGES = fileURLToPath(new URL("../src/pages", import.meta.url));

/** Every page of the package but the shell itself — read off the directory rather than
 *  listed, so the fourth page is held to this too on the day it lands. */
const pages = (): readonly string[] =>
  readdirSync(PAGES).filter((f) => f.endsWith(".ts") && f !== "shell.ts");

const sourceOf = (page: string): string => readFileSync(join(PAGES, page), "utf8");

/** The stylesheet a document came out with. */
function styleOf(body: string): string {
  const open = body.indexOf("<style>");
  expect(open, "the document carries no stylesheet").toBeGreaterThan(-1);
  return body.slice(open + "<style>".length, body.indexOf("</style>", open));
}

/** The selector of every rule in a stylesheet, whitespace flattened. */
const selectors = (sheet: string): readonly string[] =>
  [...sheet.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) =>
    (m[1] as string).trim().replace(/\s+/g, " "),
  );

const emptyBoard = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

const NONE: Rollup = { done: 0, open: 0, failed: 0 };

const aTree = (): readonly Node[] => [
  {
    entity: "project", id: 1, label: "a project", state: "planned", folded: false,
    rollup: NONE, children: [],
  },
];

const anApproval = (): readonly Approval[] => [
  {
    id: 4, objective_type: "task", objective_id: 12, worker_id: 1, phase: "waiting",
    kind: "approval", question: "is it settled?", options: null, answer: null,
    answered_by: null,
    evidence: { type: "task", id: 12, statement: "widen the scope", state: "attempting" },
  },
];

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

const fetched = async (at: string, page: ReturnType<typeof shelled>): Promise<string> => {
  const server = await serve({ [at]: page });
  servers.push(server);
  return await (await fetch(`${addressOf(server)}${at}`)).text();
};

describe("no page carries a stylesheet of its own", () => {
  it("has pages to hold to it", () => {
    expect(pages()).toEqual(expect.arrayContaining(["board.ts", "decisions.ts", "tree.ts"]));
  });

  it.each(["board.ts", "decisions.ts", "tree.ts"])("leaves no rules in %s", (page) => {
    const source = sourceOf(page);
    expect(source, "declares a stylesheet").not.toMatch(/\bconst STYLE\b/);
    expect(source, "opens a style element").not.toContain("<style");
    expect(source, "writes an inline style attribute").not.toContain("style=");
  });

  it("leaves no CSS rule in any page, named STYLE or not", () => {
    // A whole declaration block on a line of its own, which is how every rule of this
    // surface is written: `selector { property: value }`. Markup is ruled out by the
    // leading `<` a tag line starts with, and by the `${` an interpolation carries.
    const rule = /^\s*[a-z.#:][^<>{}$]*\{[^<>{}$]*:[^<>{}$]*\}\s*,?\s*$/;
    for (const page of pages()) {
      const offending = sourceOf(page)
        .split("\n")
        .filter((line) => rule.test(line) && !line.trimStart().startsWith("*"));
      expect(offending, `${page} still spells a CSS rule`).toEqual([]);
    }
  });

  it("keeps the rules in the shell, where the frame's already were", () => {
    const sheet = readFileSync(join(PAGES, "shell.ts"), "utf8");
    for (const moved of ["section li .code", "article dd.open", "ul.tree li .label"]) {
      expect(sheet, `the shell does not carry ${moved}`).toContain(moved);
    }
  });
});

describe("the shell cannot be handed one", () => {
  it("takes contents and a shell, and no stylesheet", () => {
    // Arity is the contract: a second string argument would be a page's own rules again.
    expect(document.length).toBe(1);
    expect(shelled.length).toBe(1);
  });

  it("dresses a page from the shell alone", () => {
    expect(styleOf(document("<p>a page</p>"))).toBe(styleOf(document("")));
  });
});

describe("the three pages come out in the one stylesheet", () => {
  const rendered = (): readonly [string, string][] => [
    ["board", boardPage(emptyBoard()).body],
    ["decisions", decisionsPage(anApproval()).body],
    ["tree", treePage(aTree()).body],
  ];

  it("gives all three the identical sheet", () => {
    const sheet = styleOf(document(""));
    for (const [name, body] of rendered()) {
      expect(styleOf(body), `${name} is dressed differently`).toBe(sheet);
    }
  });

  it("gives each of them exactly one", () => {
    for (const [name, body] of rendered()) {
      expect([...body.matchAll(/<style>/g)], `${name} carries two sheets`).toHaveLength(1);
    }
  });

  it("serves all three over a socket in that same sheet", async () => {
    const served = [
      await fetched("/", boardAt(emptyBoard)),
      await fetched("/decisions", decisionsAt(anApproval)),
      await fetched("/tree", treeAt(aTree)),
    ];
    const sheet = styleOf(document(""));
    for (const body of served) expect(styleOf(body)).toBe(sheet);
    // And the markup is still each page's own.
    expect(served[0] as string).toContain(`<section id="running"`);
    expect(served[1] as string).toContain(`<article id="approval-4"`);
    expect(served[2] as string).toContain(`<ul class="tree">`);
  });
});

describe("the one sheet still dresses each page, and only its own", () => {
  const SHEET = styleOf(document(""));

  it("keeps the frame's rules", () => {
    expect(selectors(SHEET)).toEqual(expect.arrayContaining([":root", "main", "h1"]));
  });

  it.each([
    ["the board's boxes", "section"],
    ["a decision's card", "article"],
    ["the tree's nesting", "ul.tree"],
  ])("dresses %s", (_what, shape) => {
    const mine = selectors(SHEET).filter((s) => s === shape || s.startsWith(`${shape} `));
    expect(mine.length).toBeGreaterThan(1);
  });

  it("selects every page's rules under that page's own shape", () => {
    // `li` unqualified would make the board's flex rows the tree's rows too; `dd` would
    // reach nothing on the board today and something on it tomorrow. A rule that is not
    // the frame's is written under the shape whose page draws it.
    const frame = [":root", "body", "main", "h1", "h2", "p.empty"];
    const shapes = ["section", "article", "ul.tree"];
    for (const selector of selectors(SHEET)) {
      if (frame.includes(selector)) continue;
      for (const one of selector.split(",").map((s) => s.trim())) {
        expect(
          shapes.some((shape) => one === shape || one.startsWith(`${shape} `)),
          `\`${one}\` is under no page's shape, so it reaches all three`,
        ).toBe(true);
      }
    }
  });

  it("gives the tree's rows no rule the board's rows have", () => {
    const flex = selectors(SHEET).filter((s) => SHEET.includes(`${s} { display: flex`));
    expect(flex).toContain("section li");
    for (const s of flex) expect(s.startsWith("ul.tree")).toBe(false);
  });
});
