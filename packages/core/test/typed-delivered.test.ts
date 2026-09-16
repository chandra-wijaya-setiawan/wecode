import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { delivered, deliveredRows } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const core = readFileSync(fileURLToPath(new URL("../src/delivered.ts", import.meta.url)), "utf8");
const cli = readFileSync(fileURLToPath(new URL("../../cli/src/delivered.ts", import.meta.url)), "utf8");

const T = "2026-09-13T00:00:00.000Z";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

const ins = (sql: string, ...args: (string | number | null)[]): number => {
  db.prepare(sql).run(...args);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

/** A delivered story under the seed's epic, with a requirement of its own so criteria can
 *  hang off it without touching the seed's. */
const story = (slug: string, at: string, state = "delivered"): { id: number; requirement: number } => {
  const id = ins(
    "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    tree.epic,
    slug,
    state,
    T,
    at,
  );
  const requirement = ins(
    "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    `${slug}-req`,
    id,
    `${slug} works`,
    "in_progress",
    T,
    at,
  );
  return { id, requirement };
};

const criteria = (requirement: number, slug: string, statement: string, state = "accepted"): number =>
  ins(
    "INSERT INTO acceptance_criteria (slug,requirement_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    slug,
    requirement,
    statement,
    state,
    T,
    T,
  );

/** The runner's table, created the way the runner creates it: beside the record, on the
 *  first landing. Nothing in the migrations builds it. */
const land = (branch: string, sha: string, taskId = 1): void => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS landed_branch (
       task_id   INTEGER PRIMARY KEY,
       branch    TEXT NOT NULL,
       sha       TEXT NOT NULL,
       merged_at TEXT NOT NULL
     )`,
  );
  db.prepare("INSERT INTO landed_branch (task_id, branch, sha, merged_at) VALUES (?,?,?,?)").run(
    taskId,
    branch,
    sha,
    T,
  );
};

const openChore = (storyId: number, kind: string, state = "open"): number =>
  ins(
    `INSERT INTO chore (slug,kind,project_id,target_type,target_id,"check",state,created_at,updated_at)
     VALUES (?,?,?,'story',?,'x',?,?,?)`,
    `${kind}-${storyId}-${state}`,
    kind,
    tree.project,
    storyId,
    state,
    T,
    T,
  );

const refuse = (choreId: number, why: string): void => {
  db.prepare("INSERT INTO chore_refusal (chore_id,why,at,since,passes) VALUES (?,?,?,?,1)").run(choreId, why, T, T);
};

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("the delivered module, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in either module", () => {
    for (const [name, source] of [
      ["core", core],
      ["cli", cli],
    ] as const) {
      expect(source, name).not.toMatch(/\bprepare\s*\(/);
      expect(
        source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g),
        name,
      ).toBeNull();
    }
  });

  it("speaks to the database only through the dialect", () => {
    // `DatabaseSync` is still the currency every caller passes, but it arrives as a type
    // and is handed on; nothing in core calls a query method on it.
    expect(core).toContain('import { queries, table } from "./db.js"');
    expect(core).not.toMatch(/\bdb\.(prepare|get|all|run)\b/);
    expect(cli).not.toMatch(/\bdb\.(prepare|get|all|run)\b/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migration cannot drift apart without a test saying
   *  so — and the list lives in one place, the module, not in a copy here.
   *
   *  `landed_branch` is not in that check: the runner builds it, no migration does, so the
   *  fixture that lands a branch is what holds its shape. */
  it("asks only for columns the migrations, or SQLite itself, actually built", () => {
    const declared = [...`${core}\n${cli}`.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1],
      columns: [...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "acceptance_criteria",
      "chore",
      "chore_refusal",
      "epic",
      "landed_branch",
      "project",
      "release",
      "requirement",
      "sqlite_master",
      "story",
    ]);

    land("story/shape", "aaaa1111");
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(d.columns.length, d.name).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });

  /** The declarations must stay unexported: `index.ts` re-exports this module whole, and
   *  `story`, `chore`, `epic` and the rest are words other modules already own. */
  it("keeps its table declarations to itself", () => {
    expect(core).not.toMatch(/export\s+const\s+\w+\s*=\s*table</);
  });
});

describe("the delivered list, through the layer", () => {
  it("lists a delivered story with the statements of its accepted criteria, in tree order", () => {
    const done = story("reset-link", "2026-09-14T00:00:00.000Z");
    criteria(done.requirement, "emailed", "a link is emailed within 60s");
    criteria(done.requirement, "expires", "the link expires after one use");

    const row = delivered(db).find((r) => r.id === done.id);
    expect(row?.criteria.map((c) => c.statement)).toEqual([
      "a link is emailed within 60s",
      "the link expires after one use",
    ]);
    expect(row?.criteria.map((c) => c.slug)).toEqual(["emailed", "expires"]);
  });

  /** The order the two joins used to impose: by requirement, then by criteria. Written
   *  here with the second requirement's criteria inserted first, so a list that merely
   *  came back in insertion order fails. */
  it("orders criteria by requirement before id, however the rows were written", () => {
    const done = story("two-reqs", "2026-09-14T00:00:00.000Z");
    const second = ins(
      "INSERT INTO requirement (slug,story_id,statement,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "later-req",
      done.id,
      "also works",
      "in_progress",
      T,
      T,
    );
    criteria(second, "b", "second requirement's criteria");
    criteria(done.requirement, "a", "first requirement's criteria");

    expect(delivered(db).find((r) => r.id === done.id)?.criteria.map((c) => c.statement)).toEqual([
      "first requirement's criteria",
      "second requirement's criteria",
    ]);
  });

  it("leaves out criteria that were dropped rather than accepted", () => {
    const done = story("reset-link", "2026-09-14T00:00:00.000Z");
    criteria(done.requirement, "emailed", "a link is emailed within 60s");
    criteria(done.requirement, "sms", "a code is sent by SMS", "dropped");

    expect(delivered(db).find((r) => r.id === done.id)?.criteria.map((c) => c.slug)).toEqual(["emailed"]);
  });

  it("does not list a story that is not delivered", () => {
    const open = story("in-flight", "2026-09-14T00:00:00.000Z", "in_progress");
    criteria(open.requirement, "half", "half of it works");

    const ids = delivered(db).map((r) => r.id);
    expect(ids).not.toContain(open.id);
    // the seed's own story is in_progress too, and is the reason this is not vacuous
    expect(ids).not.toContain(tree.story);
  });

  it("puts the newest delivery first, and breaks a shared stamp by descending id", () => {
    const older = story("older", "2026-09-10T00:00:00.000Z");
    const newer = story("newer", "2026-09-14T00:00:00.000Z");
    const sameA = story("same-a", "2026-09-12T00:00:00.000Z");
    const sameB = story("same-b", "2026-09-12T00:00:00.000Z");

    expect(delivered(db).map((r) => r.id)).toEqual([newer.id, sameB.id, sameA.id, older.id]);
  });

  it("carries the story's own updated_at as the delivery stamp", () => {
    const done = story("stamped", "2026-09-14T09:08:07.000Z");

    expect(delivered(db).find((r) => r.id === done.id)?.delivered_at).toBe("2026-09-14T09:08:07.000Z");
  });
});

describe("the project filter, now a walk up rather than two joins", () => {
  /** A second project, with a release, epic and delivered story of its own. */
  const elsewhere = (): { project: number; story: number } => {
    const p = ins(
      "INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      "other",
      tree.ws,
      "other",
      "/other",
      "in_progress",
      T,
      T,
    );
    const rel = ins(
      "INSERT INTO release (slug,project_id,version,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "v1",
      p,
      "1.0",
      "in_progress",
      T,
      T,
    );
    const e = ins(
      "INSERT INTO epic (slug,release_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "other-epic",
      rel,
      "other epic",
      "in_progress",
      T,
      T,
    );
    const s = ins(
      "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      "other-story",
      e,
      "other story",
      "delivered",
      T,
      "2026-09-14T00:00:00.000Z",
    );
    return { project: p, story: s };
  };

  it("keeps only the asked-for project's stories, and every project's when asked for none", () => {
    const mine = story("mine", "2026-09-14T00:00:00.000Z");
    const other = elsewhere();

    expect(delivered(db, tree.project).map((r) => r.id)).toEqual([mine.id]);
    expect(delivered(db, other.project).map((r) => r.id)).toEqual([other.story]);
    expect(delivered(db, null).map((r) => r.id).sort()).toEqual([mine.id, other.story].sort());
  });

  /** The walk up yields undefined for a story whose epic or release is missing, and that
   *  story is left out — which is what the inner join it replaced did with it. No fixture
   *  can reach that branch, and this is why: the record itself refuses the row. So the
   *  branch is the port's honest reading of a `JOIN`, not dead weight that changed a
   *  behaviour nobody could see. */
  it("cannot be shown a story whose epic is gone, because the record refuses one", () => {
    expect(() =>
      ins(
        "INSERT INTO story (slug,epic_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        "orphan",
        9999,
        "orphan",
        "delivered",
        T,
        "2026-09-14T00:00:00.000Z",
      ),
    ).toThrow(/FOREIGN KEY/i);
    expect(delivered(db, null).map((r) => r.slug)).not.toContain("orphan");
  });
});

describe("landing, through the layer", () => {
  it("reads the sha from landed_branch, and says unlanded when the branch is not there", () => {
    const on = story("on-base", "2026-09-14T00:00:00.000Z");
    const off = story("not-yet", "2026-09-13T00:00:00.000Z");
    land("story/on-base", "abc1234");

    const out = delivered(db);
    expect(out.find((r) => r.id === on.id)).toMatchObject({
      landed: true,
      sha: "abc1234",
      branch: "story/on-base",
      reach: "landed",
    });
    expect(out.find((r) => r.id === off.id)).toMatchObject({ landed: false, sha: null, reach: "unlanded" });
    expect(deliveredRows(db).find((r) => r.id === off.id)?.detail).toContain("unlanded");
  });

  it("reads unlanded in a workspace where the runner never built the table", () => {
    const done = story("reset-link", "2026-09-14T00:00:00.000Z");

    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'landed_branch'").get()).toBeUndefined();
    expect(delivered(db).find((r) => r.id === done.id)).toMatchObject({ landed: false, sha: null });
  });
});

describe("the reach of a delivered story, through the layer", () => {
  it("reads behind the base from an open refresh chore, with the chore's own sentence", () => {
    const done = story("behind", "2026-09-14T00:00:00.000Z");
    refuse(openChore(done.id, "refresh"), "the base moved under it");

    expect(delivered(db).find((r) => r.id === done.id)).toMatchObject({
      reach: "behind",
      owed: "refresh",
      why: "the base moved under it",
    });
    expect(deliveredRows(db).find((r) => r.id === done.id)?.detail).toContain("the base moved under it");
  });

  it("reads waiting on any other open chore, and names its kind", () => {
    const done = story("waiting", "2026-09-14T00:00:00.000Z");
    openChore(done.id, "merge");

    expect(delivered(db).find((r) => r.id === done.id)).toMatchObject({ reach: "waiting", owed: "merge", why: null });
  });

  it("prefers the refresh chore over any other open chore", () => {
    const done = story("both", "2026-09-14T00:00:00.000Z");
    openChore(done.id, "merge");
    openChore(done.id, "refresh");

    expect(delivered(db).find((r) => r.id === done.id)?.owed).toBe("refresh");
  });

  /** `reasonOf` walks the chores of the owed kind oldest first and takes the first sentence
   *  there is. One chore is all it can ever walk, and this is why: `(kind, target_type,
   *  target_id)` is unique, so a story cannot owe two chores of one kind. The sentence the
   *  port reads is therefore that chore's, and the walk is the record's guarantee spelled
   *  out rather than a choice between candidates. */
  it("reads the one chore of a kind the record allows a story to owe", () => {
    const done = story("one-merge", "2026-09-14T00:00:00.000Z");
    const only = openChore(done.id, "merge", "open");
    expect(() => openChore(done.id, "merge", "failed")).toThrow(/UNIQUE/i);
    refuse(only, "it will not merge");

    expect(delivered(db).find((r) => r.id === done.id)).toMatchObject({
      reach: "waiting",
      owed: "merge",
      why: "it will not merge",
    });
  });

  it("counts a failed chore as still owed, and a done one as not", () => {
    const done = story("failed-chore", "2026-09-14T00:00:00.000Z");
    const c = openChore(done.id, "refresh", "failed");

    expect(delivered(db).find((r) => r.id === done.id)?.reach).toBe("behind");
    db.prepare("UPDATE chore SET state = 'done' WHERE id = ?").run(c);
    expect(delivered(db).find((r) => r.id === done.id)?.reach).toBe("unlanded");
  });

  it("ignores a chore aimed at something that is not a story, even at the same id", () => {
    const done = story("not-mine", "2026-09-14T00:00:00.000Z");
    db.prepare(
      `INSERT INTO chore (slug,kind,project_id,target_type,target_id,"check",state,created_at,updated_at)
       VALUES ('sweep-p',?,?,'project',?,'x','open',?,?)`,
    ).run("refresh", tree.project, done.id, T, T);

    expect(delivered(db).find((r) => r.id === done.id)?.reach).toBe("unlanded");
  });

  it("lets a landing outrank every open chore", () => {
    const done = story("landed-anyway", "2026-09-14T00:00:00.000Z");
    refuse(openChore(done.id, "refresh"), "stale");
    land("story/landed-anyway", "def5678");

    expect(delivered(db).find((r) => r.id === done.id)).toMatchObject({
      reach: "landed",
      owed: null,
      why: null,
    });
  });

  /** The reason is a second read of `chore_refusal` now, and a workspace older than the
   *  chore migration has no such table. Dropping it is how that workspace is spelled. */
  it("reads the reach without a chore_refusal table at all", () => {
    const done = story("no-refusal-table", "2026-09-14T00:00:00.000Z");
    openChore(done.id, "refresh");
    db.exec("DROP TABLE chore_refusal");

    expect(delivered(db).find((r) => r.id === done.id)).toMatchObject({ reach: "behind", why: null });
  });
});
