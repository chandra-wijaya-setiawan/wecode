import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
// Imported by path: the landing rules belong to core but nothing exports them from the
// barrel, and the runner is not a dependency of the cli package.
import { updatePrimary } from "../../core/src/land.js";
import { DEFAULT_BUDGET, Runner } from "../../runner/src/index.js";

/** docs/design/14. A landed story has to be visible in the folder the operator works in.
 *
 *  The landing merge is made in a tree of wecode's own and `refs/heads/<base>` is moved onto
 *  it, so the primary checkout is never written to. Twice on real projects that left the
 *  operator's folder showing the pre-land files — with the landed paths reading as staged
 *  deletions, because HEAD had moved under an index that never saw them — while the board
 *  said delivered and `git log` showed the merge. It reads exactly like lost work.
 *
 *  What is pinned here is that the ref moving is never the whole of a landing: a clean
 *  primary on the base is brought forward, a primary holding the operator's own work is not
 *  touched and the exact command is named, and neither case is silent. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-primary-"));
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

/** A delivered story whose branch adds one file, with the gate's permission on the record:
 *  one acceptance test, passed. Cut and committed with plumbing so the primary checkout is
 *  never left on the story branch — the bug is about what that checkout holds. */
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

describe("a landing leaves the primary checkout current", () => {
  it("brings a clean primary checkout forward itself, with nothing to say about it", async () => {
    const { id } = deliveredStory("landed.ts");
    expect(existsSync(join(repo, "landed.ts"))).toBe(false);

    const tick = await runner().tick();

    // (a) the base gained the commit.
    expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain("landed.ts");
    // (b) and the folder holding nothing but the old tip is put on the new one: the landed
    // file is there, and no staged diff nobody made is left behind.
    expect(existsSync(join(repo, "landed.ts"))).toBe(true);
    expect(git(repo, "status", "--porcelain", "-uno")).toBe("");
    // (c) so there is no instruction worth writing about a tree wecode has made correct.
    expect(tick.landed.find((l) => l.story === id)?.notice ?? null).toBeNull();
  });

  it("leaves a dirty primary checkout alone and names the command", async () => {
    const { id } = deliveredStory("landed.ts");
    writeFileSync(join(repo, "README.md"), "mine, uncommitted\n");

    const tick = await runner().tick();

    // (c) the base still moved — the landing is not held hostage to the operator's tree.
    expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain("landed.ts");
    // Their work is exactly as they left it, and the stale tree was not written.
    expect(git(repo, "show", ":README.md")).toBe("the base");
    expect(existsSync(join(repo, "landed.ts"))).toBe(false);
    // And the landing says so, naming the tree and the command.
    const notice = tick.landed.find((l) => l.story === id)?.notice ?? "";
    expect(notice).toContain(repo);
    expect(notice).toContain("git restore --source=HEAD --staged --worktree .");
    expect(notice).toContain("README.md");
  });

  it("refuses to write over an untracked file sitting on a landed path", async () => {
    const { id } = deliveredStory("landed.ts");
    writeFileSync(join(repo, "landed.ts"), "mine, never committed\n");

    const tick = await runner().tick();

    expect(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n")).toContain("landed.ts");
    expect(git(repo, "show", `${git(repo, "rev-parse", "main")}:landed.ts`)).toBe("landed");
    // Theirs, still on disk, unread by the landing.
    expect(execFileSync("cat", [join(repo, "landed.ts")], { encoding: "utf8" })).toBe(
      "mine, never committed\n",
    );
    expect(tick.landed.find((l) => l.story === id)?.notice ?? "").toContain("landed.ts");
  });

  it("says nothing when the primary checkout is not on the base branch", () => {
    // Somebody else's tree is somebody else's business: the rule only ever speaks about a
    // checkout that has the base out and is therefore showing stale base files.
    expect(
      updatePrimary({
        path: "/w/repo",
        base: "main",
        onBase: false,
        alreadyCurrent: false,
        wasTheOldTip: false,
        ownWork: [],
      }),
    ).toEqual({ kind: "current" });
  });

  it("a ref-only merge is never left stale: every drift is brought forward or spoken", () => {
    // The defect was a third outcome — the ref moved, the tree did not, and nothing was
    // said. There is no input that produces it: one drift is wecode's to fix, the rest
    // are words, and none is silence over a stale tree.
    const drifts = [true, false].flatMap((wasTheOldTip) =>
      [[], ["README.md"]].map((ownWork) => ({
        path: "/w/repo",
        base: "main",
        onBase: true,
        alreadyCurrent: false,
        wasTheOldTip,
        ownWork,
      })),
    );
    for (const drift of drifts) {
      const verdict = updatePrimary(drift);
      // The one clean-at-the-old-tip drift is the only one wecode writes, and it says
      // nothing because there is nothing left for the operator to do.
      if (drift.wasTheOldTip && drift.ownWork.length === 0) {
        expect(verdict).toEqual({ kind: "forward" });
        continue;
      }
      expect(verdict.kind).toBe("tell");
      if (verdict.kind === "tell") {
        expect(verdict.instruction).toContain("/w/repo");
        expect(verdict.instruction).toContain("git restore --source=HEAD --staged --worktree .");
      }
    }
    // And `current` — the verdict that leaves a tree alone and silent — is never one of them.
    expect(drifts.some((d) => updatePrimary(d).kind === "current")).toBe(false);
  });
});
