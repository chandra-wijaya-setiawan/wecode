import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Violation } from "@wecode/core";
// The sentence-and-function pair every check is. Type-only, so the doctor may keep importing
// the checks from here without the two modules forming a cycle at run time.
import type { Invariant } from "../doctor.js";

/** docs/design/19, applied to what the record is judged by rather than to the record.
 *
 *  The checks whose subject is a tree on disk. The record says nothing about a build, so
 *  none of these can be answered from a snapshot: each is bound to a repository and added
 *  to the Doctor's own default rather than listed in the pure set. Kept together because
 *  "reads the tree" is the one thing that makes them different from every other invariant,
 *  and a reader looking for that difference should find one module and not a seam inside a
 *  thousand-line one. */

/** The build is current: every package's `dist` is no older than the `src` beside it.
 *
 *  Every package is run from `dist`: a bin, the tick, and every specifier that resolves
 *  through a package name read the compiled tree and never the source beside it. So a
 *  `dist` older than its `src` is a pass that judged code nobody wrote, and it is the one
 *  drift no test can find — the stale tree is the thing running the tests. Said per package
 *  and naming the source that is newer, because that is what says which build is late.
 *
 *  A package with no `dist` at all is not stale: it is unbuilt, which is a different fact
 *  and one the build says far louder than a report would. Like the ceiling, it reads a tree
 *  rather than the record, so it is the Doctor's own default and not in the pure set. */
export const DIST_CHECK = "dist_is_built_from_its_source";

/** The newest file under one tree, repository-relative, and when it was written. */
export interface Newest {
  readonly path: string;
  readonly at: number;
}

/** One package, as the two trees this check holds against each other. `null` is a tree with
 *  nothing in it, which includes a tree that is not there. */
export interface Built {
  readonly pkg: string;
  readonly source: Newest | null;
  readonly dist: Newest | null;
}

/** Source is what a person writes; `dist` is what `tsc` leaves. Declarations and maps are
 *  written by the same pass as the `.js`, so the one extension answers for the build. */
const SOURCE_EXT = [".ts", ".tsx"] as const;
const DIST_EXT = [".js"] as const;

const dirents = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The newest file of these kinds anywhere under `dir`. */
export function newestUnder(dir: string, ext: readonly string[]): Newest | null {
  let best: Newest | null = null;
  for (const e of dirents(dir)) {
    const path = join(dir, e.name);
    const found = e.isDirectory()
      ? newestUnder(path, ext)
      : ext.some((x) => e.name.endsWith(x))
        ? { path, at: statSync(path).mtimeMs }
        : null;
    if (found !== null && (best === null || found.at > best.at)) best = found;
  }
  return best;
}

/** Every package in the workspace, each with the newest of its two trees. Paths come back
 *  repository-relative with forward slashes, so a violation reads the same on every host. */
export function builtTree(root: string): readonly Built[] {
  const packages = join(root, "packages");
  const rel = (n: Newest | null): Newest | null =>
    n === null ? null : { path: relative(root, n.path).split("\\").join("/"), at: n.at };
  return dirents(packages)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((pkg) => ({
      pkg,
      source: rel(newestUnder(join(packages, pkg, "src"), SOURCE_EXT)),
      dist: rel(newestUnder(join(packages, pkg, "dist"), DIST_EXT)),
    }));
}

/** What is stale, one sentence each, in package order — a report whose lines moved between
 *  two identical passes reads as drift that is not there. */
export function staleDists(built: readonly Built[]): readonly Violation[] {
  return built
    .filter((b) => b.source !== null && b.dist !== null && b.source.at > b.dist.at)
    .map((b) => ({
      invariant: DIST_CHECK,
      entity: "package",
      // A package is not a row of the record, so there is no id to name it by. The path is.
      id: null,
      slug: `packages/${b.pkg}`,
      detail:
        `packages/${b.pkg}/dist is older than its source — ${b.source?.path} was written ` +
        `after ${b.dist?.path}, so everything that imports the package is running a build ` +
        `that predates it: run pnpm -r build`,
    }));
}

/** The check, bound to a repository. `read` is the seam the test uses: a pair of trees is
 *  handed in rather than written to disk, so the case being proven is the comparison. */
export const distIsBuiltFromSource = (
  root: string,
  read: (root: string) => readonly Built[] = builtTree,
): Invariant => ({
  name: DIST_CHECK,
  check: (): readonly Violation[] => staleDists(read(root)),
});
