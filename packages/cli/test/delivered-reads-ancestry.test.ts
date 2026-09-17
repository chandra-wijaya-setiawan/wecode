import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Maker, open } from "@wecode/core";
import { delivered } from "../src/delivered.js";
import { tmp } from "../../core/test/tmpdir.js";

/** `wecode delivered` says landed or unlanded, and until now it said it from
 *  `landed_branch` — a marker the runner writes on the one path that merges. Five stories
 *  that landed inside somebody else's merge have no row there, and the command called them
 *  unlanded while their code was in master.
 *
 *  So the base branch is the authority: a story branch with nothing on it the base does not
 *  already have is landed, marker or no marker. These tests run against a real repository,
 *  because the thing under test is what git says. */

let repo: string;
let db: DatabaseSync;
let out: string[];
let err: string[];
let cwd: string;
let under: number;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const said = (): string => out.join("");

beforeEach(() => {
  repo = tmp("wecode-delivered-ancestry-");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  // Outside the repository on purpose: a db file inside it would be swept into the fixture's
  // own commits by `git add -A`, and a checkout would then replace it underneath the test.
  process.env["WECODE_DB"] = join(tmp("wecode-delivered-record-"), "wecode.db");
  db = open(process.env["WECODE_DB"]);
  seed();

  cwd = process.cwd();
  process.chdir(repo);
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

/** One delivered story with one accepted criteria, under a project whose repo is the
 *  repository above. Written onto the record directly: what is under test is how the
 *  command reads the world, not how the record got into this shape. */
function seed(): void {
  const make = new Maker(db);
  const project = make.project(make.workspace("acme", repo), "storefront", repo);
  const story = make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "password reset");
  const criteria = make.criteria(make.requirement(story, "one change per link"), "a reset link arrives in 60s");
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
  db.prepare("UPDATE acceptance_criteria SET state = 'accepted' WHERE id = ?").run(criteria);
  under = project;
}

/** The runner's table, created the way the runner creates it: beside the record, on the
 *  first landing. Nothing in the migrations builds it. */
function marker(branch: string, sha: string): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (1,?,?,'')").run(branch, sha);
}

/** A story branch whose work the base already has: branched, committed, merged back. */
function branchLandedInto(slug: string): string {
  git("checkout", "-q", "-b", `story/${slug}`);
  writeFileSync(join(repo, `${slug}.txt`), "work\n");
  git("add", "-A");
  git("commit", "-q", "-m", `build ${slug}`);
  const sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `land story/${slug}`, `story/${slug}`);
  return sha;
}

/** A story branch with work of its own that the base has never seen. */
function branchAheadOfBase(slug: string): void {
  git("checkout", "-q", "-b", `story/${slug}`);
  writeFileSync(join(repo, `${slug}.txt`), "work\n");
  git("add", "-A");
  git("commit", "-q", "-m", `build ${slug}`);
  git("checkout", "-q", "main");
}

const answer = (): { landed: boolean; sha: string | null; reach: string }[] => {
  out.length = 0;
  expect(delivered(["--json"])).toBe(0);
  return JSON.parse(said()) as { landed: boolean; sha: string | null; reach: string }[];
};

describe("wecode delivered reads landedness from ancestry", () => {
  it("calls a story landed when the base has its branch, with no marker anywhere", () => {
    const sha = branchLandedInto("password-reset");

    const [s] = answer();
    expect(s?.landed).toBe(true);
    expect(s?.reach).toBe("landed");
    expect(s?.sha).toBe(sha);
  });

  it("prints the landing on the line, so the marker is not what the reader depended on", () => {
    branchLandedInto("password-reset");

    expect(delivered([])).toBe(0);
    expect(said()).toContain("landed story/password-reset");
    expect(said()).not.toContain("unlanded");
  });

  it("calls a story unlanded when its branch is ahead of the base, marker or not", () => {
    branchAheadOfBase("password-reset");
    marker("story/password-reset", "deadbeefcafe");

    const [s] = answer();
    expect(s?.landed).toBe(false);
    expect(s?.sha).toBeNull();
    expect(s?.reach).toBe("unlanded");
  });

  it("keeps the record's answer for a branch git cannot resolve", () => {
    marker("story/password-reset", "deadbeefcafe");

    const [s] = answer();
    expect(s?.landed).toBe(true);
    expect(s?.sha).toBe("deadbeefcafe");
  });

  it("prefers the marker's sha over the branch tip when both are there", () => {
    branchLandedInto("password-reset");
    marker("story/password-reset", "deadbeefcafe");

    expect(answer()[0]?.sha).toBe("deadbeefcafe");
  });

  it("outranks an open chore: a branch the base has is landed, not behind it", () => {
    branchLandedInto("password-reset");
    db.prepare(
      `INSERT INTO chore (slug,kind,project_id,target_type,target_id,"check",state,created_at,updated_at)
       VALUES ('refresh-1','refresh',?,'story',1,'x','open','','')`,
    ).run(under);

    const [s] = answer();
    expect(s?.reach).toBe("landed");
  });
});
