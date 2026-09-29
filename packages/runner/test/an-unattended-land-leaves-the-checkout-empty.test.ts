import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { attemptLanding } from "../src/land-chore.js";

/** docs/design/14. An unattended land cuts a detached tree of wecode's own, and the operator
 *  whose checkout that path sits under never asked for it. `an-auto-land-leaves-no-stage`
 *  pins the landing's own ways out — merged, conflicted, wedged mid-merge. This is about the
 *  way out that has no merge in it at all: the cut itself failing, and the remains a cut that
 *  died part-way leaves at wecode's path.
 *
 *  Those remains are worse than untidy. Git disowns a worktree whose creation it could not
 *  finish, so `worktree remove` refuses the directory for ever and `worktree add` refuses to
 *  cut over it — one interrupted tick and no landing is ever made again, with nothing on the
 *  board saying the reason is a directory. wecode made the path, so wecode takes it away, and
 *  says so plainly on the one path where it cannot. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;

const landTree = (): string => join(repo, ".wecode", "worktrees", "land-x");

const place = () => ({ repo, base: "main", branch: "story/x", tree: landTree() });

const commit = (cwd: string, message: string): void => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", message);
};

/** Every checkout of the repository, as git itself lists them. */
const checkouts = (): string[] =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-land-empty-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  commit(repo, "seed");
});

/** A story branch off the base tip, carrying one commit that writes `file`. */
function branchOf(file: string, body: string): void {
  const tree = join(repo, `.cut-${file}`);
  git(repo, "branch", "story/x", "main");
  git(repo, "worktree", "add", "-q", tree, "story/x");
  writeFileSync(join(tree, file), body);
  commit(tree, "the story");
  git(repo, "worktree", "remove", "--force", tree);
}

/** A checkout git will not finish making: the base cannot be written out, because a required
 *  smudge filter refuses every path of it. `wedge` makes git's own cleanup fail too, by
 *  leaving a directory behind that nobody may write in — a root-owned artefact, a busy file
 *  on another platform: the shapes differ, the fact is the same. */
function cutFails(wedge: boolean): void {
  writeFileSync(join(repo, ".gitattributes"), "* filter=boom\n");
  commit(repo, "a filter that refuses");
  git(repo, "config", "filter.boom.required", "true");
  git(repo, "config", "filter.boom.clean", "cat");
  const smudge = wedge ? 'sh -c "mkdir -p sub && touch sub/x && chmod 500 sub; exit 1"' : "false";
  git(repo, "config", "filter.boom.smudge", smudge);
}

describe("an unattended land, when the cut dies part-way", () => {
  it("leaves nothing at wecode's path, and says nothing is left", async () => {
    branchOf("reset.ts", "password reset\n");
    cutFails(false);
    const tip = git(repo, "rev-parse", "main");

    const attempt = await attemptLanding(place());

    expect(attempt.kind).toBe("refused");
    const why = attempt.kind === "refused" ? attempt.why : "";
    expect(why).toContain("could not be cut at main");
    expect(why).toContain("nothing is left at that path");
    expect(why).not.toContain("wants a person");
    // The refusal becomes a chore a person reads, and the repository it describes is the one
    // they will find: no directory of wecode's, no checkout of wecode's, the base where it
    // was, and nothing staged in the folder they work in.
    expect(existsSync(landTree())).toBe(false);
    expect(checkouts()).toEqual([repo]);
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(git(repo, "status", "--porcelain", "--untracked-files=no")).toBe("");
  });

  it("names the path when the remains will not go", async () => {
    branchOf("reset.ts", "password reset\n");
    cutFails(true);

    try {
      const attempt = await attemptLanding(place());

      expect(attempt.kind).toBe("refused");
      const why = attempt.kind === "refused" ? attempt.why : "";
      expect(why).toContain(landTree());
      expect(why).toContain("wants a person");
      expect(why).not.toContain("nothing is left at that path");
      // The sentence is true of the disk. Git kept no record of the half-made checkout, so
      // `worktree list` is exactly the answer that would let this be missed, and the refusal
      // is the only thing left saying it.
      expect(existsSync(landTree())).toBe(true);
      expect(checkouts()).toEqual([repo]);
    } finally {
      if (existsSync(join(landTree(), "sub"))) chmodSync(join(landTree(), "sub"), 0o700);
    }
  });
});

describe("an unattended land, over the remains of one that died", () => {
  it("clears away a half-made checkout git has disowned, and lands", async () => {
    branchOf("reset.ts", "password reset\n");
    // What the previous test leaves once the person has undone the permissions: a directory
    // at wecode's path, holding half a copy of the base and a `.git` file pointing at a
    // record git no longer has. `worktree remove` refuses it and `worktree add` will not cut
    // over it, so unless wecode takes it away itself this repository never lands again.
    mkdirSync(join(landTree(), "sub"), { recursive: true });
    writeFileSync(join(landTree(), ".git"), "gitdir: /gone\n");
    writeFileSync(join(landTree(), "sub", "x"), "half a base\n");

    const attempt = await attemptLanding(place());

    expect(attempt.kind).toBe("landed");
    expect(git(repo, "log", "-1", "--format=%s", "main")).toBe("land story/x");
    expect(existsSync(landTree())).toBe(false);
    expect(checkouts()).toEqual([repo]);
  });

  it("leaves a checkout git does own to `worktree remove`", async () => {
    branchOf("reset.ts", "password reset\n");
    // The other shape of remains: a tick killed after `worktree add`, so the tree is dirty
    // but git still holds its record. It goes the way git removes things, record and all —
    // the plain `rm` is for what git has disowned, and only for that.
    git(repo, "worktree", "add", "-q", "--detach", landTree(), "main");
    writeFileSync(join(landTree(), "README.md"), "half a merge\n");

    const attempt = await attemptLanding(place());

    expect(attempt.kind).toBe("landed");
    expect(existsSync(landTree())).toBe(false);
    expect(checkouts()).toEqual([repo]);
  });
});
