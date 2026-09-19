import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";
// Imported by path: the rule belongs to core but nothing exports it from the barrel.
import { type PrimaryDrift, updatePrimary } from "../../core/src/land.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

/** A checkout on master holding `a.txt`, plus a `story/pay-up` branch that adds `b.txt`.
 *  Left on master, at the tip master had before anything landed. */
function operatorCheckout(): { repo: string; before: string; after: string } {
  const repo = join(tmp("land-no-stage-"), "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.name", "Tess");
  git(repo, "config", "user.email", "tess@example.com");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "first");
  const before = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "story/pay-up");
  writeFileSync(join(repo, "b.txt"), "new\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-qm", "on the story");
  git(repo, "checkout", "-q", "master");
  return { repo, before, after: git(repo, "rev-parse", "story/pay-up") };
}

/** The landing as wecode makes it from somewhere else: the ref moves, and this checkout's
 *  index and working files are not touched. */
function landElsewhere(repo: string, after: string): void {
  git(repo, "update-ref", "refs/heads/master", after);
}

/** The facts `updatePrimary` is decided on, read off a real checkout the way the runner
 *  reads them: staleness measured against the tip the base had before the landing. */
function drift(repo: string, before: string, after: string): PrimaryDrift {
  const quiet = (...args: string[]): boolean => {
    try {
      git(repo, ...args);
      return true;
    } catch {
      return false;
    }
  };
  const matches = (c: string): boolean => quiet("diff", "--quiet", c) && quiet("diff", "--cached", "--quiet", c);
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

/** The command the instruction names, run in the path it names it for. */
function obey(instruction: string): void {
  const line = instruction.split("\n").find((l) => l.includes(": git restore"));
  expect(line).toBeDefined();
  const [where, rest] = (line as string).trim().split(": git ");
  git(where.replace(/^in /, ""), ...(rest as string).replace(/ \(.*$/, "").split(" "));
}

const tell = (u: ReturnType<typeof updatePrimary>): string => {
  expect(u.kind).toBe("tell");
  return u.kind === "tell" ? u.instruction : "";
};

describe("a land leaves nothing staged in the operator's checkout", () => {
  it("names the staged diff the moved ref left behind, and says it is not the operator's", () => {
    const { repo, before, after } = operatorCheckout();
    landElsewhere(repo, after);

    // The state the story is about: nothing the operator did, and a staged deletion of the
    // path the landing added, because HEAD moved under an index that never saw it.
    expect(git(repo, "status", "--porcelain")).toBe("D  b.txt");

    const said = tell(updatePrimary(drift(repo, before, after)));
    expect(said).toContain("master moved");
    expect(said).toContain("reads the story's paths as a staged diff");
    expect(said).toContain("staged deletions");
    expect(said).toContain("None of it is yours and none of it is lost");
    expect(said).toContain("git restore --source=HEAD --staged --worktree .");
  });

  it("leaves the checkout with nothing staged once its command has been obeyed", () => {
    const { repo, before, after } = operatorCheckout();
    landElsewhere(repo, after);

    obey(tell(updatePrimary(drift(repo, before, after))));

    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "status", "--porcelain")).toBe("");
    // And the operator is now looking at the landing rather than at the files before it.
    expect(updatePrimary(drift(repo, before, after)).kind).toBe("current");
  });

  it("calls the staged diff mixed when the operator has work of their own in there", () => {
    const { repo, before, after } = operatorCheckout();
    writeFileSync(join(repo, "a.txt"), "mine\n");
    git(repo, "add", "a.txt");
    landElsewhere(repo, after);

    const said = tell(updatePrimary(drift(repo, before, after)));
    expect(said).toContain("has work of yours");
    expect(said).toContain("  a.txt");
    expect(said).toContain("your work and the landing's mixed together");
    expect(said).toContain("look before you discard any of it");
    // The untouched-tree reassurance would be a lie here, so it is not said.
    expect(said).not.toContain("None of it is yours");
  });

  it("says nothing about a stage to a checkout that already holds the landing", () => {
    const { repo, before, after } = operatorCheckout();
    landElsewhere(repo, after);
    git(repo, "reset", "--hard", "-q", after);

    expect(updatePrimary(drift(repo, before, after))).toEqual({ kind: "current" });
  });

  it("says nothing to a checkout that is not on the base at all", () => {
    const { repo, before, after } = operatorCheckout();
    landElsewhere(repo, after);
    git(repo, "checkout", "-q", "-b", "side");

    expect(updatePrimary(drift(repo, before, after))).toEqual({ kind: "current" });
  });

  it("still warns a checkout that has drifted off the commit the landing was made from", () => {
    const base = { path: "/w/primary", base: "master", onBase: true, alreadyCurrent: false };
    const said = tell(updatePrimary({ ...base, wasTheOldTip: false, ownWork: [] }));
    expect(said).toContain("is not at the commit master was landed from");
    expect(said).toContain("reads the story's paths as a staged diff");
  });
});
