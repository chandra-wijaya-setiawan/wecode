import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Maker, open } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The standup's "delivered, not landed" group is a list of work somebody has to act on,
 *  and it read landing from `landed_branch` alone. Nothing writes a row there when a story
 *  is merged — the lander records the merge in the chore and in its own tick report, not in
 *  the marker table — so the group only ever grew. On this repository it stood at 378, of
 *  which 371 were sitting in master.
 *
 *  `wecode delivered` had already been taught to ask the base branch instead. These tests
 *  pin the standup to the same reading, against a real repository, because the thing under
 *  test is what git says. */

let repo: string;
let db: DatabaseSync;
let out: string[];
let cwd: string;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const said = (): string => out.join("");

/** The "delivered, not landed" group, as its own lines. */
const group = (): readonly string[] => {
  const lines = said().split("\n");
  const from = lines.findIndex((l) => l.includes("DELIVERED, NOT LANDED"));
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^\d+ [A-Z]/.test(l));
  return (to === -1 ? rest : rest.slice(0, to)).filter((l) => l.trim() !== "");
};

beforeEach(() => {
  repo = tmp("wecode-standup-landing-");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  // Outside the repository on purpose, the way the ancestry test keeps it there: a db file
  // inside it would be swept into the fixture's own commits by `git add -A`.
  process.env["WECODE_DB"] = join(tmp("wecode-standup-record-"), "wecode.db");
  db = open(process.env["WECODE_DB"]);
  seed();

  cwd = process.cwd();
  process.chdir(repo);
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

/** One delivered story under a project whose repo is the repository above. Written onto the
 *  record directly: what is under test is how the standup reads the world. */
function seed(): void {
  const make = new Maker(db);
  const project = make.project(make.workspace("acme", repo), "storefront", repo);
  const story = make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "password reset");
  const criteria = make.criteria(make.requirement(story, "one change per link"), "a reset link arrives in 60s");
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
  db.prepare("UPDATE acceptance_criteria SET state = 'accepted' WHERE id = ?").run(criteria);
}

/** A story branch whose work the base already has: branched, committed, merged back. */
function branchLandedInto(slug: string): void {
  git("checkout", "-q", "-b", `story/${slug}`);
  writeFileSync(join(repo, `${slug}.txt`), "work\n");
  git("add", "-A");
  git("commit", "-q", "-m", `build ${slug}`);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `land story/${slug}`, `story/${slug}`);
}

/** A story branch with work of its own that the base has never seen. */
function branchAheadOfBase(slug: string): void {
  git("checkout", "-q", "-b", `story/${slug}`);
  writeFileSync(join(repo, `${slug}.txt`), "work\n");
  git("add", "-A");
  git("commit", "-q", "-m", `build ${slug}`);
  git("checkout", "-q", "main");
}

describe("the standup reads landing from the base branch", () => {
  it("leaves out a story the base already has, though no marker records the merge", () => {
    branchLandedInto("password-reset");

    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("DELIVERED, NOT LANDED (0)");
    expect(group()).toEqual(["  —"]);
  });

  it("keeps a story whose branch is ahead of the base, which is the work still owed", () => {
    branchAheadOfBase("password-reset");

    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("DELIVERED, NOT LANDED (1)");
    expect(group().join("\n")).toContain("password reset");
  });

  it("agrees with `wecode delivered`, which is the point of one reading in one place", () => {
    branchLandedInto("password-reset");

    expect(run(["delivered"])).toBe(0);
    expect(said()).toContain("landed story/password-reset");
    out.length = 0;

    expect(run(["standup"])).toBe(0);
    expect(said()).toContain("DELIVERED, NOT LANDED (0)");
  });
});
