import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerApproval,
  ApprovalError,
  applyChore,
  bulkDrop,
  CHORE_MACHINE,
  CHORE_VERBS,
  ChoreVerbs,
  closeChore,
  Engine,
  ensureChore,
  Maker,
  raiseApproval,
  reraiseChore,
  Verbs,
} from "../src/index.js";
import { freshDb, recordRed, seed, stateOf } from "./helpers.js";

/** docs/design — the facade exists so a verb is a method and not a string. It only earns
 *  that if core's own modules use it: a caller inside core that still writes
 *  `engine.apply("assignment", id, "raise")` is the same misspelling risk the facade was
 *  generated to remove, and it is the copy that no client's compiler ever reads.
 *
 *  Nothing here is a behaviour change, so every test is one of two shapes: the call still
 *  does exactly what it did, or the call is made through the facade. Both are needed —
 *  the first alone would pass with the strings still in place, and the second alone would
 *  pass on a facade that had quietly started applying a different verb. */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const T = "2026-09-13T00:00:00.000Z";

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
});

const ledgerOf = (db: DatabaseSync, entity: string, id: number) =>
  db
    .prepare("SELECT verb, from_state, to_state, actor FROM ledger WHERE entity = ? AND entity_id = ? ORDER BY id")
    .all(entity, id) as { verb: string; from_state: string; to_state: string; actor: string }[];

describe("no core module spells an entity and a verb to the engine", () => {
  /** The facade and its generator are the two files allowed to: one is generated from
   *  machines.yaml and the other writes it. Everything else in core goes through a method. */
  const ALLOWED = new Set(["facade.ts", "facade-gen.ts"]);

  it("leaves apply(\"entity\", …, \"verb\") to the facade alone", () => {
    const offenders = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && !ALLOWED.has(f))
      .filter((f) => /\.(apply|may)\(\s*"/.test(readFileSync(join(SRC, f), "utf8")))
      // bulk.ts asks `engine.may` because the facade offers verbs to invoke, not questions.
      .filter((f) => f !== "bulk.ts");

    expect(offenders).toEqual([]);
  });

  it("holds bulk.ts to that one exception and no more", () => {
    const source = readFileSync(join(SRC, "bulk.ts"), "utf8");
    const calls = source.match(/\.(apply|may)\(\s*"[^)]*\)/g) ?? [];
    expect(calls).toEqual(['.may("task", id, "drop")']);
  });
});

/** Another task under the same acceptance_test, so a bulk has more than one id to drop. */
const extraTask = (slug: string): number => {
  db.prepare(
    "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(slug, tree.acceptance, slug, JSON.stringify({ write: ["src/**"], tools: ["bash"] }), "engineer", JSON.stringify({ tokens: 1000, seconds: 60 }), "planned", T, T);
  const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(`${slug}-test`, id, "it works", "script", "vitest run", "ready", T, T);
  return id;
};

describe("a bulk drop drops through the facade", () => {
  it("calls dropTask once per id, with the actor it was given", () => {
    const second = extraTask("second");
    const dropTask = vi.spyOn(Verbs.prototype, "dropTask");
    try {
      expect(bulkDrop(db, [tree.task, second], "chief").ok).toBe(true);
      expect(dropTask.mock.calls).toEqual([
        [tree.task, "chief"],
        [second, "chief"],
      ]);
    } finally {
      dropTask.mockRestore();
    }
  });

  it("still writes the same drop and the same ledger line", () => {
    expect(bulkDrop(db, [tree.task], "chief").ok).toBe(true);
    expect(stateOf(db, "task", tree.task)).toBe("dropped");
    expect(ledgerOf(db, "task", tree.task)).toEqual([
      { verb: "drop", from_state: "planned", to_state: "dropped", actor: "chief" },
    ]);
  });

  it("still refuses the whole list on one refusal, and names the offender", () => {
    recordRed(db, tree.acceptance);
    const second = extraTask("second");
    const engine = new Engine(db);
    // done is terminal for a task: drop does not exist from there.
    engine.apply("task", tree.task, "start", "chief");
    engine.apply("task_test", tree.taskTest, "pass", "runner");
    expect(stateOf(db, "task", tree.task)).toBe("done");

    const r = bulkDrop(db, [second, tree.task], "chief");

    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusals.map((f) => f.id)).toEqual([tree.task]);
    expect(stateOf(db, "task", second)).toBe("planned");
  });
});

/** A person to ask and an approval to answer. */
const cast = (db: DatabaseSync) => {
  const make = new Maker(db);
  make.role("operator", { write: [], tools: [] }, "human");
  return { dana: make.worker("dana", "operator", "human") };
};

const ask = (db: DatabaseSync, worker: number) =>
  raiseApproval(db, {
    objective_type: "task",
    objective_id: tree.task,
    worker_id: worker,
    question: "ship the reset mail to production?",
  });

describe("an approval is raised and answered through the facade", () => {
  it("raises with raiseAssignment, in wecode's name", () => {
    const { dana } = cast(db);
    const raise = vi.spyOn(Verbs.prototype, "raiseAssignment");
    try {
      const approval = ask(db, dana);
      expect(raise.mock.calls).toEqual([[approval.id, "wecode"]]);
      expect(approval.phase).toBe("waiting");
    } finally {
      raise.mockRestore();
    }
  });

  it("answers with answerAssignment then finishAssignment, in the answerer's name", () => {
    const { dana } = cast(db);
    const approval = ask(db, dana);
    const answer = vi.spyOn(Verbs.prototype, "answerAssignment");
    const finish = vi.spyOn(Verbs.prototype, "finishAssignment");
    try {
      answerApproval(db, approval.id, "ship it", "dana");
      expect(answer.mock.calls).toEqual([[approval.id, "dana"]]);
      expect(finish.mock.calls).toEqual([[approval.id, "dana"]]);
      expect(answer.mock.invocationCallOrder[0]).toBeLessThan(finish.mock.invocationCallOrder[0]);
    } finally {
      answer.mockRestore();
      finish.mockRestore();
    }
  });

  it("still ledgers raise, answer and finish, in that order", () => {
    const { dana } = cast(db);
    const approval = ask(db, dana);
    answerApproval(db, approval.id, "ship it", "dana");

    expect(ledgerOf(db, "assignment", approval.id)).toEqual([
      { verb: "raise", from_state: "pending", to_state: "waiting", actor: "wecode" },
      { verb: "answer", from_state: "waiting", to_state: "running", actor: "dana" },
      { verb: "finish", from_state: "running", to_state: "succeeded", actor: "dana" },
    ]);
  });

  /** The wording the module refuses with is part of its behaviour, and it used to be spelled
   *  `${verb}ed` off the string being applied. A method has no such suffix to borrow, so the
   *  two sentences are written out — and held here, because "answereded" would also compile. */
  it("still says which of the two moves could not be made", () => {
    const { dana } = cast(db);
    const approval = ask(db, dana);
    const answer = vi.spyOn(Verbs.prototype, "answerAssignment").mockReturnValue({ ok: false, why: "no" });
    try {
      expect(() => answerApproval(db, approval.id, "ship it", "dana")).toThrow(
        `approval #${approval.id} could not be answered: no`,
      );
    } finally {
      answer.mockRestore();
    }

    const finish = vi.spyOn(Verbs.prototype, "finishAssignment").mockReturnValue({ ok: false, why: "no" });
    try {
      expect(() => answerApproval(db, approval.id, "ship it", "dana")).toThrow(
        `approval #${approval.id} could not be finished: no`,
      );
    } finally {
      finish.mockRestore();
    }
    // The throw rolled the transaction back, so the approval is still waiting to be answered.
    expect(answerApproval(db, approval.id, "ship it", "dana").phase).toBe("succeeded");
  });

  it("still refuses an approval raised on a phase the machine cannot leave", () => {
    const { dana } = cast(db);
    const raise = vi.spyOn(Verbs.prototype, "raiseAssignment").mockReturnValue({ ok: false, why: "no" });
    try {
      expect(() => ask(db, dana)).toThrow(ApprovalError);
    } finally {
      raise.mockRestore();
    }
    // Created and raised in one transaction: a refused raise leaves no assignment behind.
    expect((db.prepare("SELECT count(*) AS n FROM assignment").get() as { n: number }).n).toBe(0);
  });
});

const mergeSpec = (project: number, story: number) =>
  ({
    project_id: project,
    kind: "merge",
    target_type: "story",
    target_id: story,
    check: "the branch merges cleanly",
  }) as const;

/** A chore that has been attempted and failed, the way the runner leaves one. */
const failedChore = (): number => {
  const id = ensureChore(db, mergeSpec(tree.project, tree.story)).id;
  for (const verb of ["start", "begin", "fail"]) applyChore(db, id, verb, "system-1");
  return id;
};

/** Chore is not in machines.yaml, so it is not in the generated facade; it carries its own,
 *  and the same rule applies to it — chore.ts's own callers take the methods. */
describe("chore has a typed facade of its own", () => {
  it("offers one method per verb the chore machine has", () => {
    const methods = Object.getOwnPropertyNames(ChoreVerbs.prototype)
      .filter((n) => n !== "constructor")
      .sort();
    expect(methods).toEqual([...CHORE_VERBS].sort());
    expect([...CHORE_VERBS].sort()).toEqual([...new Set(CHORE_MACHINE.transitions.map((t) => t.verb))].sort());
  });

  it("applies the transition each method names, and ledgers it", () => {
    const id = ensureChore(db, mergeSpec(tree.project, tree.story)).id;
    const verbs = new ChoreVerbs(db);

    expect(verbs.start(id, "runner")).toEqual({ ok: true, from: "planned", to: "ready" });
    expect(verbs.begin(id, "system-1")).toEqual({ ok: true, from: "ready", to: "running" });
    expect(verbs.fail(id, "system-1")).toEqual({ ok: true, from: "running", to: "failed" });
    expect(verbs.retry(id, "chandra")).toEqual({ ok: true, from: "failed", to: "ready" });
    expect(verbs.begin(id, "system-1")).toEqual({ ok: true, from: "ready", to: "running" });
    expect(verbs.finish(id, "system-1")).toEqual({ ok: true, from: "running", to: "done" });
    expect(verbs.reprove(id, "runner")).toEqual({ ok: true, from: "done", to: "planned" });
    expect(verbs.close(id, "runner")).toEqual({ ok: true, from: "planned", to: "done" });

    expect(ledgerOf(db, "chore", id).map((l) => l.verb)).toEqual([
      "start",
      "begin",
      "fail",
      "retry",
      "begin",
      "finish",
      "reprove",
      "close",
    ]);
  });

  it("is refused by the same guard a string verb was", () => {
    const id = ensureChore(db, {
      project_id: tree.project,
      kind: "sweep",
      target_type: "story",
      target_id: tree.story,
      check: "the record is rewritten",
    }).id;
    const r = new ChoreVerbs(db).start(id, "runner");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toBe("a sweep chore needs approval before it starts");
  });

  it("reraises through reprove, still clearing the stale refusal", () => {
    const id = failedChore();
    const reprove = vi.spyOn(ChoreVerbs.prototype, "reprove");
    try {
      expect(reraiseChore(db, id, "runner")).toEqual({ ok: true, from: "failed", to: "planned" });
      expect(reprove.mock.calls).toEqual([[id, "runner"]]);
    } finally {
      reprove.mockRestore();
    }
    expect(stateOf(db, "chore", id)).toBe("planned");
  });

  it("closes through close, still writing the reason", () => {
    const id = failedChore();
    const close = vi.spyOn(ChoreVerbs.prototype, "close");
    try {
      expect(closeChore(db, id, "the branch merged on its own", "runner")).toEqual({
        ok: true,
        from: "failed",
        to: "done",
      });
      expect(close.mock.calls).toEqual([[id, "runner"]]);
    } finally {
      close.mockRestore();
    }
    expect(stateOf(db, "chore", id)).toBe("done");
    expect((db.prepare("SELECT why FROM chore_refusal WHERE chore_id = ?").get(id) as { why: string }).why).toBe(
      "the branch merged on its own",
    );
  });
});
