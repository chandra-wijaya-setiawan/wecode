import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { ENTRY_HIDDEN, Examiner, entriesOf, entryFor } from "../src/index.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let story: number;
let criteria: number;
/** Where the ledger lives. Never the tree under examination, so nothing the examiner does
 *  to a tree can be confused with what it did to the database. */
let home: string;
let tree: string;

const stateOf = (table: string, id: number): string =>
  (db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id) as { state: string }).state;

const outputOf = (table: string, id: number): string =>
  (db.prepare(`SELECT last_output FROM ${table} WHERE id = ?`).get(id) as { last_output: string | null })
    .last_output ?? "";

const git = (...args: string[]): string => execFileSync("git", args, { cwd: tree, encoding: "utf8" }).trim();

const commit = (message: string): void => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
};

/** The screen the proofs below claim to prove: one file, which the app draws by. */
const SCREEN = "src/screen.js";

/** What the tree declares about itself. The proof-to-entry-point mapping is the project's
 *  own config — the examiner reads it, it does not know it. */
const declares = (entries: readonly { proof: string; file: string }[]): void => {
  mkdirSync(join(tree, "config"), { recursive: true });
  const lines = entries.map((e) => `  - proof: ${e.proof}\n    file: ${e.file}`).join("\n");
  writeFileSync(join(tree, "config", "project.yaml"), `stack: pnpm\ntest: run-the-suite\nentry:\n${lines}\n`);
};

/** A proof, written into the tree as the script its artefact invokes. */
const proof = (name: string, body: string): string => {
  writeFileSync(join(tree, name), `#!/usr/bin/env bash\n${body}\n`);
  return `bash ${name}`;
};

/** Every run the tree has seen, one line per run: the second run of a proof is the whole
 *  subject here, so it has to be countable. */
const runs = (): readonly string[] => {
  const log = join(tree, "runs.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
};

let nth = 0;

function readyTask(artefact: string, acceptance = "true"): { task: number; taskTest: number; acceptance: number } {
  const name = `${++nth}`;
  const at = make.acceptanceTest(criteria, `proof-${name}`, "script", acceptance);
  const task = make.task(at, `do-${name}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, `unit-${name}`, "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  recordRed(db, at);
  return { task, taskTest, acceptance: at };
}

beforeEach(() => {
  home = tmp("wecode-surface-");
  db = open(join(home, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", home);
  const p = make.project(ws, "s", home);
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

  tree = tmp("wecode-surface-tree-");
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, SCREEN), "the screen the app draws\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  commit("seed");
});

describe("a proof is refused when it still passes with its entry point hidden", () => {
  it("fails a green proof that never went through the screen it claims", async () => {
    const artefact = proof("prove-nothing.sh", "echo ran >> runs.log; exit 0");
    declares([{ proof: "prove-nothing.sh", file: SCREEN }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.failed).toContain(taskTest);
    expect(r.passed).toEqual([]);
    expect(stateOf("task_test", taskTest)).toBe("failed");
  });

  it("says which entry point it passed without, ahead of what the proof printed", async () => {
    const artefact = proof("prove-nothing.sh", "echo the-suite-is-green; exit 0");
    declares([{ proof: "prove-nothing.sh", file: SCREEN }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    await new Examiner(db).runTaskTests(task, tree);

    expect(outputOf("task_test", taskTest)).toContain(`${ENTRY_HIDDEN}: ${SCREEN}`);
    expect(outputOf("task_test", taskTest)).toContain("the-suite-is-green");
  });

  it("passes a proof that dies without its entry point", async () => {
    const artefact = proof("prove-the-screen.sh", "echo ran >> runs.log; test -f src/screen.js");
    declares([{ proof: "prove-the-screen.sh", file: SCREEN }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(stateOf("task_test", taskTest)).toBe("passed");
    expect(runs()).toHaveLength(2);
  });

  it("refuses an acceptance proof on the same terms", async () => {
    const artefact = proof("prove-nothing.sh", "exit 0");
    declares([{ proof: "prove-nothing.sh", file: SCREEN }]);
    commit("declare");
    const { task, acceptance } = readyTask("true", artefact);
    await new Examiner(db).runTaskTests(task, tree);

    const r = await new Examiner(db).runAcceptanceTests(story, tree);

    expect(r.failed).toContain(acceptance);
    expect(stateOf("acceptance_test", acceptance)).toBe("failed");
    expect(outputOf("acceptance_test", acceptance)).toContain(ENTRY_HIDDEN);
  });
});

describe("the examined tree is left exactly as it was", () => {
  it("puts the entry point back, whichever way the second run went", async () => {
    const artefact = proof("prove-nothing.sh", "exit 0");
    declares([{ proof: "prove-nothing.sh", file: SCREEN }]);
    commit("declare");
    const { task } = readyTask(artefact);

    await new Examiner(db).runTaskTests(task, tree);

    expect(readFileSync(join(tree, SCREEN), "utf8")).toBe("the screen the app draws\n");
    expect(readdirSync(join(tree, "src"))).toEqual(["screen.js"]);
    expect(git("status", "--porcelain", "--", SCREEN)).toBe("");
  });

  it("puts it back when the proof crashes with it hidden", async () => {
    const artefact = proof("prove-the-screen.sh", "test -f src/screen.js || exit 3");
    declares([{ proof: "prove-the-screen.sh", file: SCREEN }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(existsSync(join(tree, SCREEN))).toBe(true);
  });
});

describe("a tree is only rechecked where it asked to be", () => {
  it("judges a tree that declares no entry point on its exit code alone", async () => {
    const artefact = proof("prove-nothing.sh", "echo ran >> runs.log; exit 0");
    commit("no declaration");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(runs()).toHaveLength(1);
  });

  it("leaves a proof no declaration names alone", async () => {
    const artefact = proof("prove-something-else.sh", "echo ran >> runs.log; exit 0");
    declares([{ proof: "prove-nothing.sh", file: SCREEN }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(runs()).toHaveLength(1);
  });

  it("never re-runs a proof that already failed: there is no pass to refuse", async () => {
    const artefact = proof("prove-the-screen.sh", "echo ran >> runs.log; exit 1");
    declares([{ proof: "prove-the-screen.sh", file: SCREEN }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.failed).toContain(taskTest);
    expect(runs()).toHaveLength(1);
    expect(outputOf("task_test", taskTest)).not.toContain(ENTRY_HIDDEN);
  });

  it("takes no verdict off a proof whose declared entry point is not in the tree", async () => {
    const artefact = proof("prove-nothing.sh", "exit 0");
    declares([{ proof: "prove-nothing.sh", file: "src/gone.js" }]);
    commit("declare");
    const { task, taskTest } = readyTask(artefact);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(outputOf("task_test", taskTest)).not.toContain(ENTRY_HIDDEN);
  });
});

describe("the declarations are read off the tree's own config", () => {
  it("reads every well-formed pair and nothing else", () => {
    mkdirSync(join(tree, "config"), { recursive: true });
    writeFileSync(
      join(tree, "config", "project.yaml"),
      ["entry:", "  - proof: a.sh", "    file: src/a.js", "  - proof: b.sh", "  - file: src/c.js", ""].join("\n"),
    );

    expect(entriesOf(tree)).toEqual([{ proof: "a.sh", file: "src/a.js" }]);
  });

  it("answers with no declarations for a tree that carries no config at all", () => {
    expect(entriesOf(tree)).toEqual([]);
  });

  it("matches a declaration against the artefact's own words", () => {
    const entries = [{ proof: "test/screens.test.ts", file: "src/screens.tsx" }];

    expect(entryFor("pnpm exec vitest run test/screens.test.ts", entries)).toEqual(entries[0]);
    expect(entryFor("pnpm exec vitest run test/list.test.ts", entries)).toBeNull();
  });
});
