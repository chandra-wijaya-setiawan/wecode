import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CHORE_KINDS, ensureChore, Maker, open } from "@wecode/core";
import { Foreman, type Observation, type WorkerAdapter, type Work } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/18. What a chore's worker is actually told.
 *
 *  Two rules, and one of them is a subtraction. Each kind gets its own brief, because a
 *  merge and a refresh run the same git commands for opposite reasons and a worker told the
 *  wrong reason resolves the conflicts the wrong way. And no chore is told to write the
 *  tests that prove its work: a chore proves no acceptance_test, so a test written to
 *  assert this merge happened pins this merge rather than any requirement. */

/** Reports the assignment finished and keeps what it was handed. */
class Capture implements WorkerAdapter {
  readonly kind = "agent";
  readonly work: Work[] = [];
  private done(): Observation {
    return { phase: "succeeded", session: "sess-1", spent: { tokens: 1, seconds: 1 }, commit: null };
  }
  async start(w: Work): Promise<Observation> {
    this.work.push(w);
    return this.done();
  }
  async poll(): Promise<Observation> {
    return this.done();
  }
  async resume(): Promise<Observation> {
    return this.done();
  }
  async answer(): Promise<Observation> {
    return this.done();
  }
  async kill(): Promise<void> {}
}

let db: DatabaseSync;
let make: Maker;
let project: number;
let story: number;
let worker: number;

beforeEach(() => {
  db = open(join(tmp("wecode-chore-prompt-"), "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", "/acme"), "storefront", "/r");
  story = make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "password reset");
  worker = make.worker("system-1", "system", "agent");
});

/** The brief the foreman builds for a chore of this kind, read off the work it hands over. */
async function brief(kind: string, target_type: "story" | "project" = "story"): Promise<string> {
  const chore = ensureChore(db, {
    kind: kind as (typeof CHORE_KINDS)[number],
    project_id: project,
    target_type,
    target_id: target_type === "story" ? story : project,
    check: `the ${kind} check, as the record stores it`,
  });
  const id = make.assignment({
    objective_type: "chore",
    objective_id: chore.id,
    worker_id: worker,
    scope: { write: ["**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wecode-no-such-worktree",
  });
  const agent = new Capture();
  await new Foreman(db, { agent }, 3600, { repoRoot: "/r", integrationBranch: "main" }).tick();
  const work = agent.work.find((w) => w.id === id) as Work;
  return work.instruction;
}

describe("a chore's brief", () => {
  it("says merge, and why the merge is being made by hand", async () => {
    const text = await brief("merge");
    expect(text).toContain("This is a merge chore for story/password-reset.");
    expect(text).toContain("was delivered and will not merge into main");
    expect(text).toContain("main merges cleanly into story/password-reset");
    // The record's one line is carried, not substituted for the words to act on.
    expect(text).toContain('"the merge check, as the record stores it"');
  });

  it("says refresh, and that the story is still in flight rather than delivered", async () => {
    const text = await brief("refresh");
    expect(text).toContain("This is a refresh chore for story/password-reset.");
    expect(text).toContain("still in flight and has fallen behind main");
    expect(text).toContain("Merge main into story/password-reset");
    expect(text).not.toContain("was delivered");
    // The refresh's danger is a worker that finishes the story it was only asked to rebase.
    expect(text).toContain("not yours to finish");
  });

  it("says sweep, and names the project it is about rather than a branch", async () => {
    const text = await brief("sweep", "project");
    expect(text).toContain("This is a sweep chore for project storefront.");
    expect(text).not.toContain("story/");
    expect(text).toContain("the sweep check, as the record stores it");
  });

  it("is a different brief for each kind", async () => {
    const texts: string[] = [];
    for (const kind of CHORE_KINDS) texts.push(await brief(kind));
    expect(new Set(texts).size).toBe(CHORE_KINDS.length);
  });

  it("tells no kind of chore to write the tests that prove its work", async () => {
    for (const kind of CHORE_KINDS) {
      const text = await brief(kind);
      expect(text, kind).toContain("Write no new tests");
      expect(text, kind).not.toContain("Write the tests that prove this work");
    }
  });
});
