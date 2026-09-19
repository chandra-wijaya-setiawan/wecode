import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";
// Imported by path: the rule belongs to core but nothing exports it from the barrel.
import { type PrimaryDrift, updatePrimary } from "../../core/src/land.js";

/** A landing adds files, and the operator's checkout is the one place that shows up as the
 *  opposite: HEAD moves under an index that never saw the new paths, so `git status` there
 *  reads them as staged deletions of files the operator never had. The instruction land
 *  gives has to end that in one command — the added files on disk, and nothing staged.
 *
 *  Both halves, because either alone is a trap. Restoring only the worktree writes the files
 *  and leaves their removal staged, so the operator's next commit deletes what just landed.
 *  Restoring only the index unstages the removal and leaves the files missing, so the tree
 *  looks clean while the landing is not in it. This file pins the command that does both, by
 *  running it on a real checkout and looking at what is left. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

interface Landed {
  readonly repo: string;
  readonly before: string;
  readonly after: string;
}

/** A checkout on master, plus a story branch that adds `b.txt` and `sub/deep.txt` — a
 *  subdirectory too, because a path in one is the path a cwd-relative command misses. */
function operatorCheckout(alsoOnStory: (repo: string) => void = () => {}): Landed {
  const repo = join(tmp("land-new-files-"), "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.name", "Tess");
  git(repo, "config", "user.email", "tess@example.com");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "first");
  const before = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "story/pay-up");
  writeFileSync(join(repo, "b.txt"), "landed\n");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "sub", "deep.txt"), "landed deep\n");
  alsoOnStory(repo);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "on the story");
  git(repo, "checkout", "-q", "master");
  return { repo, before, after: git(repo, "rev-parse", "story/pay-up") };
}

/** The landing as wecode makes it from somewhere else: the ref moves, and this checkout's
 *  index and working files are not touched. */
function landElsewhere({ repo, after }: Landed): void {
  git(repo, "update-ref", "refs/heads/master", after);
}

/** The facts `updatePrimary` is decided on, read off a real checkout the way the runner
 *  reads them: staleness measured against the tip the base had before the landing. */
function drift({ repo, before, after }: Landed): PrimaryDrift {
  const quiet = (...args: string[]): boolean => {
    try {
      git(repo, ...args);
      return true;
    } catch {
      return false;
    }
  };
  const matches = (c: string): boolean =>
    quiet("diff", "--quiet", c) && quiet("diff", "--cached", "--quiet", c);
  const lines = (out: string): string[] => out.split("\n").filter((l) => l !== "");
  const landed = new Set(lines(git(repo, "diff", "--name-only", before, after)));
  const mine = [
    ...lines(git(repo, "diff", "--name-only", before)),
    ...lines(git(repo, "diff", "--cached", "--name-only", before)),
    ...lines(git(repo, "ls-files", "--others", "--exclude-standard")).filter((p) => landed.has(p)),
  ];
  return {
    path: repo,
    base: "master",
    onBase: git(repo, "rev-parse", "--abbrev-ref", "HEAD") === "master",
    alreadyCurrent: matches(after),
    wasTheOldTip: matches(before),
    ownWork: [...new Set(mine)].sort(),
  };
}

const tell = (landed: Landed): string => {
  const update = updatePrimary(drift(landed));
  expect(update.kind).toBe("tell");
  return update.kind === "tell" ? update.instruction : "";
};

/** The `in <path>: git …` line of the instruction, split into the directory it names and
 *  the argv it names, with the trailing parenthetical dropped. */
function command(instruction: string): { where: string; argv: string[] } {
  const line = instruction.split("\n").find((l) => l.includes(": git restore"));
  expect(line).toBeDefined();
  const [where, rest] = (line as string).trim().split(": git ");
  return {
    where: where.replace(/^in /, ""),
    argv: rest.replace(/ \(.*$/, "").trim().split(" "),
  };
}

/** Run the instruction's command, in the directory the instruction names. */
function obey(instruction: string): void {
  const { where, argv } = command(instruction);
  git(where, ...argv);
}

const read = (repo: string, ...path: string[]): string =>
  readFileSync(join(repo, ...path), "utf8");

/** `git status --porcelain` as lines, with the two status columns kept: an unstaged change
 *  leads with a space, and trimming the output would read it as a staged one. */
const status = (repo: string): string[] =>
  execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((l) => l !== "");

/** The lines whose index column says something is staged. */
const staged = (repo: string): string[] =>
  status(repo).filter((l) => l[0] !== " " && l[0] !== "?");

describe("a land brings its new files forward without staging their removal", () => {
  it("starts from the state the story is about: the added paths staged as deletions", () => {
    const landed = operatorCheckout();
    landElsewhere(landed);

    // Nothing of the operator's, and two files they never had, staged for deletion.
    expect(status(landed.repo)).toEqual(["D  b.txt", "D  sub/deep.txt"]);
    expect(existsSync(join(landed.repo, "b.txt"))).toBe(false);
  });

  it("puts the added files on disk with the landing's content once obeyed", () => {
    const landed = operatorCheckout();
    landElsewhere(landed);

    obey(tell(landed));

    expect(read(landed.repo, "b.txt")).toBe("landed\n");
    expect(read(landed.repo, "sub", "deep.txt")).toBe("landed deep\n");
    expect(updatePrimary(drift(landed))).toEqual({ kind: "current" });
  });

  it("leaves no removal of them staged", () => {
    const landed = operatorCheckout();
    landElsewhere(landed);

    obey(tell(landed));

    expect(staged(landed.repo)).toEqual([]);
    expect(status(landed.repo)).toEqual([]);
    // The proof that matters most: the operator's next commit carries no deletion.
    git(landed.repo, "commit", "-qm", "next", "--allow-empty");
    expect(git(landed.repo, "show", "--name-only", "--format=", "HEAD")).toBe("");
  });

  it("names a command that restores the index and the working tree from HEAD", () => {
    const landed = operatorCheckout();
    landElsewhere(landed);
    const { where, argv } = command(tell(landed));

    // Either half alone is the trap this story is about, so both are named, and from HEAD —
    // the landing — rather than from the index the removals are staged in.
    expect(argv).toEqual(["restore", "--source=HEAD", "--staged", "--worktree", "."]);
    // And it is named for the checkout's own root, which is what makes the `.` reach
    // `sub/deep.txt` as well as `b.txt`.
    expect(where).toBe(landed.repo);
  });

  it("would leave the removal staged if only the working tree were restored", () => {
    const landed = operatorCheckout();
    landElsewhere(landed);

    git(landed.repo, "restore", "--source=HEAD", "--worktree", ".");

    expect(read(landed.repo, "b.txt")).toBe("landed\n");
    expect(staged(landed.repo)).toEqual(["D  b.txt", "D  sub/deep.txt"]);
  });

  it("would leave the added files missing if only the index were restored", () => {
    const landed = operatorCheckout();
    landElsewhere(landed);

    git(landed.repo, "restore", "--source=HEAD", "--staged", ".");

    expect(staged(landed.repo)).toEqual([]);
    expect(existsSync(join(landed.repo, "b.txt"))).toBe(false);
    // Nothing is staged, so the tree reads as tidy while the landing is not in it — which is
    // why the unstaged deletions below are the only thing left saying so.
    expect(status(landed.repo)).toEqual([" D b.txt", " D sub/deep.txt"]);
  });

  it("brings a path the landing removed forward in the same command", () => {
    const landed = operatorCheckout((repo) => {
      writeFileSync(join(repo, "a.txt"), "base\n");
      git(repo, "rm", "-q", "a.txt");
    });
    landElsewhere(landed);

    // A path the landing deleted is the mirror image: staged as an addition here.
    expect(staged(landed.repo)).toContain("A  a.txt");
    obey(tell(landed));

    expect(existsSync(join(landed.repo, "a.txt"))).toBe(false);
    expect(status(landed.repo)).toEqual([]);
  });

  it("warns before the command when the operator's own file sits on an added path", () => {
    const landed = operatorCheckout();
    writeFileSync(join(landed.repo, "b.txt"), "mine\n");
    landElsewhere(landed);

    const said = tell(landed);
    expect(said).toContain("has work of yours that bringing it forward would write over");
    expect(said).toContain("  b.txt");
    expect(said).toContain("look before you discard any of it");
    // The command is still the one that brings the files forward — it is just not one to run
    // before looking, so the discard is said out loud alongside it.
    expect(command(said).argv).toContain("--staged");
    expect(said).toContain("this discards them");
  });
});
