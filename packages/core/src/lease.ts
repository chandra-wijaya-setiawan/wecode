import { hostname } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { now, transact } from "./store.js";

/** How many missed intervals make a holder dead rather than slow. One is a slow disk. */
export const STALE_INTERVALS = 3;

export interface Lease {
  readonly holder: string;
  readonly intervalMs: number;
  readonly takenAt: string;
  readonly heartbeat: string;
}

/** Taken, or refused because someone live already holds it. A refusal carries the holder
 *  and its age, because "the lease is held" is not something a person can act on. */
export type Taken =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly held: Lease; readonly ageMs: number };

/** A runner names itself where a person can find it: a host and a pid are enough to go and
 *  look, and enough to tell two runners on one workspace apart. */
export function runnerId(pid: number = process.pid): string {
  return `${hostname()}/${pid}`;
}

export function readLease(db: DatabaseSync): Lease | null {
  const row = db
    .prepare("SELECT holder, interval_ms, taken_at, heartbeat FROM runner_lease WHERE id = 1")
    .get() as { holder: string; interval_ms: number; taken_at: string; heartbeat: string } | undefined;
  if (row === undefined) return null;
  return { holder: row.holder, intervalMs: row.interval_ms, takenAt: row.taken_at, heartbeat: row.heartbeat };
}

export const leaseAgeMs = (l: Lease, at: string = now()): number =>
  Date.parse(at) - Date.parse(l.heartbeat);

/** A lease whose heartbeat is older than three of its own intervals is stale, and may be
 *  taken. The interval is the holder's, recorded when it took the lease, so a runner on a
 *  slow tick is not evicted by one on a fast one. */
export const leaseIsStale = (l: Lease, at: string = now()): boolean =>
  leaseAgeMs(l, at) > STALE_INTERVALS * l.intervalMs;

/** Take the lease, or refuse. Re-taking one you already hold is a renewal, so a restart
 *  under the same pid is not a deadlock.
 *
 *  In one transaction: reading a free lease and then claiming it are the same act, or two
 *  runners starting together both read "free". */
export function takeLease(db: DatabaseSync, holder: string, intervalMs: number, at: string = now()): Taken {
  return transact(db, () => {
    const held = readLease(db);
    if (held !== null && held.holder !== holder && !leaseIsStale(held, at)) {
      return { ok: false, held, ageMs: leaseAgeMs(held, at) } as const;
    }
    const taken: Lease = { holder, intervalMs, takenAt: at, heartbeat: at };
    db.prepare(
      "INSERT INTO runner_lease (id, holder, interval_ms, taken_at, heartbeat) VALUES (1,?,?,?,?) " +
        "ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, interval_ms = excluded.interval_ms, " +
        "taken_at = excluded.taken_at, heartbeat = excluded.heartbeat",
    ).run(holder, intervalMs, at, at);
    return { ok: true, lease: taken } as const;
  });
}

/** Renew on every tick. False means the lease was taken from under this holder — it went
 *  stale and someone else has it — and the caller is no longer the runner of record. */
export function renewLease(db: DatabaseSync, holder: string, at: string = now()): boolean {
  db.prepare("UPDATE runner_lease SET heartbeat = ? WHERE id = 1 AND holder = ?").run(at, holder);
  return readLease(db)?.holder === holder;
}

/** Give it back on the way out, so the next runner does not wait out three intervals for a
 *  runner that is already gone. Releasing someone else's lease does nothing. */
export function releaseLease(db: DatabaseSync, holder: string): void {
  db.prepare("DELETE FROM runner_lease WHERE id = 1 AND holder = ?").run(holder);
}

/** What a refused runner is told: who has it, and how long since that holder was alive. */
export function heldMessage(held: Lease, age: number): string {
  return (
    `another wecode-runner holds this workspace: ${held.holder}, last alive ${duration(age)} ago ` +
    `(ticking every ${duration(held.intervalMs)}, since ${held.takenAt}).\n` +
    `  Stop it, or wait ${STALE_INTERVALS} intervals for the lease to go stale.`
  );
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}
