import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { A_RESTART_IS_OWED, Maker, open, recordBuildDrift, takeLease } from "@wecode/core";
import { BUILD_CHECK, Doctor, RUNNER_INVARIANTS, lastPass, runningBuild, violations, type Git } from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19: landing a fix changes nothing until the process restarts. The runner of
 *  record writes its build's commit and, each tick, how far the base has moved past it — and
 *  until now nothing read that back. The doctor is where a person already looks for drift,
 *  so a build the base has left behind is reported there, in the same shape and the same
 *  table as every other violation.
 *
 *  It accuses nobody it cannot count: no lease, no measurement, or a measurement of zero is
 *  silence. And it heals nothing — only a person may restart a runner. */

const BUILT = "4f1c9a0dbe35a1c7e2d5b8064f3a91cc7e5d2b10";

let dir: string;
let db: DatabaseSync;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  dir = tmp("wecode-stale-build-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@localhost");
  writeFileSync(join(dir, "README.md"), "the base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");

  db = open(join(dir, "wecode.db"));
  const make = new Maker(db);
  make.project(make.workspace("acme", dir), "storefront", dir);
});

/** A git that resolves the base and puts every branch in it: the record's own checks have
 *  nothing to say, so what the report holds is this story's line and only it. */
const answering: Git = (args) => (args[0] === "rev-list" ? "0" : "seed");

const doctor = (): Doctor => new Doctor(db, RUNNER_INVARIANTS, answering, "main");

/** A runner of record, with what it is running and what it has measured of the base. */
const holding = (behind: number | null, build: string | null = BUILT): void => {
  takeLease(db, "host/1", 30_000, "2026-09-20T10:00:00.000Z", build);
  recordBuildDrift(db, "host/1", behind);
};

const named = (): readonly string[] => violations(db).filter((v) => v.invariant === BUILD_CHECK).map((v) => v.detail);

describe("the doctor on a running build the base has moved past", () => {
  it("says so, naming the build and how far behind it is", () => {
    holding(7);

    const found = doctor().check();

    expect(found.filter((v) => v.invariant === BUILD_CHECK)).toEqual([
      {
        invariant: BUILD_CHECK,
        entity: "runner",
        id: null,
        slug: "host/1",
        detail: `built from ${BUILT.slice(0, 12)}, 7 commits behind the base — ${A_RESTART_IS_OWED}`,
      },
    ]);
  });

  it("records it, so a view reads the drift without running a pass of its own", () => {
    holding(2);

    doctor().check();

    expect(named()).toEqual([`built from ${BUILT.slice(0, 12)}, 2 commits behind the base — ${A_RESTART_IS_OWED}`]);
  });

  it("counts in the singular when the base is one commit ahead", () => {
    holding(1);

    doctor().check();

    expect(named()[0]).toContain("1 commit behind the base");
  });

  it("names an unnamed commit rather than guessing, when the build could not say what it is", () => {
    holding(3, null);

    doctor().check();

    expect(named()[0]).toBe(`built from an unnamed commit, 3 commits behind the base — ${A_RESTART_IS_OWED}`);
  });

  it("says it looked, so a current build is told apart from one nobody asked about", () => {
    holding(0);

    doctor().check();

    expect(named()).toEqual([]);
    expect(lastPass(db)?.looked.find((l) => l.invariant === BUILD_CHECK)).toEqual({
      invariant: BUILD_CHECK,
      world: false,
      reachable: true,
      found: 0,
    });
  });

  it("is quiet about a holder that has not measured yet", () => {
    holding(null);

    doctor().check();

    expect(named()).toEqual([]);
  });

  it("claims no pass over a workspace nobody holds, rather than one that found nothing", () => {
    doctor().check();

    expect(named()).toEqual([]);
    expect(lastPass(db)?.looked.map((l) => l.invariant)).not.toContain(BUILD_CHECK);
  });

  it("heals nothing: the report is the whole of it, and the lease still says what it said", () => {
    holding(7);

    doctor().check();

    expect(runningBuild(db)).toEqual({ holder: "host/1", buildSha: BUILT, behind: 7 });
  });

  it("has nobody to ask on a record with no lease table at all", () => {
    expect(runningBuild(open(join(dir, "bare.db")))).toBeNull();
  });

  it("leaves the pure set alone, so core and the cli still agree on what they share", () => {
    expect(RUNNER_INVARIANTS.map((i) => i.name)).not.toContain(BUILD_CHECK);
  });
});
