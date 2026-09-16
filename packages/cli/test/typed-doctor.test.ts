import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { Maker, REACHED_INSIDE_ANOTHER_MERGE, checkRecord, open, type RecordNode } from "@wecode/core";
import { WORLD_CHECK, doctor, healLandedMarkers, snapshot, type Git } from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

const source = readFileSync(fileURLToPath(new URL("../src/doctor.ts", import.meta.url)), "utf8");

let repo: string;
let db: DatabaseSync;
let make: Maker;
let project: number;
let epic: number;

const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const gitIn =
  (cwd: string): Git =>
  (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd, encoding: "utf8" });

beforeEach(() => {
  repo = tmp("wecode-typed-doctor-");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  writeFileSync(join(repo, "README.md"), "the base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  db = open(join(repo, "wecode.db"));
  make = new Maker(db);
  project = make.project(make.workspace("acme", repo), "storefront", repo);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** A story with a requirement, a criteria, an acceptance_test and a task under it: the whole
 *  chain the doctor's join used to walk. */
function storyWithTask(title: string): { story: number; task: number } {
  const story = make.story(epic, title);
  const criteria = make.criteria(make.requirement(story, `${title} works`), `${title} is accepted`);
  const at = make.acceptanceTest(criteria, `${title} passes`, "manual");
  return { story, task: make.task(at, `build ${title}`, { role: "engineer" }) };
}

/** The lander's own table, beside the record the way the runner creates it. */
const recordLanded = (task: number, branch: string, sha: string): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id INTEGER PRIMARY KEY, branch TEXT NOT NULL, sha TEXT NOT NULL, merged_at TEXT NOT NULL)`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?,?,?,?)").run(
    task,
    branch,
    sha,
    "2026-09-14T00:00:00.000Z",
  );
};

/** Nodes are picked out by entity and slug, never by id: two tables' ids coincide in any
 *  linear fixture, and a test that indexed by id would pass against a chain joined wrongly. */
const node = (entity: string, slug: string): RecordNode => {
  const found = snapshot(db).nodes.filter((n) => n.entity === entity && n.slug === slug);
  expect(found, `${entity} ${slug}`).toHaveLength(1);
  return found[0] as RecordNode;
};

describe("the doctor module, ported onto the typed layer", () => {
  /** The point of the port. One `db.prepare` left behind is a query the compiler does not
   *  check, and one is enough to lose the guarantee — so this is spelled as "none", against
   *  the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
  });

  it("leaves no query text either — the only SQL left is the one table it has to create", () => {
    // The comments still talk about the joins and the ORDER BY that are gone, which is what
    // they are for; it is the code that must have no SQL left in it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code.match(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|JOIN|GROUP BY|ORDER BY|LIMIT|BEGIN|COMMIT)\b/g)).toBeNull();
    // DDL is the exception, and it is one statement: the dialect compiles queries and has no
    // vocabulary for schema, so a table that must exist before it can be written to is
    // created in SQL. Nothing about it is a query, and nothing in it is a value.
    expect(source.match(/CREATE TABLE/g)).toEqual(["CREATE TABLE"]);
    expect(source).not.toMatch(/\bdb\.(prepare|get|all|run)\b/);
    expect(source.match(/\bdb\.exec\b/g)).toEqual(["db.exec"]);
  });

  it("speaks to the database through the dialect, and transacts through core", () => {
    expect(source).toContain('from "@wecode/core/dist/db.js"');
    // The write half is one transaction still, and now it is core's — so the heal nests
    // inside whatever transaction its caller already holds instead of opening a second.
    expect(source).toContain("transact(db, () =>");
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migrations cannot drift apart without a test saying
   *  so — and the list lives in one place, the module, not in a copy here. */
  it("asks only for columns the migrations actually built", () => {
    const declared = [...source.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1] as string,
      columns: [...(m[2] as string).matchAll(/"(\w+)"/g)].map((c) => c[1] as string),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "epic",
      "landed_branch",
      "ledger",
      "project",
      "release",
      "requirement",
      "schema_version",
      "sqlite_master",
      "story",
      "task",
      "task_test",
      "worker",
    ]);
    // `landed_branch` is the lander's, created on first land, and `sqlite_master` is sqlite's
    // own: neither is in the migrations, and the first is what this module creates.
    for (const d of declared.filter((x) => x.name !== "sqlite_master" && x.name !== "landed_branch")) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as unknown as { name: string }[]).map(
        (c) => c.name,
      );
      expect(d.columns.length).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });
});

describe("the snapshot, through the layer", () => {
  it("flattens each table's own foreign key onto parent_id", () => {
    const { story, task } = storyWithTask("password reset");

    expect(node("epic", "recovery").parent_id).toBe(node("release", "1-0-0").id);
    expect(node("story", "password-reset").parent_id).toBe(epic);
    expect(node("requirement", "password-reset-works").parent_id).toBe(story);
    expect(node("acceptance_criteria", "password-reset-is-accepted").parent_id).toBe(
      node("requirement", "password-reset-works").id,
    );
    expect(node("acceptance_test", "password-reset-passes").parent_id).toBe(
      node("acceptance_criteria", "password-reset-is-accepted").id,
    );
    expect(node("task", "build-password-reset").parent_id).toBe(node("acceptance_test", "password-reset-passes").id);
    expect(node("task", "build-password-reset").id).toBe(task);
  });

  it("roots a release at nothing — its project is not an entity any invariant checks", () => {
    expect(node("release", "1-0-0").parent_id).toBeNull();
  });

  it("carries the two columns only one entity has", () => {
    const { task } = storyWithTask("password reset");
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = ? WHERE id = ?").run(
      "base0000",
      node("acceptance_test", "password-reset-passes").id,
    );

    expect(node("acceptance_test", "password-reset-passes").red_at_base_sha).toBe("base0000");
    expect(node("task", "build-password-reset").role).toBe("engineer");
    expect(node("task", "build-password-reset").id).toBe(task);
  });

  it("comes back in id order per entity, however the rows arrive", () => {
    for (const title of ["c", "a", "b"]) storyWithTask(title);
    // Touching a row does not move it: the order is applied, not inherited from the table.
    db.prepare("UPDATE story SET title = title WHERE slug = 'c'").run();

    const stories = snapshot(db).nodes.filter((n) => n.entity === "story");
    expect(stories.map((s) => s.id)).toEqual([...stories.map((s) => s.id)].sort((a, b) => a - b));
    expect(stories.map((s) => s.slug)).toEqual(["c", "a", "b"]);
  });

  it("reads landed_sha onto the story the task actually hangs under", () => {
    // Two criteria under the first story, so the second story's ids stop coinciding with its
    // task's: task #3 belongs to story #2, and any shortcut through the ids gets it wrong.
    const first = storyWithTask("password reset");
    const second = make.criteria(make.requirement(first.story, "it also logs"), "the reset is logged");
    make.task(make.acceptanceTest(second, "the log line is written", "manual"), "write the log line");
    const other = storyWithTask("magic link");
    expect(other.task).not.toBe(other.story);

    recordLanded(other.task, "story/magic-link", "abc123");

    expect(node("story", "magic-link").landed_sha).toBe("abc123");
    expect(node("story", "password-reset").landed_sha).toBeNull();
  });

  it("says no story landed when the lander has never made its table", () => {
    storyWithTask("password reset");

    expect(node("story", "password-reset").landed_sha).toBeNull();
    // And that is not drift: a record with nothing observed against it still holds.
    expect(checkRecord(snapshot(db))).toEqual([]);
  });

  it("drops a marker whose task is gone, the way the join dropped the row", () => {
    const { task } = storyWithTask("password reset");
    recordLanded(task, "story/password-reset", "abc123");
    db.prepare("DELETE FROM task WHERE id = ?").run(task);

    expect(node("story", "password-reset").landed_sha).toBeNull();
  });

  it("carries the workers, in id order and by slug and role alone", () => {
    make.worker("claude-2", "engineer", "agent");
    make.worker("claude-1", "reviewer", "agent");

    expect(snapshot(db).workers).toEqual([
      { slug: "claude-2", role: "engineer" },
      { slug: "claude-1", role: "reviewer" },
    ]);
  });

  it("reads the version the record says it is at", () => {
    const version = (db.prepare("SELECT version FROM schema_version").get() as unknown as { version: number }).version;

    expect(snapshot(db).schema_version).toBe(version);
    expect(version).toBeGreaterThan(0);
  });
});

describe("the heal's writes, through the layer", () => {
  const delivered = (title: string): { story: number; task: number } => {
    const made = storyWithTask(title);
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(made.story);
    return made;
  };

  const heals = (): { entity_id: number; from_state: string; to_state: string; actor: string }[] =>
    db
      .prepare("SELECT entity_id, from_state, to_state, actor FROM ledger WHERE verb = 'heal' ORDER BY id")
      .all() as unknown as { entity_id: number; from_state: string; to_state: string; actor: string }[];

  const landCommit = (slug: string, file: string): string => {
    writeFileSync(join(repo, file), `${file}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", `land story/${slug}`);
    return git("rev-parse", "HEAD");
  };

  const markers = (): unknown[] =>
    db.prepare("SELECT task_id, branch, sha FROM landed_branch ORDER BY task_id").all() as unknown as unknown[];

  it("writes a marker for every task under the story, found through the chain", () => {
    const { story, task } = delivered("password reset");
    const second = make.task(
      make.acceptanceTest(make.criteria(make.requirement(story, "it logs"), "logged"), "logs", "manual"),
      "log it",
    );
    // A task under a different story is not this story's to mark, and its ids are next in
    // line — the chain, not the numbering, is what decides.
    const other = storyWithTask("magic link");
    const sha = landCommit("password-reset", "reset.txt");

    const report = healLandedMarkers(db, checkRecord(snapshot(db)), gitIn(repo));

    expect(report.written).toEqual([{ story, slug: "password-reset", sha }]);
    expect(markers()).toEqual([
      { task_id: task, branch: "story/password-reset", sha },
      { task_id: second, branch: "story/password-reset", sha },
    ]);
    expect(markers().length).toBe(2);
    expect(other.task).toBeGreaterThan(second);
    expect(node("story", "password-reset").landed_sha).toBe(sha);
  });

  /** The upsert, which the record cannot reach on its own: a marker already there is a story
   *  the check does not report, so the heal never sees it. The violations are this function's
   *  argument, by design — so the branch is reached the way a concurrent lander would reach
   *  it, by handing it a drift the record has since stopped having. */
  it("writes over a marker that is already there rather than failing on it", () => {
    const { story, task } = delivered("password reset");
    recordLanded(task, "story/stale", "stale000");
    const sha = landCommit("password-reset", "reset.txt");

    const report = healLandedMarkers(
      db,
      [{ invariant: WORLD_CHECK, entity: "story", id: story, slug: "password-reset", detail: "no landed marker" }],
      gitIn(repo),
    );

    expect(report.written).toEqual([{ story, slug: "password-reset", sha }]);
    expect(markers()).toEqual([{ task_id: task, branch: "story/password-reset", sha }]);
  });

  it("refuses a story with no task to carry the marker, reading the chain to find out", () => {
    const story = make.story(epic, "password reset");
    make.requirement(story, "it works");
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = ?").run(story);
    landCommit("password-reset", "reset.txt");

    const report = healLandedMarkers(db, checkRecord(snapshot(db)), gitIn(repo));

    expect(report.written).toEqual([]);
    expect(report.left).toEqual([{ story, slug: "password-reset", why: "no task under the story to carry the marker" }]);
    expect(heals()).toEqual([]);
  });

  it("says once, in the ledger, that a story reached the base inside another merge", () => {
    const { story } = delivered("password reset");
    // In the base with no commit of its own to name: the branch is HEAD, and no commit in
    // HEAD has the land subject.
    git("branch", "story/password-reset");

    const first = healLandedMarkers(db, checkRecord(snapshot(db)), gitIn(repo));
    const again = healLandedMarkers(db, checkRecord(snapshot(db)), gitIn(repo));

    expect(first.reached).toEqual([{ story, slug: "password-reset" }]);
    expect(again.reached).toEqual([{ story, slug: "password-reset" }]);
    // The ledger line is the fact, and the fact was already recorded: said twice it would
    // read as two healings of one story.
    expect(heals()).toEqual([
      {
        entity_id: story,
        from_state: "no landed marker",
        to_state: REACHED_INSIDE_ANOTHER_MERGE,
        actor: "doctor",
      },
    ]);
  });

  it("asks the repository the first project names, and not a later one", () => {
    const { story } = delivered("password reset");
    const sha = landCommit("password-reset", "reset.txt");
    // A second project, naming a path no git could be run in. Read instead of the first, the
    // heal below would die of it rather than write the marker.
    const later = make.project(make.workspace("other", "/nowhere-at-all"), "sidecar", "/nowhere-at-all");
    expect(later).toBeGreaterThan(project);
    db.close();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(doctor([join(repo, "wecode.db"), "--heal"])).toBe(0);

    db = open(join(repo, "wecode.db"));
    expect(node("story", "password-reset").landed_sha).toBe(sha);
    expect(story).toBeGreaterThan(0);
  });
});
