import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { now, transact } from "./store.js";

/** How many missed intervals make a holder dead rather than slow. One is a slow disk. */
export const STALE_INTERVALS = 3;

export interface Lease {
  readonly holder: string;
  readonly intervalMs: number;
  readonly takenAt: string;
  readonly heartbeat: string;
  /** The commit the holder's build was made from, absent when the build cannot say. */
  readonly buildSha?: string;
  /** Commits the base has gained since that build, absent until the holder measures it. */
  readonly buildBehind?: number;
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

interface LeaseRow {
  holder: string;
  interval_ms: number;
  taken_at: string;
  heartbeat: string;
  build_sha: string | null;
  build_behind: number | null;
}

export function readLease(db: DatabaseSync): Lease | null {
  const row = db
    .prepare(
      "SELECT holder, interval_ms, taken_at, heartbeat, build_sha, build_behind FROM runner_lease WHERE id = 1",
    )
    .get() as LeaseRow | undefined;
  if (row === undefined) return null;
  return {
    holder: row.holder,
    intervalMs: row.interval_ms,
    takenAt: row.taken_at,
    heartbeat: row.heartbeat,
    // Omitted rather than null when the build could not say: a reader asking "what is it
    // running" gets no answer, which is different from an answer of nothing.
    ...(row.build_sha === null ? {} : { buildSha: row.build_sha }),
    ...(row.build_behind === null ? {} : { buildBehind: row.build_behind }),
  };
}

/** The commit this build was made from, read from the build's own directory rather than
 *  from whatever tree the process was started in.
 *
 *  This is the truth about the process and not about the checkout: the checkout moves on —
 *  that is the whole point of landing a fix — and a process already running cannot notice.
 *  Resolved once, at first call, and never again, so a runner that has been up for an hour
 *  still reports the commit it was built from and not the one that landed since.
 *
 *  Null when there is no git to ask, which is an ordinary install and not a fault. */
const resolvedBuild = new Map<string, string | null>();
export function buildSha(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const known = resolvedBuild.get(from);
  if (known !== undefined) return known;
  const sha = gitAt(from, ["rev-parse", "HEAD"]);
  resolvedBuild.set(from, sha);
  return sha;
}

/** How many commits the base has gained since `build`. Zero is current; null is a question
 *  git could not answer, and null must not be drawn as drift. A build that is not an
 *  ancestor of the base — an install from a branch that never landed — still counts the
 *  commits the base has that it does not, which is the number a person acts on. */
export function buildBehind(build: string | null, base = "HEAD", from?: string): number | null {
  if (build === null) return null;
  const dir = from ?? dirname(fileURLToPath(import.meta.url));
  const count = gitAt(dir, ["rev-list", "--count", `${build}..${base}`]);
  if (count === null) return null;
  const n = Number(count);
  return Number.isInteger(n) ? n : null;
}

function gitAt(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
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
export function takeLease(
  db: DatabaseSync,
  holder: string,
  intervalMs: number,
  at: string = now(),
  build: string | null = null,
): Taken {
  return transact(db, () => {
    const held = readLease(db);
    if (held !== null && held.holder !== holder && !leaseIsStale(held, at)) {
      return { ok: false, held, ageMs: leaseAgeMs(held, at) } as const;
    }
    const taken: Lease = { holder, intervalMs, takenAt: at, heartbeat: at, ...(build === null ? {} : { buildSha: build }) };
    db.prepare(
      "INSERT INTO runner_lease (id, holder, interval_ms, taken_at, heartbeat, build_sha, build_behind) " +
        "VALUES (1,?,?,?,?,?,NULL) " +
        "ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, interval_ms = excluded.interval_ms, " +
        "taken_at = excluded.taken_at, heartbeat = excluded.heartbeat, build_sha = excluded.build_sha, " +
        "build_behind = NULL",
    ).run(holder, intervalMs, at, at, build);
    return { ok: true, lease: taken } as const;
  });
}

/** How far the holder's build is behind the base, as the holder measures it. Only the
 *  holder may write it: it is a claim about that process, and a runner that has lost the
 *  lease is no longer describing the process that holds it. */
export function recordBuildDrift(db: DatabaseSync, holder: string, behind: number | null): void {
  db.prepare("UPDATE runner_lease SET build_behind = ? WHERE id = 1 AND holder = ?").run(behind, holder);
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
