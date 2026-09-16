import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyChore,
  approveChore,
  CHORE_KIND_DEFS,
  CLOSED_WITHOUT_REASON,
  choreAttempts,
  choreById,
  choreCandidates,
  choreFor,
  choreRefusal,
  choreSettled,
  choresPerformed,
  clearChoreRefusal,
  closeChore,
  ensureChore,
  isAttempted,
  loadRoles,
  openChores,
  recordChoreRefusal,
  reraiseChore,
  settledChores,
  WAITING_FOR_APPROVAL,
  type ChoreSpec,
  type RoleConfig,
} from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

const source = readFileSync(fileURLToPath(new URL("../src/chore.ts", import.meta.url)), "utf8");

const roles: RoleConfig = loadRoles(fileURLToPath(new URL("../../../config/roles.yaml", import.meta.url)));

const PAST = "2020-01-01T00:00:00.000Z";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

const merge = (target = tree.story): ChoreSpec => ({
  project_id: tree.project,
  kind: "merge",
  target_type: "story",
  target_id: target,
  check: "git merge --no-ff story/reset",
});

/** `sweep` is the kind that waits for a person, and its target is the project itself. */
const sweep = (): ChoreSpec => ({
  project_id: tree.project,
  kind: "sweep",
  target_type: "project",
  target_id: tree.project,
  check: "the lessons are fewer",
});

/** The fixtures speak SQL on purpose: a test that set its rows up through the module could
 *  not tell a ported query from a broken one that agrees with itself. */
const raw = (sql: string, ...args: (string | number | null)[]): void => {
  db.prepare(sql).run(...args);
};

const lastId = (): number => (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

let workers = 0;
const worker = (): number => {
  const slug = `sys-${++workers}`;
  raw("INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)", slug, slug, "system", "agent", PAST, PAST);
  return lastId();
};

const assign = (choreId: number, phase: string, slug = `a-${choreId}-${phase}`): number => {
  raw(
    `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
     VALUES (?,'chore',?,?,'{"write":[],"tools":[]}','{"tokens":1,"seconds":1}','/tmp/wt',?,'{}',?,?)`,
    slug,
    choreId,
    worker(),
    phase,
    PAST,
    PAST,
  );
  return lastId();
};

const stampOf = (id: number): string =>
  (db.prepare("SELECT updated_at AS at FROM chore WHERE id = ?").get(id) as { at: string }).at;

const backdate = (id: number): void => raw("UPDATE chore SET updated_at = ? WHERE id = ?", PAST, id);

const ledgerAt = (id: number, verb: string): string =>
  (
    db.prepare("SELECT at FROM ledger WHERE entity = 'chore' AND entity_id = ? AND verb = ? ORDER BY id DESC").get(id, verb) as {
      at: string;
    }
  ).at;

/** One attempt, begun and failed, leaving the chore in the queue again: `retry` is the
 *  person's edge back to `ready`, so the next attempt begins without a second `start`. */
const attempt = (id: number): void => {
  if (choreById(db, id)?.state === "planned") applyChore(db, id, "start", "chief");
  for (const v of ["begin", "fail", "retry"]) applyChore(db, id, v, "runner");
};

const countChores = (): number => (db.prepare("SELECT count(*) AS n FROM chore").get() as { n: number }).n;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

describe("the chore module, ported onto the typed layer", () => {
  /** The point of the port. One `db.prepare` left behind is a query the compiler does not
   *  check, and one is enough to lose the guarantee — so this is spelled as "none", against
   *  the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
    expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    // `DatabaseSync` is still the currency every caller passes, but it arrives as a type and
    // is handed on; nothing in here calls a method on it.
    expect(source).toContain('import { excluded, queries, table } from "./db.js"');
    expect(source).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migration cannot drift apart without a test saying
   *  so — and the list lives in the module, not in a copy here. */
  it("asks only for columns the migrations actually built", () => {
    const declared = [...source.matchAll(/table<[^>]*>\(\s*"(\w+)",\s*\[([^\]]*)\]/g)].map((m) => ({
      name: m[1],
      columns: [...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "assignment",
      "chore",
      "chore_refusal",
      "ledger",
      "project",
      "story",
    ]);
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(d.columns.length).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });

  /** The declaration of `chore` is the whole table, so a column added by a later migration
   *  and never declared here would be a column this module cannot see. */
  it("declares every column of the chore table, not a subset", () => {
    const declared = /table<ChoreRow>\(\s*"chore",\s*\[([^\]]*)\]/.exec(source);
    const columns = [...(declared?.[1] ?? "").matchAll(/"(\w+)"/g)].map((c) => c[1]);
    const actual = (db.prepare("PRAGMA table_info(chore)").all() as { name: string }[]).map((c) => c.name);

    expect(columns.sort()).toEqual([...actual].sort());
  });
});

describe("the chore record, read and written through the layer", () => {
  it("writes every column and reads back the one whose name is a SQL keyword", () => {
    const made = ensureChore(db, merge());

    expect(made).toEqual({
      id: made.id,
      slug: `merge-story-${tree.story}`,
      kind: "merge",
      project_id: tree.project,
      target_type: "story",
      target_id: tree.story,
      check: "git merge --no-ff story/reset",
      state: "planned",
      approved_at: null,
      approved_by: null,
    });
    // and the stamps the caller never sees are on the row all the same
    expect(db.prepare("SELECT created_at, updated_at FROM chore WHERE id = ?").get(made.id)).toEqual({
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("makes one row for a condition that is still true, not one a tick", () => {
    const first = ensureChore(db, merge());
    const again = ensureChore(db, merge());

    expect(again.id).toBe(first.id);
    expect(countChores()).toBe(1);
  });

  it("leaves the row it clashed with exactly as it was", () => {
    const first = ensureChore(db, merge());
    raw("UPDATE chore SET state = 'ready', updated_at = ? WHERE id = ?", PAST, first.id);

    ensureChore(db, merge());

    expect(choreById(db, first.id)).toMatchObject({ slug: first.slug, state: "ready" });
  });

  it("finds a chore by its kind and target, and nothing by another's", () => {
    const mine = ensureChore(db, merge());
    ensureChore(db, sweep());

    expect(choreFor(db, "merge", "story", tree.story)?.id).toBe(mine.id);
    expect(choreFor(db, "merge", "story", tree.story + 999)).toBeNull();
    expect(choreFor(db, "merge", "project", tree.story)).toBeNull();
    expect(choreById(db, 9999)).toBeNull();
  });
});

describe("a verb, through the layer", () => {
  it("moves the state and appends the ledger row in one act", () => {
    const c = ensureChore(db, merge()).id;

    expect(applyChore(db, c, "start", "chief")).toEqual({ ok: true, from: "planned", to: "ready" });
    expect(choreById(db, c)?.state).toBe("ready");
    expect(db.prepare("SELECT entity, entity_id, verb, from_state, to_state, actor FROM ledger WHERE entity = 'chore'").all()).toEqual([
      { entity: "chore", entity_id: c, verb: "start", from_state: "planned", to_state: "ready", actor: "chief" },
    ]);
  });

  /** The stamp is read once and written to both places, which is the only way the row and
   *  the ledger line can be held against each other. Back-dated first, because two writes
   *  in one millisecond make a naive "it changed" assertion fail on the clock. */
  it("re-stamps the row with the same clock read the ledger line carries", () => {
    const c = ensureChore(db, merge()).id;
    backdate(c);

    applyChore(db, c, "start", "chief");

    expect(stampOf(c)).not.toBe(PAST);
    expect(stampOf(c)).toBe(ledgerAt(c, "start"));
  });

  it("refuses an illegal verb without touching the row or the ledger", () => {
    const c = ensureChore(db, merge()).id;
    backdate(c);

    expect(applyChore(db, c, "finish", "chief")).toEqual({
      ok: false,
      why: "finish is not legal from planned. Legal here: start, close",
    });
    expect(stampOf(c)).toBe(PAST);
    expect(db.prepare("SELECT count(*) AS n FROM ledger WHERE entity = 'chore'").get()).toEqual({ n: 0 });
  });

  it("records an approval, and refuses one for a kind that does not wait", () => {
    const s = ensureChore(db, sweep()).id;
    backdate(s);

    expect(approveChore(db, s, "chief")).toEqual({ ok: true, from: "planned", to: "planned" });
    expect(choreById(db, s)).toMatchObject({ approved_at: stampOf(s), approved_by: "chief" });

    const m = ensureChore(db, merge()).id;
    expect(approveChore(db, m, "chief")).toEqual({ ok: false, why: "a merge chore does not wait for approval" });
    expect(choreById(db, m)?.approved_at).toBeNull();
  });
});

describe("attempts, counted from the ledger", () => {
  it("counts one per begin, and only this chore's", () => {
    const mine = ensureChore(db, merge()).id;
    const other = ensureChore(db, merge(tree.story + 1)).id;
    attempt(mine);
    attempt(mine);
    attempt(other);

    expect(choreAttempts(db, mine)).toEqual({ attempts: 2, max_retry: CHORE_KIND_DEFS.merge.max_retry });
    expect(choreAttempts(db, other)).toEqual({ attempts: 1, max_retry: CHORE_KIND_DEFS.merge.max_retry });
    expect(choreAttempts(db, 9999)).toBeNull();
  });
});

describe("how a settled chore was settled", () => {
  it("is what the last verb into done says, whichever pass wrote it", () => {
    const c = ensureChore(db, merge()).id;
    closeChore(db, c, "the branch landed on its own");

    expect(choreSettled(db, c)).toEqual({
      id: c,
      settlement: "closed",
      why: "the branch landed on its own",
      at: ledgerAt(c, "close"),
    });

    // the condition comes back, and this time a worker proves the check
    reraiseChore(db, c);
    for (const v of ["start", "begin", "finish"]) applyChore(db, c, v, "runner");

    expect(choreSettled(db, c)).toEqual({
      id: c,
      settlement: "performed",
      why: "git merge --no-ff story/reset",
      at: ledgerAt(c, "finish"),
    });
  });

  it("is null while the chore is still owed", () => {
    const c = ensureChore(db, merge()).id;
    expect(choreSettled(db, c)).toBeNull();
  });
});

describe("the board's chore rows, composed rather than joined", () => {
  it("names the story's title, the project's name, and the bare id of a target that is gone", () => {
    const story = ensureChore(db, merge()).id;
    const project = ensureChore(db, sweep()).id;
    const orphan = ensureChore(db, merge(4242)).id;

    expect(openChores(db).map((r) => [r.id, r.what])).toEqual([
      [story, "merge story password reset"],
      [project, "sweep project storefront"],
      [orphan, "merge story 4242"],
    ]);
  });

  it("reads running while an assignment is open on it, whatever the column says", () => {
    const c = ensureChore(db, merge()).id;

    for (const phase of ["pending", "running", "waiting"]) {
      raw("DELETE FROM assignment");
      assign(c, phase);
      expect(openChores(db)[0], phase).toMatchObject({ state: "running" });
    }
    for (const phase of ["done", "failed", "abandoned"]) {
      raw("DELETE FROM assignment");
      assign(c, phase);
      expect(openChores(db)[0], phase).toMatchObject({ state: "planned" });
    }
  });

  it("says what a chore is waiting for, and how many attempts it has had", () => {
    const s = ensureChore(db, sweep()).id;
    expect(openChores(db)[0]).toMatchObject({ state: "planned", detail: WAITING_FOR_APPROVAL });

    approveChore(db, s, "chief");
    expect(openChores(db)[0]).toMatchObject({ detail: "the lessons are fewer" });

    applyChore(db, s, "start", "chief");
    applyChore(db, s, "begin", "runner");
    applyChore(db, s, "fail", "runner");
    expect(openChores(db)[0]).toMatchObject({
      state: "failed",
      detail: `attempt 2 of ${CHORE_KIND_DEFS.sweep.max_retry} · the lessons are fewer`,
    });
  });

  it("leaves a done chore out of the open rows and shows it under how it ended", () => {
    const performed = ensureChore(db, merge()).id;
    for (const v of ["start", "begin", "finish"]) applyChore(db, performed, v, "runner");
    const closed = ensureChore(db, merge(tree.story + 1)).id;
    closeChore(db, closed, "the story landed");

    expect(openChores(db)).toEqual([]);
    expect(settledChores(db)).toEqual([
      { id: performed, what: "merge story password reset", state: "done", detail: "git merge --no-ff story/reset" },
      { id: closed, what: `merge story ${tree.story + 1}`, state: "closed", detail: "the story landed" },
    ]);
    expect(choresPerformed(settledChores(db))).toBe(1);
  });

  it("reads a closure with no reason on the row as the board's own words", () => {
    const c = ensureChore(db, merge()).id;
    closeChore(db, c, "gone");
    raw("DELETE FROM chore_refusal WHERE chore_id = ?", c);

    expect(settledChores(db)[0]).toMatchObject({ state: "closed", detail: CLOSED_WITHOUT_REASON });
    expect(choreSettled(db, c)?.why).toBe(CLOSED_WITHOUT_REASON);
  });

  it("shows only the project asked for, and every project when asked for none", () => {
    const mine = ensureChore(db, merge()).id;
    raw("INSERT INTO project (slug,workspace_id,name,repo,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", "other", tree.ws, "other", "/o", "in_progress", PAST, PAST);
    const other = lastId();
    const theirs = ensureChore(db, { ...merge(tree.story + 1), project_id: other }).id;

    expect(openChores(db, tree.project).map((r) => r.id)).toEqual([mine]);
    expect(openChores(db, other).map((r) => r.id)).toEqual([theirs]);
    expect(openChores(db).map((r) => r.id)).toEqual([mine, theirs]);

    closeChore(db, mine, "gone");
    closeChore(db, theirs, "gone");
    expect(settledChores(db, tree.project).map((r) => r.id)).toEqual([mine]);
    expect(settledChores(db).map((r) => r.id)).toEqual([mine, theirs]);
  });

  it("comes back in id order however the rows arrive", () => {
    const a = ensureChore(db, merge()).id;
    const b = ensureChore(db, merge(tree.story + 1)).id;
    const c = ensureChore(db, merge(tree.story + 2)).id;
    // touching a row does not move it: the order is applied, not inherited from the table
    raw("UPDATE chore SET updated_at = ? WHERE id = ?", PAST, a);

    expect(openChores(db).map((r) => r.id)).toEqual([a, b, c].sort((x, y) => x - y));
  });
});

describe("a chore's refusal row, upserted in TypeScript", () => {
  /** The stamps are millisecond strings and two passes land in the same millisecond, so a
   *  test that only asked whether `since` moved would be asking the clock. Back-dating the
   *  row first makes both halves of the rule answerable: `since` that stays is exactly the
   *  back-dated value, and `since` that starts over is this pass's `at`. */
  const backdateRefusal = (id: number): void =>
    raw("UPDATE chore_refusal SET at = ?, since = ? WHERE chore_id = ?", PAST, PAST, id);

  it("keeps its since and counts a pass while the reason is the same", () => {
    const c = ensureChore(db, merge()).id;

    recordChoreRefusal(db, "no worker free for role system", c);
    expect(choreRefusal(db, c)).toMatchObject({ id: c, why: "no worker free for role system", passes: 1 });
    backdateRefusal(c);

    recordChoreRefusal(db, "no worker free for role system", c);

    const now = choreRefusal(db, c);
    expect(now).toMatchObject({ since: PAST, passes: 2 });
    expect(now?.at).not.toBe(PAST);
  });

  it("starts over on a new reason", () => {
    const c = ensureChore(db, merge()).id;
    recordChoreRefusal(db, "one", c);
    recordChoreRefusal(db, "one", c);
    backdateRefusal(c);

    recordChoreRefusal(db, "two", c);

    const now = choreRefusal(db, c);
    expect(now).toMatchObject({ why: "two", passes: 1 });
    expect(now?.since).not.toBe(PAST);
    expect(now?.since).toBe(now?.at);
    expect(db.prepare("SELECT count(*) AS n FROM chore_refusal").get()).toEqual({ n: 1 });
  });

  it("is cleared rather than written when something is attempting the chore", () => {
    const c = ensureChore(db, merge()).id;
    recordChoreRefusal(db, "stale", c);
    assign(c, "running");

    recordChoreRefusal(db, "no worker free for role system", c);

    expect(choreRefusal(db, c)).toBeNull();
  });

  it("clears on demand, and reads as null when there is nothing to say", () => {
    const c = ensureChore(db, merge()).id;
    recordChoreRefusal(db, "stale", c);

    clearChoreRefusal(db, c);

    expect(choreRefusal(db, c)).toBeNull();
    expect(choreRefusal(db, 9999)).toBeNull();
  });

  it("answers whether anything is attempting one chore the way the board answers for all", () => {
    const c = ensureChore(db, merge()).id;
    expect(isAttempted(db, c)).toBe(false);

    const a = assign(c, "running");
    expect(isAttempted(db, c)).toBe(true);
    expect(isAttempted(db, c + 999)).toBe(false);

    raw("UPDATE assignment SET phase = 'done' WHERE id = ?", a);
    expect(isAttempted(db, c)).toBe(false);
  });
});

describe("chores the allocator could choose, through the layer", () => {
  it("offers an open chore with its kind's role, scope and attempts", () => {
    const c = ensureChore(db, merge()).id;

    expect(choreCandidates(db, roles).candidates).toEqual([
      {
        id: c,
        objective_type: "chore",
        title: `merge story #${tree.story}`,
        role: "system",
        scope: roles.roles["system"]?.scope,
        budget: roles.roles["system"]?.budget,
        attempts: 0,
      },
    ]);
    expect(choreCandidates(db, roles).refused).toEqual([]);
    expect(choreCandidates(db).candidates).toEqual([]);
  });

  it("leaves out one that is done, one that is running, and one something is attempting", () => {
    const done = ensureChore(db, merge()).id;
    for (const v of ["start", "begin", "finish"]) applyChore(db, done, v, "runner");
    const running = ensureChore(db, merge(tree.story + 1)).id;
    applyChore(db, running, "start", "chief");
    applyChore(db, running, "begin", "runner");
    const held = ensureChore(db, merge(tree.story + 2)).id;
    assign(held, "pending");
    const free = ensureChore(db, merge(tree.story + 3)).id;

    expect(choreCandidates(db, roles).candidates.map((x) => x.id)).toEqual([free]);
  });

  it("refuses one waiting for approval, and one out of attempts, in the board's words", () => {
    const s = ensureChore(db, sweep()).id;
    expect(choreCandidates(db, roles).refused).toEqual([{ id: s, why: WAITING_FOR_APPROVAL }]);

    approveChore(db, s, "chief");
    for (let i = 0; i < CHORE_KIND_DEFS.sweep.max_retry; i++) attempt(s);

    expect(choreCandidates(db, roles).refused).toEqual([
      { id: s, why: `out of attempts · ${CHORE_KIND_DEFS.sweep.max_retry} of ${CHORE_KIND_DEFS.sweep.max_retry}` },
    ]);
    expect(choreCandidates(db, roles).candidates).toEqual([]);
  });
});
