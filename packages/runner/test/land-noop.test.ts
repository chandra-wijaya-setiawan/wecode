import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVARIANTS, open } from "@wecode/core";
import { landingReport, Trees } from "../src/index.js";
import { snapshot } from "../src/doctor.js";
import { run as cli } from "../../cli/src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

// Field report: `wecode land` printed "story/<slug> landed" when git said "Already up to
// date" and the base gained nothing — five times on 15 Sep — and the next sweep listed the
// story unlanded again, because no land commit existed and no marker was written.

let repo: string;
let was: string;
let out: string[];
let err: string[];

const git = (...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();

const sql = (): DatabaseSync => new DatabaseSync(process.env["WECODE_DB"] as string);

const said = (): string => out.join("");

/** The whole tree the doctor's first invariant reads through: a delivered story with a task
 *  under it, and a branch carrying the work. */
function deliveredStory(): string {
  cli(["init"]);
  cli(["workspace", "create", "acme"]);
  cli(["project", "create", "--parent", "1", "p", "--path", repo]);
  cli(["release", "create", "--parent", "1", "0.0.1"]);
  cli(["epic", "create", "--parent", "1", "e"]);
  cli(["story", "create", "--parent", "1", "rescue the foreman"]);
  cli(["requirement", "create", "--parent", "1", "one tick per call"]);
  cli(["acceptance_criteria", "create", "--parent", "1", "the foreman ticks"]);
  cli(["acceptance_test", "create", "--parent", "1", "it ticks", "--artefact", "bash x.sh"]);
  cli(["task", "create", "--parent", "1", "make it tick", "--role", "engineer"]);

  const db = sql();
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = 1").run();
  const slug = (db.prepare("SELECT slug FROM story WHERE id = 1").get() as { slug: string }).slug;
  db.close();

  git("checkout", "-q", "-b", `story/${slug}`);
  writeFileSync(join(repo, "foreman.ts"), "export const tick = () => 2;\n");
  git("commit", "-q", "-am", "the story's answer");
  git("checkout", "-q", "master");
  return slug;
}

const markers = (): { task_id: number; branch: string; sha: string }[] => {
  const db = sql();
  const has =
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'landed_branch'").get() !==
    undefined;
  const rows = has
    ? (db.prepare("SELECT task_id, branch, sha FROM landed_branch").all() as unknown as {
        task_id: number;
        branch: string;
        sha: string;
      }[])
    : [];
  db.close();
  return rows;
};

/** The doctor's own first invariant, run over the record the cli just wrote. */
const unlandedStories = (): string[] => {
  const db = sql();
  const check = INVARIANTS.find((i) => i.name === "delivered_story_has_landed");
  const broken = (check?.check(snapshot(db)) ?? []).map((v) => v.detail);
  db.close();
  return broken;
};

beforeEach(() => {
  was = process.cwd();
  repo = tmp("wecode-land-noop-");
  process.env["WECODE_DB"] = join(tmp("wecode-land-noop-db-"), "wecode.db");
  process.chdir(repo);
  git("init", "-q", "-b", "master");
  git("config", "user.name", "A Person");
  git("config", "user.email", "person@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "foreman.ts"), "export const tick = () => 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(was);
});

describe("landing a story the base already holds", () => {
  it("says there was nothing to do and why, rather than that it landed", () => {
    const slug = deliveredStory();
    git("merge", "--no-ff", "-q", "-m", "landed by hand", `story/${slug}`);
    const before = git("rev-parse", "HEAD");
    out.length = 0;

    expect(cli(["land", "1"])).toBe(0);

    expect(said()).toContain("nothing to land");
    expect(said()).toContain(`story/${slug} is already in master`);
    expect(said()).not.toMatch(/story\/\S+ landed/);
    expect(git("rev-parse", "HEAD")).toBe(before);
  });

  it("writes no marker for a landing it did not do", () => {
    const slug = deliveredStory();
    git("merge", "--no-ff", "-q", "-m", "landed by hand", `story/${slug}`);

    expect(cli(["land", "1"])).toBe(0);
    expect(markers()).toEqual([]);
  });

  it("fails, naming the branch, when the story has no branch at all", () => {
    const slug = deliveredStory();
    git("branch", "-D", `story/${slug}`);
    out.length = 0;

    expect(cli(["land", "1"])).toBe(1);
    expect(err.join("")).toContain(`nothing to land: there is no story/${slug}`);
    expect(said()).not.toContain("landed");
    expect(markers()).toEqual([]);
  });
});

describe("landing a story that is ahead of the base", () => {
  it("reports the commit the base gained", () => {
    const slug = deliveredStory();
    out.length = 0;

    expect(cli(["land", "1"])).toBe(0);

    const sha = git("rev-parse", "HEAD");
    expect(said()).toContain(sha.slice(0, 12));
    expect(said()).toContain(`story/${slug} landed on master`);
    expect(git("log", "--oneline", "master")).toContain(`land story/${slug}`);
  });

  it("records the landing where a query can see it", () => {
    deliveredStory();
    expect(cli(["land", "1"])).toBe(0);

    const sha = git("rev-parse", "HEAD");
    expect(markers()).toEqual([{ task_id: 1, branch: "story/rescue-the-foreman", sha }]);
  });

  it("leaves the doctor's first invariant quiet afterwards", () => {
    deliveredStory();
    expect(unlandedStories()).toHaveLength(1);

    expect(cli(["land", "1"])).toBe(0);
    expect(unlandedStories()).toEqual([]);
  });
});

describe("the runner's own landing", () => {
  it("reports nothing to do, rather than a sha, for a branch already in the base", async () => {
    const bare = tmp("wecode-land-noop-runner-");
    const at = (...args: string[]): string =>
      execFileSync("git", args, { cwd: bare, encoding: "utf8" }).trim();
    at("init", "-q", "-b", "main");
    at("config", "user.name", "t");
    at("config", "user.email", "t@localhost");
    writeFileSync(join(bare, "README.md"), "seed\n");
    at("add", "-A");
    at("commit", "-q", "-m", "seed");

    const trees = new Trees(bare, "main");
    const storyTree = await trees.storyTree("password-reset", tmp("wecode-land-noop-story-"));
    writeFileSync(join(storyTree, "delivered.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: storyTree });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "d"], {
      cwd: storyTree,
    });
    at("update-ref", "refs/heads/story/password-reset", execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: storyTree,
      encoding: "utf8",
    }).trim());

    const first = await trees.land("password-reset", bare);
    expect(first.kind).toBe("merged");
    expect(landingReport("story/password-reset", "main", first)).toContain("landed on main");

    const again = await trees.land("password-reset", bare);
    expect(again).toEqual({ kind: "nothing", why: "already-ancestor" });
    expect(landingReport("story/password-reset", "main", again)).toBe(
      "nothing to land: story/password-reset is already in main",
    );
    // and the second call moved nothing.
    expect(at("rev-parse", "main")).toBe(first.kind === "merged" ? first.sha : "");
  });

  it("reports no branch, rather than merging, when the story was never cut", async () => {
    const bare = tmp("wecode-land-noop-nobranch-");
    const at = (...args: string[]): string =>
      execFileSync("git", args, { cwd: bare, encoding: "utf8" }).trim();
    at("init", "-q", "-b", "main");
    at("config", "user.name", "t");
    at("config", "user.email", "t@localhost");
    writeFileSync(join(bare, "README.md"), "seed\n");
    at("add", "-A");
    at("commit", "-q", "-m", "seed");

    const trees = new Trees(bare, "main");
    const landing = await trees.land("never-cut", bare);
    expect(landing).toEqual({ kind: "nothing", why: "no-branch" });
    expect(landingReport("story/never-cut", "main", landing)).toContain("there is no story/never-cut");
  });
});
