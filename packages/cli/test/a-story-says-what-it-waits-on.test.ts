/** A story says what it waits on: the two verbs that declare it, and the two lines that
 *  show it.
 *
 *  `wecode story depends <id> --on <id>` declares an edge and refuses in words the one
 *  that would close a cycle; `wecode story priority <id> --to <n>` sets the number that
 *  breaks the ties left over; `wecode show story <id>` names what it depends on and what
 *  depends on it. All three bodies are `src/depends-verbs.ts` and are proved here at that
 *  module's own boundary, the way `verbs/work.test.ts` proves `work.task()` — with one
 *  difference worth writing down, because a reader will look for the other half:
 *
 *  run.ts is not in this task's scope, and it cannot be: `each-verb-module-s-tests-are-
 *  their-own-file.test.ts` pins it at exactly 515 lines against its row in project.yaml,
 *  so the import and the three lines that dispatch to this module are a change to three
 *  files this task may not write. So there is no `run([...])` here reaching these verbs
 *  through the command line; when the wiring lands it belongs with a test that types the
 *  command. What this file holds is every claim the criterion makes about the answers.
 *
 *  ── the record the verbs write ──
 *
 *  `story_depends_on` and `story.priority` belong to `017-story-depends-on.sql`, a file
 *  another task owns and which is not in the tree yet. `theRecordKeepsEdges()` below
 *  stands both shapes up so these verbs can be proved against the record they are written
 *  for. It creates only what is absent, so once the migration lands this is a no-op — and
 *  if the migration spells either shape differently, these tests go red at the seam
 *  rather than the verbs going quietly wrong in a real workspace. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATOR, open, type Actor } from "@wecode/core";
import { queries, type Dialect } from "@wecode/core/dist/db.js";
import { run } from "../src/run.js";
import * as dep from "../src/depends-verbs.js";
import { type At } from "../src/verbs/entity.js";
import { tmp } from "../../core/test/tmpdir.js";

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-depends-"), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");
const cried = (): string => err.join("");

const database = (): ReturnType<typeof open> => open(process.env["WECODE_DB"] as string);
const q = (): Dialect => queries(database());

/** The three things only run.ts knows, lent to the verbs the way run.ts lends them. */
const at = (): At => ({
  conn: database,
  fail: (why: string): number => (process.stderr.write(`${why}\n`), 1),
  actor: (): Actor => OPERATOR,
});

/** What migration 017 will add, created here only where it is absent. */
function theRecordKeepsEdges(): void {
  const db = database();
  db.exec(
    `CREATE TABLE IF NOT EXISTS story_depends_on (
       story_id        INTEGER NOT NULL REFERENCES story(id),
       prerequisite_id INTEGER NOT NULL REFERENCES story(id),
       PRIMARY KEY (story_id, prerequisite_id)
     )`,
  );
  const columns = db.prepare("PRAGMA table_info(story)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "priority")) {
    db.exec("ALTER TABLE story ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  }
}

/** Five stories under one epic — the shape story 702 describes: a harness behind a seat,
 *  and a slice of a file handed out before the split it depends on. Five rather than four
 *  because a graph that tells a breadth-first walk from a depth-first one needs two routes
 *  between the same pair, of different lengths, and that takes five nodes. */
const STORIES = [
  "the harness the runner needs",
  "the Antigravity seat",
  "a slice of a long file",
  "the split that slice depends on",
  "the seat's own harness",
] as const;

function someStories(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "1.0.0"]);
  run(["epic", "create", "--parent", "1", "the queue"]);
  for (const title of STORIES) run(["story", "create", "--parent", "1", title]);
  theRecordKeepsEdges();
  out.length = 0;
  err.length = 0;
}

/** Every edge in the record, as `<story> → <prerequisite>` pairs, lowest first. */
const held = (): string[] =>
  q()
    .selectFrom(dep.storyDependsOn)
    .all()
    .map((r) => `${r.story_id} → ${r.prerequisite_id}`)
    .sort();

const priorityOf = (id: number): number =>
  (database().prepare("SELECT priority AS p FROM story WHERE id = ?").get(id) as { p: number }).p;

describe("wecode story depends <id> --on <id>", () => {
  it("declares an edge, and names the story it now waits on", () => {
    someStories();
    expect(dep.depends(at(), ["2", "--on", "1"])).toBe(0);
    expect(said()).toBe(`story #2 depends on story #1  ${STORIES[0]}\n`);
    expect(held()).toEqual(["2 → 1"]);
  });

  it("is not an error the second time: a fact stated twice is the same fact", () => {
    someStories();
    expect(dep.depends(at(), ["2", "--on", "1"])).toBe(0);
    out.length = 0;
    expect(dep.depends(at(), ["2", "--on", "1"])).toBe(0);
    expect(cried()).toBe("");
    expect(said()).toContain("story #2 depends on story #1");
    // One row, not two: re-declaring states the edge, it does not add one.
    expect(held()).toEqual(["2 → 1"]);
  });

  it("lets a story declare many, and lets a prerequisite be shared", () => {
    someStories();
    expect(dep.depends(at(), ["3", "--on", "4"])).toBe(0);
    expect(dep.depends(at(), ["3", "--on", "1"])).toBe(0);
    expect(dep.depends(at(), ["2", "--on", "1"])).toBe(0);
    expect(held()).toEqual(["2 → 1", "3 → 1", "3 → 4"]);
  });

  it("refuses a story that is not there, on either end, naming the ids that are", () => {
    someStories();
    expect(dep.depends(at(), ["9", "--on", "1"])).toBe(1);
    expect(cried()).toContain("no story #9. These story ids exist:");
    expect(cried()).toContain(`#1  ${STORIES[0]}`);
    err.length = 0;
    expect(dep.depends(at(), ["1", "--on", "9"])).toBe(1);
    expect(cried()).toContain("no story #9");
    expect(held()).toEqual([]);
  });

  it("answers the usage line when the flag is missing, unknown or not a number", () => {
    someStories();
    const how = "wecode story depends <id> --on <id>";
    for (const args of [[], ["2"], ["2", "--on"], ["2", "--on", "later"], ["--on", "1"], ["2", "--upon", "1"]]) {
      err.length = 0;
      expect(dep.depends(at(), args), args.join(" ")).toBe(1);
      expect(cried(), args.join(" ")).toContain(how);
    }
    expect(held()).toEqual([]);
  });
});

describe("the cycle refusal, in words", () => {
  it("refuses the edge that closes a ring of two, naming the path", () => {
    someStories();
    expect(dep.depends(at(), ["2", "--on", "1"])).toBe(0);
    out.length = 0;
    expect(dep.depends(at(), ["1", "--on", "2"])).toBe(1);
    expect(cried()).toContain("story #1 cannot depend on story #2");
    expect(cried()).toContain("that closes a cycle, #1 → #2 → #1");
    expect(cried()).toContain("#2 already waits on #1");
    // Refused is refused: the edge is not written, and nothing is printed as if it were.
    expect(held()).toEqual(["2 → 1"]);
    expect(said()).toBe("");
  });

  it("refuses one that closes through any number of hops, naming every hop", () => {
    someStories();
    // 1 waits on 2, 2 waits on 3, 3 waits on 4 — so 4 may not wait on 1.
    expect(dep.depends(at(), ["1", "--on", "2"])).toBe(0);
    expect(dep.depends(at(), ["2", "--on", "3"])).toBe(0);
    expect(dep.depends(at(), ["3", "--on", "4"])).toBe(0);
    err.length = 0;
    expect(dep.depends(at(), ["4", "--on", "1"])).toBe(1);
    expect(cried()).toContain("that closes a cycle, #4 → #1 → #2 → #3 → #4");
    expect(held()).toEqual(["1 → 2", "2 → 3", "3 → 4"]);
  });

  it("names the shortest ring when the graph offers more than one", () => {
    someStories();
    // 1 reaches 4 the long way round (1 → 2 → 3 → 4) and the short way (1 → 4).
    expect(dep.depends(at(), ["1", "--on", "2"])).toBe(0);
    expect(dep.depends(at(), ["2", "--on", "3"])).toBe(0);
    expect(dep.depends(at(), ["3", "--on", "4"])).toBe(0);
    expect(dep.depends(at(), ["1", "--on", "4"])).toBe(0);
    err.length = 0;
    expect(dep.depends(at(), ["4", "--on", "1"])).toBe(1);
    expect(cried()).toContain("that closes a cycle, #4 → #1 → #4");
  });

  it("names the shortest ring even when the long way is the branch explored last", () => {
    someStories();
    // #1 reaches #5 twice over: through #2 in two hops, and through #3 → #4 in three.
    // The walk takes #1's prerequisites lowest first, so the three-hop branch is the one
    // still on the stack when the two-hop branch is reached — a walk that finished the
    // newest branch before trying the oldest would name #1 → #3 → #4 → #5 instead.
    for (const [waiter, on] of [["1", "2"], ["2", "5"], ["1", "3"], ["3", "4"], ["4", "5"]]) {
      expect(dep.depends(at(), [waiter as string, "--on", on as string])).toBe(0);
    }
    err.length = 0;
    expect(dep.depends(at(), ["5", "--on", "1"])).toBe(1);
    expect(cried()).toContain("that closes a cycle, #5 → #1 → #2 → #5");
    expect(cried()).not.toContain("#4");
  });

  it("refuses a story that would wait on itself, which is a cycle of one", () => {
    someStories();
    expect(dep.depends(at(), ["3", "--on", "3"])).toBe(1);
    expect(cried()).toContain("story #3 cannot depend on itself");
    expect(cried()).toContain("#3 → #3");
    expect(held()).toEqual([]);
  });

  it("allows the diamond, which shares a prerequisite and closes nothing", () => {
    someStories();
    expect(dep.depends(at(), ["1", "--on", "2"])).toBe(0);
    expect(dep.depends(at(), ["1", "--on", "3"])).toBe(0);
    expect(dep.depends(at(), ["2", "--on", "4"])).toBe(0);
    expect(dep.depends(at(), ["3", "--on", "4"])).toBe(0);
    expect(cried()).toBe("");
    expect(held()).toEqual(["1 → 2", "1 → 3", "2 → 4", "3 → 4"]);
  });
});

describe("wecode story priority <id> --to <n>", () => {
  it("sets the number, and says what it was", () => {
    someStories();
    expect(dep.priority(at(), ["2", "--to", "7"])).toBe(0);
    expect(said()).toBe("story #2 priority 7  was 0\n");
    expect(priorityOf(2)).toBe(7);
    out.length = 0;
    expect(dep.priority(at(), ["2", "--to", "3"])).toBe(0);
    expect(said()).toBe("story #2 priority 3  was 7\n");
    expect(priorityOf(2)).toBe(3);
  });

  it("takes a negative, because the order is descending and some work can wait", () => {
    someStories();
    // Both spellings: parseArgs reads `-2` as a short option, and a person should not have
    // to know that. `--to=-2` is the shape it does accept, and it keeps working.
    expect(dep.priority(at(), ["4", "--to", "-2"])).toBe(0);
    expect(priorityOf(4)).toBe(-2);
    expect(dep.priority(at(), ["4", "--to=-5"])).toBe(0);
    expect(priorityOf(4)).toBe(-5);
  });

  it("touches only the story it was given", () => {
    someStories();
    expect(dep.priority(at(), ["2", "--to", "9"])).toBe(0);
    expect([1, 3, 4].map(priorityOf)).toEqual([0, 0, 0]);
  });

  it("refuses anything that is not a whole number", () => {
    someStories();
    for (const bad of ["soon", "1.5", "", "3x"]) {
      err.length = 0;
      expect(dep.priority(at(), ["2", "--to", bad]), bad).toBe(1);
      expect(cried(), bad).toContain("a priority is a whole number");
    }
    expect(priorityOf(2)).toBe(0);
  });

  it("answers the usage line when the id or the flag is missing", () => {
    someStories();
    for (const args of [[], ["2"], ["--to", "3"], ["2", "--at", "3"]]) {
      err.length = 0;
      expect(dep.priority(at(), args), args.join(" ")).toBe(1);
      expect(cried(), args.join(" ")).toContain("wecode story priority <id> --to <n>");
    }
  });

  it("refuses a story that is not there, naming the ids that are", () => {
    someStories();
    expect(dep.priority(at(), ["9", "--to", "1"])).toBe(1);
    expect(cried()).toContain("no story #9. These story ids exist:");
  });
});

describe("the two lines show adds", () => {
  it("names what the story depends on and what depends on it", () => {
    someStories();
    dep.depends(at(), ["2", "--on", "1"]);
    dep.depends(at(), ["2", "--on", "4"]);
    dep.depends(at(), ["3", "--on", "2"]);
    expect(dep.edges(q(), 2)).toBe(
      `depends on         #1 ${STORIES[0]}, #4 ${STORIES[3]}\n` +
        `depended on by     #3 ${STORIES[2]}\n`,
    );
  });

  it("is two lines, and says nothing rather than leaving one out", () => {
    someStories();
    const shown = dep.edges(q(), 1);
    expect(shown.split("\n").filter((l) => l !== "")).toEqual([
      "depends on         nothing",
      "depended on by     nothing",
    ]);
  });

  it("pads the field to the eighteen columns show pads every other one to", () => {
    someStories();
    dep.depends(at(), ["1", "--on", "2"]);
    for (const line of dep.edges(q(), 1).split("\n").filter((l) => l !== "")) {
      // `show` writes `${k.padEnd(18)} ${v}` — eighteen, then one space, then the answer.
      expect(line.slice(0, 18), line).toMatch(/^(depends on|depended on by) +$/);
      expect(line.slice(18, 19), line).toBe(" ");
      expect(line.slice(19, 20), line).not.toBe(" ");
    }
  });

  /** This pins the answer, not the mechanism, and a sweep says so: `story_depends_on`'s
   *  primary key is `(story_id, prerequisite_id)`, so SQLite already hands these back by
   *  prerequisite and dropping the sort in `edges` leaves this green. The sort stays
   *  because a page must not read differently for a reason no line of it states — but the
   *  claim here is only that what is shown is by id. */
  it("reads the graph by id rather than the order the edges were written", () => {
    someStories();
    dep.depends(at(), ["1", "--on", "4"]);
    dep.depends(at(), ["1", "--on", "2"]);
    dep.depends(at(), ["1", "--on", "3"]);
    expect(dep.edges(q(), 1)).toMatch(/depends on\s+#2 [^\n]*, #3 [^\n]*, #4 /);
  });
});

describe("the module run.ts will reach through one import", () => {
  const source = readFileSync(new URL("../src/depends-verbs.ts", import.meta.url), "utf8");

  it("exports the two verbs and the show lines, and nothing else to dispatch to", () => {
    expect(Object.keys(dep).sort()).toEqual(["depends", "edges", "priority", "storyDependsOn"]);
  });

  it("parses no argv it was not given, and does not decide where the workspace is", () => {
    expect(source).not.toContain("process.argv");
    expect(source).not.toContain("currentDatabase");
    expect(source).not.toContain("WECODE_DB");
  });
});
