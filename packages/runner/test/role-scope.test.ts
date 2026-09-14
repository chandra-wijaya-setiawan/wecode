import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { choreFor, choreRefusal, Maker, open } from "@wecode/core";
import { DEFAULT_BUDGET, Runner } from "../src/index.js";
import type { Observation, Work, WorkerAdapter } from "../src/index.js";

/** A chore's scope comes out of config/roles.yaml, which is the file its refusal names.
 *
 *  The complaint this answers: the scope was read from a `role` table nothing ever fills,
 *  so every chore in every workspace refused with "no scope for role system" while
 *  config/roles.yaml gave system `write: **`. */

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

/** The project's own roles file. `roles` is what each test varies; the rest is the shape
 *  loadRoles insists on. */
function rolesFile(roles: string): void {
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(
    join(repo, "config", "roles.yaml"),
    ["invariants:", "  never_touch: []", "  never_run: []", "roles:", roles, ""].join("\n"),
  );
}

const THE_SYSTEM_ROLE = [
  "  system:",
  "    worker_kind: agent",
  "    scope:",
  '      write: ["**"]',
  '      tools: ["bash", "read", "edit", "write"]',
].join("\n");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "wecode-role-scope-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  const ws = make.workspace("acme", repo);
  epic = make.epic(make.release(make.project(ws, "storefront", repo), "1.0.0"), "recovery");
  make.worker("system-1", "system", "agent");
});

/** A delivered story whose branch will not merge: the condition that raises a merge chore. */
function anUnmergeableStory(title = "password reset"): { id: number; slug: string } {
  const id = make.story(epic, title);
  const slug = (db.prepare("SELECT slug FROM story WHERE id = ?").get(id) as { slug: string }).slug;
  db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(id);

  const tree = join(repo, `.tree-${slug}`);
  git(repo, "branch", `story/${slug}`, "main");
  git(repo, "worktree", "add", "-q", tree, `story/${slug}`);
  writeFileSync(join(tree, "README.md"), `the story's line for ${title}\n`);
  git(tree, "add", "-A");
  git(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", title);
  git(repo, "worktree", "remove", "--force", tree);

  writeFileSync(join(repo, "README.md"), `the base's line against ${title}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "the base moved");
  return { id, slug };
}

const whyOf = (story: number): string | undefined => {
  const chore = choreFor(db, "merge", "story", story);
  return chore === null ? undefined : (choreRefusal(db, chore.id)?.why ?? undefined);
};

describe("a chore's scope", () => {
  it("comes out of config/roles.yaml, so a chore whose role is there is dispatched", async () => {
    rolesFile(THE_SYSTEM_ROLE);
    const story = anUnmergeableStory();

    const tick = await runner().tick();

    const chore = choreFor(db, "merge", "story", story.id);
    expect(chore).not.toBeNull();
    expect(tick.performed.dispatched).toEqual([chore?.id]);
    expect(whyOf(story.id)).toBeUndefined();
    // The scope on the assignment is the file's, not a literal.
    const row = db
      .prepare("SELECT scope FROM assignment WHERE objective_type = 'chore' AND objective_id = ?")
      .get(chore?.id as number) as { scope: string };
    expect(JSON.parse(row.scope)).toEqual({ write: ["**"], tools: ["bash", "read", "edit", "write"] });
  });

  it("is read once per repository per tick, however many chores want it", async () => {
    rolesFile(THE_SYSTEM_ROLE);
    const first = anUnmergeableStory("password reset");
    const second = anUnmergeableStory("session expiry");
    const runnerUnder = runner();
    const cache = (runnerUnder as unknown as { rolesByRepo: Map<string, unknown> }).rolesByRepo;

    await runnerUnder.tick();

    expect(choreFor(db, "merge", "story", first.id)).not.toBeNull();
    expect(choreFor(db, "merge", "story", second.id)).not.toBeNull();
    // Two chores in one repository, one entry: the second chore read the first one's.
    expect(cache.size).toBe(1);
  });

  it("is re-read on the next tick, so an edit to the file is in force", async () => {
    const story = anUnmergeableStory();
    const runnerUnder = runner();

    await runnerUnder.tick();
    expect(whyOf(story.id)).toMatch(/^cannot read config\/roles\.yaml: /);

    // The operator writes the file the refusal named.
    rolesFile(THE_SYSTEM_ROLE);
    await runnerUnder.tick();

    expect(whyOf(story.id)).toBeUndefined();
  });

  it("refuses by naming the role and the file when the config has no such role", async () => {
    // A file that is there and well formed, and simply does not declare `system`.
    rolesFile(
      ["  engineer:", "    worker_kind: agent", "    scope:", '      write: ["src/**"]', '      tools: ["read"]'].join(
        "\n",
      ),
    );
    const story = anUnmergeableStory();

    await runner().tick();

    expect(whyOf(story.id)).toBe("no role system in config/roles.yaml");
  });

  it("says the file could not be read, rather than blaming the role, when it is missing", async () => {
    const story = anUnmergeableStory();

    await runner().tick();

    expect(whyOf(story.id)).toMatch(/^cannot read config\/roles\.yaml: /);
  });
});
