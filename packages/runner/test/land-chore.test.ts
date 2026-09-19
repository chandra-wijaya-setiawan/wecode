import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  board,
  choreAttempts,
  choreCandidates,
  choreFor,
  choreRefusal,
  Maker,
  open,
  type RoleConfig,
} from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import { attemptLanding, isLanded, LAND_CHECK } from "../src/land-chore.js";

/** docs/design/14. A delivered story reaches the base branch with nobody merging it.
 *
 *  Landing was the one merge wecode would not make: `wecode land` was printed for a person
 *  to run in their own checkout, so a story delivered on Friday sat unlanded until somebody
 *  remembered it, and the doctor accused it of never reaching the base in the meantime.
 *
 *  What this file pins is the shape of the unattended landing, not the git. Rung 1 — the
 *  runner, inline — is silent when it works: no chore, no assignment, no board row, and the
 *  base one commit further on. The chore is what is left when the merge could not be made,
 *  and it is the reason on the board, the attempts behind it, and the check nobody but the
 *  graph may answer. */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-land-chore-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", repo), "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

const runner = (): Runner =>
  new Runner(db, { budget: DEFAULT_BUDGET, repoRoot: repo, adapters: {}, integrationBranch: "main" });

/** A story with a branch of its own carrying one commit, in whatever state is asked for,
 *  and with the gate's permission on the record: one acceptance test, passed.
 *
 *  How a story reaches `delivered` is the cascade's business and every other test's; this
 *  file is about what happens to it once it is there. */
function story(
  title: string,
  file: string,
  state = "delivered",
  testState = "passed",
): { id: number; slug: string; test: number } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = ? WHERE id = ?").run(state, id);
  const test = make.acceptanceTest(make.criteria(make.requirement(id, "it behaves"), "proven"), "it works", "script", "true");
  db.prepare("UPDATE acceptance_test SET state = ? WHERE id = ?").run(testState, test);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, file), `${title}\n`);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);
  return { id, slug, test };
}

/** The base's line, rewritten under a delivered story that rewrote the same line. Nothing
 *  on either branch is wrong; they cannot both be true, which is the conflict itself. */
function moveTheBase(line: string): void {
  writeFileSync(join(repo, "README.md"), line);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
}

const subjects = (ref: string): string[] => git(repo, "log", "--format=%s", ref).split("\n");

const landTree = (slug: string): string => join(repo, ".wecode", "worktrees", `land-${slug}`);

/** config/roles.yaml's `system`, in memory: where a chore's scope comes from, and without
 *  it no chore is a candidate at all. */
const SYSTEM_ROLES: RoleConfig = {
  invariants: { never_touch: [], never_run: [] },
  roles: {
    system: {
      name: "system",
      worker_kind: "agent",
      scope: { write: ["**"], tools: [] },
      budget: { tokens: 1000, seconds: 60 },
      harness: null,
    },
  },
};

/** Every checkout of the repository, as git lists them. */
const checkouts = (): string[] =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));

describe("a delivered story with no land commit in the base", () => {
  it("is merged to the base by the tick, with nobody asked", async () => {
    const s = story("password reset", "reset.ts");

    const tick = await runner().tick();

    // toMatchObject, not toEqual: every landing now also carries the notice for the
    // checkout that holds the base, which `land-chore-brings-the-checkout-forward` is about.
    expect(tick.landed).toMatchObject([{ story: s.id, sha: git(repo, "rev-parse", "main") }]);
    expect(subjects("main")[0]).toBe(`land story/${s.slug}`);
    expect(git(repo, "ls-tree", "--name-only", "main")).toContain("reset.ts");
    expect(await isLanded(repo, "main", `story/${s.slug}`)).toBe(true);
  });

  it("raises no chore for a landing it made itself", async () => {
    const s = story("password reset", "reset.ts");

    const tick = await runner().tick();

    expect(tick.chores).toEqual([]);
    expect(choreFor(db, "land", "story", s.id)).toBeNull();
    expect(board(db).chores).toEqual([]);
  });

  it("lands it once: the tick after reads it as already there", async () => {
    const s = story("password reset", "reset.ts");
    const first = await runner().tick();
    const tip = git(repo, "rev-parse", "main");

    const second = await runner().tick();

    expect(first.landed).toHaveLength(1);
    expect(second.landed).toEqual([]);
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(subjects("main").filter((s2) => s2 === `land story/${s.slug}`)).toHaveLength(1);
  });
});

describe("a story the landing is not owed for", () => {
  it("is not landed while it is still in progress", async () => {
    const s = story("password reset", "reset.ts", "in_progress");

    const tick = await runner().tick();

    expect(tick.landed).toEqual([]);
    expect(choreFor(db, "land", "story", s.id)).toBeNull();
    expect(await isLanded(repo, "main", `story/${s.slug}`)).toBe(false);
  });

  it("owes a merge chore rather than a land chore when its branch will not merge", async () => {
    const s = story("password reset", "README.md");
    moveTheBase("the base's line\n");

    const tick = await runner().tick();

    // The two are about opposite merges and only one of them is owed: until the base is in
    // the branch there is nothing a landing could put in the base.
    expect(tick.landed).toEqual([]);
    expect(choreFor(db, "land", "story", s.id)).toBeNull();
    expect(tick.chores).toEqual([choreFor(db, "merge", "story", s.id)?.id]);
  });

  it("is not landed while nothing under it ever passed, however delivered it is called", async () => {
    // The invariant is that wecode performs the merges the gate has already permitted. A
    // story whose acceptance test never passed has not been permitted by anything except
    // the row that says `delivered`.
    const s = story("password reset", "reset.ts", "delivered", "ready");

    const tick = await runner().tick();

    expect(tick.landed).toEqual([]);
    expect(choreFor(db, "land", "story", s.id)).toBeNull();
    expect(await isLanded(repo, "main", `story/${s.slug}`)).toBe(false);
  });

  it("is not landed on the tick that delivered it, so no pass is judged against a base that moved", async () => {
    // A story the tick itself finishes: its acceptance test is red at base — reset.ts is
    // only on the branch — and green in the story tree, so the pass proves it, the cascade
    // delivers the story, and the landing is the *next* tick's. Everything a tick reads is
    // read against one base: the run at base, the story trees, and every chore's check.
    const s = story("password reset", "reset.ts", "in_progress", "ready");
    db.prepare("UPDATE acceptance_test SET artefact = 'test -f reset.ts' WHERE id = ?").run(s.test);
    db.prepare("UPDATE requirement SET state = 'in_progress' WHERE story_id = ?").run(s.id);
    db.prepare("UPDATE acceptance_criteria SET state = 'in_progress' WHERE id IN (SELECT parent_id FROM acceptance_test WHERE id = ?)").run(s.test);
    const task = make.task(s.test, "do the work", { role: "engineer", scope: { write: ["reset.ts"], tools: [] } });
    db.prepare("UPDATE task SET state = 'done' WHERE id = ?").run(task);
    const tip = git(repo, "rev-parse", "main");

    const first = await runner().tick();
    expect(first.scripts.passed).toContain(s.test);
    expect((db.prepare("SELECT state FROM story WHERE id = ?").get(s.id) as { state: string }).state).toBe("delivered");
    expect(first.landed).toEqual([]);
    expect(git(repo, "rev-parse", "main")).toBe(tip);

    const second = await runner().tick();
    expect(second.landed).toMatchObject([{ story: s.id, sha: git(repo, "rev-parse", "main") }]);
  });

  it("has no branch at all, so there is nothing to land and nothing to say", async () => {
    const id = make.story(epic, "never started");
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

    const tick = await runner().tick();

    expect(tick.landed).toEqual([]);
    expect(tick.chores).toEqual([]);
  });
});

describe("a landing that conflicts", () => {
  it("is refused with the reason, leaves no merge in progress, and does not move the base", async () => {
    const s = story("password reset", "README.md");
    moveTheBase("the base's line\n");
    const tip = git(repo, "rev-parse", "main");

    const attempt = await attemptLanding({
      repo,
      base: "main",
      branch: `story/${s.slug}`,
      tree: landTree(s.slug),
    });

    expect(attempt.kind).toBe("refused");
    expect(attempt.kind === "refused" && attempt.why).toContain("conflicted in: README.md");
    expect(attempt.kind === "refused" && attempt.why).toContain("no merge is left standing");
    // The base is where it was, the tree the merge was tried in is gone, and nothing is
    // left mid-merge for the next tick or a person to find.
    expect(git(repo, "rev-parse", "main")).toBe(tip);
    expect(existsSync(landTree(s.slug))).toBe(false);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(checkouts()).toEqual([repo]);
  });
});

/** Blocks the one thing the landing needs and cannot make for itself: a tree to merge in.
 *  A file where the worktree goes is the cheapest refusal that is not a conflict — the
 *  branches still merge, so the story is owed a landing on every tick, and what the chore
 *  records is that wecode tried and could not. */
function blockTheTree(slug: string): void {
  mkdirSync(join(repo, ".wecode", "worktrees"), { recursive: true });
  writeFileSync(landTree(slug), "not a worktree\n");
}

describe("a land chore, raised on the refusal", () => {
  it("is on the board, as itself, with its kind, its target and the reason", async () => {
    const s = story("password reset", "reset.ts");
    blockTheTree(s.slug);

    const tick = await runner().tick();

    const chore = choreFor(db, "land", "story", s.id);
    expect(chore).toMatchObject({
      kind: "land",
      project_id: project,
      target_type: "story",
      target_id: s.id,
      check: LAND_CHECK,
      state: "failed",
    });
    expect(tick.chores).toEqual([chore?.id]);
    expect(choreRefusal(db, chore?.id as number)?.why).toContain("no tree to merge in");
    expect(board(db).chores).toEqual([
      {
        id: chore?.id,
        what: "land story password reset",
        state: "failed",
        detail: `attempt 2 of 3 · ${LAND_CHECK}`,
      },
    ]);
    expect(git(repo, "rev-parse", "main")).toBe(git(repo, "merge-base", "main", `story/${s.slug}`));
  });

  it("is re-raised with the reason on every tick the condition is still true", async () => {
    const s = story("password reset", "reset.ts");
    blockTheTree(s.slug);

    await runner().tick();
    const tick = await runner().tick();

    const chore = choreFor(db, "land", "story", s.id);
    expect(tick.chores).toEqual([chore?.id]);
    // One row, two attempts: reraising keeps the count, which is the point of reraising
    // rather than deleting the row and letting the next tick insert a fresh one.
    expect((db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n).toBe(1);
    expect(choreAttempts(db, chore?.id as number)).toEqual({ attempts: 2, max_retry: 3 });
  });

  it("is performed and finished once the landing can be made, and only then", async () => {
    const s = story("password reset", "reset.ts");
    blockTheTree(s.slug);
    await runner().tick();
    expect(choreFor(db, "land", "story", s.id)?.state).toBe("failed");

    rmSync(landTree(s.slug));
    const tick = await runner().tick();

    expect(tick.landed).toMatchObject([{ story: s.id, sha: git(repo, "rev-parse", "main") }]);
    // `done` by `finish`, not by `close`: a worker — the runner itself — made the merge and
    // the graph proved it. The board counts it as work carried out.
    expect(choreFor(db, "land", "story", s.id)?.state).toBe("done");
    expect(board(db).settled).toEqual([
      { id: choreFor(db, "land", "story", s.id)?.id, what: "land story password reset", state: "done", detail: LAND_CHECK },
    ]);
    expect(tick.chores).toEqual([]);
  });

  it("stops being attempted once it has used its attempts, and says so", async () => {
    const s = story("password reset", "reset.ts");
    blockTheTree(s.slug);

    for (let i = 0; i < 4; i++) await runner().tick();

    const chore = choreFor(db, "land", "story", s.id);
    expect(choreAttempts(db, chore?.id as number)).toEqual({ attempts: 3, max_retry: 3 });
    expect(board(db).chores).toEqual([
      {
        id: chore?.id,
        what: "land story password reset",
        state: "failed",
        detail: `out of attempts · 3 of 3 · ${LAND_CHECK}`,
      },
    ]);
  });

  it("is closed, rather than left as a stale claim, when the story reaches the base anyway", async () => {
    const s = story("password reset", "reset.ts");
    blockTheTree(s.slug);
    await runner().tick();

    // A person landed it themselves, in their own checkout, which is still allowed.
    rmSync(landTree(s.slug));
    git(repo, "merge", "--no-ff", "-q", "-m", `land story/${s.slug}`, `story/${s.slug}`);
    const tick = await runner().tick();

    const chore = choreFor(db, "land", "story", s.id);
    expect(chore?.state).toBe("done");
    expect(choreRefusal(db, chore?.id as number)?.why).toBe(`main already contains story/${s.slug}`);
    expect(tick.landed).toEqual([]);
    expect(tick.chores).toEqual([]);
  });
});

describe("the landing is the runner's own work", () => {
  it("is never handed to a worker, however free the system worker is", async () => {
    const s = story("password reset", "reset.ts");
    const other = story("session timeout", "README.md");
    moveTheBase("the base's line\n");
    blockTheTree(s.slug);
    make.worker("system-1", "system", "agent");

    const tick = await runner().tick();

    const land = choreFor(db, "land", "story", s.id);
    expect(land).not.toBeNull();
    // No assignment, so no story tree was cut for a merge that cannot be made in one.
    expect(db.prepare("SELECT count(*) AS n FROM assignment").get()).toEqual({ n: 0 });
    expect(tick.performed.dispatched).toEqual([]);
    // Nor is it offered: a chore nobody may take must not sit in the allocator's order, and
    // being refused there instead would write over the reason it is actually carrying.
    const offered = choreCandidates(db, SYSTEM_ROLES);
    expect(offered.candidates.map((c) => c.id)).toEqual([choreFor(db, "merge", "story", other.id)?.id]);
    expect(offered.refused.map((r) => r.id)).not.toContain(land?.id);
    expect(choreRefusal(db, land?.id as number)?.why).toContain("no tree to merge in");
  });
});
