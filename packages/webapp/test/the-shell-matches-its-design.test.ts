/** The web surface's frame is declared, and every page of it wears the declared one.
 *
 *  design.yaml is one design with three renderers on it. Two of them were already there —
 *  the terminal the ink gate holds, and the wireframe the projector draws — and the third,
 *  the browser, drew whatever `board.ts` happened to spell in a template string. A document
 *  written out inside a page is a design nothing can disagree with, because there is no
 *  design: rename the product and the tab keeps the old word until somebody greps for it.
 *
 *  So `renderers.webapp.shell` says what a document of this surface is, `shell.ts` is the
 *  only thing that turns those words into markup, and this file holds three things:
 *    - the shell is read off the design file and not off `shell.ts` — an edited design
 *      moves the document;
 *    - a page put through `shelled` comes out in that frame, over a socket too;
 *    - no page of the package makes a document of its own.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import { addressOf, boardAt, boardPage, serve } from "../src/index.js";
import { document, loadShell, shelled, ShellError } from "../src/pages/shell.js";

const DESIGN = fileURLToPath(
  new URL("../../tui/config/design.yaml", import.meta.url),
);
const TEXT = readFileSync(DESIGN, "utf8");
const SHELL = loadShell();

/** The design file with one edit, written somewhere else. Reading the shell back out of a
 *  copy is the only way to say the document came from the file: an assertion against the
 *  real config cannot tell a reader from a literal that happens to agree with it. */
function edited(from: string, to: string): string {
  expect(TEXT, from).toContain(from);
  const at = join(mkdtempSync(join(tmpdir(), "wecode-shell-")), "design.yaml");
  writeFileSync(at, TEXT.replace(from, to));
  return at;
}

const emptyBoard = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((done) => s.close(done));
});

describe("the shell is the design's, not the page's", () => {
  it("declares the webapp beside the other renderers", () => {
    expect(TEXT).toContain("\n  webapp:\n");
    expect(TEXT.indexOf("\n  webapp:\n")).toBeGreaterThan(TEXT.indexOf("\nrenderers:\n"));
    expect(TEXT.indexOf("\n  webapp:\n")).toBeLessThan(TEXT.indexOf("\nshared:\n"));
  });

  it("reads every sentence of the frame off the file", () => {
    expect(SHELL).toEqual({
      doctype: "<!doctype html>",
      lang: "en",
      charset: "utf-8",
      viewport: "width=device-width, initial-scale=1",
      title: "wecode",
      banner: "wecode",
      body: "main",
    });
  });

  it("moves when the design moves", () => {
    const at = edited("      title: wecode\n      banner: wecode", "      title: elsewhere\n      banner: a board");
    const shell = loadShell(at);
    expect(shell.title).toBe("elsewhere");
    expect(shell.banner).toBe("a board");
    expect(document("", shell)).toContain("<title>elsewhere</title>");
    expect(document("", shell)).toContain("<h1>a board</h1>");
  });

  it("refuses a design that does not declare the frame, and names what is missing", () => {
    const at = edited("      lang: en\n", "");
    expect(() => loadShell(at)).toThrow(ShellError);
    expect(() => loadShell(at)).toThrow(/no lang/);
  });
});

describe("the document is the declared frame", () => {
  const body = document("<p>a page</p>");

  it("opens with the declared doctype and language", () => {
    expect(body.startsWith(`${SHELL.doctype}\n`)).toBe(true);
    expect(body).toContain(`<html lang="${SHELL.lang}">`);
  });

  it("carries the declared charset, viewport and title", () => {
    expect(body).toContain(`<meta charset="${SHELL.charset}">`);
    expect(body).toContain(`<meta name="viewport" content="${SHELL.viewport}">`);
    expect(body).toContain(`<title>${SHELL.title}</title>`);
  });

  it("carries the banner once, and the page's markup inside the one element", () => {
    expect([...body.matchAll(/<h1>/g)]).toHaveLength(1);
    const inside = body.slice(
      body.indexOf(`<${SHELL.body}>`),
      body.indexOf(`</${SHELL.body}>`),
    );
    expect(inside).toContain(`<h1>${SHELL.banner}</h1>`);
    expect(inside).toContain("<p>a page</p>");
    expect([...body.matchAll(/<main>/g)]).toHaveLength(1);
  });

  it("keeps the one stylesheet in the document", () => {
    expect(body).toContain("<style>");
    expect(body).toContain("color-scheme: dark");
    expect(body).not.toContain("<link");
    expect([...body.matchAll(/<style>/g)]).toHaveLength(1);
  });
});

describe("every page wears it", () => {
  it("turns a page's markup into a reply in the shell", async () => {
    const page = shelled(() => "<p>anything</p>");
    const reply = page(new URL("http://localhost/"));
    expect(reply.status).toBe(200);
    expect(reply.type).toBe("text/html; charset=utf-8");
    expect(reply.body).toBe(document("<p>anything</p>"));
  });

  it("gives a page its own query and none of the document", () => {
    const page = shelled((url) => `<p>${url.searchParams.get("q")}</p>`);
    expect(page(new URL("http://localhost/?q=hello")).body).toContain("<p>hello</p>");
  });

  it("serves the board in it, over a socket", async () => {
    const server = await serve({ "/": boardAt(emptyBoard) });
    servers.push(server);
    const served = await (await fetch(`${addressOf(server)}/`)).text();
    expect(served.startsWith(`${SHELL.doctype}\n`)).toBe(true);
    expect(served).toContain(`<title>${SHELL.title}</title>`);
    expect(served).toContain(`<h1>${SHELL.banner}</h1>`);
    // Its boxes are inside the shell's one element, not beside it.
    const inside = served.slice(
      served.indexOf(`<${SHELL.body}>`),
      served.indexOf(`</${SHELL.body}>`),
    );
    expect(inside).toContain(`<section id="running"`);
    expect(boardPage(emptyBoard()).body).toBe(served);
  });

  it("leaves no page of the package making a document of its own", () => {
    const dir = fileURLToPath(new URL("../src/pages", import.meta.url));
    const pages = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "shell.ts");
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const source = readFileSync(join(dir, page), "utf8");
      expect(source, `${page} spells its own document`).not.toContain("<!doctype");
      expect(source, `${page} spells its own html element`).not.toContain("<html");
      expect(source, `${page} goes round the shell`).toContain(`from "./shell.js"`);
    }
  });
});
