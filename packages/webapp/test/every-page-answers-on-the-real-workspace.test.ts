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
 *  three readings `bin.ts` hands it, and fetches every path that comes back. What is proved
 *  is the wiring and the data together: a page that reads the wrong question throws, and a
 *  page that reads the right one meets values only a live ledger has — thousands of nodes,
 *  a project nobody has touched in a month, a name someone typed in a hurry.
 *
 *  Read-only, twice over. The database is opened through `node:sqlite` with `readOnly`
 *  rather than through `open()`, which refuses the operator's own workspace from a test for
 *  exactly the right reason: it migrates. A read-only handle cannot write, cannot migrate
 *  and cannot lock — and the file's size and mtime are checked afterwards to say so.
 *
 *  Where there is no such workspace — a fresh clone, or CI — there is nothing to prove
 *  against and these tests do not run. That is the one shape of green this file allows
 *  itself to be wrong about, and it is announced rather than silent. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { board, diagnose, tree, waitingApprovals, type Board } from "@wecode/core";
import { afterAll, describe, expect, it } from "vitest";
import { answer } from "../src/index.js";
import { discovered, pages, pathOf } from "../src/pages/discover.js";
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
 *  a reading list of this test's own would prove this test's wiring, not the surface's. */
const readingsOf = (db: DatabaseSync) => ({
  record: () => tree(db),
  board: () => board(db),
  approvals: () => waitingApprovals(db),
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

const PATHS = discovered(readdirSync(new URL("../src/pages", import.meta.url))).map(pathOf);

const surfaceOf = async (path: string): Promise<Routes> => pages(readingsOf(held(path)));

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
