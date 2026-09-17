import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { INVARIANTS, Maker, open, type Snapshot, type Violation } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type RunnerOptions } from "../src/index.js";
import {
  checksOf,
  Doctor,
  READY_TASK_CHECK,
  readyTaskCanBeDispatched,
  RUNNER_INVARIANTS,
  violations,
  type Invariant,
} from "../src/doctor.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-doctor-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

const runner = (opts: Partial<RunnerOptions> = {}): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: {},
    integrationBranch: "main",
    ...opts,
  });

/** A story marked `delivered` on the record and nowhere else. Nothing has landed it, so
 *  `delivered_story_has_landed` is broken by exactly one entity: the drift docs/design/19
 *  names first, and the one a person can check by hand. */
function deliveredButNeverLanded(title: string): number {
  const id = make.story(epic, title);
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);
  return id;
}

/** Every entity table the invariants read, as text. The comparison behind "reporting
 *  only": if a single row moved, the doctor was not reading. */
const ENTITIES = [
  "release",
  "epic",
  "story",
  "requirement",
  "acceptance_criteria",
  "acceptance_test",
  "task",
  "task_test",
] as const;

const recordOf = (): string =>
  ENTITIES.map((e) => `${e}:${JSON.stringify(db.prepare(`SELECT * FROM ${e} ORDER BY id`).all())}`).join("\n");

describe("the doctor's pass over a record with a known violation", () => {
  it("names the invariant, and the one entity that broke it", async () => {
    const story = deliveredButNeverLanded("password reset");

    const tick = await runner().tick();

    expect(tick.doctor).toEqual([
      {
        invariant: "delivered_story_has_landed",
        entity: "story",
        id: story,
        slug: "password-reset",
        detail: "delivered with no landed_sha — it never reached the base",
      },
    ]);
  });

  it("records it, so a view reads the table rather than running the pass again", async () => {
    const story = deliveredButNeverLanded("password reset");
    await runner().tick();

    // Read back through a handle that has never run a check: the table is the answer.
    expect(violations(db)).toEqual([
      {
        invariant: "delivered_story_has_landed",
        entity: "story",
        id: story,
        slug: "password-reset",
        detail: "delivered with no landed_sha — it never reached the base",
      },
    ]);
  });

  it("replaces the last pass rather than appending to it", async () => {
    deliveredButNeverLanded("password reset");
    await runner().tick();
    await runner().tick();
    await runner().tick();

    // Three passes, one standing violation. Appended, the same drift would read as three.
    expect(violations(db)).toHaveLength(1);
  });

  it("heals nothing and writes to no entity — it reports and stops", async () => {
    deliveredButNeverLanded("password reset");

    const before = recordOf();
    await runner().tick();
    const after = recordOf();

    expect(after).toBe(before);
    // Nor does it propose: a chore is the healing slice's, and this one has not landed it.
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(0);
  });

  it("clears the table once the drift is gone", async () => {
    const story = deliveredButNeverLanded("password reset");
    await runner().tick();
    expect(violations(db)).toHaveLength(1);

    db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(story);
    // in_progress with nothing under it breaks a different sentence, so give it a
    // requirement: the point here is that the delivered drift stops being reported.
    make.requirement(story, "the link expires");

    expect((await runner().tick()).doctor).toEqual([]);
    expect(violations(db)).toEqual([]);
  });
});

describe("the doctor's pass over a clean record", () => {
  it("reports nothing", async () => {
    const tick = await runner().tick();

    expect(tick.doctor).toEqual([]);
    expect(violations(db)).toEqual([]);
  });

  it("reports nothing for a story in progress with work under it", async () => {
    const story = make.story(epic, "password reset");
    db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(story);
    make.criteria(make.requirement(story, "the link expires"), "an expired link is refused");

    expect((await runner().tick()).doctor).toEqual([]);
  });
});

/** The failure mode this slice exists to rule out: the check is the newest thing in the
 *  tick and the least load-bearing, so it must not be able to take the tick with it. */
describe("an invariant that throws", () => {
  const explodes: Invariant = {
    name: "the_moon_is_where_we_left_it",
    check: (): readonly Violation[] => {
      throw new Error("no telescope");
    },
  };

  const withExplosion = (): Runner => runner({ invariants: [explodes, ...INVARIANTS] });

  it("does not abort the tick", async () => {
    const story = deliveredButNeverLanded("password reset");

    // Resolves rather than rejects, and the tick's own work is all still there.
    const tick = await withExplosion().tick();

    expect(tick.allocated).toBeDefined();
    expect(tick.merged).toEqual([]);
    expect(tick.exhausted).toEqual([]);
    expect(tick.scripts.failed).toEqual([]);
    // And the sound invariants still ran: one bad check costs its own result, not the set.
    expect(tick.doctor.map((v) => v.invariant)).toContain("delivered_story_has_landed");
    expect(tick.doctor.find((v) => v.invariant === "delivered_story_has_landed")?.id).toBe(story);
  });

  it("is reported as itself, rather than swallowed", async () => {
    const tick = await withExplosion().tick();

    expect(tick.doctor).toContainEqual({
      invariant: "the_moon_is_where_we_left_it",
      entity: "invariant",
      id: null,
      slug: "the_moon_is_where_we_left_it",
      detail: "the check itself failed: no telescope",
    });
    // Recorded like any other finding, so the view says the check is broken rather than
    // quietly showing one sentence fewer than there are.
    expect(violations(db).map((v) => v.invariant)).toContain("the_moon_is_where_we_left_it");
  });

  it("still leaves the record untouched", async () => {
    deliveredButNeverLanded("password reset");

    const before = recordOf();
    await withExplosion().tick();

    expect(recordOf()).toBe(before);
  });
});

describe("the doctor outside a tick", () => {
  it("is a pass anyone can run, and it throws for nothing", () => {
    const story = deliveredButNeverLanded("password reset");
    const broken: Invariant = {
      name: "every_snapshot_is_readable",
      check: (_: Snapshot): readonly Violation[] => {
        throw new Error("nope");
      },
    };

    const found = new Doctor(db, [broken, ...INVARIANTS]).check();

    expect(found.map((v) => v.invariant)).toEqual([
      "every_snapshot_is_readable",
      "delivered_story_has_landed",
    ]);
    expect(found[1]?.id).toBe(story);
  });
});

/** docs/design/19. The one check the runner adds to core's set, read on its own.
 *
 *  Pure over the snapshot, so it is proven over one: `stalled-task.test.ts` is the same
 *  sentence proven through a whole tick, and this is the sentence itself. */
describe("the check for a ready task no pass can dispatch", () => {
  const snapshotOf = (tasks: readonly { id: number; state: string; role?: string }[], roles: readonly string[]): Snapshot => ({
    nodes: tasks.map((t) => ({
      entity: "task" as const,
      id: t.id,
      slug: `task-${t.id}`,
      state: t.state,
      parent_id: 1,
      ...(t.role === undefined ? {} : { role: t.role }),
    })),
    workers: roles.map((role, i) => ({ slug: `w-${i}`, role })),
  });

  it("names the task, with the allocator's refusal and the part it cannot know", () => {
    const found = readyTaskCanBeDispatched.check(snapshotOf([{ id: 7, state: "ready", role: "system" }], ["engineer"]));

    expect(found).toEqual([
      {
        invariant: READY_TASK_CHECK,
        entity: "task",
        id: 7,
        slug: "task-7",
        detail:
          "ready, and every pass refuses it — no worker free for role system, and no worker " +
          "holds role system at all: hire one, or give the task a role somebody holds",
      },
    ]);
  });

  /** `task_may_be_attempted` refuses a task with no role at `start`, so the record should
   *  not hold one — but a guard is a gate and not a repair, and a report that said nothing
   *  at all about a roleless ready task would be the quietest drift of the lot. */
  it("has words for a ready task carrying no role at all", () => {
    const found = readyTaskCanBeDispatched.check(snapshotOf([{ id: 7, state: "ready" }], ["engineer"]));

    expect(found[0]?.detail).toContain("no worker free for role (none), and no worker holds role (none) at all");
  });

  it("is quiet when somebody holds the role, however busy they are", () => {
    // The snapshot does not say who is free, and must not: *busy* is this minute's answer
    // and *nobody holds it* is the record's.
    expect(readyTaskCanBeDispatched.check(snapshotOf([{ id: 7, state: "ready", role: "system" }], ["system"]))).toEqual(
      [],
    );
  });

  it("is quiet for a task that is not ready", () => {
    for (const state of ["planned", "done", "failed", "dropped"]) {
      expect(readyTaskCanBeDispatched.check(snapshotOf([{ id: 7, state, role: "system" }], [])), state).toEqual([]);
    }
  });

  it("is one line per task, in the order the snapshot was read", () => {
    const found = readyTaskCanBeDispatched.check(
      snapshotOf(
        [
          { id: 4, state: "ready", role: "system" },
          { id: 5, state: "ready", role: "engineer" },
          { id: 6, state: "ready", role: "scribe" },
        ],
        ["engineer"],
      ),
    );

    expect(found.map((v) => v.id)).toEqual([4, 6]);
  });

  /** The set the tick runs is core's plus this; the set the command and the tick are held
   *  to agreeing on is core's alone. `packages/cli/test/doctor-parity.test.ts` reads the
   *  second one, and this is the same fact said from this side. */
  it("is in the runner's set, and not in the set the two halves share", () => {
    expect(RUNNER_INVARIANTS.map((i) => i.name)).toEqual([...INVARIANTS.map((i) => i.name), READY_TASK_CHECK]);
    expect(INVARIANTS.map((i) => i.name)).not.toContain(READY_TASK_CHECK);
    expect(checksOf().map((c) => c.name)).not.toContain(READY_TASK_CHECK);
  });
});
