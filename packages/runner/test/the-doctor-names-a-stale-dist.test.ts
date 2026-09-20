import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Maker, open, type Snapshot } from "@wecode/core";
import {
  builtTree,
  DIST_CHECK,
  distIsBuiltFromSource,
  Doctor,
  lastPass,
  newestUnder,
  RUNNER_INVARIANTS,
  staleDists,
  violations,
  type Built,
} from "../src/doctor.js";

/** A `dist` older than the `src` beside it is drift, and the doctor is where drift is said
 *  out loud.
 *
 *  Every package is run from its compiled tree: a bin, the tick, and every specifier that
 *  resolves through a package name read `dist` and never the source next to it. So a build
 *  left behind by an edit is the one defect no test can find — the stale tree is the thing
 *  running the tests, and it goes on saying green about code nobody wrote. This check reads
 *  the two trees instead: a package whose newest source is newer than its newest built file
 *  is a violation naming the package, both files, and the command that settles it.
 *
 *  An unbuilt package is not stale. It has no `dist` at all, which is a different fact and
 *  one the build itself says far louder than a report would. */

const tmp: string[] = [];

/** A tree on disk, one file at a time, each with the mtime it is given: the check is about
 *  which of two trees is newer, so the times are the case and not an accident of writing
 *  order. `{ "packages/a/src/a.ts": 2 }` is a file written at second 2. */
function treeOf(files: Readonly<Record<string, number>>): string {
  const root = mkdtempSync(join(tmpdir(), "stale-dist-"));
  tmp.push(root);
  for (const [path, at] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "const a = 1;\n");
    utimesSync(full, at, at);
  }
  return root;
}

afterAll(() => {
  for (const root of tmp) rmSync(root, { recursive: true, force: true });
});

/** The check takes no notice of the record; it is handed one anyway, because an invariant
 *  is a function of a snapshot and this one simply ignores it. */
const EMPTY: Snapshot = { nodes: [], workers: [], schema_version: 0 };

/** One package's two trees, as the comparison sees them. Seconds, because that is what the
 *  fixture writes and the units never leave this file. */
const pkg = (source: number | null, dist: number | null): Built => ({
  pkg: "a",
  source: source === null ? null : { path: "packages/a/src/a.ts", at: source },
  dist: dist === null ? null : { path: "packages/a/dist/a.js", at: dist },
});

describe("what a stale dist is", () => {
  it("names a package whose source was written after its build", () => {
    expect(staleDists([pkg(2, 1)]).map((v) => v.slug)).toEqual(["packages/a"]);
  });

  it("passes a package built after its source, which is every healthy package", () => {
    expect(staleDists([pkg(1, 2)])).toEqual([]);
  });

  it("passes a build written in the same second as its source, so a fast build is not drift", () => {
    expect(staleDists([pkg(2, 2)])).toEqual([]);
  });

  it("says nothing about an unbuilt package, which is a different fact", () => {
    expect(staleDists([pkg(2, null)])).toEqual([]);
  });

  it("says nothing about a package with no source, which has nothing to be behind", () => {
    expect(staleDists([pkg(null, 2)])).toEqual([]);
  });

  it("names both files and the command that settles it", () => {
    const [v] = staleDists([pkg(2, 1)]);
    expect(v?.detail).toBe(
      "packages/a/dist is older than its source — packages/a/src/a.ts was written after " +
        "packages/a/dist/a.js, so everything that imports the package is running a build " +
        "that predates it: run pnpm -r build",
    );
  });

  it("is a violation of a package rather than of a row, so it carries a path and no id", () => {
    const [v] = staleDists([pkg(2, 1)]);
    expect(v).toMatchObject({ invariant: DIST_CHECK, entity: "package", id: null, slug: "packages/a" });
  });

  it("reports in package order, so two identical passes read the same", () => {
    const stale = (name: string): Built => ({ ...pkg(2, 1), pkg: name });
    expect(staleDists([stale("runner"), stale("cli"), stale("tui")]).map((v) => v.slug)).toEqual([
      "packages/runner",
      "packages/cli",
      "packages/tui",
    ]);
  });
});

describe("reading the two trees", () => {
  it("takes the newest file anywhere under a tree, however deep", () => {
    const root = treeOf({ "packages/a/src/a.ts": 10, "packages/a/src/deep/b.ts": 20 });
    expect(newestUnder(join(root, "packages", "a", "src"), [".ts"])).toMatchObject({
      path: join(root, "packages", "a", "src", "deep", "b.ts"),
    });
  });

  it("finds nothing in a tree that is not there, rather than failing", () => {
    expect(newestUnder(join(treeOf({}), "packages", "a", "src"), [".ts"])).toBeNull();
  });

  it("holds each package's source against its own build, repository-relative", () => {
    const root = treeOf({
      "packages/a/src/a.ts": 20,
      "packages/a/dist/a.js": 10,
      "packages/b/src/b.ts": 10,
      "packages/b/dist/b.js": 20,
    });
    expect(builtTree(root)).toEqual([
      { pkg: "a", source: { path: "packages/a/src/a.ts", at: 20000 }, dist: { path: "packages/a/dist/a.js", at: 10000 } },
      { pkg: "b", source: { path: "packages/b/src/b.ts", at: 10000 }, dist: { path: "packages/b/dist/b.js", at: 20000 } },
    ]);
  });

  it("reads no source out of dist and no build out of src, whatever is sitting in them", () => {
    const root = treeOf({ "packages/a/src/a.js": 20, "packages/a/dist/a.ts": 20 });
    expect(builtTree(root)).toEqual([{ pkg: "a", source: null, dist: null }]);
  });

  it("finds nothing in a tree with no packages, rather than failing", () => {
    expect(builtTree(treeOf({}))).toEqual([]);
  });
});

describe("the invariant, over a real tree", () => {
  const root = treeOf({
    "packages/stale/src/a.ts": 20,
    "packages/stale/dist/a.js": 10,
    "packages/fresh/src/a.ts": 10,
    "packages/fresh/dist/a.js": 20,
  });

  it("reports the package whose build is behind and not the one that is current", () => {
    expect(distIsBuiltFromSource(root).check(EMPTY).map((v) => v.slug)).toEqual(["packages/stale"]);
  });

  it("is named so the report and the board say the same thing", () => {
    expect(distIsBuiltFromSource(root).name).toBe(DIST_CHECK);
  });
});

/** The check is only worth writing if the tick runs it, and the tick runs the Doctor's
 *  default set. The repository it reads is the one the record names, so a doctor over one
 *  project never reports another project's build. */
describe("the doctor runs it", () => {
  const root = treeOf({ "packages/stale/src/a.ts": 20, "packages/stale/dist/a.js": 10 });
  const db = open(join(root, "wecode.db"));
  const make = new Maker(db);
  make.project(make.workspace("acme", root), "storefront", root);
  const found = new Doctor(db).check();

  it("reports the stale package as a violation of its own", () => {
    expect(found.filter((v) => v.invariant === DIST_CHECK).map((v) => v.slug)).toEqual(["packages/stale"]);
  });

  it("records it, so a view can read it back without running a pass of its own", () => {
    expect(violations(db).filter((v) => v.invariant === DIST_CHECK).map((v) => v.slug)).toEqual(["packages/stale"]);
  });

  it("says it looked, which is how a quiet record is told from an unexamined one", () => {
    expect(lastPass(db)?.looked.find((l) => l.invariant === DIST_CHECK)).toEqual({
      invariant: DIST_CHECK,
      world: false,
      reachable: true,
      found: 1,
    });
  });

  it("is the doctor's own, not core's pure set, because it reads a tree and not the record", () => {
    expect(RUNNER_INVARIANTS.map((i) => i.name)).not.toContain(DIST_CHECK);
  });
});
