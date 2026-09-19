import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
// Imported by path: the landing rules belong to core but nothing exports them from the
// barrel.
import { updatePrimary } from "../../core/src/land.js";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";

/** docs/design/14. A delivered story reaches the base branch with nobody merging it.
 *
 *  The half of that page about what the operator sees afterwards. Landing moves the base
 *  ref under checkouts nobody asked, so a checkout sitting on the base at the old tip is
 *  brought forward, one holding work of its own is left alone and told, and the rest are
 *  left in peace. Its sibling `land-chore.test.ts` pins the landing itself. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-land-forward-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const project = make.project(make.workspace("acme", repo), "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

const runner = (): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: {}, integrationBranch: "main" });

/** A delivered story with a branch of its own carrying one commit, and the gate's
 *  permission on the record: one acceptance test, passed. */
function story(title: string, file: string): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);
  const test = make.acceptanceTest(make.criteria(make.requirement(id, "it behaves"), "proven"), "it works", "script", "true");
  db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(test);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, file), `${title}\n`);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);
  return { id, slug };
}

const landTree = (slug: string): string => join(repo, ".wecode", "worktrees", `land-${slug}`);

/** Every checkout of the repository, as git lists them. */
const checkouts = (): string[] =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

describe("the primary checkout, after a landing it did not make", () => {
  it("is brought forward when it is clean, and no tree is left standing", async () => {
    const s = story("password reset", "reset.ts");
    const before = checkouts();

    const tick = await runner().tick();

    // The merge still happens in a detached tree of wecode's own, and that tree is gone
    // afterwards. Once the base ref has moved, a primary checkout that was clean at the old
    // tip is brought forward too, so the operator does not see staged inverse changes.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("the base\n");
    expect(readFileSync(join(repo, "reset.ts"), "utf8")).toBe("password reset\n");
    expect(git(repo, "status", "--short", "--untracked-files=no")).toBe("");
    expect(tick.landed.find((l) => l.story === s.id)?.notice).toBeUndefined();
    expect(existsSync(landTree(s.slug))).toBe(false);
    expect(checkouts()).toEqual(before);
  });

  it("is not brought forward over operator work, and is told the command", async () => {
    const s = story("password reset", "reset.ts");
    writeFileSync(join(repo, "README.md"), "operator notes\n");

    const tick = await runner().tick();

    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("operator notes\n");
    expect(existsSync(join(repo, "reset.ts"))).toBe(false);
    const notice = tick.landed.find((l) => l.story === s.id)?.notice ?? "";
    expect(notice).toContain(repo);
    expect(notice).toContain("README.md");
    expect(notice).toContain("git restore --source=HEAD --staged --worktree .");
  });

  it("answers primary drift by syncing only the clean old-tip checkout", () => {
    expect(
      updatePrimary({
        path: "/w/repo",
        base: "main",
        onBase: true,
        alreadyCurrent: false,
        wasTheOldTip: true,
        ownWork: [],
      }),
    ).toEqual({ kind: "sync" });

    const drifts = [
      { wasTheOldTip: false, ownWork: [] },
      { wasTheOldTip: true, ownWork: ["README.md"] },
      { wasTheOldTip: false, ownWork: ["README.md"] },
    ];
    for (const drift of drifts) {
      const verdict = updatePrimary({
        path: "/w/repo",
        base: "main",
        onBase: true,
        alreadyCurrent: false,
        ...drift,
      });
      expect(verdict.kind).toBe("tell");
      if (verdict.kind === "tell") expect(verdict.instruction).toContain("/w/repo");
    }
    // And a checkout that is not on the base, or already holds the landing, is left in peace
    // without a word — there is nothing there that is stale.
    const quiet = { path: "/w/repo", base: "main", alreadyCurrent: false, wasTheOldTip: false, ownWork: [] };
    expect(updatePrimary({ ...quiet, onBase: false })).toEqual({ kind: "current" });
    expect(updatePrimary({ ...quiet, onBase: true, alreadyCurrent: true })).toEqual({ kind: "current" });
  });
});
