/** `last_seen` is what the operator reads to tell a long attempt from a dead one, and the
 *  foreman writes it where it observes — between phases. An attempt that spends its whole
 *  budget inside one phase therefore says nothing for the length of it: 848 and 849 both
 *  read 202 seconds stale while their processes were running.
 *
 *  These tests hold a real assignment through a phase that never returns, with the clock
 *  faked, and read the record back through the board's own reader. Nothing polls, nothing
 *  finishes: if `last_seen` moves in here, it moved on a timer. */
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, Maker, open, Verbs } from "@wecode/core";
import { assignmentFacts } from "@wecode/core/dist/board.js";
import { startWorkHeartbeat } from "../src/heartbeat.js";
import { tmp } from "../../core/test/tmpdir.js";

const EVERY = 15_000;
const T0 = "2026-09-20T10:00:00.000Z";
/** Longer than any single phase the old, between-phases write could cover. */
const A_LONG_PHASE = 5 * EVERY;

let db: DatabaseSync;
let make: Maker;
let verbs: Verbs;
let worker: number;
let project: number;

const at = (): string => new Date(Date.now()).toISOString();

/** A whole tree down to one task, because an assignment must hang on one. Every name it
 *  coins is numbered: a slug is unique across the workspace, and two attempts running at
 *  once is the case two of these have to build. */
let nth = 0;
const aTask = (): number => {
  const n = ++nth;
  const test = make.acceptanceTest(
    make.criteria(
      make.requirement(make.story(make.epic(make.release(project, `1.${n}.0`), `e${n}`), `s${n}`), `r${n}`),
      `c${n}`,
    ),
    "proof",
    "script",
    "bash x.sh",
  );
  return make.task(test, `work slowly ${n}`, { role: "engineer", scope: { write: ["src/**"], tools: [] } });
};

/** An assignment in `running`: the phase a long attempt is in while it says nothing. */
const running = (): number => {
  const id = make.assignment({
    objective_type: "task",
    objective_id: aTask(),
    worker_id: worker,
    scope: { write: ["src/**"], tools: ["bash"] },
    budget: { tokens: 100, seconds: 10 },
    worktree: "/tmp/wecode-no-such-worktree",
  });
  expect(verbs.startAssignment(id, "foreman").ok).toBe(true);
  return id;
};

/** The record's own writer for the column, standing in for the foreman's — the beat's job
 *  is to decide *when*, not to own the SQL. */
const seen = (id: number, when: string): void => {
  db.prepare("UPDATE assignment SET last_seen = ?, updated_at = ? WHERE id = ?").run(when, when, id);
};

const beatOf = (id: number): string | null => assignmentFacts(db, id)?.beat ?? null;
const silentMs = (id: number): number | null => assignmentFacts(db, id)?.silent ?? null;
/** What the beat is told is still working, read back through the board rather than
 *  remembered: an assignment that ended between beats stops being claimed alive. */
const live = (ids: readonly number[]) => (): readonly number[] =>
  ids.filter((id) => assignmentFacts(db, id)?.open === true);

const port = (ids: readonly number[], extra = {}) => ({
  everyMs: EVERY,
  live: live(ids),
  seen,
  now: at,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(T0) });
  db = open(join(tmp("wecode-beat-"), "wecode.db"));
  make = new Maker(db);
  verbs = new Verbs(new Engine(db));
  project = make.project(make.workspace("acme", "/acme"), "s", "/r");
  worker = make.worker("claude-1", "engineer", "agent");
  nth = 0;
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("a long phase", () => {
  it("still beats: last_seen advances while one phase runs and nothing observes it", async () => {
    const id = running();
    const hb = startWorkHeartbeat(port([id]));

    const beats: string[] = [];
    // No phase ever ends in here — nothing polls, nothing records. The only writer is the
    // clock.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(EVERY);
      beats.push(beatOf(id) ?? "");
    }

    expect(new Set(beats).size, "last_seen advanced at least twice inside one phase").toBeGreaterThanOrEqual(2);
    expect(beats).toEqual([
      "2026-09-20T10:00:15.000Z",
      "2026-09-20T10:00:30.000Z",
      "2026-09-20T10:00:45.000Z",
      "2026-09-20T10:01:00.000Z",
      "2026-09-20T10:01:15.000Z",
    ]);
    hb.stop();
  });

  it("never lets a live assignment read older than one interval", async () => {
    const id = running();
    const hb = startWorkHeartbeat(port([id]));
    // Fresh on the way in, so the window before the first beat is not a silence either.
    hb.beat();

    let worst = 0;
    // Sampled just before each beat, which is the moment the record is at its oldest.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(EVERY - 1);
      worst = Math.max(worst, silentMs(id) ?? Number.POSITIVE_INFINITY);
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(worst, "a working attempt was silent for longer than an interval").toBeLessThanOrEqual(EVERY);
    hb.stop();
  });

  it("does not claim an assignment that stopped being open", async () => {
    const id = running();
    const hb = startWorkHeartbeat(port([id]));
    await vi.advanceTimersByTimeAsync(EVERY);
    const last = beatOf(id);

    expect(verbs.finishAssignment(id, "foreman").ok).toBe(true);
    await vi.advanceTimersByTimeAsync(A_LONG_PHASE);

    expect(beatOf(id), "a finished attempt went on being marked alive").toBe(last);
    hb.stop();
  });

  it("beats every live assignment, not just the first", async () => {
    const [a, b] = [running(), running()];
    const hb = startWorkHeartbeat(port([a, b]));
    await vi.advanceTimersByTimeAsync(A_LONG_PHASE);

    expect(beatOf(a)).toBe("2026-09-20T10:01:15.000Z");
    expect(beatOf(b)).toBe(beatOf(a));
    hb.stop();
  });

  it("goes on beating the others when one assignment cannot be written", async () => {
    const [a, b] = [running(), running()];
    const errs: number[] = [];
    const hb = startWorkHeartbeat(
      port([a, b], {
        seen: (id: number, when: string) => {
          if (id === a) throw new Error("locked");
          seen(id, when);
        },
        onError: (id: number) => errs.push(id),
      }),
    );

    await vi.advanceTimersByTimeAsync(2 * EVERY);
    expect(errs).toEqual([a, a]);
    expect(beatOf(b), "one bad row stopped the beat for every other attempt").toBe(
      "2026-09-20T10:00:30.000Z",
    );
    expect(hb.running()).toBe(true);
    hb.stop();
  });

  it("stops when the runner is asked to stop", async () => {
    const id = running();
    const stop = new AbortController();
    const hb = startWorkHeartbeat(port([id], { signal: stop.signal }));
    await vi.advanceTimersByTimeAsync(EVERY);
    const last = beatOf(id);

    stop.abort();
    expect(hb.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(A_LONG_PHASE);
    expect(beatOf(id), "a stopped process must stop saying its work is alive").toBe(last);
  });
});
