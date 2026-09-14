/** What the runner is running, and whether it is what landed.
 *
 *  Landing a runner fix changes nothing until the runner restarts, and nothing said so:
 *  story 175 landed the fix that keeps an agent's commits and the very next task still lost
 *  its work; story 187 landed chore dispatch while three chores sat planned for half an
 *  hour. Both times the live process predated the fix. These are the three sentences that
 *  would have said it: a lease carries the build it was taken by, a build the base has
 *  moved past is reported as drift with the count, and a current build is quiet. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  A_RESTART_IS_OWED,
  buildBehind,
  buildSha,
  checkRunner,
  readLease,
  recordBuildDrift,
  renewLease,
  runnerBuildIsCurrent,
  RUNNER_INVARIANTS,
  takeLease,
  type RunnerBuild,
} from "../src/index.js";
import { freshDb } from "./helpers.js";
import { tmp } from "./tmpdir.js";

const EVERY = 15_000;
const T0 = "2026-09-15T10:00:00.000Z";
const BUILT = "1111111111111111111111111111111111111111";

let db: DatabaseSync;

beforeEach(() => {
  db = freshDb();
});

const running = (r: Partial<RunnerBuild> = {}): RunnerBuild => ({ holder: "host/1", ...r });

describe("the lease says what the holder is running", () => {
  it("carries the commit the holder was built from, beside the holder and the heartbeat", () => {
    expect(takeLease(db, "host/1", EVERY, T0, BUILT).ok).toBe(true);
    const lease = readLease(db);
    expect(lease?.holder).toBe("host/1");
    expect(lease?.heartbeat).toBe(T0);
    expect(lease?.buildSha).toBe(BUILT);
  });

  it("says nothing about a build that cannot say, rather than inventing one", () => {
    takeLease(db, "host/1", EVERY, T0);
    expect(readLease(db)?.buildSha).toBeUndefined();
    expect(readLease(db)?.buildBehind).toBeUndefined();
  });

  it("keeps the build across renewals — a running process does not change what it is", () => {
    takeLease(db, "host/1", EVERY, T0, BUILT);
    expect(renewLease(db, "host/1", "2026-09-15T10:00:15.000Z")).toBe(true);
    expect(readLease(db)?.buildSha).toBe(BUILT);
  });

  it("replaces the build when a different runner takes the lease over", () => {
    takeLease(db, "host/1", EVERY, T0, BUILT);
    const later = new Date(Date.parse(T0) + 10 * EVERY).toISOString();
    takeLease(db, "host/2", EVERY, later, "2222222222222222222222222222222222222222");
    expect(readLease(db)?.buildSha).toBe("2222222222222222222222222222222222222222");
    expect(readLease(db)?.buildBehind).toBeUndefined(); // the new process has not measured yet
  });

  it("lets only the holder say how far behind its build is", () => {
    takeLease(db, "host/1", EVERY, T0, BUILT);
    recordBuildDrift(db, "host/2", 9);
    expect(readLease(db)?.buildBehind).toBeUndefined();
    recordBuildDrift(db, "host/1", 3);
    expect(readLease(db)?.buildBehind).toBe(3);
  });
});

describe("the build is read from the build and not from the working tree", () => {
  const git = (dir: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  const commit = (dir: string, name: string): string => {
    writeFileSync(join(dir, name), name);
    git(dir, "add", "-A");
    git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", name);
    return git(dir, "rev-parse", "HEAD");
  };

  /** A repository that stands in for an install: the build is made at one commit and the
   *  checkout then moves on, exactly as it does when a fix lands under a live runner. */
  const repo = (): string => {
    const dir = tmp("wecode-build-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    commit(dir, "one");
    return dir;
  };

  it("counts the commits the base has gained since the build", () => {
    const dir = repo();
    const built = buildSha(dir);
    expect(built).toBe(git(dir, "rev-parse", "HEAD"));
    expect(buildBehind(built, "HEAD", dir)).toBe(0);
    commit(dir, "two");
    commit(dir, "three");
    // The process kept its sha; the checkout moved. That difference is the whole story.
    expect(buildBehind(built, "HEAD", dir)).toBe(2);
    expect(buildSha(dir)).toBe(built);
  });

  it("answers nothing, rather than zero, where there is no git to ask", () => {
    const bare = tmp("wecode-nogit-");
    expect(buildBehind(null, "HEAD", bare)).toBeNull();
  });
});

describe("the runner's build is an ancestor of the base", () => {
  it("is quiet about a current build", () => {
    expect(runnerBuildIsCurrent(running({ buildSha: BUILT, behind: 0 }))).toEqual([]);
  });

  it("is quiet about a holder that has not measured, and about no holder at all", () => {
    expect(runnerBuildIsCurrent(running({ buildSha: BUILT }))).toEqual([]);
    expect(runnerBuildIsCurrent(null)).toEqual([]);
  });

  it("reports a build behind the base as drift, with the count and the restart owed", () => {
    const found = runnerBuildIsCurrent(running({ buildSha: BUILT, behind: 7 }));
    expect(found).toHaveLength(1);
    expect(found[0]?.invariant).toBe("runner_build_is_current");
    expect(found[0]?.entity).toBe("runner");
    expect(found[0]?.slug).toBe("host/1");
    expect(found[0]?.detail).toContain("7 commits behind the base");
    expect(found[0]?.detail).toContain(BUILT.slice(0, 12));
    expect(found[0]?.detail).toContain(A_RESTART_IS_OWED);
  });

  it("counts one commit as a commit", () => {
    const found = runnerBuildIsCurrent(running({ buildSha: BUILT, behind: 1 }));
    expect(found[0]?.detail).toContain("1 commit behind the base");
  });

  it("is one of the runner invariants a pass runs, so nobody has to ask for it", () => {
    expect(RUNNER_INVARIANTS.map((i) => i.name)).toContain("runner_build_is_current");
    const found = checkRunner(running({ buildSha: BUILT, behind: 4 }));
    expect(found.map((v) => v.invariant)).toContain("runner_build_is_current");
    expect(checkRunner(null)).toEqual([]);
  });

  it("judges the lease the runner actually wrote", () => {
    takeLease(db, "host/1", EVERY, T0, BUILT);
    recordBuildDrift(db, "host/1", 2);
    const lease = readLease(db);
    const found = runnerBuildIsCurrent(
      running({
        holder: lease?.holder ?? "",
        ...(lease?.buildSha === undefined ? {} : { buildSha: lease.buildSha }),
        ...(lease?.buildBehind === undefined ? {} : { behind: lease.buildBehind }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("2 commits behind the base");
  });
});
