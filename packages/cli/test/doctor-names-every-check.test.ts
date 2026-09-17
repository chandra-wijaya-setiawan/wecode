import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INVARIANTS, open } from "@wecode/core";
import { UnknownFile, type Purpose, type Reading, type RepoIndex, type Use } from "@wecode/explorer";
import { checksOf, doctor, examined, roll, rollCall, type Reported } from "../src/doctor.js";
import { TREE_INVARIANTS } from "../src/unimported.js";
import { recordRed, seed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** An index that holds nothing: every file is one it has never read.
 *
 *  The tree half's *findings* are proved in `unimported-export.test.ts` against a reader of
 *  a real fixture. What is being proved here is only that the check ran at all, so the
 *  cheapest honest index is one that answers "not a module I hold" to everything — it makes
 *  the tree pass return no violations without making it a pass that did not happen. */
class Empty implements RepoIndex {
  constructor(readonly root: string) {}
  async read(file: string): Promise<Reading> {
    throw new UnknownFile(file, this.root);
  }
  async usesOf(file: string, _symbol: string): Promise<readonly Use[]> {
    throw new UnknownFile(file, this.root);
  }
  async purposeOf(file: string): Promise<Purpose> {
    throw new UnknownFile(file, this.root);
  }
}

/** A repository for the tree half to ask `ls-files` of, and for `worldOf` to resolve HEAD
 *  in. One commit, because a base nobody can name is the unreachable case below. */
let repo: string;

beforeAll(() => {
  repo = tmp("wecode-roll-repo-");
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@localhost");
  git("commit", "-q", "--allow-empty", "-m", "seed");
});

let out: string[];
let db: DatabaseSync;
let dbPath: string;
let exitCode: number | string | undefined;

beforeEach(() => {
  dbPath = join(tmp("wecode-roll-db-"), "wecode.db");
  db = open(dbPath);
  const ids = seed(db);
  recordRed(db, ids.acceptance);
  // The seed names `/repo`, which is nowhere, and every git-answered check would go
  // unanswered. The record points at the fixture checkout so the default is a pass that
  // could ask the world.
  db.prepare("UPDATE project SET repo = ?").run(repo);
  out = [];
  exitCode = process.exitCode;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  db.close();
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

const said = (): string => out.join("");

const ask = (...args: string[]): number => doctor([dbPath, ...args], (r) => new Empty(r));

/** The line the roll-call gives a check, without the leading indent. */
const lineFor = (name: string): string =>
  said()
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${name} —`)) ?? `<${name} is not in the roll-call>`;

/** Every check a pass could know about: core's pure set and the tree half's, which is the
 *  whole roster the story asks to be reported. Read off the sources rather than written out
 *  here, so a check added to either one fails these tests until it is reported. */
const EVERY_CHECK = [...INVARIANTS.map((i) => i.name), ...TREE_INVARIANTS.map((i) => i.name)];

describe("wecode doctor --checks", () => {
  it("names every check a pass knows, not only the broken ones", () => {
    expect(ask("--checks")).toBe(0);
    for (const name of EVERY_CHECK) expect(said()).toContain(name);
    // The roster is not one check long, and it is not only what core owns.
    expect(EVERY_CHECK.length).toBeGreaterThan(1);
  });

  it("says a check held rather than saying nothing about it", () => {
    ask("--checks");
    expect(lineFor("story_in_progress_has_a_requirement")).toBe("story_in_progress_has_a_requirement — held");
  });

  it("marks the tree half as not run, and why, when --tree was not asked for", () => {
    ask("--checks");
    expect(lineFor("export_is_imported_somewhere")).toBe(
      "export_is_imported_somewhere — not run — the tree half was not asked for — --tree",
    );
  });

  it("does not call it held when nobody ran it", () => {
    ask("--checks");
    expect(lineFor("export_is_imported_somewhere")).not.toContain("held");
  });

  it("marks the git-answered check as not run, and why, with no repository to ask", () => {
    db.prepare("UPDATE project SET repo = ?").run(join(tmpdir(), "wecode-roll-absent-repo"));

    ask("--checks");

    expect(lineFor("delivered_story_has_landed")).toBe("delivered_story_has_landed — not run — no repository to ask");
    // The rest of the pass still reports: one unanswerable check is not a pass that failed.
    expect(lineFor("story_in_progress_has_a_requirement")).toBe("story_in_progress_has_a_requirement — held");
  });

  it("says the git-answered check ran when the repository was there", () => {
    ask("--checks");
    expect(lineFor("delivered_story_has_landed")).toBe("delivered_story_has_landed — held");
  });

  it("counts what each check accused, so a broken one is not merely listed", () => {
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = (SELECT MIN(id) FROM story)").run();

    expect(ask("--checks")).toBe(1);

    expect(lineFor("delivered_story_has_landed")).toBe("delivered_story_has_landed — broken by 1 entity");
  });

  it("tallies how many checks ran and how many did not", () => {
    ask("--checks");
    const run = checksOf().length;
    expect(said()).toContain(`${run + TREE_INVARIANTS.length} checks — ${run} run, ${TREE_INVARIANTS.length} not run`);
  });

  it("waits for the tree half before reporting it, rather than guessing", async () => {
    ask("--checks", "--tree", "--entry=src/index.ts");

    // Nothing is said about the tree check yet: the pass that would answer it is in flight.
    expect(lineFor("export_is_imported_somewhere")).toBe("<export_is_imported_somewhere is not in the roll-call>");
    await examined();
    expect(lineFor("export_is_imported_somewhere")).toBe("export_is_imported_somewhere — held");
  });

  it("says nothing at all without the flag, which is what the tick runs", () => {
    expect(ask()).toBe(0);
    expect(said()).toBe("");
  });
});

describe("the roll-call itself", () => {
  const world = { ancestry: () => "in" as const, reachable: true };

  it("holds one row per check, and no more", () => {
    const rows: readonly Reported[] = roll([], world, []);
    expect(rows.map((r) => r.name)).toEqual(EVERY_CHECK);
  });

  it("keeps 'did not run' and 'found nothing' apart", () => {
    const unreachable = roll([], { ...world, reachable: false }, null);
    const named = new Map(unreachable.map((r) => [r.name, r]));

    // Both have a zero count. Only one of them was actually asked.
    expect(named.get("delivered_story_has_landed")).toEqual({
      name: "delivered_story_has_landed",
      skipped: "no repository to ask",
      found: 0,
    });
    expect(named.get("story_in_progress_has_a_requirement")?.skipped).toBeNull();
  });

  it("attributes a violation to the check that raised it and to no other", () => {
    const found = [
      { invariant: "delivered_story_has_landed", entity: "story", id: 1, slug: "reset", detail: "no landed_sha" },
    ];
    const named = new Map(roll(found, world, []).map((r) => [r.name, r.found]));

    expect(named.get("delivered_story_has_landed")).toBe(1);
    expect([...named].filter(([, n]) => n > 0)).toHaveLength(1);
  });

  it("prints every row it was given, whatever became of each", () => {
    const said = rollCall([
      { name: "a_held", skipped: null, found: 0 },
      { name: "b_broke", skipped: null, found: 2 },
      { name: "c_unrun", skipped: "nobody asked", found: 0 },
    ]);

    expect(said).toContain("3 checks — 2 run, 1 not run");
    expect(said).toContain("  a_held — held");
    expect(said).toContain("  b_broke — broken by 2 entities");
    expect(said).toContain("  c_unrun — not run — nobody asked");
  });
});
