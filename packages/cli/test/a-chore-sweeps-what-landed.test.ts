import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sweepLandedStories } from "../../core/src/chore/raise.js";
import { seed, freshDb } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (repo: string, file: string): void => {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", file);
};

/** A merged story branch still has a story worktree, while the two other branches show the
 *  cleanup's boundaries: one delivered story is not landed, and one landed branch belongs
 *  to a story that is not delivered. */
function repository(): { repo: string; landedTree: string; openTree: string; oldTree: string } {
  const repo = tmp("sweep-landed-repo-");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@localhost");
  commit(repo, "base.txt");

  for (const slug of ["reset", "still-open", "not-delivered"]) {
    git(repo, "checkout", "-qb", `story/${slug}`);
    commit(repo, `${slug}.txt`);
    git(repo, "checkout", "-q", "master");
  }
  for (const slug of ["reset", "not-delivered"]) git(repo, "merge", "--no-ff", "-q", "-m", `land ${slug}`, `story/${slug}`);

  const landedTree = join(tmp("sweep-landed-tree-"), "reset");
  const openTree = join(tmp("sweep-open-tree-"), "still-open");
  const oldTree = join(tmp("sweep-old-tree-"), "not-delivered");
  git(repo, "worktree", "add", "-q", landedTree, "story/reset");
  git(repo, "worktree", "add", "-q", openTree, "story/still-open");
  git(repo, "worktree", "add", "-q", oldTree, "story/not-delivered");
  return { repo, landedTree, openTree, oldTree };
}

describe("the landed-story sweep chore", () => {
  it("removes delivered stories already in master, names them, and leaves the rest", async () => {
    const db = freshDb();
    const delivered = seed(db);
    db.prepare("UPDATE story SET slug = 'reset', state = 'delivered' WHERE id = ?").run(delivered.story);
    db.prepare(
      "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("still-open", delivered.epic, "still open", "delivered", "2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.000Z");
    db.prepare(
      "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("not-delivered", delivered.epic, "not delivered", "in_progress", "2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.000Z");
    const trees = repository();

    const swept = await sweepLandedStories(db, trees.repo);

    expect(swept.removed).toEqual([trees.landedTree, "story/reset"]);
    expect(swept.notice).toContain(trees.landedTree);
    expect(swept.notice).toContain("story/reset");
    expect(existsSync(trees.landedTree)).toBe(false);
    expect(git(trees.repo, "branch", "--list", "story/reset")).toBe("");
    expect(existsSync(trees.openTree)).toBe(true);
    expect(existsSync(trees.oldTree)).toBe(true);
    expect(git(trees.repo, "branch", "--list", "story/still-open")).toContain("story/still-open");
    expect(git(trees.repo, "branch", "--list", "story/not-delivered")).toContain("story/not-delivered");
  });
});
