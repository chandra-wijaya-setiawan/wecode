/** Every page of the surface, mounted the way `bin.ts` mounts it, against the workspace
 *  the operator is actually working in — and nothing else in the suite does that.
 *
 *  A hand-made board proves a page's arithmetic; it cannot prove a page was wired to the
 *  question it answers. `projects.ts` was mounted on the *record* — it declared no `READS`,
 *  so discovery handed it `tree()`'s nodes while its own factory expects a `Board` — and
 *  every page test in this directory stayed green, because each one calls its page's
 *  factory itself and hands it the right shape by hand. The only reader who found out was
 *  the operator, on the front page.
 *
 *  So this file mounts nothing by name. It asks `pages()` for the surface, hands it the
 *  readings `bin.ts` hands it, and fetches every path that comes back. What is proved is
 *  the wiring and the data together: a page that reads the wrong question throws, and a
 *  page that reads the right one meets values only a live ledger has — thousands of nodes,
 *  a project nobody has touched in a month, a name someone typed in a hurry.
 *
 *  The readings are a copy, and a copy can fall behind the original — so they are held
 *  against `bin.ts`'s own by name, and against what every page declares it reads, before a
 *  single mount is attempted. Those two are the only tests here that do not need a live
 *  workspace, because a missing name is a drift in this file and not in the record.
 *
 *  Read-only, twice over. The database is opened through `node:sqlite` with `readOnly`
 *  rather than through `open()`, which refuses the operator's own workspace from a test for
 *  exactly the right reason: it migrates. A read-only handle cannot write, cannot migrate
 *  and cannot lock — and the file's size and mtime are checked afterwards to say so.
 *
 *  Where there is no such workspace — a fresh clone, or CI — there is nothing to prove
 *  against and these tests do not run. That is the one shape of green this file allows
 *  itself to be wrong about, and it is announced rather than silent. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { board, diagnose, sketches, tree, waitingApprovals, type Board } from "@wecode/core";
import { afterAll, describe, expect, it } from "vitest";
import { answer } from "../src/index.js";
import { discovered, pages, pathOf, READS_BY_DEFAULT } from "../src/pages/discover.js";
import type { Routes } from "../src/server.js";

/** The operator's own home, read as it is. `wecodeHome()` redirects to a temp directory
 *  under the test runner — which is what keeps the rest of the suite off this file — so
 *  the one test that means the live home has to spell it. */
const LIVE_HOME = join(homedir(), ".wecode", "workspaces");

/** The live workspaces this build can answer questions about. A database from another
 *  build's schema is left alone rather than reported: what it would prove is that two
 *  builds disagree, which the doctor says better than a page does. */
function liveDatabases(): readonly string[] {
  if (!existsSync(LIVE_HOME)) return [];
  return readdirSync(LIVE_HOME, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(LIVE_HOME, e.name, "wecode.db"))
    .filter((path) => existsSync(path) && diagnose(path).state === "current");
}

const LIVE = liveDatabases();

/** The biggest live workspace there is — the operator's real one rather than a workspace
 *  they onboarded once and left. Size, because the question this file asks is what the
 *  page does with a ledger that has been worked in. */
const busiest = (paths: readonly string[]): string =>
  [...paths].sort((a, b) => statSync(b).size - statSync(a).size)[0] as string;

const open = (path: string): DatabaseSync => new DatabaseSync(path, { readOnly: true });

/** A workspace's readings, spelled the way `bin.ts` spells them and for the same reason:
 *  a reading list of this test's own would prove this test's wiring, not the surface's.
 *
 *  A copy is a copy, and this one fell behind `bin.ts` the day `pages/sketches` landed: the
 *  page asked a question this list had never heard of, so every mount in this file threw
 *  and the whole surface went unproved. The two tests under "the readings this file hands
 *  the surface" are what hold the copy to the original now — the next reading to be added
 *  reds one named test that says which word is missing, rather than six that say a page
 *  cannot be mounted. */
const readingsOf = (db: DatabaseSync) => ({
  record: () => tree(db),
  board: () => board(db),
  approvals: () => waitingApprovals(db),
  sketches: () => sketches(db),
});

const handles: DatabaseSync[] = [];
const held = (path: string): DatabaseSync => {
  const db = open(path);
  handles.push(db);
  return db;
};

afterAll(() => {
  for (const db of handles.splice(0)) db.close();
});

/** Where the pages are, with the slash: the modules below are imported by a URL built on
 *  this one, and a template-literal *relative* specifier is what vite refuses with "Unknown
 *  variable dynamic import". */
const PAGES = new URL("../src/pages/", import.meta.url);

const NAMES = discovered(readdirSync(PAGES));
const PATHS = NAMES.map(pathOf);

const surfaceOf = async (path: string): Promise<Routes> => pages(readingsOf(held(path)));

/** A request target as the url a page is handed for it — the base `answer` builds on, which
 *  a page never reads: what a page reads of a target is its path and its params. */
const target = (at: string): URL => new URL(at, "http://localhost");

/** What the busiest live record has drawn, read once at collection so that a test about the
 *  empty shape can say it is the empty shape it is proving. */
const DRAWN = LIVE.length === 0 ? [] : sketches(held(busiest(LIVE)));

/** The names this file's copy offers. No database is opened to ask for them: a reading is a
 *  closure and nothing here calls one, so the two tests below hold on a fresh clone as well
 *  — where there is no live workspace and the rest of this file is skipped. */
const OFFERED = Object.keys(readingsOf(null as unknown as DatabaseSync)).sort();

/** The names `bin.ts` offers, read off `bin.ts`. Its `readings` cannot be imported — that
 *  file *is* the process: importing it parses argv, opens a database and binds a port — so
 *  the object literal is read as text. One key per `<name>: () => …` line, which is the one
 *  way that file spells a reading. */
function declaredByBin(): readonly string[] {
  const source = readFileSync(new URL("../src/bin.ts", import.meta.url), "utf8");
  const from = source.indexOf("const readings = {");
  if (from < 0) throw new Error("bin.ts declares no `const readings = {` to be held against");
  const block = source.slice(from, source.indexOf("\n};", from));
  return [...block.matchAll(/^\s*(\w+): \(\) =>/gm)].map((m) => m[1] as string).sort();
}

/** The copy against the original, and every page's question against the copy. Neither test
 *  needs a workspace: what they prove is that this file asks the surface the questions the
 *  surface is asking for, which is the one thing its six live mounts cannot say for
 *  themselves — a name missing here throws at mount, and a throw at mount is every test in
 *  the file red at once with nothing saying which word it was. */
describe("the readings this file hands the surface", () => {
  it("offers exactly the readings bin.ts offers", () => {
    const declared = declaredByBin();
    expect(declared.length, "bin.ts's readings read as none").toBeGreaterThan(1);
    expect(OFFERED).toEqual(declared);
  });

  it("offers a reading for every question the pages ask", async () => {
    expect(NAMES, "the surface has no sketches page to mount").toContain("sketches");
    for (const name of NAMES) {
      const module = (await import(new URL(`${name}.ts`, PAGES).href)) as Record<string, unknown>;
      const reads = module["READS"] ?? READS_BY_DEFAULT;
      expect(OFFERED, `pages/${name} reads ${String(reads)}`).toContain(reads);
    }
  });
});

describe.skipIf(LIVE.length === 0)("every page, against the operator's own workspace", () => {
  it("has a workspace to be proved against at all", () => {
    expect(LIVE.length).toBeGreaterThan(0);
    expect(PATHS).toContain("/");
    expect(PATHS.length).toBeGreaterThan(1);
  });

  it("mounts the whole surface on the readings bin.ts offers", async () => {
    const routes = await surfaceOf(busiest(LIVE));
    expect(Object.keys(routes).sort()).toEqual([...PATHS].sort());
  });

  it("answers a whole document on every page, in every live workspace", async () => {
    for (const path of LIVE) {
      const routes = await surfaceOf(path);
      for (const at of PATHS) {
        const reply = answer(routes, "GET", at);
        expect(reply.status, `${at} of ${path}`).toBe(200);
        expect(reply.type, `${at} of ${path}`).toContain("text/html");
        expect(reply.body.trimEnd().endsWith("</html>"), `${at} of ${path}`).toBe(true);
      }
    }
  });

  it("draws the operator's own rows on the front page, not an empty one", async () => {
    const path = busiest(LIVE);
    const rows = board(held(path)).projects;
    expect(rows.length, "the busiest live workspace holds no project").toBeGreaterThan(0);

    const body = answer(await surfaceOf(path), "GET", "/projects").body;
    const ids = [...body.matchAll(/<li id="project-(\d+)">/g)].map((m) => m[1] as string);
    expect(ids).toEqual(rows.map((p) => String(p.id)));
    for (const p of rows) expect(body).toContain(`#${p.id}`);
  });

  it("draws the record's own drawings on the sketches page, in every live workspace", async () => {
    for (const path of LIVE) {
      const db = held(path);
      // The reading is the `sketch` table and nothing else: the count SQL gives and the
      // count the reading gives are the same count, so a reading that had quietly become a
      // view of something else — the record, a slice, a cap — would say so here.
      const drawn = readingsOf(db).sketches();
      const counted = db.prepare("select count(*) as n from sketch").get() as { n: number };
      expect(drawn.length, `${path} holds ${String(counted.n)} sketches`).toBe(counted.n);

      const body = answer(await surfaceOf(path), "GET", "/sketches").body;
      const ids = [...body.matchAll(/<li id="sketch-(\d+)">/g)].map((m) => m[1] as string);
      expect(ids, path).toEqual(drawn.map((s) => String(s.id)));
      for (const s of drawn) expect(body, path).toContain(`#${s.id}`);
    }
  });

  /** Most days nobody has drawn anything, and on this machine the live `sketch` table holds
   *  no row at all — so what there is to prove against a live ledger is the shape of an
   *  empty record: the page says the record is empty, in its own whole document, rather
   *  than coming back blank. Skipped the day there is a drawing, because the list then
   *  carries relative times and two documents built a moment apart are the same document
   *  only until one of them crosses a minute. */
  const emptily = it.skipIf(DRAWN.length > 0);
  emptily("says an empty sketch record is empty, in the page's own document", async () => {
    const path = busiest(LIVE);
    const drawn = sketches(held(path));
    expect(drawn, "the live record grew a drawing under this test").toEqual([]);

    const served = answer(await surfaceOf(path), "GET", "/sketches");
    const { sketchesPage } = await import("../src/pages/sketches.js");
    expect(served.status).toBe(200);
    expect(served.body).toBe(sketchesPage(drawn, target("/sketches")).body);
    expect(served.body).not.toContain(`<li id="sketch-`);
  });

  it("says so where the target names a drawing the live record has not got", async () => {
    const path = busiest(LIVE);
    const drawn = sketches(held(path));
    const missing = drawn.reduce((n, s) => Math.max(n, s.id), 0) + 1;
    const at = `/sketches?open=${missing}`;

    // The open view renders nothing dated, so this holds whether or not the record has
    // drawings in it — and `sketchesPage` and the mounted page are the same document, which
    // a page mounted on the record could not be: `tree()`'s nodes carry no sketch.
    const served = answer(await surfaceOf(path), "GET", at);
    const { sketchesPage } = await import("../src/pages/sketches.js");
    expect(served.status).toBe(200);
    expect(served.body).toBe(sketchesPage(drawn, target(at)).body);
    expect(served.body).toContain(`#${missing}`);
    expect(served.body).not.toContain(`<li id="sketch-`);
  });

  it("reads the same question the front page's own factory takes", async () => {
    const path = busiest(LIVE);
    const routes = await surfaceOf(path);
    const served = answer(routes, "GET", "/projects").body;

    // Against the live rows, `projectsPage` and the mounted page are the same document.
    // A page mounted on the wrong reading cannot be: `tree()` has no `.projects`.
    const { projectsPage } = await import("../src/pages/projects.js");
    expect(served).toBe(projectsPage(board(held(path))).body);
  });

  it("counts every box of the strip against the live board", async () => {
    const path = busiest(LIVE);
    const live: Board = board(held(path));
    const body = answer(await surfaceOf(path), "GET", "/projects").body;
    const strip = body.slice(body.indexOf(`<ul class="strip">`), body.indexOf("</ul>"));
    const counts = [...strip.matchAll(/<span class="count">(\d+)<\/span>/g)].map((m) =>
      Number(m[1]),
    );
    expect(counts.length).toBeGreaterThan(0);
    // Every cell's number is a box of the board, and none of them is invented.
    const sizes = Object.values(live).map((rows) => (rows as readonly unknown[]).length);
    for (const n of counts) expect(sizes).toContain(n);
  });
});

describe.skipIf(LIVE.length === 0)("and writes nothing while doing it", () => {
  it("leaves every live database byte for byte as it found it", async () => {
    const before = LIVE.map((p) => statSync(p));
    for (const path of LIVE) {
      const routes = await surfaceOf(path);
      for (const at of PATHS) expect(answer(routes, "GET", at).status).toBe(200);
    }
    LIVE.forEach((path, i) => {
      const now = statSync(path);
      expect(now.size, path).toBe((before[i] as ReturnType<typeof statSync>).size);
      expect(now.mtimeMs, path).toBe((before[i] as ReturnType<typeof statSync>).mtimeMs);
    });
  });

  it("holds a handle that refuses to write at all", () => {
    const db = held(busiest(LIVE));
    expect(() => db.exec("CREATE TABLE proof (x)")).toThrow();
  });
});
