import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, Repo, children, open, transact } from "../src/index.js";
import { tmp } from "./tmpdir.js";

const source = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");

let db: DatabaseSync;
let make: Maker;
let repo: Repo;

/** One row of every stateful entity, so every link in the ERD has both ends. */
interface Tree {
  project: number;
  release: number;
  epic: number;
  story: number;
  requirement: number;
  acceptance_criteria: number;
  acceptance_test: number;
  task: number;
  task_test: number;
  assignment: number;
}
let tree: Tree;

const ledgerFor = (entity: string, id: number): Record<string, unknown>[] =>
  db
    .prepare("SELECT entity, entity_id, verb, from_state, to_state, actor, at FROM ledger WHERE entity = ? AND entity_id = ?")
    .all(entity, id) as unknown as Record<string, unknown>[];

const column = (table: string, col: string, id: number): unknown =>
  (db.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id) as { v: unknown } | undefined)?.v;

beforeEach(() => {
  db = open(join(tmp(), "wecode.db"));
  make = new Maker(db);
  repo = new Repo(db);
  const ws = make.workspace("acme", "/acme");
  const project = make.project(ws, "s", "/r");
  const release = make.release(project, "1.0.0");
  const epic = make.epic(release, "e");
  const story = make.story(epic, "s");
  const requirement = make.requirement(story, "r");
  const acceptance_criteria = make.criteria(requirement, "c");
  const acceptance_test = make.acceptanceTest(acceptance_criteria, "proof", "script", "bash x.sh");
  const task = make.task(acceptance_test, "do it", { scope: { write: ["src/**"], tools: [] }, role: "engineer" });
  const task_test = make.taskTest(task, "unit", "script", "vitest run");
  const worker = make.worker("claude-1", "engineer", "agent");
  const assignment = make.assignment({
    objective_type: "task",
    objective_id: task,
    worker_id: worker,
    scope: { write: ["src/**"], tools: [] },
    budget: { tokens: 1, seconds: 1 },
    worktree: "/tmp/wt",
  });
  tree = {
    project,
    release,
    epic,
    story,
    requirement,
    acceptance_criteria,
    acceptance_test,
    task,
    task_test,
    assignment,
  };
});

describe("the repo module, ported onto the typed layer", () => {
  /** The point of the port. A single `db.prepare` left behind is a query the compiler does
   *  not check, and one is enough to lose the guarantee — so this is spelled as "none",
   *  against the source, rather than as a test of the queries that were ported. */
  it("leaves no prepared statement, and no SQL text at all, in the module", () => {
    expect(source).not.toMatch(/\bprepare\s*\(/);
    expect(source.match(/\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|LIMIT)\b/g)).toBeNull();
  });

  it("speaks to the database only through the dialect", () => {
    expect(source).toContain('from "./db.js"');
    expect(source).not.toMatch(/\bdb\.(prepare|exec|get|all|run)\b/);
  });

  /** Every table the module declares is read out of the source and held against the real
   *  schema, so the declaration and the migration cannot drift apart without a test saying
   *  so — and the column list lives in one place, the module, not in a copy here. */
  it("asks only for columns the migrations actually built", () => {
    const shared = [...(/const NODE = \[([^\]]*)\]/.exec(source)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(shared.length).toBeGreaterThan(0);

    const declared = [...source.matchAll(/table<[\s\S]*?>\(\s*"(\w+)",\s*\[([\s\S]*?)\]/g)].map((m) => ({
      name: m[1],
      columns: [
        ...(m[2].includes("...NODE") ? shared : []),
        ...[...m[2].matchAll(/"(\w+)"/g)].map((c) => c[1]),
      ],
    }));

    expect(declared.map((d) => d.name).sort()).toEqual([
      "acceptance_criteria",
      "acceptance_test",
      "assignment",
      "epic",
      "ledger",
      "project",
      "release",
      "requirement",
      "story",
      "task",
      "task_test",
    ]);
    for (const d of declared) {
      const actual = (db.prepare(`PRAGMA table_info(${d.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(d.columns.length).toBeGreaterThan(0);
      for (const c of d.columns) expect(actual, `${d.name}.${c}`).toContain(c);
    }
  });
});

describe("the state of a row, through the layer", () => {
  it("answers for every stateful entity, from the column that entity keeps it in", () => {
    for (const [entity, id] of Object.entries(tree)) {
      const col = entity === "assignment" ? "phase" : "state";
      expect(repo.stateOf(entity as keyof Tree, id), entity).toBe(column(entity, col, id));
      expect(repo.stateOf(entity as keyof Tree, id), entity).toBeTypeOf("string");
    }
  });

  it("is null for a row that is not there, rather than a row of nulls", () => {
    for (const entity of Object.keys(tree)) expect(repo.stateOf(entity as keyof Tree, 9999), entity).toBeNull();
  });
});

describe("the tree, through the layer", () => {
  /** The whole ERD chain, walked once: each entity's child list holds the row built under
   *  it, and each child names the parent it was built under. */
  const chain: readonly [keyof Tree, keyof Tree][] = [
    ["project", "release"],
    ["release", "epic"],
    ["epic", "story"],
    ["story", "requirement"],
    ["requirement", "acceptance_criteria"],
    ["acceptance_criteria", "acceptance_test"],
    ["acceptance_test", "task"],
    ["task", "task_test"],
  ];

  it("names the child entity of every link, and none for a leaf", () => {
    for (const [parent, child] of chain) expect(repo.childEntityOf(parent), parent).toBe(child);
    expect(repo.childEntityOf("task_test")).toBeNull();
    expect(repo.childEntityOf("assignment")).toBeNull();
  });

  it("reads each child with its id and state, narrowed by the column the child points back through", () => {
    for (const [parent, child] of chain) {
      expect(repo.childrenOf(parent, tree[parent]), parent).toEqual([
        { id: tree[child], state: column(child, "state", tree[child]) },
      ]);
    }
  });

  it("bears nothing where the ERD says nothing, and nothing for a parent that is not there", () => {
    expect(repo.childrenOf("task_test", tree.task_test)).toEqual([]);
    expect(repo.childrenOf("assignment", tree.assignment)).toEqual([]);
    expect(repo.childrenOf("project", 9999)).toEqual([]);
  });

  it("reads the same children through the free function as through the class", () => {
    expect(children(db, "story", tree.story)).toEqual(repo.childrenOf("story", tree.story));
  });

  it("walks back up the chain, and stops at the root", () => {
    for (const [parent, child] of chain) {
      expect(repo.parentOf(child, tree[child]), child).toEqual({ entity: parent, id: tree[parent] });
    }
    expect(repo.parentOf("project", tree.project)).toBeNull();
    expect(repo.parentOf("assignment", tree.assignment)).toBeNull();
  });

  it("has no parent for a child that is not there", () => {
    expect(repo.parentOf("task", 9999)).toBeNull();
  });

  it("finds every child when a parent bears more than one", () => {
    const second = make.taskTest(tree.task, "another", "script", "vitest run");

    expect(repo.childrenOf("task", tree.task).map((r) => r.id).sort()).toEqual([tree.task_test, second].sort());
  });

  it("does not mistake one parent's children for another's", () => {
    const other = make.epic(tree.release, "other");
    make.story(other, "elsewhere");

    expect(repo.childrenOf("epic", tree.epic).map((r) => r.id)).toEqual([tree.story]);
  });
});

describe("the artefact and the task's own columns, through the layer", () => {
  it("reads the artefact of either kind of test", () => {
    expect(repo.artefactOf("acceptance_test", tree.acceptance_test)).toBe("bash x.sh");
    expect(repo.artefactOf("task_test", tree.task_test)).toBe("vitest run");
  });

  it("is null for an unset artefact, and for a row that is not there", () => {
    db.prepare("UPDATE task_test SET artefact = NULL WHERE id = ?").run(tree.task_test);

    expect(repo.artefactOf("task_test", tree.task_test)).toBeNull();
    expect(repo.artefactOf("acceptance_test", 9999)).toBeNull();
  });

  it("reads the retry budget and the scope and role of a task", () => {
    db.prepare("UPDATE task SET attempts = 2, max_retry = 5 WHERE id = ?").run(tree.task);

    expect(repo.taskRetry(tree.task)).toEqual({ attempts: 2, max_retry: 5 });
    expect(repo.taskScopeAndRole(tree.task)).toEqual({
      scope: column("task", "scope", tree.task),
      role: "engineer",
    });
  });

  it("is null for a task that is not there, on both", () => {
    expect(repo.taskRetry(9999)).toBeNull();
    expect(repo.taskScopeAndRole(9999)).toBeNull();
  });
});

describe("setState, through the layer", () => {
  it("writes the state, stamps the row, and appends exactly one ledger line", () => {
    // back-date the stamp, so "setState re-stamped it" cannot be satisfied by the
    // fixture's own stamp happening to share a millisecond with this write
    const before = "1999-12-31T23:59:59.000Z";
    db.prepare("UPDATE story SET updated_at = ? WHERE id = ?").run(before, tree.story);

    repo.setState("story", tree.story, "planned", "ready", "start", "chief");

    expect(column("story", "state", tree.story)).toBe("ready");
    const lines = ledgerFor("story", tree.story);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      entity: "story",
      entity_id: tree.story,
      verb: "start",
      from_state: "planned",
      to_state: "ready",
      actor: "chief",
    });
    // the row's stamp and the ledger line's `at` are the same instant, read once
    expect(column("story", "updated_at", tree.story)).toBe(lines[0].at);
    expect(column("story", "updated_at", tree.story)).not.toBe(before);
  });

  it("writes an assignment's phase, and still says `assignment` in the ledger", () => {
    repo.setState("assignment", tree.assignment, "pending", "running", "start", "runner");

    expect(column("assignment", "phase", tree.assignment)).toBe("running");
    expect(ledgerFor("assignment", tree.assignment)).toHaveLength(1);
    expect(ledgerFor("assignment", tree.assignment)[0]).toMatchObject({ to_state: "running" });
  });

  it("touches only the row it was given", () => {
    const other = make.story(tree.epic, "other");

    repo.setState("story", tree.story, "planned", "ready", "start", "chief");

    expect(column("story", "state", other)).not.toBe("ready");
    expect(ledgerFor("story", other)).toEqual([]);
  });

  it("appends rather than overwrites, so a second transition keeps the first", () => {
    repo.setState("story", tree.story, "planned", "ready", "start", "chief");
    repo.setState("story", tree.story, "ready", "delivered", "deliver", "claude-1");

    expect(ledgerFor("story", tree.story).map((l) => l.to_state)).toEqual(["ready", "delivered"]);
  });
});

/** The claim this story exists to prove: the state and its ledger line are one write. The
 *  module opens no transaction, so they land inside the caller's — and when the caller's
 *  rolls back, neither survives. */
describe("the ledger line stays in the same transaction as the state", () => {
  it("opens no transaction of its own, leaving the caller's in charge", () => {
    expect(source).not.toMatch(/\btransact\b/);
    expect(source).not.toMatch(/BEGIN|COMMIT|ROLLBACK|SAVEPOINT/);
  });

  it("loses the state and the ledger line together when the caller's transaction rolls back", () => {
    expect(() =>
      transact(db, () => {
        repo.setState("story", tree.story, "planned", "ready", "start", "chief");
        expect(column("story", "state", tree.story)).toBe("ready");
        expect(ledgerFor("story", tree.story)).toHaveLength(1);
        throw new Error("the caller changed its mind");
      }),
    ).toThrow("the caller changed its mind");

    expect(column("story", "state", tree.story)).toBe("planned");
    expect(ledgerFor("story", tree.story)).toEqual([]);
  });

  it("loses the state change when the ledger line itself cannot be written", () => {
    db.exec("CREATE TRIGGER no_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'no ledger'); END");

    expect(() => transact(db, () => repo.setState("story", tree.story, "planned", "ready", "start", "chief"))).toThrow(
      /no ledger/,
    );

    expect(column("story", "state", tree.story)).toBe("planned");
    expect(ledgerFor("story", tree.story)).toEqual([]);
  });

  /** Two transitions in one operation are one write too — a cascade that dies half way
   *  leaves neither entity moved, and no ledger line claiming it moved. */
  it("loses an earlier transition when a later one in the same transaction fails", () => {
    expect(() =>
      transact(db, () => {
        repo.setState("task_test", tree.task_test, "planned", "delivered", "deliver", "claude-1");
        repo.setState("task", tree.task, "planned", "ready", "start", "chief");
        throw new Error("the cascade died");
      }),
    ).toThrow("the cascade died");

    expect(column("task_test", "state", tree.task_test)).toBe("planned");
    expect(column("task", "state", tree.task)).toBe("planned");
    expect(ledgerFor("task_test", tree.task_test)).toEqual([]);
    expect(ledgerFor("task", tree.task)).toEqual([]);
  });

  it("keeps both when the caller's transaction commits", () => {
    transact(db, () => repo.setState("story", tree.story, "planned", "ready", "start", "chief"));

    expect(column("story", "state", tree.story)).toBe("ready");
    expect(ledgerFor("story", tree.story)).toHaveLength(1);
  });
});
