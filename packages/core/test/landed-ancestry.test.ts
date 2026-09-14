import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { checkRecord, keepUnlanded, Maker, open, NEVER_REACHED_THE_BASE, REACHED_INSIDE_ANOTHER_MERGE, type Violation } from "../src/index.js";
// The ancestry question is git's, so the half that answers it lives in the runner. Imported
// by path because core may not depend on `@wecode/runner`; vitest resolves both from the
// one root config.
import { ancestryOf, Doctor, healLandedMarkers, snapshot, type Git } from "../../runner/src/doctor.js";

/** Field report, 15 Sep: the doctor said stories 134 and 148 were "delivered with no
 *  landed_sha — it never reached the base", and `merge-base --is-ancestor` said both
 *  branches were ancestors of master. They landed inside another story's merge, so no
 *  commit titled `land story/<slug>` of their own exists. Story 119 in the same list had no
 *  branch at all. Three shapes, and only the third is drift. */

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-ancestry-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  epic = make.epic(make.release(make.project(ws, "storefront", repo), "1.0.0"), "recovery");
});

/** A story `delivered` on the record with a task under it to carry a marker, and no marker. */
function deliveredStory(title: string): { story: number; slug: string } {
  const story = make.story(epic, title);
  const criteria = make.criteria(make.requirement(story, "it works"), `${title} is accepted`);
  make.task(make.acceptanceTest(criteria, `${title} passes`, "manual"), `build ${title}`);
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;
  return { story, slug };
}

/** A story branch with one commit on it, left unmerged. */
function branchOf(slug: string, file: string): void {
  git("checkout", "-q", "-b", `story/${slug}`);
  writeFileSync(join(repo, file), `${file}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", `${slug}: attempt`);
  git("checkout", "-q", "main");
}

/** The shape of 134 and 148: the branch arrives in the base inside another merge, so the
 *  base has no commit named after this story at all. */
function landedInsideAnotherMerge(slug: string, file: string): void {
  branchOf(slug, file);
  git("checkout", "-q", "-b", "story/other", `story/${slug}`);
  writeFileSync(join(repo, `other-${file}`), "other\n");
  git("add", "-A");
  git("commit", "-q", "-m", "other: attempt");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "land story/other", "story/other");
}

/** The shape the lander writes from now on: a `land story/<slug>` commit of its own. */
function landedByItsOwnCommit(slug: string, file: string): void {
  branchOf(slug, file);
  git("merge", "-q", "--no-ff", "-m", `land story/${slug}`, `story/${slug}`);
}

const found = (): readonly Violation[] => checkRecord(snapshot(db));

const judged = (): readonly Violation[] => keepUnlanded(found(), ancestryOf(gitIn(repo), "HEAD"));

const heals = (): { entity_id: number; to_state: string }[] =>
  db.prepare("SELECT entity_id, to_state FROM ledger WHERE verb = 'heal' ORDER BY id").all() as unknown as {
    entity_id: number;
    to_state: string;
  }[];

describe("a delivered story that reached the base inside another story's merge", () => {
  it("is not accused of never having reached it", () => {
    const { story, slug } = deliveredStory("checkout totals");
    landedInsideAnotherMerge(slug, "totals.txt");

    // The world's answer, by the command the field report ran.
    expect(() => git("merge-base", "--is-ancestor", `story/${slug}`, "main")).not.toThrow();
    // The pure pass alone still names it — all it can see is the missing marker.
    expect(found().map((v) => v.id)).toContain(story);
    expect(judged()).toEqual([]);
  });

  it("is never described as not having reached the base, by any wording", () => {
    const { slug } = deliveredStory("checkout totals");
    landedInsideAnotherMerge(slug, "totals.txt");

    for (const v of judged()) expect(v.detail).not.toContain("reached the base");
    expect(new Doctor(db, undefined, gitIn(repo), "HEAD").check()).toEqual([]);
  });

  it("is recorded as having reached it, rather than healed into a sha it has not got", () => {
    const { story, slug } = deliveredStory("checkout totals");
    landedInsideAnotherMerge(slug, "totals.txt");

    const report = healLandedMarkers(db, found(), gitIn(repo));

    expect(report.reached).toEqual([{ story, slug }]);
    expect(report.written).toEqual([]);
    expect(report.left).toEqual([]);
    expect(heals()).toEqual([{ entity_id: story, to_state: REACHED_INSIDE_ANOTHER_MERGE }]);
    // Said once, however many passes run over it.
    healLandedMarkers(db, found(), gitIn(repo));
    expect(heals()).toHaveLength(1);
  });
});

describe("a delivered story with a land commit of its own", () => {
  it("has the marker written from that commit, and is not merely recorded as reached", () => {
    const { story, slug } = deliveredStory("password reset");
    landedByItsOwnCommit(slug, "reset.txt");
    const sha = git("rev-parse", "HEAD");

    const report = healLandedMarkers(db, found(), gitIn(repo));

    expect(report.written).toEqual([{ story, slug, sha }]);
    expect(report.reached).toEqual([]);
    expect(report.left).toEqual([]);
    expect(found()).toEqual([]);
  });
});

describe("a delivered story that is not in the base", () => {
  it("with no branch at all, is the drift that is still reported", () => {
    const { story } = deliveredStory("audit log");

    expect(judged()).toEqual([
      {
        invariant: "delivered_story_has_landed",
        entity: "story",
        id: story,
        slug: "audit-log",
        detail: NEVER_REACHED_THE_BASE,
      },
    ]);
    const report = healLandedMarkers(db, found(), gitIn(repo));
    expect(report.reached).toEqual([]);
    expect(report.written).toEqual([]);
    expect(report.left).toEqual([
      { story, slug: "audit-log", why: "no commit in HEAD with subject 'land story/audit-log'" },
    ]);
  });

  it("with a branch that is not in, is reported too", () => {
    const { story, slug } = deliveredStory("audit log");
    branchOf(slug, "audit.txt");

    expect(ancestryOf(gitIn(repo), "HEAD")(`story/${slug}`)).toBe("out");
    expect(judged().map((v) => ({ id: v.id, detail: v.detail }))).toEqual([
      { id: story, detail: NEVER_REACHED_THE_BASE },
    ]);
    expect(healLandedMarkers(db, found(), gitIn(repo)).left).toEqual([
      { story, slug, why: `no commit in HEAD with subject 'land story/${slug}'` },
    ]);
  });
});
