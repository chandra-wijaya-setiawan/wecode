import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { board } from "../src/index.js";
import { freshDb, seed } from "./helpers.js";

/** A row appears in a box only in a state that box's filter names.
 *
 *  The record moves through phases nobody can act on — an assignment that has come back,
 *  and the task it leaves `ready` until a later tick settles it into `done`. The board was
 *  showing that `ready` in the queue, so a task whose work was finished read as a task
 *  nobody had started, and the same id sat there pass after pass.
 *
 *  Every phase is seeded on a task of its own so each box can be read against the whole
 *  assignment machine at once, rather than one phase at a time.
 *
 *  "Settling" is narrow on purpose: a succeeded attempt whose task_tests are all settled,
 *  which is precisely what the automatic `finish` takes. A succeeded attempt that left a
 *  test red is work the allocator still owes a pass, and stays in the queue. */

const T = "2026-09-13T00:00:00.000Z";

/** The assignment machine's phases, in the order `machines.yaml` lists them. */
const PHASES = ["pending", "running", "waiting", "succeeded", "failed"] as const;
type Phase = (typeof PHASES)[number];

describe("a state the record is only passing through", () => {
  let db: DatabaseSync;
  let tree: ReturnType<typeof seed>;
  /** The task carrying each phase's assignment, and the assignment's own id. */
  let task: Record<Phase, number>;
  let assignment: Record<Phase, number>;

  const ins = (sql: string, ...args: (string | number | null)[]): number => {
    db.prepare(sql).run(...args);
    return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  };

  /** A ready task, and one assignment against it in the phase named. Ready is the point:
   *  the task row is the same in every case, so any difference between the boxes is the
   *  assignment's phase and nothing else. */
  const seedPhase = (phase: Phase): void => {
    task[phase] = ins(
      "INSERT INTO task (slug,acceptance_test_id,title,scope,role,budget,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      `t-${phase}`,
      tree.acceptance,
      `the ${phase} task`,
      JSON.stringify({ write: [`src/${phase}/**`], tools: ["bash"] }),
      "engineer",
      "{}",
      "ready",
      T,
      T,
    );
    const worker = ins(
      "INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      `w-${phase}`,
      `w-${phase}`,
      "engineer",
      "agent",
      T,
      T,
    );
    assignment[phase] = ins(
      "INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,question,created_at,updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      `a-${phase}`,
      "task",
      task[phase],
      worker,
      "{}",
      "{}",
      "/tmp/wt",
      phase,
      "{}",
      phase === "waiting" ? "which mailbox?" : null,
      T,
      T,
    );
  };

  beforeEach(() => {
    db = freshDb();
    tree = seed(db);
    task = {} as Record<Phase, number>;
    assignment = {} as Record<Phase, number>;
    for (const phase of PHASES) seedPhase(phase);
  });

  const ids = (rows: readonly { id: number }[]): number[] => rows.map((r) => r.id).sort((a, b) => a - b);

  it("keeps a succeeded assignment's task out of the queue, where its ready is not yet anybody's", () => {
    expect(ids(board(db).queued)).not.toContain(task.succeeded);
  });

  it("leaves a succeeded assignment out of running and out of needs you, which name no such phase", () => {
    const b = board(db);

    expect(ids(b.running)).not.toContain(assignment.succeeded);
    expect(ids(b.needs_human)).not.toContain(assignment.succeeded);
  });

  it("puts no assignment of any phase in a box whose filter does not name it", () => {
    const b = board(db);

    expect(ids(b.running)).toEqual([assignment.pending, assignment.running].sort((a, z) => a - z));
    expect(ids(b.needs_human)).toEqual([assignment.waiting]);
  });

  it("queues the one task nothing holds — the one whose attempt failed, and only that one", () => {
    // `failed` is the ledger being finished with an attempt, not a state on the way to
    // one: the task stays ready, the allocator dispatches it again, and the queue is
    // exactly where a person should see it. The seed's own task is `planned`, so it is
    // not a candidate for the queue in the first place.
    expect(ids(board(db).queued)).toEqual([task.failed]);
  });

  it("queues a succeeded attempt's task again when it came back with a test still red", () => {
    // The narrow edge of the rule. An attempt can succeed and still leave a task_test
    // failing; the automatic `finish` will not take that task, the allocator will
    // dispatch it again, and a board that hid it would hide live work.
    ins(
      "INSERT INTO task_test (slug,parent_id,statement,kind,artefact,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      "still-red",
      task.succeeded,
      "the token is signed",
      "script",
      "vitest run token",
      "failed",
      T,
      T,
    );

    expect(ids(board(db).queued)).toContain(task.succeeded);
  });

  it("says the same thing about stale, which reads the same set", () => {
    // Three refusals for one reason is what puts a ready task in `stale` — but nothing
    // stale can be said about a task whose attempt has already come back.
    for (const t of [task.succeeded, task.failed]) {
      for (let i = 0; i < 3; i++) {
        db.prepare(
          "INSERT INTO refusal (task_id,why,at,since,passes) VALUES (?,?,?,?,?)" +
            " ON CONFLICT (task_id) DO UPDATE SET passes = refusal.passes + 1",
        ).run(t, "no slot", T, T, 1);
      }
    }

    const stale = ids(board(db).stale);

    expect(stale).not.toContain(task.succeeded);
    expect(stale).toContain(task.failed);
  });
});
