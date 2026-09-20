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

/** docs/design/14. A landing nobody watched leaves a checkout somebody can work in.
 *
 *  The merge is made in a detached tree of wecode's own and moves `refs/heads/<base>`, so
 *  the checkout holding the base is left one commit behind the ref it is on — every path
 *  the story added reading as a staged deletion. That is the shape lost work has, and it is
 *  handed to a person who did nothing to earn it.
 *
 *  When that checkout is clean at the old tip there is nothing to weigh: its index and its
 *  working files are the pre-land tree exactly, so wecode brings it to the new tip and
 *  stages nothing. When it is not — an edit of the operator's, a staged path, an untracked
 *  file the landing wrote — none of it is wecode's to write over, and the checkout is left
 *  as it stands with the command said in full. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-unattended-land-"));
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
  const test = make.acceptanceTest(
    make.criteria(make.requirement(id, "it behaves"), "proven"),
    "it works",
    "script",
    "true",
  );
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

const noticeFor = (tick: { landed: readonly { story: number; notice?: string }[] }, id: number): string | undefined =>
  tick.landed.find((l) => l.story === id)?.notice;

describe("an unattended land, over a clean checkout", () => {
  it("brings it to the new tip and stages nothing", async () => {
    const s = story("password reset", "reset.ts");

    const tick = await runner().tick();

    // The landing happened, and the folder a person works in shows it: the file the story
    // added is on the disk, at the commit the base now points at.
    expect(git(repo, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(existsSync(join(repo, "reset.ts"))).toBe(true);
    expect(readFileSync(join(repo, "reset.ts"), "utf8")).toBe("password reset\n");
    // And nothing is staged there — not the story's paths, not anything. The next commit
    // made in that tree carries only what its author put in it.
    // (Untracked files are left out: the ledger's own sqlite files sit here.)
    expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    // Nothing is owed the operator, so nothing is said to them.
    expect(noticeFor(tick, s.id)).toBeUndefined();
  });

  it("leaves untouched files of the operator's alone while it does it", async () => {
    // An untracked file on a path the landing never writes survives the update: it is not
    // in the way of anything, and refusing over it would leave the checkout stale for ever.
    writeFileSync(join(repo, "notes.txt"), "mine\n");
    const s = story("password reset", "reset.ts");

    const tick = await runner().tick();

    expect(existsSync(join(repo, "reset.ts"))).toBe(true);
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("mine\n");
    expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(noticeFor(tick, s.id)).toBeUndefined();
  });
});

describe("an unattended land, over a checkout that is not clean", () => {
  it("writes none of it, and says the command", async () => {
    const s = story("password reset", "reset.ts");
    writeFileSync(join(repo, "README.md"), "operator notes\n");

    const tick = await runner().tick();

    // Their edit is theirs: wecode does not bring the tree forward over it, and does not
    // put the story's files in a folder it is about to be told to restore.
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("operator notes\n");
    expect(existsSync(join(repo, "reset.ts"))).toBe(false);
    const notice = noticeFor(tick, s.id) ?? "";
    expect(notice).toContain(repo);
    expect(notice).toContain("README.md");
    expect(notice).toContain("git restore --source=HEAD --staged --worktree .");
  });
});

describe("the rule the landing is decided on", () => {
  const drift = { path: "/w/repo", base: "main", onBase: true, alreadyCurrent: false };

  it("brings forward exactly the checkout that is clean at the old tip", () => {
    expect(updatePrimary({ ...drift, wasTheOldTip: true, ownWork: [] })).toEqual({ kind: "forward" });
  });

  it("tells, rather than writes, every checkout holding anything else", () => {
    for (const held of [
      { wasTheOldTip: false, ownWork: [] },
      { wasTheOldTip: true, ownWork: ["README.md"] },
      { wasTheOldTip: false, ownWork: ["README.md"] },
    ]) {
      const verdict = updatePrimary({ ...drift, ...held });
      expect(verdict.kind).toBe("tell");
      if (verdict.kind === "tell") {
        expect(verdict.instruction).toContain("/w/repo");
        expect(verdict.instruction).toContain("git restore --source=HEAD --staged --worktree .");
      }
    }
  });

  it("leaves in peace a checkout that is not stale at all", () => {
    expect(updatePrimary({ ...drift, onBase: false, wasTheOldTip: false, ownWork: [] })).toEqual({ kind: "current" });
    expect(updatePrimary({ ...drift, alreadyCurrent: true, wasTheOldTip: false, ownWork: [] })).toEqual({
      kind: "current",
    });
  });
});
