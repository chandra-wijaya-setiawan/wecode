import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyChore, choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";

/** The runner half of docs/design/18's rule: a chore's state is a claim about the world now.
 *
 *  `raiseMergeChores` re-reads the condition on every tick, so it is the one place that can
 *  say either half. Story 139: the branch merged, the chore was discharged, the story beside
 *  it landed and the branch was behind again — and nothing raised it. Story 192: the branch
 *  became mergeable and the chore stayed `failed`, because the runner rightly stopped calling
 *  `ensureChore` and nothing closed it.
 *
 *  These drive real git rather than stubbing the condition: the bug was in what the runner
 *  read off the branch, so a test that told it the answer would prove nothing. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-chore-level-"));
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

function deliveredStory(title: string, line: string): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), line);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);
  return { id, slug };
}

/** The base moves under a delivered story, on the same line: the two cannot both be true. */
function moveTheBase(line: string): void {
  writeFileSync(join(repo, "README.md"), line);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
}

const stateOf = (story: number): string | undefined => choreFor(db, "merge", "story", story)?.state;

describe("the story beside it lands and the branch is behind again", () => {
  it("raises the same chore a second time, rather than leaving a done row as a memo", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    await runner().tick();

    // The chore was performed and proved: whoever took it merged the base in.
    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    for (const verb of ["start", "begin", "finish"]) applyChore(db, id, verb, "system-1");
    expect(stateOf(story.id)).toBe("done");

    // Story 138 lands. The branch conflicts with the base again, on a line neither side
    // knows about, so the condition the chore was raised for is true a second time.
    git(repo, "checkout", "-q", "main");
    moveTheBase("a third line entirely\n");

    const tick = await runner().tick();

    expect(tick.chores).toEqual([id]);
    expect(stateOf(story.id)).toBe("planned");
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(1);
  });
});

describe("the branch becomes mergeable while the chore sits failed", () => {
  it("closes it, with the reason, rather than refusing a stale claim every tick", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    await runner().tick();

    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");
    expect(stateOf(story.id)).toBe("failed");

    // Somebody took the conflict out by hand: the base goes back to what the branch grew
    // from, so the two merge and nothing is owed. The merge itself has still not been made.
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "README.md"), "the base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "the conflict is taken out");

    const tick = await runner().tick();

    expect(tick.chores).toEqual([]);
    expect(stateOf(story.id)).toBe("done");
    expect(choreRefusal(db, id)?.why).toBe(`story/${story.slug} no longer conflicts with main`);
    expect(
      db
        .prepare("SELECT verb, from_state, actor FROM ledger WHERE entity = 'chore' AND entity_id = ? ORDER BY id")
        .all(id)
        .at(-1),
    ).toMatchObject({ verb: "close", from_state: "failed", actor: "runner" });
  });

  it("but not when the merge is what made it mergeable: that is the chore's check to judge", async () => {
    const story = deliveredStory("password reset", "the story's line\n");
    moveTheBase("the base's line\n");
    await runner().tick();

    const id = choreFor(db, "merge", "story", story.id)?.id as number;
    for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");

    // The attempt did land the merge on the branch after all. The branch now contains the
    // base, so it merges cleanly — but the world did not move, a chore's attempt did.
    const tree = join(repo, ".tree-merged");
    git(repo, "worktree", "add", "-q", tree, `story/${story.slug}`);
    git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "-q", "--no-edit", "-X", "ours", "main");
    git(repo, "worktree", "remove", "--force", tree);

    await runner().tick();

    expect(stateOf(story.id)).toBe("failed");
    expect(choreRefusal(db, id)?.why).not.toBe(`story/${story.slug} no longer conflicts with main`);
  });
});
