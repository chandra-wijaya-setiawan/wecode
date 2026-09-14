import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Maker, open, type Snapshot, type Violation } from "@wecode/core";
import {
  checksOf as cliChecks,
  doctor,
  runChecks as cliRun,
  snapshot as cliSnapshot,
  worldOf as cliWorld,
  type Git,
} from "../src/doctor.js";
// The runner is the half that may read the world and `@wecode/cli` cannot depend on it, so
// the world-facing pass lives in both files. Imported here by path — vitest resolves it from
// the one root config — so the command and the tick are run over the same record and the
// duplication cannot quietly drift.
import {
  checksOf as runnerChecks,
  runChecks as runnerRun,
  snapshot as runnerSnapshot,
  worldOf as runnerWorld,
} from "../../runner/src/doctor.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-parity-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  epic = make.epic(make.release(make.project(ws, "storefront", repo), "1.0.0"), "recovery");
});

/** A story `delivered` with a task under it and no marker anywhere: the shape stories 134
 *  and 148 are in — the record cannot tell, on its own, whether they reached the base. */
function deliveredStory(title: string): number {
  const story = make.story(epic, title);
  const criteria = make.criteria(make.requirement(story, "it works"), `${title} is accepted`);
  make.task(make.acceptanceTest(criteria, `${title} passes`, "manual"), `build ${title}`);
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
  return story;
}

const slugOf = (story: number): string =>
  (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;

/** The branch of a story whose work is already in the base: what a merge leaves behind. */
const mergedBranch = (slug: string): void => git(repo, "branch", `story/${slug}`, "HEAD");

/** Comparable and order-free: two doctors that name the same drift agree, however each of
 *  them happened to walk the record. */
const setOf = (found: readonly Violation[]): string[] =>
  found.map((v) => `${v.invariant}|${v.entity}|${v.id}|${v.slug}|${v.detail}`).sort();

/** The command's pass and the tick's pass, over one database and one repository. */
const bothOver = (dir: string): { cli: string[]; runner: string[] } => ({
  cli: setOf(cliRun(cliSnapshot(db), cliWorld(gitIn(dir)))),
  runner: setOf(runnerRun(runnerSnapshot(db), runnerWorld(gitIn(dir)))),
});

describe("wecode doctor and the runner's tick", () => {
  it("agree that a story whose branch is in the base did reach it", () => {
    const story = deliveredStory("password reset");
    mergedBranch(slugOf(story));

    const { cli, runner } = bothOver(repo);

    // The answer git gives, and the one the command used to contradict.
    expect(runner).not.toContain(
      `delivered_story_has_landed|story|${story}|password-reset|delivered with no landed_sha — it never reached the base`,
    );
    expect(cli).toEqual(runner);
  });

  it("agree that a story with no branch at all never reached it", () => {
    const story = deliveredStory("session timeout");

    const { cli, runner } = bothOver(repo);

    expect(runner).toContain(
      `delivered_story_has_landed|story|${story}|session-timeout|delivered with no landed_sha — it never reached the base`,
    );
    expect(cli).toEqual(runner);
  });

  it("agree over a record holding every case at once", () => {
    const landed = deliveredStory("password reset");
    mergedBranch(slugOf(landed));
    deliveredStory("session timeout");
    // Drift that owes git nothing, so the pure set has something to say here too.
    db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(make.story(epic, "empty shape"));

    const { cli, runner } = bothOver(repo);

    expect(cli).toEqual(runner);
    expect(cli.length).toBeGreaterThan(1);
  });

  it("agree with no repository to ask, and still report the rest", () => {
    deliveredStory("password reset");
    db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(make.story(epic, "empty shape"));
    const nowhere = mkdtempSync(join(tmpdir(), "wecode-norepo-"));

    const { cli, runner } = bothOver(nowhere);

    expect(cliWorld(gitIn(nowhere)).reachable).toBe(false);
    expect(cli).toEqual(runner);
    // Not an error, and not only the check that could not be answered.
    expect(cli.some((v) => v.startsWith("story_in_progress_has_a_requirement|"))).toBe(true);
  });

  it("run the same set of checks, and the same set of them needs git", () => {
    // The guard on the next divergence: a check either half gains, or stops asking the
    // world, is a check the other cannot see, and this is where that shows.
    expect(cliChecks()).toEqual(runnerChecks());
    expect(cliChecks().filter((c) => c.world).map((c) => c.name)).toEqual(["delivered_story_has_landed"]);
  });
});

describe("the report", () => {
  const said = (args: readonly string[]): { code: number; out: string } => {
    const w = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = doctor(args);
    const out = w.mock.calls.map((c) => String(c[0])).join("");
    w.mockRestore();
    return { code, out };
  };

  it("says which checks had to ask git", () => {
    deliveredStory("session timeout");

    const { code, out } = said([join(repo, "wecode.db")]);

    expect(code).toBe(1);
    expect(out).toContain("delivered_story_has_landed (asked git)");
  });

  it("does not claim a check was asked when there was no repository", () => {
    deliveredStory("session timeout");
    // The record names a repository that is not there: the command still runs.
    db.prepare("UPDATE project SET repo = ?").run(join(tmpdir(), "wecode-absent-repo"));

    const { code, out } = said([join(repo, "wecode.db")]);

    expect(code).toBe(1);
    expect(out).toContain("no repository to ask — unanswered: delivered_story_has_landed");
  });
});
