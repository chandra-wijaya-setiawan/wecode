import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { board, choreFor, choreRefusal, closeChore, Maker, open, recordChoreRefusal } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";

/** 15 Sep: assignment 271 was running on worker 111 against chore 2, the chore row read
 *  `planned`, and its refusal still said `no worker free for role system` at 16 passes —
 *  written before the worker arrived and never taken back. One board, three answers.
 *
 *  The rule these pin: a refusal is a claim about now, so it lives exactly as long as the
 *  condition it names; and a chore something is attempting reads as running, because the
 *  assignment is the fact and the column is only a record of it. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

class SystemAgent implements WorkerAdapter {
  readonly kind = "agent";
  async start(): Promise<Observation> {
    return { phase: "running", session: "sess-1", spent: { tokens: 0, seconds: 0 }, commit: null };
  }
  async poll(w: Work): Promise<Observation> {
    return { phase: "running", session: w.session ?? "sess-1", spent: { tokens: 0, seconds: 0 }, commit: null };
  }
  async resume(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async answer(w: Work): Promise<Observation> {
    return this.poll(w);
  }
  async kill(): Promise<void> {}
}

const runner = (): Runner =>
  new Runner(db, {
    budget: DEFAULT_BUDGET,
    repoRoot: repo,
    adapters: { agent: new SystemAgent() },
    integrationBranch: "main",
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-refusal-cleared-"));
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

function theSystemRole(): void {
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "roles.yaml"),
    [
      "invariants:",
      "  never_touch: []",
      "  never_run: []",
      "roles:",
      "  system:",
      "    worker_kind: agent",
      "    scope:",
      '      write: ["**"]',
      '      tools: ["bash", "read", "edit", "write"]',
      "",
    ].join("\n"),
  );
}

const aSystemWorker = (): number => make.worker("system-1", "system", "agent");

/** A delivered story whose branch will not merge: the condition that raises a merge chore. */
function anUnmergeableStory(title = "password reset"): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), "the story's line\n");
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "README.md"), "the base's line\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug };
}

const choreOf = (story: number): number => choreFor(db, "merge", "story", story)?.id as number;

const openAssignmentsOn = (chore: number): number =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM assignment
          WHERE objective_type = 'chore' AND objective_id = ?
            AND phase IN ('pending','running','waiting')`,
      )
      .get(chore) as { n: number }
  ).n;

const choreRow = (chore: number) => board(db).chores.find((r) => r.id === chore);

describe("a dispatched chore", () => {
  it("carries no refusal, and does not read as waiting on one", async () => {
    theSystemRole();
    const story = anUnmergeableStory();

    // First pass: nobody to hand it to, so the board says so.
    await runner().tick();
    const chore = choreOf(story.id);
    expect(choreRefusal(db, chore)?.why).toBe("no worker free for role system");

    // The worker arrives and the chore goes out.
    aSystemWorker();
    await runner().tick();

    expect(openAssignmentsOn(chore)).toBe(1);
    expect(choreRefusal(db, chore)).toBeNull();
    // Nothing in the board's stale box: staleness is read from a refusal, and there is none.
    expect(board(db).stale.some((r) => r.what.startsWith("merge story"))).toBe(false);
  });

  it("reads as running rather than planned while its assignment is open", async () => {
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();
    await runner().tick();
    const chore = choreOf(story.id);

    // The 15 Sep shape, made by hand: the assignment is open and the row was left behind.
    db.prepare("UPDATE chore SET state = 'planned' WHERE id = ?").run(chore);
    expect(openAssignmentsOn(chore)).toBe(1);

    expect(choreRow(chore)?.state).toBe("running");
  });

  it("is not handed out a second time while the first attempt is open", async () => {
    theSystemRole();
    aSystemWorker();
    make.worker("system-2", "system", "agent");
    const story = anUnmergeableStory();
    await runner().tick();
    const chore = choreOf(story.id);

    db.prepare("UPDATE chore SET state = 'planned' WHERE id = ?").run(chore);
    await runner().tick();

    expect(openAssignmentsOn(chore)).toBe(1);
  });

  it("cannot be given a refusal at all while something is attempting it", async () => {
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();
    await runner().tick();
    const chore = choreOf(story.id);

    // Whatever path tries — a pass that has not noticed, or one still to be written.
    recordChoreRefusal(db, "no worker free for role system", chore);

    expect(choreRefusal(db, chore)).toBeNull();
  });

  it("is never both on the board as attempted and showing a reason it is not running", async () => {
    // The 15 Sep board, read as a whole: the two boxes are fed from `chore.state` and from
    // `chore_refusal`, and the complaint was that they answered differently about chore 2.
    // Whatever a pass does, no chore may appear in both readings at once.
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();
    await runner().tick();
    const chore = choreOf(story.id);

    // The row left behind by a `begin` that did not land, with last pass's sentence still on it.
    db.prepare("UPDATE chore SET state = 'planned' WHERE id = ?").run(chore);
    await runner().tick();

    for (const row of board(db).chores) {
      if (row.state === "running") expect(choreRefusal(db, row.id)).toBeNull();
    }
    expect(choreRow(chore)?.state).toBe("running");
    expect(board(db).stale.some((r) => r.id === chore)).toBe(false);
  });
});

describe("a chore that was closed", () => {
  it("keeps the reason it was closed for, even with an assignment still open on it", async () => {
    // `chore_refusal` carries two different sentences. "Passed over because X" is a claim
    // that nothing is attempting the chore, and must go when something does. "Closed
    // because X" is the epitaph, and an assignment left standing — the very shape a failed
    // `begin` leaves behind — must not swallow it.
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();
    await runner().tick();
    const chore = choreOf(story.id);
    db.prepare("UPDATE chore SET state = 'planned' WHERE id = ?").run(chore);
    expect(openAssignmentsOn(chore)).toBe(1);

    const out = closeChore(db, chore, "the branch merged on its own");

    expect(out.ok).toBe(true);
    expect(choreRefusal(db, chore)?.why).toBe("the branch merged on its own");
  });
});

describe("a chore refused for a reason that is true", () => {
  it("keeps it, and keeps counting the passes it has held", async () => {
    theSystemRole();
    const story = anUnmergeableStory();

    await runner().tick();
    const chore = choreOf(story.id);
    const first = choreRefusal(db, chore);
    await runner().tick();
    const second = choreRefusal(db, chore);

    expect(second?.why).toBe("no worker free for role system");
    expect(second?.passes).toBe(2);
    expect(second?.since).toBe(first?.since);
    expect(openAssignmentsOn(chore)).toBe(0);
    expect(choreRow(chore)?.state).toBe("planned");
  });

  it("loses it the moment the reason goes, without waiting to be dispatched", async () => {
    // A worker for the role exists, but every slot is taken: a reason with nothing to do
    // with this chore, and one that heals on its own.
    theSystemRole();
    aSystemWorker();
    const story = anUnmergeableStory();
    const held = make.worker("dev-1", "dev", "agent");
    const filler: number[] = [];
    for (let i = 0; i < DEFAULT_BUDGET.max_open; i++) {
      filler.push(
        new Maker(db).assignment({
          objective_type: "task",
          objective_id: 900 + i,
          worker_id: held,
          scope: { write: ["**"], tools: ["read"] },
          budget: { tokens: 1000, seconds: 60 },
          worktree: repo,
        }),
      );
    }

    await runner().tick();
    const chore = choreOf(story.id);
    expect(choreRefusal(db, chore)?.why).toMatch(/slots are open$/);

    // The slots free up. The chore is dispatched on the next pass, and the sentence about
    // slots must not survive the slots.
    for (const id of filler) db.prepare("UPDATE assignment SET phase = 'succeeded' WHERE id = ?").run(id);
    await runner().tick();

    expect(choreRefusal(db, chore)).toBeNull();
    expect(choreRow(chore)?.state).toBe("running");
  });
});

describe("a task, held to the same rule", () => {
  it("has no refusal left once something is attempting it", async () => {
    theSystemRole();
    const story = anUnmergeableStory();
    const task = aReadyTask(story.id);

    // First pass: no engineer to give it to, so the reason goes on the record.
    await runner().tick();
    expect(refusalOf(task)).toBe("no worker free for role engineer");

    make.worker("eng-1", "engineer", "agent");
    await runner().tick();

    expect(openTaskAssignments(task)).toBe(1);
    expect(refusalOf(task)).toBeUndefined();
    expect(board(db).queued.some((r) => r.id === task)).toBe(false);
  });

  it("loses a refusal the moment the task is no longer waiting on anything", async () => {
    theSystemRole();
    const story = anUnmergeableStory();
    const task = aReadyTask(story.id);
    await runner().tick();
    expect(refusalOf(task)).toBeDefined();

    // Somebody drops it. Nothing is owed and nothing is refused, so the sentence about a
    // worker for a role must not still be on the board.
    db.prepare("UPDATE task SET state = 'dropped' WHERE id = ?").run(task);
    await runner().tick();

    expect(refusalOf(task)).toBeUndefined();
  });
});

/** A ready task under the story, so the allocator has something of its own to refuse. */
function aReadyTask(story: number): number {
  const requirement = make.requirement(story, "the password is reset");
  const criteria = make.criteria(requirement, "a reset mail is sent");
  const test = make.acceptanceTest(criteria, "it sends one mail", "automated", null, "test/reset.test.ts");
  const id = make.task(test, "send the mail", { role: "engineer", scope: { write: ["src/**"], tools: ["read"] } });
  db.prepare("UPDATE task SET state = 'ready' WHERE id = ?").run(id);
  return id;
}

const refusalOf = (task: number): string | undefined =>
  (db.prepare("SELECT why FROM refusal WHERE task_id = ?").get(task) as { why: string } | undefined)?.why;

const openTaskAssignments = (task: number): number =>
  (
    db
      .prepare(
        `SELECT count(*) AS n FROM assignment
          WHERE objective_type = 'task' AND objective_id = ?
            AND phase IN ('pending','running','waiting')`,
      )
      .get(task) as { n: number }
  ).n;
