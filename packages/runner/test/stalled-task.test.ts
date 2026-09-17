import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open, type Scope } from "@wecode/core";
import { DEFAULT_BUDGET, Runner, type RunnerOptions } from "../src/index.js";
import { READY_TASK_CHECK, violations } from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19. A ready task whose role nobody holds.
 *
 *  The allocator already refuses it every pass, and every pass clears the reason and writes
 *  it again, so the record says *not yet* for ever without ever saying *never*. `system` is
 *  the live case: `config/roles.yaml` declares the role and no worker holds it, so a merge
 *  chore's task is created, shown, refused, and taken by nobody.
 *
 *  What is being proven here is that the drift is named, in the allocator's own words, and
 *  that it is named only when it is really permanent — a refusal that is true this tick
 *  because somebody is busy is a queue, and a doctor that called that drift would teach a
 *  person to stop reading the report. */

let repo: string;
let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = tmp("wecode-stalled-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", repo);
  const project = make.project(ws, "storefront", repo);
  const release = make.release(project, "1.0.0");
  const epic = make.epic(release, "recovery");
  const story = make.story(epic, "s");
  const requirement = make.requirement(story, "it works");
  criteria = make.criteria(requirement, "accepted");
  for (const [entity, id] of [
    ["project", project],
    ["release", release],
    ["epic", epic],
    ["story", story],
    ["requirement", requirement],
    ["acceptance_criteria", criteria],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
});

const runner = (opts: Partial<RunnerOptions> = {}): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: {},
    integrationBranch: "main",
    ...opts,
  });

/** A ready task under a role, with its own acceptance_test so two tasks never share one,
 *  and one test of its own that fails — so nothing here settles, finishes, or lands, and
 *  what the pass did is only ever what it chose. */
function readyTask(title: string, role: string, scope?: Scope): number {
  const at = make.acceptanceTest(criteria, `${title} proof`, "script", "false");
  const task = make.task(at, title, { role, scope: scope ?? { write: [`packages/${title}/**`], tools: [] } });
  const unit = make.taskTest(task, `${title} unit`, "script", "false");
  engine.apply("task_test", unit, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  expect(engine.apply("task", task, "start", "chief").ok).toBe(true);
  return task;
}

const stateOf = (task: number): string =>
  (db.prepare("SELECT state FROM task WHERE id = ?").get(task) as { state: string }).state;

/** The reason the last pass recorded against a task, which is what the board shows. */
const refusalOf = (task: number): string | undefined =>
  (db.prepare("SELECT why FROM refusal WHERE task_id = ?").get(task) as { why: string } | undefined)?.why;

const stalled = (found: readonly { invariant: string }[]): readonly { invariant: string }[] =>
  found.filter((v) => v.invariant === READY_TASK_CHECK);

describe("a ready task whose role nobody holds", () => {
  it("is reported, one line, naming the task and not its story", async () => {
    const task = readyTask("reconcile-the-merge", "system");

    const tick = await runner().tick();

    expect(stalled(tick.doctor)).toEqual([
      {
        invariant: READY_TASK_CHECK,
        entity: "task",
        id: task,
        slug: "reconcile-the-merge",
        detail:
          "ready, and every pass refuses it — no worker free for role system, and no worker " +
          "holds role system at all: hire one, or give the task a role somebody holds",
      },
    ]);
  });

  it("carries the refusal the allocator recorded against it, word for word", async () => {
    const task = readyTask("reconcile-the-merge", "system");

    const tick = await runner().tick();

    // The sentence a person already read on the board, and then the part the allocator
    // cannot know: that the next pass will say it again.
    expect(refusalOf(task)).toBe("no worker free for role system");
    expect(stalled(tick.doctor)[0]).toMatchObject({
      detail: expect.stringContaining(refusalOf(task) as string) as unknown as string,
    });
  });

  it("says it again on the next pass, because nothing about the next pass is different", async () => {
    readyTask("reconcile-the-merge", "system");

    await runner().tick();
    await runner().tick();
    const tick = await runner().tick();

    // Three passes, one standing drift: the table is the last pass and not a tally.
    expect(stalled(tick.doctor)).toHaveLength(1);
    expect(stalled(violations(db))).toHaveLength(1);
  });

  it("reports and stops — the task is not dispatched, dropped, or chored", async () => {
    const task = readyTask("reconcile-the-merge", "system");

    const tick = await runner().tick();

    expect(tick.allocated.created).toBeNull();
    expect(stateOf(task)).toBe("ready");
    expect((db.prepare("SELECT count(*) AS n FROM assignment").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(0);
  });

  it("is one line per stalled task", async () => {
    const first = readyTask("reconcile-the-merge", "system");
    const second = readyTask("write-the-release-notes", "scribe");

    const tick = await runner().tick();

    expect(stalled(tick.doctor).map((v) => (v as { id: number }).id)).toEqual([first, second]);
  });

  it("stops being reported once somebody holds the role", async () => {
    const task = readyTask("reconcile-the-merge", "system");
    await runner().tick();
    expect(stalled(violations(db))).toHaveLength(1);

    make.worker("system-1", "system", "agent");
    const tick = await runner().tick();

    expect(stalled(tick.doctor)).toEqual([]);
    expect(stalled(violations(db))).toEqual([]);
    // And it is the drift that cleared, not the task: hiring is what dispatches it.
    expect(tick.allocated).not.toBeNull();
    expect(stateOf(task)).toBe("ready");
  });
});

/** The other half, and the reason the check is not simply "a refusal was recorded": a
 *  refusal that is true because somebody is busy stops being true on its own. */
describe("a ready task waiting its turn", () => {
  it("is not reported while the only worker of its role is busy", async () => {
    make.worker("claude-1", "engineer", "agent");
    const taken = readyTask("first", "engineer");
    const waiting = readyTask("second", "engineer");

    const tick = await runner().tick();

    // Refused this pass, and reported by nobody: the worker holding the role finishes, and
    // then the same sentence stops being true. Only a role nobody holds cannot change.
    expect(tick.allocated.created).not.toBeNull();
    expect(refusalOf(waiting)).not.toBeUndefined();
    expect(stalled(tick.doctor)).toEqual([]);
    expect(taken).toBeLessThan(waiting);
  });

  it("is not reported while its write scope overlaps one already open", async () => {
    make.worker("claude-1", "engineer", "agent");
    make.worker("claude-2", "engineer", "agent");
    readyTask("first", "engineer", { write: ["packages/runner/**"], tools: [] });
    const overlapping = readyTask("second", "engineer", { write: ["packages/runner/src/**"], tools: [] });

    const tick = await runner().tick();

    expect(stateOf(overlapping)).toBe("ready");
    expect(stalled(tick.doctor)).toEqual([]);
  });

  it("is not reported for a task that is not ready yet", async () => {
    const at = make.acceptanceTest(criteria, "planned proof", "script", "false");
    make.task(at, "not started", { role: "system" });

    expect(stalled((await runner().tick()).doctor)).toEqual([]);
  });
});
