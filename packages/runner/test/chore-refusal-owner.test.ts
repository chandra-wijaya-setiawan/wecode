import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, choreRefusal, Maker, now, open, recordChoreRefusal } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";

/** Who owns a chore's one `chore_refusal` row.
 *
 *  Two passes write to it every tick. `followRefresh` writes the note that raised the chore
 *  — "story/x does not contain main" — which the chore's kind and check already say.
 *  `dispatchChore` and `performChores` write the sentences nothing else on the board carries:
 *  no worker free, no slot, the attempt proved nothing.
 *
 *  The note used to be written unconditionally, so it landed over the other two on every
 *  pass. These pin both readings that cost: a dispatch refusal that is still true keeps its
 *  `since` and its count, and the verdict on a chore out of attempts — the row nothing ever
 *  comes back to rewrite — is not replaced by the note. */

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
  repo = mkdtempSync(join(tmpdir(), "wecode-refusal-owner-"));
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

/** An in_progress story whose branch is a commit behind the base: the condition that raises
 *  a `refresh` chore, and the only chore kind whose raise writes a note of its own. */
function aStoryBehindTheBase(title = "password reset"): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'in_progress' WHERE id = ?").run(id);

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

const refreshChoreOf = (story: number): number => choreFor(db, "refresh", "story", story)?.id as number;

describe("a refresh chore nobody can be given", () => {
  it("shows the dispatcher's sentence rather than the note that raised it", async () => {
    const story = aStoryBehindTheBase();

    await runner().tick();

    const chore = refreshChoreOf(story.id);
    expect(choreRefusal(db, chore)?.why).toBe("no worker free for role system");
  });

  it("keeps that sentence standing, and keeps counting the passes it has held", async () => {
    // The note is written before the dispatch pass on every tick, so unconditionally writing
    // it reset `since` and `passes` each time: a chore held for half an hour read as though
    // this pass were the first to refuse it.
    const story = aStoryBehindTheBase();

    await runner().tick();
    const chore = refreshChoreOf(story.id);
    const first = choreRefusal(db, chore);
    await runner().tick();
    const second = choreRefusal(db, chore);

    expect(second?.why).toBe("no worker free for role system");
    expect(second?.passes).toBe(2);
    expect(second?.since).toBe(first?.since);
  });
});

describe("a refresh chore that has used its attempts", () => {
  it("keeps the verdict of its last attempt, which nothing else will rewrite", async () => {
    const story = aStoryBehindTheBase();
    await runner().tick();
    const chore = refreshChoreOf(story.id);

    // The shape three failed attempts leave: `failed`, at `max_retry`, with the verdict the
    // judge wrote on the row. `ensureChore` cannot reraise it, so the tick re-reads a branch
    // that is still behind and finds a chore nothing will hand out again — and the note used
    // to land on top of the verdict, for good.
    theChoreHasFailedThreeTimes(chore);
    recordChoreRefusal(db, "the merge was not made", chore);

    await runner().tick();

    expect(choreRefusal(db, chore)?.why).toBe("the merge was not made");
  });
});

function theChoreHasFailedThreeTimes(chore: number): void {
  db.prepare("UPDATE chore SET state = 'failed' WHERE id = ?").run(chore);
  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO ledger (entity, entity_id, verb, from_state, to_state, actor, at)
       VALUES ('chore', ?, 'begin', 'ready', 'running', 'worker-1', ?)`,
    ).run(chore, now());
  }
}
