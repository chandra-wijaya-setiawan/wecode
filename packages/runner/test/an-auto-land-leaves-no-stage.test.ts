import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { attemptLanding } from "../src/land-chore.js";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";

/** docs/design/14. `wecode land` leaves the checkout it merged in clean — the merge either
 *  commits or is undone, and a base left dirty is said out loud rather than left to be
 *  somebody's mystery. An auto land is the same landing with nobody watching, so it owes the
 *  same promise, and it owes it about two checkouts rather than one.
 *
 *  The operator's checkout: the base ref moves under it, so the landed paths read as staged
 *  deletions until they bring it forward themselves. That folder is theirs and wecode never
 *  writes it, so what it owes there is the sentence — the staged diff named as the
 *  landing's, and the command. Pinned here through a whole tick, because that is the only
 *  place the promise is visible as the operator sees it.
 *
 *  Wecode's own: the merge is made in a detached tree of wecode's own, and that tree is not
 *  a thing an operator should ever have to find, prune or be sent to. It goes on every path
 *  — landed, conflicted, wedged mid-merge — and the refusal is worded after it has gone, so
 *  a chore never names a directory that is not there. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;

/** Every checkout of the repository, as git itself lists them. */
const checkouts = (): string[] =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

const landTree = (): string => join(repo, ".wecode", "worktrees", "land-x");

const commit = (cwd: string, message: string): void => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", message);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-auto-land-stage-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  commit(repo, "seed");
});

/** A story branch off the base tip, carrying one commit that writes `file`. */
function branchOf(file: string, body: string): string {
  const tree = join(repo, `.cut-${file}`);
  git(repo, "branch", "story/x", "main");
  git(repo, "worktree", "add", "-q", tree, "story/x");
  writeFileSync(join(tree, file), body);
  commit(tree, "the story");
  git(repo, "worktree", "remove", "--force", tree);
  return "story/x";
}

const place = () => ({ repo, base: "main", branch: "story/x", tree: landTree() });

describe("an auto land, in wecode's own tree", () => {
  it("leaves no tree standing when the landing is made", async () => {
    const before = checkouts();
    branchOf("reset.ts", "password reset\n");

    const attempt = await attemptLanding(place());

    expect(attempt.kind).toBe("landed");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("land story/x");
    // The tree the merge was made in is gone from the disk and from git's own record of
    // what this repository's checkouts are. An operator never prunes after a landing.
    expect(existsSync(landTree())).toBe(false);
    expect(checkouts()).toEqual(before);
  });

  it("leaves no tree and no merge standing when the merge conflicts", async () => {
    const before = checkouts();
    branchOf("README.md", "the story's line\n");
    writeFileSync(join(repo, "README.md"), "the operator's line\n");
    commit(repo, "the base moves");
    const tip = git(repo, "rev-parse", "main");

    const attempt = await attemptLanding(place());

    expect(attempt.kind).toBe("refused");
    const why = attempt.kind === "refused" ? attempt.why : "";
    expect(why).toContain("conflicted in: README.md");
    expect(why).toContain("no merge is left standing");
    // Worded after the removal: the refusal becomes a chore a person reads, and it must not
    // send them to a directory wecode has deleted.
    expect(why).not.toContain("wants a person");
    expect(existsSync(landTree())).toBe(false);
    expect(checkouts()).toEqual(before);
    // And the repository is exactly as it was found: the base where it was, nothing staged
    // in the checkout the operator works in.
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("says so, and names it, when the tree will not go", async () => {
    // A tree that cannot be removed: a merge driver takes the write bit off a directory
    // inside it, so the merge conflicts, `merge --abort` succeeds — and the tree survives
    // `worktree remove --force`. Somebody's post-merge hook, a root-owned artefact, a busy
    // file on another platform: the shapes differ, the fact is the same.
    //
    // This is the one case where the landing leaves a checkout behind, and it is the whole
    // reason the refusal is worded after the removal rather than before it. Read off
    // `MERGE_HEAD` — which the abort did clear — the sentence says the tree is fine.
    writeFileSync(join(repo, ".gitattributes"), "conflicted.txt merge=wedge\n");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "keep.txt"), "kept\n");
    writeFileSync(join(repo, "conflicted.txt"), "the base line\n");
    commit(repo, "a driver and a directory");
    branchOf("conflicted.txt", "the story's line\n");
    writeFileSync(join(repo, "conflicted.txt"), "the operator's line\n");
    commit(repo, "the base moves");
    git(repo, "config", "merge.wedge.name", "a driver that wedges the tree");
    git(repo, "config", "merge.wedge.driver", 'sh -c "chmod 500 sub; exit 1"');

    try {
      const attempt = await attemptLanding(place());

      expect(attempt.kind).toBe("refused");
      const why = attempt.kind === "refused" ? attempt.why : "";
      expect(why).toContain("conflicted in: conflicted.txt");
      expect(why).toContain(landTree());
      expect(why).toContain("wants a person");
      expect(why).not.toContain("no merge is left standing");
      // The chore's sentence is true of the repository the caller is handed back: the
      // directory is on the disk. Git gave up its own record of it — `prune` takes that
      // either way — so `worktree list` is exactly the answer that would let this be
      // missed, and the only thing left saying it is the refusal.
      expect(existsSync(landTree())).toBe(true);
      expect(checkouts()).not.toContain(landTree());
    } finally {
      if (existsSync(join(landTree(), "sub"))) chmodSync(join(landTree(), "sub"), 0o700);
    }
  });

  it("clears away what an interrupted tick left at the same path", async () => {
    branchOf("reset.ts", "password reset\n");
    // A tick killed between `worktree add` and the removal: a tree at wecode's path, dirty,
    // holding no copy of anything — the branch is the only copy of what matters.
    git(repo, "worktree", "add", "-q", "--detach", landTree(), "main");
    writeFileSync(join(landTree(), "README.md"), "half a merge\n");

    const attempt = await attemptLanding(place());

    expect(attempt.kind).toBe("landed");
    expect(existsSync(landTree())).toBe(false);
  });

  it("cuts no tree at all when there is nothing owed", async () => {
    const before = checkouts();

    // No branch: the landing is not attempted, so nothing is made to take away either.
    expect(await attemptLanding(place())).toEqual({ kind: "nothing", why: "no-branch" });
    expect(existsSync(landTree())).toBe(false);
    expect(checkouts()).toEqual(before);
  });
});

describe("an auto land, in the operator's checkout", () => {
  it("leaves the tree alone and says what is staged there", async () => {
    const db: DatabaseSync = open(join(repo, "wecode.db"));
    const make = new Maker(db);
    const project = make.project(make.workspace("acme", repo), "storefront", repo);
    const story = make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "password reset");
    const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
    const test = make.acceptanceTest(
      make.criteria(make.requirement(story, "it behaves"), "proven"),
      "it works",
      "script",
      "true",
    );
    db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(test);
    const tree = join(repo, `.cut-${slug}`);
    git(repo, "branch", `story/${slug}`, "main");
    git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
    writeFileSync(join(tree, "reset.ts"), "password reset\n");
    commit(tree, "the story");
    git(repo, "worktree", "remove", "--force", tree);

    const tick = await new Runner(db, {
      budget: DEFAULT_BUDGET,
      repoRoot: repo,
      adapters: {},
      integrationBranch: "main",
    }).tick();

    // The whole promise, as the operator sees it. The ref moved under their checkout, so
    // the landed path *is* a staged deletion there — and wecode does not reach into their
    // folder to clear it. What it owes is the sentence: the staged diff named as the
    // landing's rather than theirs, and the command that clears it.
    expect(git(repo, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(existsSync(join(repo, "reset.ts"))).toBe(false);
    expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toContain("reset.ts");

    const notice = tick.landed.find((l) => l.story === story)?.notice ?? "";
    expect(notice).toContain(repo);
    expect(notice).toContain("staged deletions");
    expect(notice).toContain("None of it is yours");
    expect(notice).toContain("git restore --source=HEAD --staged --worktree .");
  });
});
