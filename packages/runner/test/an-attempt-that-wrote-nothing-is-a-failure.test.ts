/** An attempt that wrote nothing is a failure, and what the session said goes on the record
 *  with it.
 *
 *  A session that read the brief and gave up exits 0 exactly like one that did the work. The
 *  harness has no opinion about it and every adapter reports `commit: null` — making the
 *  commit is the runner's, not the agent's — so "succeeded" was written down for both. What
 *  that left was a record saying the task had been worked and a branch with nothing on it to
 *  show for it, and the one account of why, the sentence the session ended with, filed under a
 *  success nobody would go back and read.
 *
 *  So the foreman reads the attempt's own tree before it writes the phase down: nothing to
 *  commit and no commit of its own is an attempt that wrote nothing, however cleanly the
 *  harness exited. */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { lessons, Maker, open } from "@wecode/core";
import { Foreman, type Observation, type WorkerAdapter } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const SPENT = { tokens: 10, seconds: 1 };

/** An adapter whose session has already ended, however the test says it ended. One
 *  observation for every call: what the foreman does with it is the whole subject here. */
class Ended implements WorkerAdapter {
  readonly kind = "agent";
  constructor(private readonly seen: Observation) {}
  async start(): Promise<Observation> {
    return this.seen;
  }
  async poll(): Promise<Observation> {
    return this.seen;
  }
  async resume(): Promise<Observation> {
    return this.seen;
  }
  async answer(): Promise<Observation> {
    return this.seen;
  }
  async kill(): Promise<void> {}
}

/** A session that exited cleanly, naming no commit — which is what every harness reports. */
const clean = (lesson?: string): Observation => ({
  phase: "succeeded",
  session: "s1",
  spent: SPENT,
  commit: null,
  ...(lesson === undefined ? {} : { lesson }),
});

let repo: string;
let tree: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let task: number;
let test_id: number;
let worker: number;

/** The repository an attempt is made in: a task branch, and a tree cut detached at its tip,
 *  which is what the allocator hands a worker. */
beforeEach(() => {
  repo = tmp("wecode-wrote-nothing-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  git(repo, "branch", "task/send-the-mail");
  tree = join(repo, "trees", "send-the-mail");
  git(repo, "worktree", "add", "-q", "--detach", tree, "task/send-the-mail");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", repo), "storefront", repo);
  test_id = make.acceptanceTest(
    make.criteria(
      make.requirement(make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "reset"), "one link"),
      "emailed in 60s",
    ),
    "mail arrives",
    "script",
    "test -f mail.ts",
  );
  task = make.task(test_id, "send the mail", { role: "engineer", scope: { write: ["mail.ts"], tools: [] } });
  worker = make.worker("claude-1", "engineer", "agent");
});

const assign = (worktree = tree, objective = task, type = "task" as const): number =>
  make.assignment({
    objective_type: type,
    objective_id: objective,
    worker_id: worker,
    scope: { write: ["mail.ts"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree,
  });

const tick = (seen: Observation): Promise<{ failed: readonly number[]; advanced: readonly number[] }> =>
  new Foreman(db, { agent: new Ended(seen) }).tick();

interface Row {
  phase: string;
  reason: string | null;
  session: string | null;
  commit_sha: string | null;
}

const rowOf = (id: number): Row => db.prepare("SELECT phase, reason, session, commit_sha FROM assignment WHERE id = ?").get(id) as Row;

const attemptsOf = (): number =>
  (db.prepare("SELECT attempts FROM task WHERE id = ?").get(task) as { attempts: number }).attempts;

const said = (): { text: string; assignment_id: number | null }[] =>
  lessons(db, project, 10).map((l) => ({ text: l.text, assignment_id: l.assignment_id }));

describe("an attempt that wrote nothing", () => {
  it("is recorded failed, whatever the harness exited with", async () => {
    const id = assign();

    await tick(clean());

    expect(rowOf(id).phase).toBe("failed");
  });

  it("says why, in the only word the record has for it", async () => {
    const id = assign();

    await tick(clean());

    expect(rowOf(id).reason).toBe("other");
  });

  it("is one of the tick's failures, and not one of the attempts it advanced", async () => {
    const id = assign();

    const report = await tick(clean());

    expect(report.failed).toContain(id);
    expect(report.advanced).not.toContain(id);
  });

  it("carries the sentence the session ended with, against the attempt that said it", async () => {
    const id = assign();

    await tick(clean("The worktree had no node_modules and the install needs a network."));

    expect(rowOf(id).phase).toBe("failed");
    expect(said()).toEqual([
      { text: "The worktree had no node_modules and the install needs a network.", assignment_id: id },
    ]);
  });

  it("invents nothing when the session said nothing, and is failed all the same", async () => {
    const id = assign();

    await tick(clean());

    expect(said()).toEqual([]);
    expect(rowOf(id).phase).toBe("failed");
  });

  it("keeps the session the harness named, because the model did answer", async () => {
    // An attempt on the record as failed with no session id is how a harness that never
    // reached the model reads, and two of those in a row stop dispatch. This one reached it.
    const id = assign();

    await tick(clean());

    expect(rowOf(id).session).toBe("s1");
  });

  it("records no commit, because there is none to record", async () => {
    const id = assign();

    await tick(clean());

    expect(rowOf(id).commit_sha).toBeNull();
  });

  it("counts against the task's retries, the way every attempt counts", async () => {
    assign();

    await tick(clean());

    expect(attemptsOf()).toBe(1);
  });
});

describe("an attempt that left something behind", () => {
  it("is a success when it wrote the file its scope allows", async () => {
    const id = assign();
    writeFileSync(join(tree, "mail.ts"), "work\n");

    await tick(clean());

    expect(rowOf(id).phase).toBe("succeeded");
  });

  it("is a success when what it changed was already tracked", async () => {
    const id = assign();
    appendFileSync(join(tree, "README.md"), "a line the attempt wrote\n");

    await tick(clean());

    expect(rowOf(id).phase).toBe("succeeded");
  });

  it("is a success when it committed for itself, where no branch holds it yet", async () => {
    // A tree is cut detached, so an attempt that ran `git commit` left a HEAD its task
    // branch cannot see. The tree is clean, and the work is still the attempt's own.
    const id = assign();
    writeFileSync(join(tree, "mail.ts"), "work\n");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "the attempt's own commit");
    expect(git(tree, "status", "--porcelain")).toBe("");

    await tick(clean());

    expect(rowOf(id).phase).toBe("succeeded");
  });

  it("is a success when the harness names a commit itself, tree or no tree", async () => {
    const id = assign();

    await tick({ phase: "succeeded", session: "s1", spent: SPENT, commit: "a".repeat(40) });

    expect(rowOf(id).phase).toBe("succeeded");
    expect(rowOf(id).commit_sha).toBe("a".repeat(40));
  });

  it("is read and not touched: committing the tree is the settling pass's", async () => {
    assign();
    writeFileSync(join(tree, "mail.ts"), "work\n");

    await tick(clean());

    expect(git(tree, "status", "--porcelain")).toBe("?? mail.ts");
    expect(git(tree, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "task/send-the-mail"));
  });
});

describe("what an empty tree does not decide", () => {
  it("an attempt whose tree has gone is not failed on its absence", async () => {
    // A tree released by an earlier pass, or a record restored beside a different checkout:
    // an attempt is failed on what was seen, never on what could not be read.
    const id = assign(join(repo, "trees", "no-such-tree"));

    await tick(clean());

    expect(rowOf(id).phase).toBe("succeeded");
  });

  it("an attempt on an acceptance test is not, because its work is a verdict", async () => {
    const id = assign(tree, test_id, "acceptance_test");

    await tick(clean());

    expect(rowOf(id).phase).toBe("succeeded");
  });
});

describe("a failure the harness reported itself", () => {
  it("keeps its own reason rather than being renamed", async () => {
    const id = assign();

    await tick({ phase: "failed", session: "s1", spent: SPENT, reason: "budget_exceeded" });

    expect(rowOf(id).reason).toBe("budget_exceeded");
  });

  it("records the session it named, so it does not read as never having reached the model", async () => {
    const id = assign();

    await tick({ phase: "failed", session: "s1", spent: SPENT, reason: "budget_exceeded" });

    expect(rowOf(id).session).toBe("s1");
  });

  it("leaves the session column alone when it names none, which is that harness's answer", async () => {
    const id = assign();

    await tick({ phase: "failed", session: null, spent: SPENT, reason: "other" });

    expect(rowOf(id).session).toBeNull();
  });
});
