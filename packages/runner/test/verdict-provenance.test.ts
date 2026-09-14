/** Provenance is the stamp, ancestry is the fact — docs/design/19.
 *
 *  On 15 Sep three verdicts were wrong because the tree was stale rather than the code:
 *  acceptance_test 166 failed twice in a story tree missing the services box that had
 *  already landed, then passed untouched once the tree was refreshed. `last_run_at` said
 *  when, `last_output` said what it printed, and nothing said what it was run against.
 *
 *  So: the examiner stamps the git tree sha of the worktree it ran in beside the result,
 *  and a pass whose stamp is not the story's tree now is drift the doctor names. Named,
 *  never repaired — re-proving a verdict is a decision, and healing may not change one. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkVerdicts,
  Engine,
  IT_PROVES_A_TREE_NOBODY_HAS,
  Maker,
  open,
  VERDICT_INVARIANTS,
  type Verdict,
} from "@wecode/core";
import { Examiner } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let story: number;
let criteria: number;
let dir: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

/** The tree sha of the checkout as it stands — the same question the examiner asks.
 *  `HEAD:` is `HEAD:.` at the top of a checkout, which is where these trees are. */
const treeOf = (): string => git("rev-parse", "HEAD:");

const provenanceOf = (table: string, id: number): string | null =>
  (db.prepare(`SELECT provenance_sha FROM ${table} WHERE id = ?`).get(id) as {
    provenance_sha: string | null;
  }).provenance_sha;

function commit(file: string, body: string): void {
  writeFileSync(join(dir, file), body);
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", file);
}

beforeEach(() => {
  dir = tmp("wecode-provenance-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", dir);
  const p = make.project(ws, "s", dir);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  story = make.story(e, "s");
  const req = make.requirement(story, "r");
  criteria = make.criteria(req, "c");
  for (const [entity, id] of [
    ["project", p],
    ["release", rel],
    ["epic", e],
    ["story", story],
    ["requirement", req],
    ["acceptance_criteria", criteria],
  ] as const) {
    engine.apply(entity, id, "start", "chief");
  }
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "wecode.db*\n");
  commit("services.box", "one\n");
});

function readyAcceptance(artefact: string): number {
  const at = make.acceptanceTest(criteria, "proof", "script", artefact);
  engine.apply("acceptance_test", at, "deliver", "chief");
  recordRed(db, at);
  return at;
}

function readyTask(artefact: string): { task: number; taskTest: number } {
  const at = make.acceptanceTest(criteria, `proof-${artefact}`, "script", "true");
  const task = make.task(at, `do-${artefact}`, { role: "engineer", scope: { write: ["**"], tools: [] } });
  const taskTest = make.taskTest(task, "unit", "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  return { task, taskTest };
}

describe("a run records the tree it proves", () => {
  it("stamps the story tree's sha beside an acceptance verdict", async () => {
    const at = readyAcceptance("test -f services.box");

    const r = await new Examiner(db).runAcceptanceTests(story, dir);

    expect(r.passed).toContain(at);
    expect(provenanceOf("acceptance_test", at)).toBe(treeOf());
  });

  it("stamps a failed verdict too — a red proves a tree as much as a green does", async () => {
    const at = readyAcceptance("test -f nothing-here");

    const r = await new Examiner(db).runAcceptanceTests(story, dir);

    expect(r.failed).toContain(at);
    expect(provenanceOf("acceptance_test", at)).toBe(treeOf());
  });

  it("stamps the attempt tree beside a task_test verdict", async () => {
    const { task, taskTest } = readyTask("test -f services.box");

    const r = await new Examiner(db).runTaskTests(task, dir);

    expect(r.passed).toContain(taskTest);
    expect(provenanceOf("task_test", taskTest)).toBe(treeOf());
  });

  it("stamps the tree, not the commit: two commits with the same sources stamp alike", async () => {
    const at = readyAcceptance("test -f services.box");
    await new Examiner(db).runAcceptanceTests(story, dir);
    const first = provenanceOf("acceptance_test", at);
    const wasAt = git("rev-parse", "HEAD");

    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "nothing");

    expect(git("rev-parse", "HEAD")).not.toBe(wasAt);
    expect(treeOf()).toBe(first);
  });

  it("says nothing where there is no git to ask", async () => {
    const bare = tmp("wecode-no-git-");
    const other = open(join(bare, "wecode.db"));
    const m = new Maker(other);
    const e2 = new Engine(other);
    const ws = m.workspace("b", bare);
    const p = m.project(ws, "s", bare);
    const rel = m.release(p, "1.0.0");
    const ep = m.epic(rel, "e");
    const st = m.story(ep, "s");
    const rq = m.requirement(st, "r");
    const cr = m.criteria(rq, "c");
    for (const [entity, id] of [
      ["project", p], ["release", rel], ["epic", ep], ["story", st], ["requirement", rq], ["acceptance_criteria", cr],
    ] as const) {
      e2.apply(entity, id, "start", "chief");
    }
    const at = m.acceptanceTest(cr, "proof", "script", "true");
    e2.apply("acceptance_test", at, "deliver", "chief");
    recordRed(other, at);

    await new Examiner(other).runAcceptanceTests(st, bare);

    const row = other.prepare("SELECT provenance_sha FROM acceptance_test WHERE id = ?").get(at) as {
      provenance_sha: string | null;
    };
    expect(row.provenance_sha).toBeNull();
  });
});

describe("a verdict taken in a tree that has since moved is reported", () => {
  const verdict = (over: Partial<Verdict> = {}): Verdict => ({
    entity: "acceptance_test",
    id: 166,
    slug: "the-services-box-is-there",
    state: "passed",
    story_slug: "s",
    provenance_sha: "a".repeat(40),
    tree_sha: "a".repeat(40),
    ...over,
  });

  it("is registered where nothing heals it, not beside the record invariants", () => {
    expect(VERDICT_INVARIANTS.map((i) => i.name)).toContain("verdict_provenance_is_current");
  });

  it("names a pass whose stamp is not the story's tree now", async () => {
    const at = readyAcceptance("test -f services.box");
    await new Examiner(db).runAcceptanceTests(story, dir);
    const stamped = provenanceOf("acceptance_test", at);

    // The story tree moves on under a verdict that already stands, exactly as it did on
    // 15 Sep when the landed box arrived after the run.
    commit("another.box", "two\n");

    const found = checkVerdicts([
      verdict({ id: at, provenance_sha: stamped, tree_sha: treeOf() }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.invariant).toBe("verdict_provenance_is_current");
    expect(found[0]?.id).toBe(at);
    expect(found[0]?.detail).toContain(IT_PROVES_A_TREE_NOBODY_HAS);
    expect(found[0]?.detail).toContain(stamped!.slice(0, 12));
    expect(found[0]?.detail).toContain(treeOf().slice(0, 12));
  });

  it("names the drift and changes nothing — the verdict still stands", async () => {
    const at = readyAcceptance("test -f services.box");
    await new Examiner(db).runAcceptanceTests(story, dir);
    commit("another.box", "two\n");

    checkVerdicts([verdict({ id: at, provenance_sha: provenanceOf("acceptance_test", at), tree_sha: treeOf() })]);

    const row = db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(at) as { state: string };
    expect(row.state).toBe("passed");
  });

  it("names a task_test the same way", () => {
    const found = checkVerdicts([
      verdict({ entity: "task_test", tree_sha: "b".repeat(40) }),
    ]);
    expect(found[0]?.entity).toBe("task_test");
  });
});

describe("a current verdict is quiet", () => {
  const passed = (over: Partial<Verdict> = {}): Verdict => ({
    entity: "acceptance_test",
    id: 1,
    slug: "proof",
    state: "passed",
    provenance_sha: "c".repeat(40),
    tree_sha: "c".repeat(40),
    ...over,
  });

  it("says nothing about a pass stamped with the tree it is still in", async () => {
    const at = readyAcceptance("test -f services.box");
    await new Examiner(db).runAcceptanceTests(story, dir);

    expect(
      checkVerdicts([passed({ id: at, provenance_sha: provenanceOf("acceptance_test", at), tree_sha: treeOf() })]),
    ).toEqual([]);
  });

  it("says nothing about a verdict that carries no stamp — a null accuses nobody", () => {
    expect(checkVerdicts([passed({ provenance_sha: null, tree_sha: "d".repeat(40) })])).toEqual([]);
    expect(checkVerdicts([passed({ provenance_sha: undefined, tree_sha: "d".repeat(40) })])).toEqual([]);
  });

  it("says nothing when nobody could read the story's tree", () => {
    expect(checkVerdicts([passed({ tree_sha: null })])).toEqual([]);
    expect(checkVerdicts([passed({ tree_sha: undefined })])).toEqual([]);
  });

  it("says nothing about a failure — a red is a question, not an excuse", () => {
    expect(checkVerdicts([passed({ state: "failed", tree_sha: "e".repeat(40) })])).toEqual([]);
    expect(checkVerdicts([passed({ state: "ready", tree_sha: "e".repeat(40) })])).toEqual([]);
  });

  it("is quiet on an empty board", () => {
    expect(checkVerdicts([])).toEqual([]);
  });
});
