import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Violation } from "@wecode/core";
// Type-only, and deliberately so: `doctor.ts` imports this module for the invariant it
// builds, and a value imported back the other way would be a cycle. A type is erased.
import type { Invariant } from "./doctor.js";

/** docs/design/19, applied to the shape of the tree rather than the shape of the record.
 *
 *  A long file is the one defect no test ever fails on. It grows a line at a time, nobody
 *  is the person who made it long, and it is found only when two tasks collide on it and
 *  one of them has to wait. So it is drift like any other drift, and the doctor is where
 *  drift is said out loud: every file whose code exceeds the ceiling is a violation naming
 *  the file, how long it is, and what it was allowed to be.
 *
 *  Code lines, not `wc -l`: blanks and comments are not the thing that makes a file hard to
 *  share, and a module that explains itself should not be punished for it.
 *
 *  The ceiling is configuration — `packages/core/config/project.yaml` — because the number
 *  is a policy the people who own the tree change, not a constant in a module they would
 *  have to open to change it. */

/** The check's name, as the report and the board say it. */
export const CEILING_CHECK = "file_is_within_its_ceiling";

/** Where the number lives, relative to the repository root. */
export const CEILING_CONFIG = join("packages", "core", "config", "project.yaml");

/** What is walked: the packages' own source and their tests, and nothing generated. */
const EXTENSIONS = [".ts", ".tsx"] as const;
const KINDS = ["src", "test"] as const;

/** One file, measured. */
export interface Measured {
  /** Repository-relative, forward slashes, so the violation reads the same on every host. */
  readonly path: string;
  /** Code lines: blanks and comments excluded. */
  readonly length: number;
}

/** The ceiling, read off the config text by hand.
 *
 *  One scalar is the whole grammar this needs, and reading it this way keeps the runner's
 *  dependency list where it is. `null` is the honest answer to a config that does not
 *  declare one: no ceiling was set, so there is nothing to be over. */
export function readCeiling(text: string): number | null {
  const said = text.split("\n").find((l) => /^ceiling:\s*\d+\s*$/.test(l));
  if (said === undefined) return null;
  return Number(said.slice("ceiling:".length).trim());
}

/** The ceiling this repository declares, or `null` when it declares none — which includes
 *  a tree that has no such config at all. A check that threw over a missing file would
 *  report a broken invariant where the truth is that nobody set a policy. */
export function ceilingOf(root: string): number | null {
  try {
    return readCeiling(readFileSync(join(root, CEILING_CONFIG), "utf8"));
  } catch {
    return null;
  }
}

/** Lines of code: blanks and comments do not count.
 *
 *  A line that closes a block comment and then carries code counts as comment, and so does
 *  a one-line block comment with code after it. Both are rare, and the bias is deliberate:
 *  this may undercount a file,
 *  and must never call a comment code — a violation that turns out to be prose would teach
 *  people to stop reading the report. */
export function codeLines(text: string): number {
  let count = 0;
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    count++;
  }
  return count;
}

/** What is over, and the sentence for each. Sorted by path, because a report whose lines
 *  moved between two identical passes reads as drift that is not there. */
export function overCeiling(files: readonly Measured[], ceiling: number): readonly Violation[] {
  return [...files]
    .filter((f) => f.length > ceiling)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({
      invariant: CEILING_CHECK,
      entity: "file",
      // A file is not a row of the record, so there is no id to name it by. The path is.
      id: null,
      slug: f.path,
      detail:
        `${f.path} is ${f.length} code lines, over the ceiling of ${ceiling} — ` +
        `split it, or raise the ceiling in ${CEILING_CONFIG}`,
    }));
}

/** Every module under each package's `src` and `test`, measured. A tree with no packages
 *  in it is not an error: it is a tree with nothing to measure. */
export function sourceTree(root: string): readonly Measured[] {
  const found: Measured[] = [];
  const packages = join(root, "packages");
  for (const pkg of entries(packages)) {
    for (const kind of KINDS) {
      walk(join(packages, pkg, kind), (file) =>
        found.push({
          path: relative(root, file).split("\\").join("/"),
          length: codeLines(readFileSync(file, "utf8")),
        }),
      );
    }
  }
  return found;
}

const entries = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function walk(dir: string, seen: (file: string) => void): void {
  if (!isDir(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, seen);
    else if (EXTENSIONS.some((e) => entry.name.endsWith(e))) seen(path);
  }
}

/** The check, bound to a repository.
 *
 *  It takes no notice of the snapshot: the record has nothing to say about how long a file
 *  is. That is why this is the runner's and not core's — core's set is a pure function of
 *  the record, and reading a tree is reading the world.
 *
 *  `read` is the seam the test uses: a tree is handed in rather than written to disk, so
 *  the case being proven is the check and not the walk. */
export const fileCeilingInvariant = (
  root: string,
  read: (root: string) => readonly Measured[] = sourceTree,
  ceiling: (root: string) => number | null = ceilingOf,
): Invariant => ({
  name: CEILING_CHECK,
  check: (): readonly Violation[] => {
    const limit = ceiling(root);
    return limit === null ? [] : overCeiling(read(root), limit);
  },
});
