import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Maker, open } from "@wecode/core";
import { redAtBase } from "../src/doctor.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The doctor lists the files that fail at the base.
 *
 *  A ready acceptance test is run once at the commit its story was cut from, and red there is
 *  what makes it proof. That sha sits on the test, which answers "did this test earn its
 *  keep". The question a scope author has is the other end of it: which files in this tree are
 *  red before anybody touches them, so that a gate never names one. That list is what this
 *  reads back — the file the plan spec'd in `script_path`, never a guess off a command line. */

let dir: string;
let db: DatabaseSync;
let make: Maker;
let criteria: number;

/** A ready-shaped acceptance test with the given script, and the base run the runner would
 *  have recorded against it. `sha` of null is a test nobody has run at a base yet. */
function test(statement: string, script: string | null, sha: string | null): number {
  const at = make.acceptanceTest(criteria, statement, "script", "pnpm vitest run", script);
  if (sha !== null) db.prepare("UPDATE acceptance_test SET red_at_base_sha = ? WHERE id = ?").run(sha, at);
  return at;
}

beforeEach(() => {
  dir = tmp("wecode-red-files-");
  db = open(join(dir, "wecode.db"));
  make = new Maker(db);
  const workspace = make.workspace("acme", dir);
  const project = make.project(workspace, "storefront", dir);
  const story = make.story(make.epic(make.release(project, "1.0.0"), "recovery"), "password reset");
  criteria = make.criteria(make.requirement(story, "one change per link"), "emailed in 60s");
});

describe("the doctor lists the files that fail at the base", () => {
  it("says nothing of a record where nothing has been run at a base", () => {
    test("mail arrives", "packages/mail/test/mail.test.ts", null);
    expect(redAtBase(db)).toEqual([]);
  });

  it("names the file of a test that was watched failing, and the commit it failed at", () => {
    test("mail arrives", "packages/mail/test/mail.test.ts", "deadbee");
    expect(redAtBase(db)).toEqual([
      { file: "packages/mail/test/mail.test.ts", test: "mail-arrives", sha: "deadbee" },
    ]);
  });

  it("leaves out the test that passed at its base, which is the one that proves nothing", () => {
    test("mail arrives", "packages/mail/test/mail.test.ts", "deadbee");
    test("the link expires", "packages/mail/test/expiry.test.ts", null);
    expect(redAtBase(db).map((r) => r.file)).toEqual(["packages/mail/test/mail.test.ts"]);
  });

  it("leaves out a red test whose plan never said where its script lives, rather than guessing", () => {
    test("mail arrives", null, "deadbee");
    expect(redAtBase(db)).toEqual([]);
  });

  it("names a file once, by the first test that proved it: two tests over one file is one fact", () => {
    test("mail arrives", "packages/mail/test/mail.test.ts", "deadbee");
    test("the link expires", "packages/mail/test/mail.test.ts", "cafe123");
    expect(redAtBase(db)).toEqual([
      { file: "packages/mail/test/mail.test.ts", test: "mail-arrives", sha: "deadbee" },
    ]);
  });

  it("lists in record order, so two identical passes read the same", () => {
    test("mail arrives", "packages/mail/test/mail.test.ts", "deadbee");
    test("the link expires", "packages/mail/test/expiry.test.ts", "deadbee");
    test("the link is one use", "packages/mail/test/once.test.ts", "deadbee");
    const files = ["packages/mail/test/mail.test.ts", "packages/mail/test/expiry.test.ts", "packages/mail/test/once.test.ts"];
    expect(redAtBase(db).map((r) => r.file)).toEqual(files);
    expect(redAtBase(db)).toEqual(redAtBase(db));
  });

  it("reads back what a second story added, because the list is of the tree and not of one story", () => {
    test("mail arrives", "packages/mail/test/mail.test.ts", "deadbee");
    const other = make.story(make.epic(make.release(make.project(make.workspace("b", dir), "p", dir), "2.0.0"), "e"), "reset again");
    const c = make.criteria(make.requirement(other, "r"), "c");
    const at = make.acceptanceTest(c, "the token rotates", "script", "pnpm vitest run", "packages/auth/test/token.test.ts");
    db.prepare("UPDATE acceptance_test SET red_at_base_sha = ? WHERE id = ?").run("cafe123", at);
    expect(redAtBase(db).map((r) => r.file)).toEqual([
      "packages/mail/test/mail.test.ts",
      "packages/auth/test/token.test.ts",
    ]);
  });
});
