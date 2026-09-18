import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { INVARIANTS, Maker, open, type Snapshot, type Violation } from "@wecode/core";
import {
  Doctor,
  lastPass,
  RUNNER_INVARIANTS,
  SNAPSHOT_STEP,
  violations,
  WORLD_CHECK,
  type Git,
  type Invariant,
} from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** docs/design/19: a report of nothing is a claim, and a claim needs to say what was
 *  examined to make it. These tests are the difference between the two records a view
 *  cannot otherwise tell apart — a pass that ran every check and found nothing, and no
 *  pass at all. */

let dir: string;
let db: DatabaseSync;
let make: Maker;
let epic: number;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  dir = tmp("wecode-pass-looked-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@localhost");
  writeFileSync(join(dir, "README.md"), "the base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");

  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  const project = make.project(make.workspace("acme", dir), "storefront", dir);
  epic = make.epic(make.release(project, "1.0.0"), "recovery");
});

/** A git that resolves the base and puts every branch in it. Enough for the world check to
 *  have really been asked. */
const answering: Git = (args) => (args[0] === "rev-list" ? "0" : "seed");

/** A git with no repository behind it: the base does not resolve, so the world check ran
 *  over a world it could not read. */
const missing: Git = () => {
  throw new Error("not a git repository");
};

const doctor = (g: Git = answering): Doctor => new Doctor(db, RUNNER_INVARIANTS, g, "main");

const names = (): readonly string[] => (lastPass(db)?.looked ?? []).map((l) => l.invariant);

describe("what a pass says it looked at", () => {
  it("is nothing at all before any pass has run", () => {
    // The table exists — the constructor makes it — and is still empty. Nobody looked.
    expect(lastPass(db)).toBeNull();
  });

  it("is nothing at all on a record no doctor has ever touched", () => {
    const untouched = open(join(dir, "other.db"));
    expect(lastPass(untouched)).toBeNull();
  });

  it("names every check the pass ran, in the order it ran them", () => {
    doctor().check();

    expect(names()).toEqual(RUNNER_INVARIANTS.map((i) => i.name));
  });

  it("tells a clean record from an unexamined one", () => {
    doctor().check();

    // The two halves of the story: nothing found, and the list of what was examined to
    // say so. A view with only the first cannot tell this from the state before the pass.
    expect(violations(db)).toEqual([]);
    expect(lastPass(db)?.looked.every((l) => l.found === 0)).toBe(true);
    expect(lastPass(db)?.looked.length).toBe(RUNNER_INVARIANTS.length);
  });

  it("counts what each check found against the check that found it", () => {
    const story = make.story(epic, "password reset");
    db.exec(`UPDATE story SET state = 'delivered' WHERE id = ${story}`);

    const found = doctor(() => {
      throw new Error("no such ref");
    }).check();

    expect(found.map((v) => v.invariant)).toContain(WORLD_CHECK);
    const world = lastPass(db)?.looked.find((l) => l.invariant === WORLD_CHECK);
    expect(world?.found).toBe(1);
    // Every other check ran too, and said so with a zero rather than an absence.
    expect(lastPass(db)?.looked.filter((l) => l.found === 0).length).toBe(RUNNER_INVARIANTS.length - 1);
  });

  it("says which checks had to ask the world", () => {
    doctor().check();

    const asked = lastPass(db)?.looked.filter((l) => l.world) ?? [];
    expect(asked.map((l) => l.invariant)).toEqual([WORLD_CHECK]);
  });

  it("does not claim the world was read when there was no repository to read", () => {
    doctor(missing).check();

    const asked = lastPass(db)?.looked.find((l) => l.invariant === WORLD_CHECK);
    expect(asked?.reachable).toBe(false);
    // A pure check reads only the record, which was there: its answer stands.
    expect(lastPass(db)?.looked.filter((l) => !l.world).every((l) => l.reachable)).toBe(true);
  });

  it("says the world was read when it was", () => {
    doctor().check();

    expect(lastPass(db)?.looked.find((l) => l.invariant === WORLD_CHECK)?.reachable).toBe(true);
  });

  it("names a check that threw, so an unevaluated check is not read as a quiet one", () => {
    const throws: Invariant = {
      name: "the_moon_is_where_we_left_it",
      check: (): readonly Violation[] => {
        throw new Error("the moon moved");
      },
    };

    new Doctor(db, [...INVARIANTS, throws], answering, "main").check();

    expect(names()).toContain(throws.name);
    expect(lastPass(db)?.looked.find((l) => l.invariant === throws.name)?.found).toBe(1);
  });

  it("says the pass got no further than the snapshot when the record could not be read", () => {
    db.exec("DROP TABLE story");

    const found = doctor().check();

    expect(found.map((v) => v.invariant)).toEqual([SNAPSHOT_STEP]);
    // Not an empty list: the pass came, and this is how far it got.
    expect(names()).toEqual([SNAPSHOT_STEP]);
  });

  it("is replaced whole by the next pass, so it is always the last one", () => {
    new Doctor(db, INVARIANTS, answering, "main").check();
    expect(names()).toEqual(INVARIANTS.map((i) => i.name));

    doctor().check();

    expect(names()).toEqual(RUNNER_INVARIANTS.map((i) => i.name));
    expect(new Set(names()).size).toBe(RUNNER_INVARIANTS.length);
  });

  it("is written in the same transaction as the report it explains", () => {
    const story = make.story(epic, "password reset");
    db.exec(`UPDATE story SET state = 'delivered' WHERE id = ${story}`);
    doctor(() => {
      throw new Error("no such ref");
    }).check();

    const at = lastPass(db)?.at;
    const stamps = (db.prepare("SELECT DISTINCT found_at FROM doctor_violation").all() as { found_at: string }[]).map(
      (r) => r.found_at,
    );

    expect(stamps).toEqual([at]);
  });

  it("stands as the pass's own account, taken over a snapshot rather than a live handle", () => {
    const pure: Invariant = {
      name: "reads_only_the_snapshot",
      check: (s: Snapshot): readonly Violation[] => (s.nodes.length === 0 ? [] : []),
    };

    new Doctor(db, [pure], answering, "main").check();

    expect(lastPass(db)?.looked).toEqual([
      { invariant: pure.name, world: false, reachable: true, found: 0 },
    ]);
  });
});
