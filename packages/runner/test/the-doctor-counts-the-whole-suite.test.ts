import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { open } from "@wecode/core";
import { Doctor, lastSuite, recordSuite, runSuite, suiteTally, tallyOf, type Git } from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** master was called green for hours off one file while a hundred tests were red. What the
 *  doctor has to be able to say instead is the whole tip's tally — failed, passed, skipped,
 *  and the file each failure is in — and it has to survive being written down, because the
 *  board reads the row and not the run. */

const silent: Git = () => "";

/** The same output with its colour taken off, written here rather than imported so the two
 *  spellings are held against each other and not against one shared opinion of them. */
const stripped = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = tmp("wecode-suite-tally-");
  db = open(join(dir, "wecode.db"));
});

describe("the tally, off what the runner printed", () => {
  /** vitest, verbatim: the file count above and the test count below. The trap this test
   *  exists for is reading the line above — one red file holding a hundred red tests. */
  const printed = [
    " FAIL  packages/tui/test/a-row-is-a-sentence.test.ts > a row is a sentence",
    " FAIL  packages/core/test/typed-engine.test.ts > it settles",
    "",
    " Test Files  2 failed | 27 passed (29)",
    "      Tests  101 failed | 3396 passed | 8 skipped (3505)",
    "   Start at  09:14:44",
  ].join("\n");

  it("counts tests and not files", () => {
    expect(tallyOf(printed, "f23b143")).toEqual({
      tip: "f23b143",
      failed: 101,
      passed: 3396,
      skipped: 8,
      files: ["packages/tui/test/a-row-is-a-sentence.test.ts", "packages/core/test/typed-engine.test.ts"],
    });
  });

  it("reads a kind the summary leaves out as nought of it", () => {
    expect(tallyOf("      Tests  3 passed (3)", "abc")).toEqual({
      tip: "abc",
      failed: 0,
      passed: 3,
      skipped: 0,
      files: [],
    });
  });

  /** A runner that thinks it is talking to a terminal writes the same counts in escape
   *  codes. A pass that could only read the plain spelling would call a coloured run
   *  uncountable, which is the failure this whole story is about. */
  it("counts a run that came back coloured exactly as a plain one", () => {
    const coloured =
      "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m packages/x/test/known-red.test.ts\u001b[2m > \u001b[22mis red\n" +
      "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m101 failed\u001b[39m\u001b[22m | 3396 passed\u001b[90m (3497)\u001b[39m";

    expect(tallyOf(coloured, "f23b143")).toEqual(tallyOf(stripped(coloured), "f23b143"));
    expect(tallyOf(coloured, "f23b143")?.failed).toBe(101);
    expect(tallyOf(coloured, "f23b143")?.files).toEqual(["packages/x/test/known-red.test.ts"]);
  });

  /** A suite that died before it counted anything is not a suite that found nothing. A zero
   *  here would be the same mistake this story is about, one layer down. */
  it("says nothing at all when the output carries no summary", () => {
    expect(tallyOf("Error: Cannot find package 'react'", "abc")).toBeNull();
  });
});

describe("the tally, off a tree with a known red file", () => {
  /** A tree of its own, with one file in it whose counts are known by construction: one
   *  failing test, one passing, one skipped. The suite really runs — the point being proven
   *  is that the doctor reads a real runner's real output. */
  const treeWithAKnownRedFile = (): string => {
    const tree = tmp("wecode-suite-tree-");
    mkdirSync(join(tree, "packages", "x", "test"), { recursive: true });
    writeFileSync(
      join(tree, "packages", "x", "test", "known-red.test.ts"),
      [
        'import { it, expect } from "vitest";',
        'it("is red", () => { expect(1).toBe(2); });',
        'it("is green", () => { expect(1).toBe(1); });',
        'it.skip("is skipped", () => {});',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tree, "vitest.config.ts"),
      'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["packages/*/test/**/*.test.ts"] } });\n',
    );
    return tree;
  };

  /** The repository's own vitest, run against the other tree. `pnpm exec` from a directory
   *  outside the workspace has no install to resolve, so the binary is named directly —
   *  which is what `runSuite` does through pnpm, one layer up. */
  const vitestIn = (root: string) => (cwd: string): string => {
    try {
      return execFileSync(join(root, "node_modules", ".bin", "vitest"), ["run"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
  };

  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

  it("names the red file and counts every test in the tree", () => {
    const tally = suiteTally(treeWithAKnownRedFile(), "deadbee", vitestIn(repoRoot));

    expect(tally).toEqual({
      tip: "deadbee",
      failed: 1,
      passed: 1,
      skipped: 1,
      files: ["packages/x/test/known-red.test.ts"],
    });
  });
});

describe("the tally, as a doctor row", () => {
  const tally = {
    tip: "f23b143",
    failed: 101,
    passed: 3396,
    skipped: 8,
    files: ["packages/tui/test/a-row-is-a-sentence.test.ts"],
  };

  it("has the row to write into as soon as a doctor exists", () => {
    new Doctor(db, [], silent);

    expect(lastSuite(db)).toBeNull();
  });

  it("reads back what was recorded, files and all", () => {
    new Doctor(db, [], silent);
    recordSuite(db, tally);

    expect(lastSuite(db)).toEqual({ ...tally, at: expect.any(String) });
  });

  /** The board asks "how red is the tip", and there is one answer to that. Two rows would
   *  leave it to guess which of them the branch is at. */
  it("replaces the last tally rather than appending to it", () => {
    new Doctor(db, [], silent);
    recordSuite(db, tally);
    recordSuite(db, { ...tally, tip: "c2a8451", failed: 4, files: [] });

    expect(lastSuite(db)?.tip).toBe("c2a8451");
    expect(lastSuite(db)?.failed).toBe(4);
    expect(lastSuite(db)?.files).toEqual([]);
  });

  /** A run that could not be counted must not overwrite a count that could. */
  it("leaves the last tally standing when a run came back with no tally at all", () => {
    new Doctor(db, [], silent);
    recordSuite(db, tally);
    recordSuite(db, null);

    expect(lastSuite(db)?.failed).toBe(101);
  });

  it("says nobody has counted before any doctor has touched the record", () => {
    expect(lastSuite(open(join(tmp("wecode-suite-untouched-"), "wecode.db")))).toBeNull();
  });

  /** The default runner is the whole suite and not a path: naming one would be the bug. */
  it("runs the suite whole by default", () => {
    expect(String(runSuite)).toContain('"run"');
    expect(String(runSuite)).not.toContain("packages/");
  });
});
