import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A refresh that conflicts leaves the story tree mid-merge unless someone aborts it. The
 *  abort is made here, and the tick says which of the two happened: the tree stands where it
 *  did, or it is wedged and wants a person. Silence read the same either way. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

beforeEach(() => {
  repo = tmp("wecode-abort-refresh-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  const project = make.project(ws, "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

const runner = (): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: {}, integrationBranch: "main" });

const slugOf = (story: number): string =>
  (db.prepare("SELECT slug FROM story WHERE id = ?").get(story) as { slug: string }).slug;

const stateOf = (test: number): string =>
  (db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(test) as { state: string }).state;

const storyTree = (slug: string): string => join(repo, ".wecode/worktrees", `story-${slug}`);

/** An in-progress story with one ready script test and one done task under it: enough for
 *  the tick to want to judge it, so the refresh runs first. */
function story(title: string): { id: number; slug: string; test: number } {
  const id = make.story(epic, title);
  const req = make.requirement(id, "it behaves");
  const c = make.criteria(req, "proven by a script");
  const test = make.acceptanceTest(c, "the suite is green", "script", "true");
  const task = make.task(test, "do the work", { role: "engineer", scope: { write: ["mine.ts"], tools: [] } });

  db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);
  db.prepare("UPDATE requirement SET state = 'in_progress' WHERE id = ?").run(req);
  db.prepare("UPDATE acceptance_criteria SET state = 'in_progress' WHERE id = ?").run(c);
  db.prepare("UPDATE acceptance_test SET state = 'ready' WHERE id = ?").run(test);
  db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(task);
  return { id, slug: slugOf(id), test };
}

/** A story branch that edits README.md, and a base that edits it too: the refresh merge can
 *  only conflict. */
function conflicting(slug: string): void {
  git(repo, "branch", `story/${slug}`, "main");
  const cut = join(repo, `.cut-${slug}`);
  git(repo, "worktree", "add", "-q", cut, `story/${slug}`);
  writeFileSync(join(cut, "README.md"), "the story's idea\n");
  writeFileSync(join(cut, "mine.ts"), "mine\n");
  git(cut, "add", "-A");
  git(cut, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "ours");
  git(repo, "worktree", "remove", "--force", cut);

  writeFileSync(join(repo, "README.md"), "the base's idea\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base moves");
}

/** Where git keeps this worktree's per-tree state — MERGE_HEAD and index.lock both live here. */
const gitDirOf = (tree: string): string => git(tree, "rev-parse", "--absolute-git-dir");

describe("a refresh that conflicts is aborted, and the tick says so", () => {
  it("aborts the merge and says the tree stands where it did", async () => {
    const s = story("the conflicted one");
    conflicting(s.slug);

    const tick = await runner().tick();

    const why = tick.behind.find((b) => b.story === s.id)?.why ?? "";
    expect(why).toContain(`story/${s.slug} is behind main and will not take it`);
    expect(why).toContain("no merge is left standing: the tree is as it was");
    expect(why).not.toContain("mid-merge");

    // and the sentence is true of the tree: no merge in flight, nothing half-written
    const tree = storyTree(s.slug);
    expect(existsSync(join(gitDirOf(tree), "MERGE_HEAD"))).toBe(false);
    expect(git(tree, "status", "--porcelain")).toBe("");

    // nothing was judged in it either
    expect(stateOf(s.test)).toBe("ready");
  });

  it("says the tree is left mid-merge when the abort cannot run", async () => {
    const s = story("the wedged one");
    conflicting(s.slug);

    // An abort that will not run: every other git the tick makes goes through untouched, and
    // `merge --abort` alone fails, leaving the conflicted merge standing exactly as an
    // interrupted or refused abort does.
    const bin = tmp("wecode-git-shim-");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif [ "$1" = merge ] && [ "$2" = --abort ]; then\n  echo "fatal: refusing to abort" >&2\n  exit 128\nfi\nexec ${execFileSync("which", ["git"], { encoding: "utf8" }).trim()} "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    let tick;
    try {
      tick = await runner().tick();
    } finally {
      process.env.PATH = path;
    }

    const tree = storyTree(s.slug);
    const gitDir = gitDirOf(tree);

    const why = tick.behind.find((b) => b.story === s.id)?.why ?? "";
    expect(why).toContain(`story/${s.slug} is behind main and will not take it`);
    expect(why).toContain("the merge would not abort");
    expect(why).toContain(tree);
    expect(why).toContain("wants a person");

    // The claim is checked, not assumed: the tree really is still mid-merge.
    expect(existsSync(join(gitDir, "MERGE_HEAD"))).toBe(true);
    expect(stateOf(s.test)).toBe("ready");
  });
});
