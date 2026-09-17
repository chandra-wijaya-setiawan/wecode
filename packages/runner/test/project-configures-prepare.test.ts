import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, Maker, open } from "@wecode/core";
import { Examiner, prepareCommandOf } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** This repository's own root — the checkout carrying the `config/project.yaml` under test.
 *  Found from this file rather than from `process.cwd()`, which is the vitest root and not
 *  the same directory when a package runs its own suite. */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let db: DatabaseSync;
let make: Maker;
let engine: Engine;
let criteria: number;
let home: string;
let tree: string;
let log: string;
let path: string;

const ranIn = (): string[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);

/** A `pnpm` the test can watch. The real one would install from the network and build a
 *  workspace that is not there; what this file is about is which command the examiner takes
 *  from the config, and in which order, not what pnpm does with it. */
function shimPnpm(): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pnpm"), `#!/usr/bin/env bash\necho "pnpm $*" >> ${log}\n`);
  chmodSync(join(bin, "pnpm"), 0o755);
  process.env["PATH"] = `${bin}:${path}`;
}

beforeEach(() => {
  path = process.env["PATH"] ?? "";
  home = tmp("wecode-configures-prepare-");
  log = join(home, "ran.log");
  writeFileSync(log, "");
  db = open(join(home, "wecode.db"));
  make = new Maker(db);
  engine = new Engine(db);
  const ws = make.workspace("acme", home);
  const p = make.project(ws, "s", home);
  const rel = make.release(p, "1.0.0");
  const e = make.epic(rel, "e");
  const story = make.story(e, "s");
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

  // A tree that is this repository as far as the examiner can tell: the same config file,
  // byte for byte, so nothing here can pass against a command this repository does not name.
  tree = tmp("wecode-configures-prepare-tree-");
  mkdirSync(join(tree, "config"), { recursive: true });
  copyFileSync(join(REPO, "config", "project.yaml"), join(tree, "config", "project.yaml"));
});

afterEach(() => {
  process.env["PATH"] = path;
});

function readyTask(artefact: string): { task: number; taskTest: number } {
  const at = make.acceptanceTest(criteria, "proof", "script", "true");
  const task = make.task(at, "do", { role: "engineer", scope: { write: ["src/**"], tools: [] } });
  const taskTest = make.taskTest(task, "unit", "script", artefact);
  engine.apply("task_test", taskTest, "deliver", "chief");
  engine.apply("acceptance_test", at, "deliver", "chief");
  engine.apply("task", task, "start", "chief");
  return { task, taskTest };
}

describe("this repository names what makes a fresh worktree runnable", () => {
  const command = (): string => prepareCommandOf(REPO) ?? "";

  it("carries a prepare command in config/project.yaml", () => {
    expect(prepareCommandOf(REPO)).not.toBeNull();
  });

  it("installs and builds, which is what a worktree with no node_modules needs", () => {
    expect(command()).toContain("pnpm install");
    expect(command()).toContain("pnpm -r build");
  });

  it("names them there and nowhere else, so the test command cannot disagree", () => {
    const config = readFileSync(join(REPO, "config", "project.yaml"), "utf8");
    const test = /^test:(.*)$/m.exec(config)?.[1] ?? "";
    expect(test.trim()).not.toBe("");
    expect(test).not.toContain("pnpm install");
    expect(test).not.toContain("pnpm -r build");
  });
});

describe("the examiner reads this repository's config", () => {
  it("takes the same command off a tree holding this repository's config", () => {
    expect(prepareCommandOf(tree)).toBe(prepareCommandOf(REPO));
  });

  it("runs it before it proves anything in the tree", async () => {
    shimPnpm();
    const { task, taskTest } = readyTask(`echo "the test" >> ${log}`);

    const r = await new Examiner(db).runTaskTests(task, tree);

    expect(r.passed).toContain(taskTest);
    expect(ranIn()).toEqual(["pnpm install", "pnpm -r build", "the test"]);
  });

  it("does not build a tree it was not given", async () => {
    shimPnpm();
    const { task } = readyTask("true");

    await new Examiner(db).runTaskTests(task, tmp("wecode-configures-prepare-bare-"));

    expect(ranIn()).toEqual([]);
  });
});
