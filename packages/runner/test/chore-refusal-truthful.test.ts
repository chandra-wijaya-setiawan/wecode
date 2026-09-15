import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";

/** What a chore's refusal says when the thing that stopped it was thrown rather than
 *  decided.
 *
 *  The fixed sentence dispatchChore used to write — "no branch to merge into yet" — read
 *  identically for every throw out of the tree-cutting half, so an operator watching a
 *  chore sit in `planned` could not tell a missing branch from an occupied worktree path
 *  from a locked index without going to the tree themselves. The error that was caught is
 *  the only thing that distinguishes them, so it is what gets written down. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
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
  repo = mkdtempSync(join(tmpdir(), "wecode-chore-truthful-"));
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
});

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

/** Raise the chore with nobody to take it, then hand back its id: every test here wants the
 *  chore on the record before it breaks the tree the second pass would cut. */
async function aMergeChoreFor(story: number): Promise<number> {
  await runner().tick();
  return choreFor(db, "merge", "story", story)?.id as number;
}

const whyOfChore = async (id: number): Promise<string | undefined> => {
  make.worker("system-1", "system", "agent");
  await runner().tick();
  return choreRefusal(db, id)?.why ?? undefined;
};

describe("a chore refused by something that threw", () => {
  it("quotes git rather than the old fixed sentence when the tree path is occupied", async () => {
    const story = anUnmergeableStory();
    const id = await aMergeChoreFor(story.id);

    // A plain file sitting exactly where the story's tree would be laid out.
    mkdirSync(join(repo, ".wecode", "worktrees"), { recursive: true });
    writeFileSync(join(repo, ".wecode", "worktrees", `story-${story.slug}`), "not a tree\n");

    const why = await whyOfChore(id);

    expect(why).toBeDefined();
    expect(why).not.toBe("no branch to merge into yet");
    // git names the path it could not have, so the operator knows what to move.
    expect(why).toContain(`story-${story.slug}`);
  });

  it("tells a missing branch apart from an occupied path", async () => {
    const story = anUnmergeableStory();
    const id = await aMergeChoreFor(story.id);

    // The other way the tree-cutting half throws: the branch the chore targets is gone.
    git(repo, "branch", "-D", `story/${story.slug}`);

    const why = await whyOfChore(id);

    expect(why).toBeDefined();
    expect(why).not.toBe("no branch to merge into yet");
    expect(why).toContain(`story/${story.slug}`);
  });
});
