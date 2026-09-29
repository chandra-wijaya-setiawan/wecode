import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
// Imported by path: the landing rules belong to core but nothing exports them from the
// barrel, and the runner is not a dependency of the cli package.
import { updatePrimary } from "../../core/src/land.js";
import { DEFAULT_BUDGET, Runner } from "../../runner/src/index.js";

/** docs/design/14. What a landing may do to an index it did not fill.
 *
 *  An operator stages work in their own folder and keeps it staged for hours — a half-made
 *  change, a review in progress, a commit they are still writing the message for. A landing
 *  that happens in that window moves the base ref under them, and the one thing it may not
 *  do is touch that index: `reset --hard` would take the staged work with it, and staging
 *  the story's own paths on top of it would write an inverse of the landing into a commit
 *  the operator is about to make under their own message.
 *
 *  So the index is compared entry for entry, before the landing and after. Not "the file is
 *  still there" — `git ls-files -s` is the index itself, and it has to be the same bytes. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-staging-"));
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

/** A delivered story whose branch adds one file, with the gate's permission on the record.
 *  Cut with plumbing so the primary checkout is never left on the story branch — what that
 *  checkout holds is the whole subject. */
function deliveredStory(file: string): { id: number; slug: string } {
  const id = make.story(epic, "add the file");
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
  writeFileSync(join(tree, file), "landed\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "the file");
  git(repo, "worktree", "remove", "--force", tree);
  return { id, slug };
}

/** The index itself: one line per entry, mode, blob and path. Independent of HEAD, so it
 *  does not move when the landing moves the ref — only a write to the index moves it. */
const index = (): string => git(repo, "ls-files", "-s");

describe("a land leaves your staging alone", () => {
  it("does not touch an index holding unrelated staged work", async () => {
    const { id } = deliveredStory("landed.ts");
    // The operator's own staging, on paths the story never mentions: one edit to a tracked
    // file, one brand new file. Both staged, neither committed.
    writeFileSync(join(repo, "README.md"), "mine, half-written\n");
    writeFileSync(join(repo, "notes.md"), "mine, brand new\n");
    git(repo, "add", "README.md", "notes.md");
    const staged = index();

    const tick = await runner().tick();

    // The base moved — the landing is not held hostage to the operator's index.
    expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain("landed.ts");
    // And the index is the same bytes: nothing of theirs unstaged, nothing of the story's
    // staged over it, no inverse of the landing written into the commit they are drafting.
    expect(index()).toBe(staged);
    expect(git(repo, "show", ":README.md")).toBe("mine, half-written");
    expect(git(repo, "show", ":notes.md")).toBe("mine, brand new");
    // Their working files too, byte for byte.
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("mine, half-written\n");
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("mine, brand new\n");

    // Not silently: the notice names their tree, their path, and the mixed stage.
    const notice = tick.landed.find((l) => l.story === id)?.notice ?? "";
    expect(notice).toContain(repo);
    expect(notice).toContain("README.md");
    expect(notice).toContain("your work and the landing's mixed together");
    expect(notice).toContain("git restore --source=HEAD --staged --worktree .");
    // The reassurance owed to an untouched tree would be a lie over their staged work.
    expect(notice).not.toContain("None of it is yours");
  });

  it("stages no inverse of the story on top of a staged path the story also touched", async () => {
    const { id } = deliveredStory("landed.ts");
    // The hardest case: their staged work sits on the very path the landing adds.
    writeFileSync(join(repo, "landed.ts"), "mine, not the landing's\n");
    git(repo, "add", "landed.ts");
    const staged = index();

    const tick = await runner().tick();

    expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain("landed.ts");
    expect(index()).toBe(staged);
    expect(git(repo, "show", ":landed.ts")).toBe("mine, not the landing's");
    expect(readFileSync(join(repo, "landed.ts"), "utf8")).toBe("mine, not the landing's\n");
    expect(tick.landed.find((l) => l.story === id)?.notice ?? "").toContain("landed.ts");
  });

  it("never brings a checkout forward while anything of the operator's is staged in it", () => {
    // The rule alone. `forward` is the only verdict that writes, and it is unreachable the
    // moment the drift names work of theirs — whatever else the checkout looks like.
    for (const wasTheOldTip of [true, false]) {
      const verdict = updatePrimary({
        path: "/w/repo",
        base: "main",
        onBase: true,
        alreadyCurrent: false,
        wasTheOldTip,
        ownWork: ["notes.md"],
      });
      expect(verdict.kind).toBe("tell");
      if (verdict.kind === "tell") {
        expect(verdict.instruction).toContain("work of yours that bringing it forward would write over");
        expect(verdict.instruction).toContain("  notes.md");
      }
    }
  });
});
