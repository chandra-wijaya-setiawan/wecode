import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyChore, choreFor, Engine, identity, Maker, open, Verbs, type Scope } from "@wecode/core";
import { queries, table } from "@wecode/core/dist/db.js";
import { BEHIND_THE_BASE, TEST_OUTSIDE_SCOPE } from "../src/healer.js";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19: the healing half runs on the tick's timer, not only when a person types
 *  a command. `healer.ts` already knew what a stopped task's safe fixes are; until now
 *  nothing called it, so a task that failed in a stale tree sat failed until somebody
 *  noticed. The tick calls it, and says in its report what it healed — because a repair
 *  nobody is told about is the same silence in a better mood. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const taskRow = table<{ id: number; state: string; attempts: number; scope: string }>("task", [
  "id",
  "state",
  "attempts",
  "scope",
]);

const ledgerRow = table<{ entity: string; entity_id: number; verb: string; actor: string }>("ledger", [
  "entity",
  "entity_id",
  "verb",
  "actor",
]);

let repo: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let storyId: number;
let storySlug: string;
let criteriaId: number;

/** The role every task below runs under, in the file the runner reads it from. The ceiling
 *  is the subject of one case here, so it is a real config/roles.yaml in the repository
 *  rather than a value handed to the heal: what the runner supplies is the world. */
const ROLES = `roles:
  engineer:
    worker_kind: agent
    scope:
      write: ["packages/runner/**"]
      tools: ["bash"]
`;

beforeEach(() => {
  repo = tmp("wecode-tick-heals-");
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(join(repo, "config", "roles.yaml"), ROLES);
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);

  const ws = make.workspace("acme", repo);
  const project = make.project(ws, "storefront", repo);
  const rel = make.release(project, "1.0.0");
  const ep = make.epic(rel, "recovery");
  storyId = make.story(ep, "password reset");
  const req = make.requirement(storyId, "one change per link");
  criteriaId = make.criteria(req, "emailed in 60s");
  for (const [entity, id] of [
    ["project", project],
    ["release", rel],
    ["epic", ep],
    ["story", storyId],
    ["requirement", req],
    ["acceptance_criteria", criteriaId],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  storySlug = slugOf(storyId);
});

const slugOf = (story: number): string =>
  (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;

const runner = (): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: {}, integrationBranch: "main" });

/** A task whose task_test lives in `artefact`, started and then run out of attempts. The
 *  acceptance test is `true`: what a diagnosis reads off it is its path, and this one has
 *  none, so every case below is about the file it is given. */
function failedTask(scope: Scope, artefact: string): number {
  const at = make.acceptanceTest(criteriaId, `it works ${artefact}`, "script", "true");
  const id = make.task(at, `do the work for ${artefact}`, { role: "engineer", scope, max_retry: 3 });
  const tt = make.taskTest(id, `proved by ${artefact}`, "script", `test -f ${artefact}`);
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  expect(engine.apply("task", id, "start", "chief").ok).toBe(true);
  queries(db).update(taskRow).set({ attempts: 3 }).where("id", "=", id).run();
  return id;
}

/** The same task, taken the rest of the way to `failed` by hand — for the cases that are
 *  about what a tick does with one that was already there. */
function stopped(scope: Scope, artefact: string): number {
  const id = failedTask(scope, artefact);
  const out = new Verbs(engine).giveUpTask(id, "runner");
  expect(out.ok, out.ok ? "" : out.why).toBe(true);
  return id;
}

const state = (id: number): string =>
  queries(db).selectFrom(taskRow).select(["state"]).where("id", "=", id).get()?.state ?? "";

const attempts = (id: number): number =>
  queries(db).selectFrom(taskRow).select(["attempts"]).where("id", "=", id).get()?.attempts ?? -1;

const scopeOf = (id: number): Scope =>
  JSON.parse(queries(db).selectFrom(taskRow).select(["scope"]).where("id", "=", id).get()?.scope ?? "{}") as Scope;

/** The actor the last retry was recorded under: who did it, and the reason they gave. */
const retriedBy = (id: number): { actor: string; reason: string | null } => {
  const row = queries(db)
    .selectFrom(ledgerRow)
    .where("entity", "=", "task")
    .where("entity_id", "=", id)
    .where("verb", "=", "retry")
    .all()
    .at(-1);
  return row === undefined ? { actor: "", reason: null } : identity(row.actor);
};

/** A story branch cut at main that then disagrees with it about README.md. Behind the base
 *  and unable to be brought forward, which is the condition that outlives the tick: a
 *  branch the runner could merge would be merged before the heal ever looked at it. */
function branchBehindTheBase(): void {
  git(repo, "branch", `story/${storySlug}`, "main");
  const tree = join(repo, `.cut-${storySlug}`);
  git(repo, "worktree", "add", "-q", tree, `story/${storySlug}`);
  writeFileSync(join(tree, "README.md"), "the story's idea\n");
  git(tree, "add", "-A");
  git(tree, "commit", "-q", "-m", "ours");
  git(repo, "worktree", "remove", "--force", tree);
  writeFileSync(join(repo, "README.md"), "the base's idea\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base moves on");
}

describe("a tick with a failed task whose test lies outside its scope", () => {
  const mine = "packages/runner/test/the-tick-heals-a-known-cause.test.ts";

  it("widens the scope, puts the task back, and says so in the tick", async () => {
    const id = stopped({ write: ["packages/runner/src/healer.ts"], tools: ["bash"] }, mine);

    const tick = await runner().tick();

    expect(tick.healed.repaired.map((r) => r.task)).toEqual([id]);
    expect(tick.healed.repaired[0]?.cause).toBe(TEST_OUTSIDE_SCOPE);
    expect(tick.healed.repaired[0]?.widened).toBe(mine);
    expect(tick.healed.repaired[0]?.reason).toContain("its write scope does not cover");
    expect(tick.healed.waiting).toEqual([]);
    expect(tick.healed.left).toEqual([]);

    expect(state(id)).toBe("ready");
    expect(attempts(id)).toBe(0);
    expect(scopeOf(id).write).toEqual(["packages/runner/src/healer.ts", mine]);
  }, 20_000);

  it("records the heal as the runner's own, with the finding as its reason", async () => {
    const id = stopped({ write: ["packages/runner/src/healer.ts"], tools: [] }, mine);

    await runner().tick();

    expect(retriedBy(id).actor).toBe("runner");
    expect(retriedBy(id).reason).toBe(`its test is ${mine}, which its write scope does not cover`);
  }, 20_000);

  it("is a tree question too: a story with no branch is not called behind", async () => {
    const id = stopped({ write: ["packages/runner/src/healer.ts"], tools: [] }, mine);

    const tick = await runner().tick();

    // Nothing to bring forward, so no refresh is owed — the file is the whole finding.
    expect(choreFor(db, "refresh", "story", storyId)).toBeNull();
    expect(tick.healed.repaired.map((r) => r.cause)).toEqual([TEST_OUTSIDE_SCOPE]);
    expect(state(id)).toBe("ready");
  }, 20_000);

  it("refuses a widening the role's ceiling forbids, and leaves the task alone", async () => {
    const outside = stopped({ write: ["packages/runner/src/a.ts"], tools: [] }, "packages/tui/test/far.test.ts");

    const tick = await runner().tick();

    // The ceiling is engineer's, out of the repository's own config/roles.yaml: the runner
    // supplies the file, so a task nobody declared a role for is not quietly widened.
    expect(tick.healed.repaired).toEqual([]);
    expect(tick.healed.left.map((l) => l.task)).toEqual([outside]);
    expect(tick.healed.left[0]?.why).toContain("outside the role's ceiling");
    expect(scopeOf(outside).write).toEqual(["packages/runner/src/a.ts"]);
    expect(state(outside)).toBe("failed");
  }, 20_000);
});

describe("a tick with a failed task whose story tree is behind the base", () => {
  it("raises the refresh, waits, and names the chore the task is waiting on", async () => {
    branchBehindTheBase();
    const id = stopped({ write: ["packages/runner/**"], tools: [] }, "packages/runner/test/mine.test.ts");

    const tick = await runner().tick();

    const chore = choreFor(db, "refresh", "story", storyId);
    expect(chore?.kind).toBe("refresh");
    expect(tick.healed.waiting.map((w) => w.task)).toEqual([id]);
    expect(tick.healed.waiting[0]?.chore).toBe(chore?.id);
    expect(tick.healed.waiting[0]?.finding).toContain(`story/${storySlug} does not contain main`);
    expect(tick.healed.repaired).toEqual([]);
    // Not retried: an attempt in the same stale tree proves the same nothing.
    expect(state(id)).toBe("failed");
    expect(attempts(id)).toBe(3);
  }, 20_000);

  it("retries it on the tick after the refresh proves, saying what changed", async () => {
    branchBehindTheBase();
    const id = stopped({ write: ["packages/runner/**"], tools: [] }, "packages/runner/test/mine.test.ts");
    await runner().tick();
    proveTheRefresh();

    const tick = await runner().tick();

    expect(tick.healed.waiting).toEqual([]);
    expect(tick.healed.repaired.map((r) => r.task)).toEqual([id]);
    expect(tick.healed.repaired[0]?.cause).toBe(BEHIND_THE_BASE);
    expect(tick.healed.repaired[0]?.reason).toContain("it failed in a tree behind main");
    expect(tick.healed.repaired[0]?.reason).toMatch(/refresh chore #\d+ has since proved/);
    expect(state(id)).toBe("ready");
    expect(attempts(id)).toBe(0);
  }, 30_000);
});

describe("a tick with nothing it may safely do", () => {
  it("says the task is stopped and leaves it exactly where it is", async () => {
    const id = stopped({ write: ["packages/runner/**"], tools: [] }, "packages/runner/test/plain.test.ts");

    const tick = await runner().tick();

    expect(tick.healed.repaired).toEqual([]);
    expect(tick.healed.waiting).toEqual([]);
    expect(tick.healed.left.map((l) => l.task)).toEqual([id]);
    expect(tick.healed.left[0]?.why).toContain("a person decides whether a further attempt is owed");
    expect(state(id)).toBe("failed");
    expect(attempts(id)).toBe(3);
    expect(choreFor(db, "refresh", "story", storyId)).toBeNull();
  }, 20_000);

  it("says an empty report on a tick with no stopped task at all", async () => {
    const tick = await runner().tick();

    expect(tick.healed).toEqual({ repaired: [], waiting: [], left: [] });
  }, 20_000);
});

describe("a task that runs out of attempts on this very tick", () => {
  it("is given up and diagnosed in the same pass, not a tick later", async () => {
    const mine = "packages/runner/test/the-tick-heals-a-known-cause.test.ts";
    // Ready, with the attempts used: what `enforceRetryLimit` gives up mid-tick.
    const id = failedTask({ write: ["packages/runner/src/healer.ts"], tools: [] }, mine);

    const tick = await runner().tick();

    expect(tick.exhausted).toContain(id);
    expect(tick.healed.repaired.map((r) => r.task)).toEqual([id]);
    expect(state(id)).toBe("ready");
  }, 20_000);
});

/** The chore's attempt, as a worker would leave it: the branch gains the base, and the
 *  chore is started, begun and finished on the record. `finish` is what "it proved" means,
 *  and the ledger line it writes is what dates the repair against the failure. */
function proveTheRefresh(): void {
  const raised = choreFor(db, "refresh", "story", storyId);
  expect(raised).not.toBeNull();
  // In the story tree the tick already cut, which is where the chore's worker would be.
  git(join(repo, ".wecode/worktrees", `story-${storySlug}`), "merge", "-q", "-m", "refresh", "-X", "ours", "main");
  for (const verb of ["start", "begin", "finish"]) {
    const out = applyChore(db, raised?.id ?? 0, verb, "runner");
    expect(out.ok, out.ok ? "" : out.why).toBe(true);
  }
}
