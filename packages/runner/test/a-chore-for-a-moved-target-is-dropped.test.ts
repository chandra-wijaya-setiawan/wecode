import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyChore, choreById, choreFor, choreRefusal, closeChore, ensureChore, Maker, open } from "@wecode/core";
import { attemptLanding, LAND_CHECK, landStanding, targetGone } from "../src/land-chore.js";

/** docs/design/18. A chore is a thing wecode owes itself, and the world is the only thing
 *  that may retire one.
 *
 *  A `land` chore is raised against a story branch and checks that the base contains it.
 *  When that branch is later deleted — rewound, renamed, tidied away by a person — the
 *  chore's target no longer resolves. Nothing can satisfy it: there is no branch to merge,
 *  and the check is a question about a ref that is not in the repository. It used to sit
 *  open, asking every tick for a merge of nothing.
 *
 *  What this file pins is that such a chore is *dropped*, with the reason standing where
 *  anybody can read it, and that a chore whose target is merely unlanded is untouched. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-moved-target-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", repo), "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

/** A delivered story with a branch of its own carrying one commit. */
function story(title: string, file: string): { id: number; slug: string; branch: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const branch = `story/${slug}`;
  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", branch, "main");
  git(repo, "worktree", "add", "-q", tree, branch);
  writeFileSync(join(tree, file), `${title}\n`);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);
  return { id, slug, branch };
}

/** The `land` chore the runner raises when a landing is refused, on the record in the state
 *  a refused landing leaves it: raised, attempted once, failed. */
function raiseFailedLandChore(storyId: number): number {
  const c = ensureChore(db, { project_id: project, kind: "land", target_type: "story", target_id: storyId, check: LAND_CHECK });
  applyChore(db, c.id, "start", "runner");
  applyChore(db, c.id, "begin", "runner");
  applyChore(db, c.id, "fail", "runner");
  return c.id;
}

describe("a land chore whose target branch is gone", () => {
  it("stands as `gone`, with the branch and the check named in the reason", async () => {
    const s = story("password reset", "reset.ts");
    git(repo, "branch", "-D", s.branch);

    expect(await landStanding(repo, "main", s.branch)).toEqual({ kind: "gone", why: targetGone(s.branch) });
    expect(targetGone(s.branch)).toContain(s.branch);
    expect(targetGone(s.branch)).toContain(LAND_CHECK);
  });

  it("is dropped, and the reason it was dropped is on the chore", async () => {
    const s = story("password reset", "reset.ts");
    const id = raiseFailedLandChore(s.id);
    git(repo, "branch", "-D", s.branch);

    const standing = await landStanding(repo, "main", s.branch);
    expect(standing.kind).toBe("gone");
    if (standing.kind !== "gone") return;
    expect(closeChore(db, id, standing.why, "runner").ok).toBe(true);

    // Dropped, not passed: the chore is off the board and the epitaph says the target went
    // away rather than that anything landed.
    expect(choreById(db, id)?.state).toBe("done");
    expect(choreRefusal(db, id)?.why).toBe(targetGone(s.branch));
    expect(choreRefusal(db, id)?.why).not.toContain(`main already contains ${s.branch}`);
  });

  it("is not claimed to have landed, because nothing can see whether it did", async () => {
    const s = story("password reset", "reset.ts");
    // The commits reached the base and then the branch was deleted — the ordinary tidy-up.
    // Even here the answer is `gone`: `main` contains the work, but the ref the check names
    // is not there to be asked about, and guessing is what a chore exists to avoid.
    expect((await attemptLanding({ repo, base: "main", branch: s.branch, tree: join(repo, ".land") })).kind).toBe("landed");
    git(repo, "branch", "-D", s.branch);

    expect((await landStanding(repo, "main", s.branch)).kind).toBe("gone");
  });
});

describe("a land chore whose target is still there", () => {
  it("is owed while the base does not contain the branch", async () => {
    const s = story("password reset", "reset.ts");

    expect(await landStanding(repo, "main", s.branch)).toEqual({ kind: "owed" });
  });

  it("is still owed when it is the base that is missing, not the target", async () => {
    const s = story("password reset", "reset.ts");

    // A repository with no integration branch is wrong in a way a person fixes. It is not
    // the target having moved, and it does not drop the chore.
    expect(await landStanding(repo, "no-such-base", s.branch)).toEqual({ kind: "owed" });
  });

  it("is discharged, not dropped, once the base contains the branch", async () => {
    const s = story("password reset", "reset.ts");
    const id = raiseFailedLandChore(s.id);
    expect((await attemptLanding({ repo, base: "main", branch: s.branch, tree: join(repo, ".land") })).kind).toBe("landed");

    const standing = await landStanding(repo, "main", s.branch);
    expect(standing).toEqual({ kind: "landed", why: `main already contains ${s.branch}` });
    if (standing.kind !== "landed") return;

    closeChore(db, id, standing.why, "runner");
    expect(choreFor(db, "land", "story", s.id)?.state).toBe("done");
    expect(choreRefusal(db, id)?.why).toBe(`main already contains ${s.branch}`);
  });
});
