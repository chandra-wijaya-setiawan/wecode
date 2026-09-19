import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CEILING_CHECK,
  CEILING_CONFIG,
  ceilingOf,
  codeLines,
  fileCeilingInvariant,
  overCeiling,
  readCeiling,
  sourceTree,
  type Measured,
} from "../src/ceiling.js";
import { Maker, open, type Snapshot } from "@wecode/core";
import { Doctor, lastPass, RUNNER_INVARIANTS, violations } from "../src/doctor.js";

/** A file that has grown past the size at which it blocks other work is drift, and the
 *  doctor is where drift is said out loud.
 *
 *  Nothing in the nine invariants looks at a file's length, so a bottleneck is only found
 *  when two tasks collide on it and one has to wait. This check reads the tree instead: every
 *  source file whose code — blanks and comments excluded — exceeds the ceiling in
 *  configuration is a violation naming the file, its length, and the ceiling.
 *
 *  The ceiling is a number in `packages/core/config/project.yaml`, not a constant in a
 *  module, so shortening the tree's budget is not a code change. */

const tmp: string[] = [];

/** A tree on disk, one file at a time: `{ "packages/x/src/a.ts": "…" }`. */
function treeOf(files: Readonly<Record<string, string>>, config?: string): string {
  const root = mkdtempSync(join(tmpdir(), "ceiling-"));
  tmp.push(root);
  if (config !== undefined) write(join(root, CEILING_CONFIG), config);
  for (const [path, text] of Object.entries(files)) write(join(root, path), text);
  return root;
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

afterAll(() => {
  for (const root of tmp) rmSync(root, { recursive: true, force: true });
});

/** The check takes no notice of the record; it is handed one anyway, because that is the
 *  shape every invariant has. */
const EMPTY: Snapshot = { nodes: [], workers: [], schema_version: 0 };

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n";

describe("the ceiling is configuration, not a constant", () => {
  it("is read off the config as a scalar", () => {
    expect(readCeiling("stack: pnpm\nceiling: 400\nover:\n  a.ts: 900\n")).toBe(400);
  });

  it("is null when the config declares none, so nothing is invented", () => {
    expect(readCeiling("stack: pnpm\n")).toBeNull();
  });

  it("is read off a tree's own config file", () => {
    expect(ceilingOf(treeOf({}, "ceiling: 12\n"))).toBe(12);
  });

  it("is null for a tree with no config at all", () => {
    expect(ceilingOf(treeOf({}))).toBeNull();
  });

  it("is the number this repository declares, so the check is data-driven here too", () => {
    expect(ceilingOf(join(import.meta.dirname, "..", "..", ".."))).toBeGreaterThan(0);
  });
});

describe("length is code, not lines", () => {
  it("counts a line of code", () => {
    expect(codeLines("const a = 1;\nconst b = 2;\n")).toBe(2);
  });

  it("does not count blanks", () => {
    expect(codeLines("const a = 1;\n\n\nconst b = 2;\n")).toBe(2);
  });

  it("does not count a line comment", () => {
    expect(codeLines("// why\nconst a = 1;\n  // and why not\n")).toBe(1);
  });

  it("does not count a block comment, however long", () => {
    expect(codeLines("/** one\n *  two\n *  three */\nconst a = 1;\n")).toBe(1);
  });

  it("does not count a block comment that opens and closes on one line", () => {
    expect(codeLines("/* aside */\nconst a = 1;\n")).toBe(1);
  });

  it("makes a file of comments and blanks zero long", () => {
    expect(codeLines("\n// a\n/* b\n   c */\n\n")).toBe(0);
  });
});

describe("what the check reports", () => {
  const above: Measured = { path: "packages/a/src/long.ts", length: 41 };
  const below: Measured = { path: "packages/a/src/short.ts", length: 40 };

  it("reports only the file above the ceiling", () => {
    expect(overCeiling([above, below], 40).map((v) => v.slug)).toEqual(["packages/a/src/long.ts"]);
  });

  it("names the file, its length and the ceiling", () => {
    const [v] = overCeiling([above, below], 40);
    expect(v?.invariant).toBe(CEILING_CHECK);
    expect(v?.entity).toBe("file");
    expect(v?.id).toBeNull();
    expect(v?.slug).toBe("packages/a/src/long.ts");
    expect(v?.detail).toContain("41");
    expect(v?.detail).toContain("40");
    expect(v?.detail).toContain("packages/a/src/long.ts");
  });

  it("says nothing about a tree that is all under the ceiling", () => {
    expect(overCeiling([below], 40)).toEqual([]);
  });

  it("orders by path, so two identical passes read identically", () => {
    const files = [
      { path: "packages/b/src/z.ts", length: 99 },
      { path: "packages/a/src/a.ts", length: 99 },
    ];
    expect(overCeiling(files, 40).map((v) => v.slug)).toEqual(["packages/a/src/a.ts", "packages/b/src/z.ts"]);
  });
});

describe("the tree it reads", () => {
  it("measures every module under a package's src and test, in code lines", () => {
    const root = treeOf({
      "packages/a/src/one.ts": "// a comment\n\nconst a = 1;\n",
      "packages/a/src/deep/two.tsx": "const b = 2;\n",
      "packages/a/test/three.ts": "const c = 3;\n",
    });
    expect([...sourceTree(root)].sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
      { path: "packages/a/src/deep/two.tsx", length: 1 },
      { path: "packages/a/src/one.ts", length: 1 },
      { path: "packages/a/test/three.ts", length: 1 },
    ]);
  });

  it("ignores what is not a module, and what is outside a package", () => {
    const root = treeOf({
      "packages/a/src/one.ts": "const a = 1;\n",
      "packages/a/src/notes.md": "long enough to matter\n",
      "packages/a/dist/one.js": "const a = 1;\n",
      "scripts/tool.ts": "const a = 1;\n",
    });
    expect(sourceTree(root).map((m) => m.path)).toEqual(["packages/a/src/one.ts"]);
  });

  it("finds nothing in a tree with no packages, rather than failing", () => {
    expect(sourceTree(treeOf({}))).toEqual([]);
  });
});

describe("the invariant, over a real tree", () => {
  /** The case the story names: one file above the ceiling and one below it. */
  const root = treeOf({ "packages/a/src/long.ts": lines(41), "packages/a/src/short.ts": lines(40) }, "ceiling: 40\n");

  it("reports the file above the ceiling and not the one below", () => {
    const found = fileCeilingInvariant(root).check(EMPTY);
    expect(found.map((v) => v.slug)).toEqual(["packages/a/src/long.ts"]);
  });

  it("names the length and the ceiling in the violation", () => {
    const [v] = fileCeilingInvariant(root).check(EMPTY);
    expect(v?.detail).toBe(
      `packages/a/src/long.ts is 41 code lines, over the ceiling of 40 — ` +
        `split it, or raise the ceiling in ${CEILING_CONFIG}`,
    );
  });

  it("is named so the report and the board say the same thing", () => {
    expect(fileCeilingInvariant(root).name).toBe(CEILING_CHECK);
  });

  it("counts code and not lines, so a long comment is not a violation", () => {
    const commented = treeOf(
      { "packages/a/src/prose.ts": `/**\n${" *  why\n".repeat(200)} */\n${lines(10)}` },
      "ceiling: 40\n",
    );
    expect(fileCeilingInvariant(commented).check(EMPTY)).toEqual([]);
  });

  it("says nothing at all when no ceiling is declared", () => {
    const none = treeOf({ "packages/a/src/long.ts": lines(500) });
    expect(fileCeilingInvariant(none).check(EMPTY)).toEqual([]);
  });
});

/** The check is only worth writing if the tick runs it, and the tick runs the Doctor's
 *  default set. The repository it reads is the one the record names, so a doctor over one
 *  project never reports another project's files. */
describe("the doctor runs it", () => {
  const root = treeOf({ "packages/a/src/long.ts": lines(41), "packages/a/src/short.ts": lines(40) }, "ceiling: 40\n");
  const db = open(join(root, "wecode.db"));
  new Maker(db).project(new Maker(db).workspace("acme", root), "storefront", root);
  const found = new Doctor(db).check();

  it("reports the file over the ceiling as a violation of its own", () => {
    expect(found.filter((v) => v.invariant === CEILING_CHECK).map((v) => v.slug)).toEqual(["packages/a/src/long.ts"]);
  });

  it("records it, so a view can read it back without running a pass of its own", () => {
    expect(violations(db).filter((v) => v.invariant === CEILING_CHECK).map((v) => v.slug)).toEqual([
      "packages/a/src/long.ts",
    ]);
  });

  it("says it looked, which is how a quiet record is told from an unexamined one", () => {
    expect((lastPass(db)?.looked ?? []).find((l) => l.invariant === CEILING_CHECK)).toEqual({
      invariant: CEILING_CHECK,
      world: false,
      reachable: true,
      found: 1,
    });
  });

  it("leaves the pure set alone, so core and the cli still agree on what they share", () => {
    expect(RUNNER_INVARIANTS.map((i) => i.name)).not.toContain(CEILING_CHECK);
  });
});
