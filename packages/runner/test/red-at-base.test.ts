import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type WorkerAdapter } from "../src/index.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Ends cleanly having written nothing, so the task never finishes and the acceptance test
 *  is never reached by the ordinary prove-the-story pass. What runs here is only the base
 *  run, so a counter counts it and nothing else. */
const idle: WorkerAdapter = {
  kind: "agent",
  start: async () => ({ phase: "succeeded", session: "s", spent: { tokens: 1, seconds: 0 }, commit: null }),
  poll: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
  answer: async () => ({ phase: "running", session: "s", spent: { tokens: 0, seconds: 0 } }),
  kill: async () => {},
};

let repo: string;
let db: DatabaseSync;
let at: number;
let counter: string;

const storyTree = (): string => join(repo, ".wecode/worktrees", "story-password-reset");

interface Proof {
  readonly red_at_base_sha: string | null;
  readonly red_at_base_at: string | null;
  readonly reason: string | null;
}

const proof = (): Proof | undefined =>
  db
    .prepare("SELECT red_at_base_sha, red_at_base_at, reason FROM red_at_base WHERE test_id = ?")
    .get(at) as Proof | undefined;

const runs = (): number => readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length;

const stateOf = (): string =>
  (db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(at) as { state: string }).state;

/** The story, its criteria, one ready acceptance test with the given artefact, and one task
 *  whose own test never passes — so nothing lands and nothing but the base run runs. */
function seed(artefact: string): void {
  const make = new Maker(db);
  const engine = new Engine(db);
  const ws = make.workspace("acme", repo);
  const p = make.project(ws, "storefront", repo);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "recovery");
  const s = make.story(e, "password reset");
  const req = make.requirement(s, "one change per link");
  const c = make.criteria(req, "emailed in 60s");
  at = make.acceptanceTest(c, "mail arrives", "script", artefact);
  const task = make.task(at, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
  const tt = make.taskTest(task, "mailer called", "script", "test -f never.ts");
  make.worker("claude-1", "engineer", "agent");

  for (const [entity, id] of [["project", p], ["release", rel], ["epic", e], ["story", s], ["requirement", req], ["acceptance_criteria", c]] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
}

const runner = (): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: { agent: idle },
    integrationBranch: "main",
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-red-at-base-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  counter = join(mkdtempSync(join(tmpdir(), "wecode-counter-")), "runs");
  writeFileSync(counter, "");

  db = open(join(repo, "wecode.db"));
});

describe("a test that fails at base is proven red", () => {
  it("records the base sha and when, once per base sha, and reaches no verdict", async () => {
    // mail.ts is the work; at the merge-base it does not exist, so the test fails there.
    seed(`echo ran >> ${counter}; test -f mail.ts`);

    const first = await runner().tick();

    const base = git(repo, "merge-base", "story/password-reset", "main");
    expect(base).toBe(git(repo, "rev-parse", "main"));
    expect(proof()).toEqual({ red_at_base_sha: base, red_at_base_at: expect.any(String), reason: null });
    expect(first.redAtBase.proven).toContain(at);
    expect(runs()).toBe(1);

    // A proof is a fact about a base sha, not about a tick: the second tick owes nothing.
    const second = await runner().tick();
    expect(second.redAtBase.proven).toEqual([]);
    expect(runs()).toBe(1);

    // The base run is a probe, not a judgement — the test still has everything to prove.
    expect(stateOf()).toBe("ready");
    // and the story tree is left where the rest of the tick expects to find it
    expect(git(storyTree(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("story/password-reset");
  });
});

describe("a test that passes at base proves nothing", () => {
  it("says so against the test and leaves it unproven", async () => {
    // README.md is in the seed commit, so this passes at base and can never fail.
    seed(`echo ran >> ${counter}; test -f README.md`);

    const first = await runner().tick();

    expect(proof()).toEqual({
      red_at_base_sha: null,
      red_at_base_at: null,
      reason: "it passes at base, so it cannot fail",
    });
    expect(first.redAtBase.unproven).toContain(at);
    expect(first.redAtBase.proven).toEqual([]);
    expect(runs()).toBe(1);

    // It is not retried into a different answer: the base sha has not moved.
    const second = await runner().tick();
    expect(second.redAtBase.unproven).toEqual([]);
    expect(runs()).toBe(1);
    expect(stateOf()).toBe("ready");
  });
});
