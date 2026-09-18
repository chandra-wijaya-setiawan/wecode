import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { applyChore, choreFor, Engine, identity, Maker, open, Verbs, type RoleConfig, type Scope } from "@wecode/core";
import { queries, table } from "@wecode/core/dist/db.js";
import { BEHIND_THE_BASE, diagnose, filesIn, healTasks, TEST_OUTSIDE_SCOPE } from "../src/healer.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19: a diagnosis that names a safe fix becomes work. The two causes a machine
 *  may act on — a tree behind the base, and a test the task could not reach — and the rule
 *  that holds over both: every automatic retry carries the finding as its reason. */

const taskRow = table<{
  id: number;
  state: string;
  attempts: number;
  scope: string;
  updated_at: string;
}>("task", ["id", "state", "attempts", "scope", "updated_at"]);

const ledgerRow = table<{ entity: string; entity_id: number; verb: string; to_state: string; actor: string; at: string }>(
  "ledger",
  ["entity", "entity_id", "verb", "to_state", "actor", "at"],
);

let dir: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let storyId: number;
let taskId: number;

/** The role the tasks below run under, with a ceiling wide enough for the package and no
 *  wider. Built by hand rather than loaded: the ceiling is the subject of one test here. */
const ENGINEER: RoleConfig = {
  invariants: { never_touch: [], never_run: [] },
  roles: {
    engineer: {
      name: "engineer",
      worker_kind: "agent",
      scope: { write: ["packages/runner/**"], tools: ["bash"] },
      budget: { tokens: 1000, seconds: 10 },
      harness: null,
    },
  },
};

/** A task with one script task_test, taken to `failed` the only way the machine allows:
 *  attempts at the ceiling, then `give_up`. */
function seedTask(scope: Scope, artefact: string): number {
  const at = make.acceptanceTest(criteriaId, `it works ${artefact}`, "script", "pnpm exec vitest run");
  const id = make.task(at, `do the work for ${artefact}`, { role: "engineer", scope, max_retry: 3 });
  const tt = make.taskTest(id, `proved by ${artefact}`, "script", `pnpm exec vitest run ${artefact}`);
  engine.apply("task_test", tt, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  const started = engine.apply("task", id, "start", "chief");
  expect(started.ok, started.ok ? "" : started.why).toBe(true);
  queries(db).update(taskRow).set({ attempts: 3 }).where("id", "=", id).run();
  const out = new Verbs(engine).giveUpTask(id, "runner");
  expect(out.ok, out.ok ? "" : out.why).toBe(true);
  return id;
}

let criteriaId: number;

beforeEach(() => {
  dir = tmp("wecode-heal-cause-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);

  const ws = make.workspace("acme", dir);
  const project = make.project(ws, "storefront", dir);
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

  taskId = seedTask(
    { write: ["packages/runner/src/healer.ts"], tools: ["bash"] },
    "packages/runner/test/heal-a-known-cause.test.ts",
  );
});

const state = (id: number): string =>
  queries(db).selectFrom(taskRow).select(["state"]).where("id", "=", id).get()?.state ?? "";

const attempts = (id: number): number =>
  queries(db).selectFrom(taskRow).select(["attempts"]).where("id", "=", id).get()?.attempts ?? -1;

const scopeOf = (id: number): Scope =>
  JSON.parse(queries(db).selectFrom(taskRow).select(["scope"]).where("id", "=", id).get()?.scope ?? "{}") as Scope;

/** The reason the last retry was given, as the ledger kept it. */
const retryReason = (id: number): string | null => {
  const row = queries(db)
    .selectFrom(ledgerRow)
    .where("entity", "=", "task")
    .where("entity_id", "=", id)
    .where("verb", "=", "retry")
    .all()
    .at(-1);
  return row === undefined ? null : identity(row.actor).reason;
};

/** A branch the world says is behind, and one it says is not. */
const behindAlways = (): boolean => true;
const behindNever = (): boolean => false;

describe("a failed task whose story tree is behind the base", () => {
  it("has a refresh chore raised for its story, and is not retried yet", () => {
    const found = diagnose(db, { behind: behindAlways, base: "main" });
    expect(found.map((d) => d.cause)).toEqual([BEHIND_THE_BASE]);
    expect(found[0]?.finding).toContain("story/password-reset does not contain main");

    const report = healTasks(db, found);
    expect(report.repaired).toEqual([]);
    expect(report.waiting.map((w) => w.task)).toEqual([taskId]);

    const chore = choreFor(db, "refresh", "story", storyId);
    expect(chore?.kind).toBe("refresh");
    expect(chore?.check).toBe("the base is an ancestor of the branch");
    // Not retried: an attempt in the same stale tree proves the same nothing.
    expect(state(taskId)).toBe("failed");
  });

  it("raises one chore however many passes see the condition", () => {
    healTasks(db, diagnose(db, { behind: behindAlways }));
    const first = choreFor(db, "refresh", "story", storyId)?.id;
    healTasks(db, diagnose(db, { behind: behindAlways }));
    expect(choreFor(db, "refresh", "story", storyId)?.id).toBe(first);
  });

  it("waits while the chore is open, even once the branch is no longer behind", () => {
    healTasks(db, diagnose(db, { behind: behindAlways }));
    const report = healTasks(db, diagnose(db, { behind: behindNever }));
    expect(report.repaired).toEqual([]);
    expect(report.waiting[0]?.finding).toMatch(/waiting on its refresh: chore #\d+ is planned/);
    expect(state(taskId)).toBe("failed");
  });

  it("is retried once the chore proves, carrying the finding as its reason", () => {
    healTasks(db, diagnose(db, { behind: behindAlways }));
    proveRefresh();

    const report = healTasks(db, diagnose(db, { behind: behindNever, base: "main" }), { actor: "doctor" });
    expect(report.repaired.map((r) => r.task)).toEqual([taskId]);
    expect(report.repaired[0]?.cause).toBe(BEHIND_THE_BASE);
    expect(state(taskId)).toBe("ready");
    expect(retryReason(taskId)).toContain("it failed in a tree behind main");
    expect(retryReason(taskId)).toMatch(/refresh chore #\d+ has since proved/);
  });

  it("puts the counter back, so the next tick does not give it up unattempted", () => {
    healTasks(db, diagnose(db, { behind: behindAlways }));
    proveRefresh();
    healTasks(db, diagnose(db, { behind: behindNever }));
    expect(attempts(taskId)).toBe(0);
  });

  it("does not retry a task that failed after the refresh proved", () => {
    healTasks(db, diagnose(db, { behind: behindAlways }));
    proveRefresh();
    // A second failure, in the tree the refresh made. Nothing about it is stale.
    const later = seedTask({ write: ["packages/runner/**"], tools: [] }, "packages/runner/test/other.test.ts");
    const found = diagnose(db, { behind: behindNever }).filter((d) => d.task === later);
    expect(found[0]?.cause).toBeNull();
    expect(found[0]?.finding).toContain("no cause with a safe fix");
  });
});

describe("a failed task whose failing test lies outside its scope", () => {
  it("has that one file added to the scope and is retried, with the finding as the reason", () => {
    const found = diagnose(db, { behind: behindNever });
    expect(found.map((d) => d.cause)).toEqual([TEST_OUTSIDE_SCOPE]);
    expect(found[0]?.file).toBe("packages/runner/test/heal-a-known-cause.test.ts");

    const report = healTasks(db, found, { roles: ENGINEER });
    expect(report.repaired[0]?.widened).toBe("packages/runner/test/heal-a-known-cause.test.ts");
    expect(scopeOf(taskId).write).toEqual([
      "packages/runner/src/healer.ts",
      "packages/runner/test/heal-a-known-cause.test.ts",
    ]);
    // Widened, not replaced: the tools it was given are untouched.
    expect(scopeOf(taskId).tools).toEqual(["bash"]);
    expect(state(taskId)).toBe("ready");
    expect(retryReason(taskId)).toBe(
      "its test is packages/runner/test/heal-a-known-cause.test.ts, which its write scope does not cover",
    );
  });

  it("says nothing about a task whose scope already covers its test", () => {
    const covered = seedTask(
      { write: ["packages/runner/test/**"], tools: [] },
      "packages/runner/test/covered.test.ts",
    );
    const found = diagnose(db, { behind: behindNever }).filter((d) => d.task === covered);
    expect(found[0]?.cause).toBeNull();
  });

  it("leaves the scope alone when the role's ceiling forbids the file", () => {
    const outside = seedTask({ write: ["packages/runner/src/a.ts"], tools: [] }, "packages/tui/test/far.test.ts");
    const found = diagnose(db, { behind: behindNever }).filter((d) => d.task === outside);
    const report = healTasks(db, found, { roles: ENGINEER });

    expect(report.repaired).toEqual([]);
    expect(report.left[0]?.why).toContain("outside the role's ceiling");
    expect(scopeOf(outside).write).toEqual(["packages/runner/src/a.ts"]);
    expect(state(outside)).toBe("failed");
  });
});

describe("a cause with no safe fix", () => {
  it("is left alone and said out loud", () => {
    const plain = seedTask({ write: ["packages/runner/**"], tools: [] }, "packages/runner/test/plain.test.ts");
    const found = diagnose(db, { behind: behindNever }).filter((d) => d.task === plain);
    const report = healTasks(db, found);

    expect(report.repaired).toEqual([]);
    expect(report.waiting).toEqual([]);
    expect(report.left[0]?.why).toContain("a person decides whether a further attempt is owed");
    expect(state(plain)).toBe("failed");
    expect(choreFor(db, "refresh", "story", storyId)).toBeNull();
  });

  it("is not a task that has not failed", () => {
    const fine = make.task(make.acceptanceTest(criteriaId, "untouched", "script", "true"), "still going", {
      role: "engineer",
      scope: { write: [], tools: [] },
    });
    engine.apply("task", fine, "start", "chief");
    expect(diagnose(db, { behind: behindAlways }).some((d) => d.task === fine)).toBe(false);
  });
});

describe("the pass itself", () => {
  it("reads and decides without writing: diagnose changes nothing", () => {
    const before = queries(db).selectFrom(ledgerRow).all().length;
    diagnose(db, { behind: behindAlways });
    expect(queries(db).selectFrom(ledgerRow).all().length).toBe(before);
    expect(choreFor(db, "refresh", "story", storyId)).toBeNull();
    expect(state(taskId)).toBe("failed");
  });

  it("heals what the record proves when the world cannot be asked", () => {
    const throws = (): boolean => {
      throw new Error("no repository");
    };
    const report = healTasks(db, diagnose(db, { behind: throws }), { roles: ENGINEER });
    expect(report.repaired[0]?.cause).toBe(TEST_OUTSIDE_SCOPE);
  });

  it("reads a path out of an artefact and nothing else out of it", () => {
    expect(filesIn("pnpm exec vitest run packages/runner/test/a.test.ts")).toEqual([
      "packages/runner/test/a.test.ts",
    ]);
    expect(filesIn("cargo test -p wecode --all-features")).toEqual([]);
    expect(filesIn(null)).toEqual([]);
  });
});

/** The chore's attempt, as the runner would record it: started, begun, and finished with the
 *  base in the branch. `finish` is what "the chore proves" means on the record. */
function proveRefresh(): void {
  const raised = choreFor(db, "refresh", "story", storyId);
  expect(raised).not.toBeNull();
  for (const verb of ["start", "begin", "finish"]) {
    const out = applyChore(db, raised?.id ?? 0, verb, "runner");
    expect(out.ok, out.ok ? "" : out.why).toBe(true);
  }
}
