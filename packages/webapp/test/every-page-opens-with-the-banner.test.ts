/** The banner carries every page, in a declared order, and every document wears it.
 *
 *  The surface had five pages and no way to get from one to another: a reader who opened
 *  the board could reach the tasks only by typing the path. Adding a row of links to each
 *  page would have been five answers to what the surface's pages are and what order they
 *  come in — the same mistake the look was in before it was declared, and it would have
 *  drifted the first time a page was added and one of the five rows was not.
 *
 *  So `renderers.webapp.banner.order` is the order, `shell.ts` is the only thing that turns
 *  it into markup, and this file holds three things:
 *    - the order is declared in the design and read off the file, so an edited design
 *      reorders the banner;
 *    - it names every page the package serves, once, and no page it does not serve;
 *    - every document carries it, once, inside the shell's one element, with each name
 *      pointing at where that page actually answers.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board } from "@wecode/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { addressOf, serve } from "../src/server.js";
import { boardAt } from "../src/pages/board.js";
import { discovered, pathOf } from "../src/pages/discover.js";
import { document, loadBanner, loadShell, shelled, ShellError } from "../src/pages/shell.js";

const DESIGN = fileURLToPath(new URL("../../tui/config/design.yaml", import.meta.url));
const TEXT = readFileSync(DESIGN, "utf8");
const ORDER = loadBanner();
const SHELL = loadShell();

/** The design file with one edit, written somewhere else — the only way to say the banner
 *  came off the file rather than out of a constant that happens to agree with it. */
function edited(from: string, to: string): string {
  expect(TEXT, from).toContain(from);
  const at = join(mkdtempSync(join(tmpdir(), "wecode-banner-")), "design.yaml");
  writeFileSync(at, TEXT.replace(from, to));
  return at;
}

const emptyBoard = (): Board => ({
  projects: [], stale: [], running: [], needs_human: [], queued: [], failed: [],
  dropped: [], unproven: [], open: [], planned: [], delivered: [], unmergeable: [],
  cooking: [],
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("the order is the design's, not the shell's", () => {
  it("sits in the browser's half of the design, beside the frame the banner is part of", () => {
    expect(TEXT.indexOf("\n    banner:\n")).toBeGreaterThan(TEXT.indexOf("\n  webapp:\n"));
    expect(TEXT.indexOf("\n    banner:\n")).toBeLessThan(TEXT.indexOf("\n  wireframe:\n"));
  });

  it("reorders the banner when the design is reordered", () => {
    const at = edited("        - page: board\n          says: Board\n", "");
    const reordered = loadBanner(at).map((tab) => tab.page);
    expect(reordered).not.toContain("board");
    expect(ORDER.map((tab) => tab.page)).toContain("board");
    expect(reordered).toEqual(ORDER.map((tab) => tab.page).filter((page) => page !== "board"));
  });

  it("renames what a page is offered as when the design renames it", () => {
    const at = edited("          says: Tasks", "          says: The inbox");
    expect(loadBanner(at).find((tab) => tab.page === "tasks")?.says).toBe("The inbox");
    expect(ORDER.find((tab) => tab.page === "tasks")?.says).toBe("Tasks");
  });

  it("refuses a design that declares no order, and says so", () => {
    const at = edited("    banner:\n      order:", "    banner:\n      absent:");
    expect(() => loadBanner(at)).toThrow(ShellError);
    expect(() => loadBanner(at)).toThrow(/declares no order/);
  });

  it("refuses a row that does not say which page it opens, or what it says", () => {
    const missing = edited("        - page: tree\n          says: Tree", "        - says: Tree");
    expect(() => loadBanner(missing)).toThrow(/order\[4\] declares no page/);
    const wordless = edited("        - page: tree\n          says: Tree", "        - page: tree");
    expect(() => loadBanner(wordless)).toThrow(/order\[4\] declares no says/);
  });
});

describe("it names every page the package serves, and only those", () => {
  const pages = discovered(readdirSync(fileURLToPath(new URL("../src/pages", import.meta.url))));

  it("has a name for each discovered page", () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(ORDER.map((tab) => tab.page).sort()).toEqual([...pages].sort());
  });

  it("names each page once, so a page has one way in and not two", () => {
    const named = ORDER.map((tab) => tab.page);
    expect(named.length).toBe(new Set(named).size);
  });

  it("offers a word that is not the filename, for every page", () => {
    for (const tab of ORDER) {
      expect(tab.says.length, tab.page).toBeGreaterThan(0);
      expect(tab.says, tab.page).not.toBe(tab.page);
    }
  });

  it("opens the board first, because that is what the surface opens on", () => {
    expect(ORDER[0]?.page).toBe("board");
  });

  it("points each name at where that page answers, and does not declare it twice", () => {
    for (const tab of ORDER) expect(tab.at, tab.page).toBe(pathOf(tab.page));
    expect(ORDER.find((tab) => tab.page === "board")?.at).toBe("/");
    expect(TEXT.slice(TEXT.indexOf("\n    banner:\n"), TEXT.indexOf("\n    sections:\n")))
      .not.toContain("at:");
  });
});

describe("every document wears it", () => {
  const body = document("<p>a page</p>");

  it("carries the word and the row, once, inside the shell's one element", () => {
    const inside = body.slice(body.indexOf(`<${SHELL.body}>`), body.indexOf(`</${SHELL.body}>`));
    expect(inside).toContain(`<h1>${SHELL.banner}</h1>`);
    expect([...body.matchAll(/<nav>/g)]).toHaveLength(1);
    expect(inside).toContain("<nav>");
  });

  it("writes the row under the word and above the page's own markup", () => {
    expect(body.indexOf("<nav>")).toBeGreaterThan(body.indexOf("<h1>"));
    expect(body.indexOf("<nav>")).toBeLessThan(body.indexOf("<p>a page</p>"));
  });

  it("writes one link per declared page, in the declared order", () => {
    const links = [...body.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual(ORDER.map((tab) => [tab.at, tab.says]));
  });

  it("styles the row out of the declared tokens, in the frame and not in a page", () => {
    // The row is in every document, so its rules are the frame's — a page-scoped block
    // would style nothing, and a loose rule would reach everybody's markup.
    expect(body).toContain("nav {");
    expect(body).toContain("nav a {");
    expect(body).toMatch(/nav a \{[^}]*var\(--faint\)/);
  });

  it("puts it in a page served over a socket, not only in the function", async () => {
    const server = await serve({ "/": boardAt(emptyBoard) });
    servers.push(server);
    const served = await (await fetch(`${addressOf(server)}/`)).text();
    for (const tab of ORDER) expect(served).toContain(`<a href="${tab.at}">${tab.says}</a>`);
  });

  it("gives a page no way to be served without it", () => {
    // `shelled` is the only way a page becomes a reply, and it does not take an opinion
    // about the banner from the page — the default is the design's.
    const reply = shelled(() => "<p>anything</p>")(new URL("http://localhost/"));
    expect(reply.body).toBe(document("<p>anything</p>"));
    expect(reply.body).toContain("<nav>");
  });
});
