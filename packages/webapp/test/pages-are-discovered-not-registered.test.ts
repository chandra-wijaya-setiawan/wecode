/** The web surface's pages are the files under `src/pages/`, and nothing else says so.
 *
 *  A route table is a second declaration of the surface: the page exists, and a list
 *  somewhere else has to agree. When they disagree the page is simply missing, with nothing
 *  red to say so — so the list is gone and the directory is the list.
 *
 *  This file holds four things:
 *    - a file dropped into `pages/` is routed, with no edit anywhere else;
 *    - a page answers at its own name, and the board answers at `/`;
 *    - a page is served from the reading it asks for, and from the record if it asks for
 *      nothing;
 *    - `bin.ts` names no page at all — the proof that the table is gone and not merely
 *      duplicated.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answer, html } from "../src/index.js";
import {
  discovered,
  HOME,
  mounted,
  NOT_PAGES,
  pages,
  pathOf,
  PageError,
  READS_BY_DEFAULT,
} from "../src/pages/discover.js";

const SRC = fileURLToPath(new URL("../src/pages", import.meta.url));

/** A pages directory of one's own, with whatever files a test wants in it. Discovery read
 *  against a made-up directory is the only way to say a page is found rather than known:
 *  an assertion against the real `pages/` cannot tell a reader from a list that happens to
 *  agree with it. */
function directory(files: Readonly<Record<string, string>>): URL {
  const at = mkdtempSync(join(tmpdir(), "wecode-pages-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(at, name), source);
  return pathToFileURL(`${at}/`);
}

/** A page module, written out. It says what it read, so that a test can tell which reading
 *  it was handed without looking at the wiring. */
const pageModule = (name: string, reads?: string): string =>
  `${reads === undefined ? "" : `export const READS = ${JSON.stringify(reads)};\n`}` +
  `export const ${name}At = (read) => () => ({ status: 200, type: "text/plain", body: String(read()) });\n`;

const READINGS = {
  record: () => "the record",
  board: () => "the board",
  approvals: () => "the approvals",
};

describe("a page is a file under pages/", () => {
  it("routes a file nobody registered", async () => {
    const dir = directory({ "weather.js": pageModule("weather") });
    const routes = await pages(READINGS, dir);

    expect(Object.keys(routes)).toEqual(["/weather"]);
    expect(answer(routes, "GET", "/weather").body).toBe("the record");
  });

  it("routes a second file with no edit to the first", async () => {
    const dir = directory({
      "weather.js": pageModule("weather"),
      "tides.js": pageModule("tides", "board"),
    });
    const routes = await pages(READINGS, dir);

    expect(Object.keys(routes).sort()).toEqual(["/tides", "/weather"]);
    expect(answer(routes, "GET", "/tides").body).toBe("the board");
  });

  it("finds the pages of a directory, in an order a filesystem cannot change", () => {
    expect(discovered(["tides.ts", "weather.ts", "board.ts"])).toEqual([
      "board",
      "tides",
      "weather",
    ]);
  });

  it("finds a page whether it is source or built, and never its types", () => {
    expect(discovered(["weather.ts"])).toEqual(["weather"]);
    expect(discovered(["weather.js", "weather.d.ts"])).toEqual(["weather"]);
    expect(discovered(["views.yaml", "README.md"])).toEqual([]);
  });

  it("leaves out the files that are not pages", () => {
    expect(NOT_PAGES).toContain("shell");
    expect(discovered(NOT_PAGES.map((n) => `${n}.ts`))).toEqual([]);
  });
});

describe("a page answers at its own name", () => {
  it("opens the surface on the board", () => {
    expect(pathOf(HOME)).toBe("/");
    expect(HOME).toBe("board");
  });

  it("gives every other page the path its file is called", () => {
    expect(pathOf("tree")).toBe("/tree");
    expect(pathOf("decisions")).toBe("/decisions");
  });

  it("serves the board at the root of a directory it was found in", async () => {
    const dir = directory({ "board.js": pageModule("board", "board") });
    const routes = await pages(READINGS, dir);

    expect(Object.keys(routes)).toEqual(["/"]);
    expect(answer(routes, "GET", "/").body).toBe("the board");
  });
});

describe("a page is served from the reading it asks for", () => {
  const module = (reads?: string): Record<string, unknown> => ({
    ...(reads === undefined ? {} : { READS: reads }),
    weatherAt: (read: () => unknown) => () => html(String(read())),
  });

  it("reads the record when it asks for nothing", () => {
    expect(READS_BY_DEFAULT).toBe("record");
    const handler = mounted("weather", module(), READINGS) as (url: URL) => { body: string };
    expect(handler(new URL("http://x/weather")).body).toBe("the record");
  });

  it("reads what it named when it named one", () => {
    const handler = mounted("weather", module("approvals"), READINGS) as (url: URL) => {
      body: string;
    };
    expect(handler(new URL("http://x/weather")).body).toBe("the approvals");
  });

  it("refuses a reading of the workspace nobody offers, and says which there are", () => {
    expect(() => mounted("weather", module("rainfall"), READINGS)).toThrow(PageError);
    expect(() => mounted("weather", module("rainfall"), READINGS)).toThrow(
      /reads rainfall.*approvals board record/,
    );
  });

  it("refuses a file that is neither a page nor declared as not one", () => {
    expect(() => mounted("weather", { helper: () => null }, READINGS)).toThrow(PageError);
    expect(() => mounted("weather", { helper: () => null }, READINGS)).toThrow(/exports no weatherAt/);
  });
});

describe("the surface this repository has", () => {
  it("is every page file there is, at the paths they are read on", async () => {
    const files = discovered(readdirSync(SRC));

    // Naming the pages here would be the route table again, in a test. The directory is the
    // list, so the expectation is read from it: whatever files are there are the surface.
    expect(files).toContain(HOME);
    const routes = await pages(READINGS, new URL("../src/pages/", import.meta.url));
    expect(Object.keys(routes).sort()).toEqual(files.map(pathOf).sort());
  });

  it("gains a page when a file is added, with nothing in this test to edit", async () => {
    const before = discovered(readdirSync(SRC));
    const dir = directory({
      ...Object.fromEntries(before.map((n) => [`${n}.js`, pageModule(n)])),
      "weather.js": pageModule("weather"),
    });
    const routes = await pages(READINGS, dir);

    expect(Object.keys(routes).sort()).toEqual([...before, "weather"].map(pathOf).sort());
  });

  it("names no page in bin.ts — the table is gone, not copied", () => {
    const bin = readFileSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "utf8");

    for (const name of discovered(readdirSync(SRC))) {
      expect(bin, `bin.ts names the ${name} page`).not.toContain(`pages/${name}.js`);
      expect(bin, `bin.ts routes the ${name} page`).not.toContain(`"${pathOf(name)}":`);
    }
    // What it does still name is the one verb, which is not a page and not under `pages/`.
    expect(bin).toContain(`"/answer": answerAt(`);
  });
});
