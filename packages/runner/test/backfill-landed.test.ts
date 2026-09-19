import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkRecord, Maker, open, type Violation } from "@wecode/core";
import { healLandedMarkers, snapshot, type Git } from "../src/doctor.js";
// `@wecode/cli` depends on `@wecode/core` alone and cannot import the runner, so the heal
// lives in both files. Imported by path, and run against the same repository below, so the
// copy cannot quietly drift from the original.
import { doctor as cliDoctor, healLandedMarkers as cliHeal } from "../../cli/src/doctor.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8" });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-backfill-"));
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

/** A story `delivered` with a task under it and no marker anywhere: the drift the doctor
 *  names, in the shape the five real ones have.
 *
 *  The chain under it is settled too, and that is not decoration: a delivered story with a
 *  `ready` task beneath it is a second, different drift — `nothing_is_open_under_a_settled_parent`
 *  names the task — and these tests are about the missing marker alone. */
function deliveredStory(title: string): { story: number } {
  const story = make.story(epic, title);
  const criteria = make.criteria(make.requirement(story, "it works"), `${title} is accepted`);
  make.task(make.acceptanceTest(criteria, `${title} passes`, "manual"), `build ${title}`);
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
  settleUnder(story);
  return { story };
}

/** Every descendant of a story put into its own success state, by direct SQL for the same
 *  reason the story above is: the fixture is asserting about a record that already got
 *  here, not about the transitions that would have brought it. */
function settleUnder(story: number): void {
  db.prepare("UPDATE requirement SET state = 'met' WHERE story_id = ?").run(story);
  db.prepare(
    "UPDATE acceptance_criteria SET state = 'accepted' WHERE requirement_id IN (SELECT id FROM requirement WHERE story_id = ?)",
  ).run(story);
  db.prepare(
    "UPDATE acceptance_test SET state = 'passed' WHERE parent_id IN (SELECT ac.id FROM acceptance_criteria ac JOIN requirement r ON r.id = ac.requirement_id WHERE r.story_id = ?)",
  ).run(story);
  db.prepare(
    "UPDATE task SET state = 'done' WHERE acceptance_test_id IN (SELECT at.id FROM acceptance_test at JOIN acceptance_criteria ac ON ac.id = at.parent_id JOIN requirement r ON r.id = ac.requirement_id WHERE r.story_id = ?)",
  ).run(story);
}

/** A commit on the base whose subject is exactly what `wecode land` writes. */
function landCommit(slug: string, file: string): string {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `land story/${slug}`);
  return git(repo, "rev-parse", "HEAD");
}

const slugOf = (story: number): string =>
  (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;

const found = (): readonly Violation[] => checkRecord(snapshot(db));

const markers = (): { task_id: number; branch: string; sha: string }[] =>
  (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'landed_branch'").get() === undefined
    ? []
    : (db.prepare("SELECT task_id, branch, sha FROM landed_branch ORDER BY task_id").all() as unknown as {
        task_id: number;
        branch: string;
        sha: string;
      }[]));

const heals = (): { entity_id: number; from_state: string; to_state: string; actor: string }[] =>
  db
    .prepare("SELECT entity_id, from_state, to_state, actor FROM ledger WHERE verb = 'heal' ORDER BY id")
    .all() as unknown as { entity_id: number; from_state: string; to_state: string; actor: string }[];

/** Both copies of the heal, run against the same repository. Anything true of one has to
 *  be true of the other, or the duplication has drifted. */
const COPIES: readonly { name: string; heal: typeof healLandedMarkers }[] = [
  { name: "the runner's", heal: healLandedMarkers },
  { name: "the cli's", heal: cliHeal },
];

describe.each(COPIES)("$name backfill of a missing landed marker", ({ heal }) => {
  it("writes the marker from the one land commit in the base", () => {
    const { story } = deliveredStory("password reset");
    const sha = landCommit(slugOf(story), "reset.txt");

    const report = heal(db, found(), gitIn(repo));

    expect(report.written).toEqual([{ story, slug: "password-reset", sha }]);
    expect(report.left).toEqual([]);
    expect(markers()).toEqual([{ task_id: 1, branch: "story/password-reset", sha }]);
    // And the invariant it was breaking now holds — which is what proves the heal.
    expect(found()).toEqual([]);
  });

  it("says in the ledger what it found and what it wrote", () => {
    const { story } = deliveredStory("password reset");
    const sha = landCommit(slugOf(story), "reset.txt");

    heal(db, found(), gitIn(repo));

    expect(heals()).toEqual([
      {
        entity_id: story,
        from_state: "no landed marker",
        to_state: `landed_sha ${sha} from 'land story/password-reset'`,
        actor: "doctor",
      },
    ]);
  });

  it("leaves a story with no land commit alone, and reports it", () => {
    const { story } = deliveredStory("password reset");

    const report = heal(db, found(), gitIn(repo));

    expect(report.written).toEqual([]);
    expect(report.left).toEqual([
      {
        story,
        slug: "password-reset",
        why: "no commit in HEAD with subject 'land story/password-reset'",
      },
    ]);
    expect(markers()).toEqual([]);
    expect(heals()).toEqual([]);
    // Still drift, still said out loud: refusing is not resolving.
    expect(found().map((v) => v.invariant)).toEqual(["delivered_story_has_landed"]);
  });

  it("leaves a story with two land commits alone, and reports it", () => {
    const { story } = deliveredStory("password reset");
    landCommit(slugOf(story), "reset.txt");
    landCommit(slugOf(story), "reset-again.txt");

    const report = heal(db, found(), gitIn(repo));

    expect(report.written).toEqual([]);
    expect(report.left).toEqual([
      {
        story,
        slug: "password-reset",
        why: "2 commits in HEAD with subject 'land story/password-reset'",
      },
    ]);
    expect(markers()).toEqual([]);
    expect(heals()).toEqual([]);
    expect(found().map((v) => v.invariant)).toEqual(["delivered_story_has_landed"]);
  });

  it("heals the one it can and refuses the one it cannot, in the same pass", () => {
    const one = deliveredStory("password reset");
    const two = deliveredStory("session timeout");
    const sha = landCommit(slugOf(one.story), "reset.txt");

    const report = heal(db, found(), gitIn(repo));

    expect(report.written).toEqual([{ story: one.story, slug: "password-reset", sha }]);
    expect(report.left.map((l) => l.story)).toEqual([two.story]);
  });

  it("matches the subject exactly, rather than as a substring", () => {
    const { story } = deliveredStory("reset");
    // `land story/reset-password` contains `land story/reset`; a grep alone would take it.
    landCommit("reset-password", "other.txt");

    const report = heal(db, found(), gitIn(repo));

    expect(report.written).toEqual([]);
    expect(report.left.map((l) => l.story)).toEqual([story]);
  });
});

describe("wecode doctor, without --heal", () => {
  it("writes nothing at all", () => {
    const { story } = deliveredStory("password reset");
    landCommit(slugOf(story), "reset.txt");
    const before = recordOf();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = cliDoctor([join(repo, "wecode.db")]);

    out.mockRestore();
    expect(code).toBe(1);
    expect(markers()).toEqual([]);
    expect(heals()).toEqual([]);
    expect(recordOf()).toBe(before);
    // The drift it reports is the one it deliberately did not fix.
    expect(found().map((v) => v.invariant)).toEqual(["delivered_story_has_landed"]);
  });

  it("is what --heal turns into a fix", () => {
    const { story } = deliveredStory("password reset");
    const sha = landCommit(slugOf(story), "reset.txt");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = cliDoctor(["--heal", join(repo, "wecode.db")]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("");

    out.mockRestore();
    expect(code).toBe(0);
    expect(markers()).toEqual([{ task_id: 1, branch: "story/password-reset", sha }]);
    expect(heals()).toHaveLength(1);
    expect(printed).toContain("healed delivered_story_has_landed");
    expect(printed).toContain(`story #${story} password-reset — landed_sha ${sha.slice(0, 12)}`);
  });

  it("still reports what --heal refused to touch", () => {
    deliveredStory("password reset");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = cliDoctor(["--heal", join(repo, "wecode.db")]);
    const printed = out.mock.calls.map((c) => String(c[0])).join("");

    out.mockRestore();
    expect(code).toBe(1);
    expect(markers()).toEqual([]);
    expect(printed).toContain("delivered_story_has_landed");
    expect(printed).not.toContain("healed");
  });
});

/** Every entity table, as text: the comparison behind "writes nothing at all". */
const ENTITIES = [
  "release",
  "epic",
  "story",
  "requirement",
  "acceptance_criteria",
  "acceptance_test",
  "task",
  "task_test",
  "ledger",
] as const;

const recordOf = (): string =>
  ENTITIES.map((e) => `${e}:${JSON.stringify(db.prepare(`SELECT * FROM ${e} ORDER BY id`).all())}`).join("\n");
