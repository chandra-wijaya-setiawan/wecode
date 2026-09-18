import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";
// Imported by path: the rules belong to core but nothing exports them from the barrel.
import { refuseResurrection, type LandingDiff } from "../../core/src/land.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const lines = (out: string): readonly string[] => out.split("\n").filter((l) => l !== "");

/** The repository the rule is judged against.
 *
 *  Its history is the incident, in order:
 *
 *    1. master has `mail.ts` and `a.txt`
 *    2. master removes `mail.ts` — the decision the merge must not undo
 *    3. `story/x` forks *here*, so its merge base does not hold `mail.ts`
 *    4. `story/x` re-adds `mail.ts` and edits `a.txt`
 *
 *  The fork point matters more than anything else here. A branch that forked at step 1 and
 *  left the file alone merges as a deletion, which needs no rule; it is the branch that
 *  forked after the removal and brought the path back that git carries in silently. */
function fixture(): string {
  const repo = join(tmp("land-resurrect-"), "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master", ".");
  git(repo, "config", "user.name", "Tess");
  git(repo, "config", "user.email", "tess@example.com");
  writeFileSync(join(repo, "a.txt"), "base\n");
  writeFileSync(join(repo, "mail.ts"), "export const send = () => {};\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  rmSync(join(repo, "mail.ts"));
  git(repo, "commit", "-qam", "remove mail.ts");
  git(repo, "checkout", "-q", "-b", "story/x");
  writeFileSync(join(repo, "mail.ts"), "export const send = () => {};\n");
  writeFileSync(join(repo, "a.txt"), "story\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "attempt");
  git(repo, "checkout", "-q", "master");
  return repo;
}

/** The rule's two path sets, read out of a real repository by the commands its interface
 *  names. Written once here so that the sets the tests reason about are the sets git gives
 *  and not sets a test author found convenient. */
function diff(repo: string, branch: string, base = "master"): LandingDiff {
  const mergeBase = git(repo, "merge-base", base, branch);
  const held = new Set(lines(git(repo, "ls-tree", "-r", "--name-only", base)));
  const everDeleted = lines(git(repo, "log", "--diff-filter=D", "--name-only", "--pretty=format:", base));
  return {
    branch,
    base,
    added: lines(git(repo, "diff", "--name-only", "--diff-filter=A", mergeBase, branch)),
    removedByBase: [...new Set(everDeleted)].filter((p) => !held.has(p)),
  };
}

describe("the paths a landing merge is judged on", () => {
  it("are what git says: mail.ts is added by the branch and removed by the base", () => {
    const d = diff(fixture(), "story/x");
    expect(d.added).toEqual(["mail.ts"]);
    expect(d.removedByBase).toEqual(["mail.ts"]);
  });

  it("is a case git lands silently, which is why there is a rule at all", () => {
    // The motivation, proved rather than asserted: the merge succeeds, and the file the base
    // deleted is back in the working tree. All git says about it is `create mode`, the same
    // words it uses for a file nobody ever removed — and `wecode land` pipes that output
    // away, so the operator is told the story landed and nothing else.
    const repo = fixture();
    const said = git(repo, "merge", "--no-ff", "-m", "land story/x", "story/x");
    expect(said).not.toContain("CONFLICT");
    expect(said).toContain("create mode 100644 mail.ts");
    expect(said).not.toContain("removed");
    expect(existsSync(join(repo, "mail.ts"))).toBe(true);
  });
});

describe("a land that would restore a path the base removed", () => {
  const refusal = (): string => {
    const why = refuseResurrection(diff(fixture(), "story/x"));
    expect(why).not.toBeNull();
    return why ?? "";
  };

  it("is refused", () => {
    expect(refusal()).toContain("land story/x refused");
  });

  it("names the path, because the operator cannot decide without knowing which file", () => {
    expect(refusal()).toContain("mail.ts");
  });

  it("names the path on a line of its own, not buried in a sentence", () => {
    expect(refusal().split("\n")).toContain("  mail.ts");
  });

  it("says the base removed it, so the refusal is not read as a conflict", () => {
    expect(refusal()).toContain("master removed");
    expect(refusal()).not.toContain("conflict");
  });

  it("says what to do about it, which is a decision about the branch", () => {
    expect(refusal()).toContain("drop the commit on story/x that re-adds it");
    expect(refusal()).toContain("redeliver");
  });

  it("names every such path when there is more than one, and each only once", () => {
    const why = refuseResurrection({
      branch: "story/x",
      base: "master",
      added: ["b.ts", "mail.ts", "mail.ts", "new.ts"],
      removedByBase: ["b.ts", "mail.ts", "gone.ts"],
    });
    expect(why?.split("\n").filter((l) => l.startsWith("  ") && l.endsWith(".ts"))).toEqual([
      "  b.ts",
      "  mail.ts",
    ]);
    expect(why).toContain("2 paths");
  });

  it("names them in a fixed order, so two operators reading one refusal read the same thing", () => {
    const one = refuseResurrection({ branch: "s", base: "m", added: ["z.ts", "a.ts"], removedByBase: ["a.ts", "z.ts"] });
    const other = refuseResurrection({ branch: "s", base: "m", added: ["a.ts", "z.ts"], removedByBase: ["z.ts", "a.ts"] });
    expect(one).toBe(other);
    expect(one?.indexOf("a.ts")).toBeLessThan(one?.indexOf("z.ts") ?? -1);
  });
});

describe("a land that restores nothing", () => {
  it("is allowed when the branch adds a path the base never had", () => {
    const repo = fixture();
    git(repo, "checkout", "-q", "story/x");
    writeFileSync(join(repo, "brand-new.ts"), "export const x = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "a genuinely new file");
    git(repo, "checkout", "-q", "master");
    const d = diff(repo, "story/x");
    expect(d.added).toContain("brand-new.ts");
    // A new file is not a resurrection, whatever else this branch is guilty of.
    expect(refuseResurrection({ ...d, removedByBase: [] })).toBeNull();
  });

  it("is allowed when the base removed the path after the fork, which the merge deletes anyway", () => {
    // The branch forks before the removal and leaves the file alone. `mail.ts` is in the
    // merge base, so it is not added by the branch, and git's merge keeps it deleted —
    // the rule must not mistake that for a resurrection.
    const repo = join(tmp("land-late-removal-"), "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "master", ".");
    git(repo, "config", "user.name", "Tess");
    git(repo, "config", "user.email", "tess@example.com");
    writeFileSync(join(repo, "a.txt"), "base\n");
    writeFileSync(join(repo, "mail.ts"), "export const send = () => {};\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "first");
    git(repo, "checkout", "-q", "-b", "story/y");
    writeFileSync(join(repo, "a.txt"), "story\n");
    git(repo, "commit", "-qam", "the story's own change");
    git(repo, "checkout", "-q", "master");
    rmSync(join(repo, "mail.ts"));
    git(repo, "commit", "-qam", "remove mail.ts");

    const d = diff(repo, "story/y");
    expect(d.removedByBase).toEqual(["mail.ts"]);
    expect(d.added).toEqual([]);
    expect(refuseResurrection(d)).toBeNull();
    git(repo, "merge", "--no-ff", "-m", "land story/y", "story/y");
    expect(existsSync(join(repo, "mail.ts"))).toBe(false);
  });

  it("is allowed when the base has never removed anything", () => {
    expect(refuseResurrection({ branch: "s", base: "m", added: ["a.ts"], removedByBase: [] })).toBeNull();
  });
});
