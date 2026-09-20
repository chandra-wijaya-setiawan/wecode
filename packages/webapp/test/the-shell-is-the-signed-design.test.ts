/** The web surface's look is declared, and every page of it is drawn in the declared one.
 *
 *  The frame was already the design's — `renderers.webapp.shell` says what a document of
 *  this surface is. How it *looks* was not. Each of the five pages carried a template
 *  string with its own `#888`, `#6cf` and `ui-monospace` written into it: five answers to
 *  what faint is, what a mark is and what the surface is set in, which agree right up until
 *  one page is restyled and the others are not. Nothing could disagree with them, because
 *  there was nothing to disagree with.
 *
 *  So `renderers.webapp.look` is the signed look — a palette and a type by name, and the
 *  rules that spend them — `shell.ts` is the only thing that turns it into a stylesheet, and
 *  this file holds four things:
 *    - the look is declared beside the frame, in the renderer half, and read off the file
 *      rather than off `shell.ts` — an edited design restyles the surface;
 *    - every rule spends the named tokens, so a colour is one row and not a grep;
 *    - each page's rules are scoped to a shape only that page draws, which is what lets one
 *      sheet carry the whole surface without one page reaching into another;
 *    - no page of the package draws in a look of its own — a page that still hands one in is
 *      served the signed sheet regardless.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board } from "@wecode/core";
import { describe, expect, it } from "vitest";
import { boardBoxes } from "../src/pages/board.js";
import { discovered } from "../src/pages/discover.js";
import { document, loadLook, type Rules, ShellError, stylesheet } from "../src/pages/shell.js";

const DESIGN = fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url));
const TEXT = readFileSync(DESIGN, "utf8");
const LOOK = loadLook();
const SHEET = stylesheet();

/** The design file with one edit, written somewhere else — the only way to say the sheet
 *  came off the file rather than out of a constant that happens to agree with it. */
function edited(from: string, to: string): string {
  expect(TEXT, from).toContain(from);
  const at = join(mkdtempSync(join(tmpdir(), "wecode-look-")), "design.yaml");
  writeFileSync(at, TEXT.replace(from, to));
  return at;
}

/** Every selector the block declares, queries unwrapped: a rule inside `@media` is still a
 *  rule about somebody's markup, and is held to the same scope as one outside it. */
function selectors(rules: Rules): readonly string[] {
  return Object.entries(rules).flatMap(([selector, held]) =>
    typeof held === "string" ? [selector] : selectors(held as Rules),
  );
}

/** Every declaration in the whole look, wherever it sits. */
function declarations(rules: Rules): readonly string[] {
  return Object.values(rules).flatMap((held) =>
    typeof held === "string" ? [held] : declarations(held as Rules),
  );
}

const everyRule = [LOOK.frame, ...Object.values(LOOK.pages)];

const emptyBoard = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

describe("the look is declared, not written into the pages", () => {
  it("sits in the browser's half of the design, beside the frame it wears", () => {
    expect(TEXT.indexOf("\n    look:\n")).toBeGreaterThan(TEXT.indexOf("\n  webapp:\n"));
    expect(TEXT.indexOf("\n    look:\n")).toBeLessThan(TEXT.indexOf("\n  wireframe:\n"));
  });

  it("names the palette, the type and the way round the surface is", () => {
    expect(LOOK.scheme).toBe("dark");
    // Named by what they are for. A rule that wanted a new colour would have to say what
    // the colour is for before it could spend it.
    expect(Object.keys(LOOK.palette)).toContain("ink");
    expect(Object.keys(LOOK.palette)).toContain("faint");
    expect(Object.keys(LOOK.palette)).toContain("mark");
    expect(LOOK.type["family"]).toContain("monospace");
  });

  it("declares a block for every page the package serves, and none for a page it does not", () => {
    const dir = fileURLToPath(new URL("../src/pages", import.meta.url));
    const pages = discovered(readdirSync(dir));
    expect(pages.length).toBeGreaterThan(0);
    expect(Object.keys(LOOK.pages).sort()).toEqual([...pages].sort());
    expect(Object.keys(LOOK.roots).sort()).toEqual([...pages].sort());
  });

  it("restyles the surface when the design is edited", () => {
    const at = edited(`        ink: "#ddd"`, `        ink: "#0f0"`);
    expect(loadLook(at).palette["ink"]).toBe("#0f0");
    expect(stylesheet(loadLook(at))).toContain("--ink: #0f0");
    expect(SHEET).not.toContain("--ink: #0f0");
  });

  it("refuses a design that declares no look, and names what is missing", () => {
    const at = edited("      palette:\n", "      absent:\n");
    expect(() => loadLook(at)).toThrow(ShellError);
    expect(() => loadLook(at)).toThrow(/no palette/);
  });
});

describe("every rule spends the named tokens", () => {
  it("spells no colour of its own anywhere in the look", () => {
    for (const said of declarations(Object.assign({}, ...everyRule) as Rules)) {
      expect(said, said).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("names only tokens the palette or the type declares", () => {
    const declared = new Set([...Object.keys(LOOK.palette), ...Object.keys(LOOK.type)]);
    for (const rules of everyRule) {
      for (const said of declarations(rules)) {
        for (const [, name] of said.matchAll(/var\(--([a-z-]+)\)/g)) {
          expect(declared.has(name as string), `${name} is spent but never declared`).toBe(true);
        }
      }
    }
  });

  it("writes every declared token into the sheet, once, at the root", () => {
    const root = SHEET.slice(0, SHEET.indexOf("\n"));
    expect(root.startsWith(":root {")).toBe(true);
    expect(root).toContain(`color-scheme: ${LOOK.scheme}`);
    for (const [name, held] of Object.entries({ ...LOOK.palette, ...LOOK.type })) {
      expect(root, name).toContain(`--${name}: ${held}`);
      expect([...SHEET.matchAll(new RegExp(`--${name}:`, "g"))].length, name).toBe(1);
    }
  });
});

describe("one sheet carries the whole surface, and no page reaches into another", () => {
  it("scopes every page's rules to a shape that page's roots declare", () => {
    for (const [page, rules] of Object.entries(LOOK.pages)) {
      const roots = LOOK.roots[page] ?? [];
      expect(roots.length, page).toBeGreaterThan(0);
      for (const selector of selectors(rules)) {
        const held = roots.some((root) => selector.split(",").every((part) => part.trim().startsWith(root)));
        expect(held, `${page} styles ${selector}, which is outside ${roots.join(" or ")}`).toBe(true);
      }
    }
  });

  it("gives no two pages the same root, so a scope belongs to one page", () => {
    const seen = new Map<string, string>();
    for (const [page, roots] of Object.entries(LOOK.roots)) {
      for (const root of roots) {
        expect(seen.get(root), `${root} is ${page}'s and ${seen.get(root)}'s`).toBeUndefined();
        seen.set(root, page);
      }
    }
  });

  it("declares each selector once in the whole look, so nothing is answered twice", () => {
    // Inside a query it may be said again — that is what a query is for, and why the count
    // is taken one scope at a time rather than over the whole tree.
    const said = everyRule.flatMap((rules) =>
      Object.entries(rules).filter(([, held]) => typeof held === "string").map(([s]) => s),
    );
    expect(said.length).toBe(new Set(said).size);
  });

  it("keeps the frame out of the pages' shapes and the pages out of the frame's", () => {
    // The frame is the document: the element the shell puts a page inside, its banner, its
    // type. None of it is any one page's, so none of it is scoped to a page's root.
    expect(Object.keys(LOOK.frame)).toContain("body");
    expect(Object.keys(LOOK.frame)).toContain("main");
    expect(Object.keys(LOOK.frame)).toContain("h1");
    const roots = Object.values(LOOK.roots).flat();
    for (const selector of selectors(LOOK.frame)) {
      for (const root of roots) {
        expect(selector === root, `${selector} is the frame's and ${root} is a page's`).toBe(false);
      }
    }
  });

  it("writes the frame's rules before any page's, so a page may override the document", () => {
    const first = SHEET.indexOf("\nbody {");
    expect(first).toBeGreaterThan(0);
    for (const rules of Object.values(LOOK.pages)) {
      for (const selector of selectors(rules)) {
        expect(SHEET.indexOf(`\n${selector} `), selector).toBeGreaterThan(first);
      }
    }
  });

  it("keeps a query a query, with its rules inside it", () => {
    // A responsive rule is still one of the page's, and is held to the same scope — but it
    // is written as the query the browser needs and not flattened into a selector.
    expect(SHEET).toMatch(/@media \(max-width: 48rem\) \{\n {2}div\.inbox \{[^}]*\}\n\}/);
  });
});

describe("every page is drawn in it", () => {
  it("puts the whole declared sheet in every document", () => {
    const body = document("<p>a page</p>");
    expect(body).toContain(`<style>${SHEET}</style>`);
    for (const rules of everyRule) {
      for (const selector of selectors(rules)) expect(body, selector).toContain(`${selector} {`);
    }
  });

  it("serves the signed sheet to a page that still hands one in of its own", () => {
    // The look is the design's. A page passing a stylesheet is a page with an opinion about
    // the surface, and the document is drawn without it.
    expect(document("<p>a page</p>", "p { color: red }")).toBe(document("<p>a page</p>"));
    expect(document("<p>a page</p>", "p { color: red }")).not.toContain("color: red");
  });

  it("carries no loose rule — every rule in the sheet is the frame's or one page's", () => {
    // What the pages' own sheets did, and what makes putting them all in one document safe
    // to stop doing: each of them styled bare `li`, bare `h2`, bare `.code`. Loose in one
    // page's document that reaches only that page's markup; loose in the surface's sheet it
    // reaches everybody's. So the sheet is read back and held to it, rule by rule.
    const roots = Object.values(LOOK.roots).flat();
    const frame = selectors(LOOK.frame);
    for (const [, selector] of SHEET.matchAll(/^([^\s{][^{\n]*) \{/gm)) {
      const said = (selector as string).trim();
      if (said === ":root" || frame.includes(said) || said.startsWith("@")) continue;
      const held = roots.some((root) => said.split(",").every((p) => p.trim().startsWith(root)));
      expect(held, `${said} is loose in the surface's sheet`).toBe(true);
    }
  });

  it("leaves the page the look was taken out of writing no stylesheet at all", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/pages/board.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("const STYLE");
    expect(source, "board.ts spells a colour").not.toMatch(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/);
    expect(source, "board.ts spells a typeface").not.toContain("monospace");
  });

  it("draws the board in the shape the design scopes the board's rules to", () => {
    const root = LOOK.roots["board"]?.[0] as string;
    const [element, shape] = root.split(".");
    const drawn = boardBoxes(emptyBoard());
    expect(drawn).toContain(`<${element} `);
    expect(drawn).toContain(`class="${shape}"`);
  });
});
