import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Maker, open } from "@wecode/core";
import { run } from "../src/run.js";
import * as rungs from "../src/verbs/tree.js";
import * as work from "../src/verbs/work.js";
import * as see from "../src/verbs/run-and-see.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The cli has no verb for the red record yet, so a fixture that wants to pass an
 *  acceptance_test writes it into the same database the cli is driving. */
const watchedItFail = (id: number): void => recordRed(open(process.env["WECODE_DB"] as string), id);

/** Nor a verb for the attempt record `task.finish` reads. Settled task_tests no longer
 *  finish a task on their own: the branch has to hold a commit the task wrote, and an
 *  attempt's sha is the only thing that says so. */
const wroteACommit = (task: number, sha = "c0ffee0"): void => {
  const db = open(process.env["WECODE_DB"] as string);
  db.prepare("INSERT OR IGNORE INTO worker (id,slug,name,role,kind,created_at,updated_at) VALUES (1,'w','w','engineer','agent','t','t')").run();
  db.prepare("INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,commit_sha,spent,created_at,updated_at) VALUES (?,'task',?,1,'{}','{}','/tmp','succeeded','work',?,'{}','t','t')").run(sha, task, sha);
  db.close();
};

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(tmp("wecode-cli-"), "wecode.db");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");

describe("the cli", () => {
  it("builds a tree and cascades a pass to a delivered epic", () => {
    expect(run(["init"])).toBe(0);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    run(["release", "create", "--parent", "1", "1.0.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
    run(["requirement", "create", "--parent", "1", "one change per link"]);
    run(["acceptance_criteria", "create", "--parent", "1", "emailed in 60s"]);
    run(["acceptance_test", "create", "--parent", "1", "mail arrives", "--artefact", "bash x.sh"]);
    run(["task", "create", "--parent", "1", "send the mail", "--role", "engineer"]);
    run(["task_test", "create", "--parent", "1", "mailer called", "--artefact", "vitest run"]);

    for (const e of ["project", "release", "epic", "story", "requirement", "acceptance_criteria"]) {
      expect(run([e, "start", "1"])).toBe(0);
    }

    expect(run(["task", "start", "1"])).toBe(1);
    expect(err.join("")).toContain("no write scope");

    run(["task", "scope", "1", "--write", "src/**", "--tools", "bash"]);
    run(["task_test", "deliver", "1"]);
    run(["acceptance_test", "deliver", "1"]);
    expect(run(["task", "start", "1"])).toBe(0);

    out.length = 0;
    run(["task_test", "pass", "1"]);
    // Every task_test is settled, and the task stays ready: nothing on record says it
    // wrote anything, which is the second half of `finish`'s guard.
    expect(said()).not.toContain("task #1");

    out.length = 0;
    wroteACommit(1);
    run(["task_test", "invalidate", "1"]);
    run(["task_test", "pass", "1"]);
    expect(said()).toContain("task #1  ready → done  (cascade)");

    out.length = 0;
    watchedItFail(1);
    run(["acceptance_test", "pass", "1"]);
    expect(said()).toContain("epic #1  in_progress → delivered  (cascade)");
  });

  it("names the legal verbs when one is refused", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p"]);
    expect(run(["project", "release", "1"])).toBe(1);
    expect(err.join("")).toContain("Legal here");
  });

  it("refuses an entity that has no states", () => {
    run(["init"]);
    expect(run(["worker", "start", "1"])).toBe(1);
    expect(err.join("")).toContain("has no states");
  });
});

describe("answering", () => {
  it("refuses an assignment that is not waiting on anybody", () => {
    run(["init"]);
    expect(run(["answer", "1", "yes"])).toBe(1);
    expect(err.join("")).toContain("no assignment #1");
  });

  it("records the answer and who gave it", () => {
    run(["init"]);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(process.env["WECODE_DB"] as string);
    db.prepare(`INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES ('w','w','engineer','agent','t','t')`).run();
    db.prepare(`INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,spent,created_at,updated_at) VALUES ('a','task',1,1,'{}','{}','/tmp','waiting','approval','may I?','{}','t','t')`).run();
    db.close();

    expect(run(["answer", "1", "yes,", "go", "ahead"])).toBe(0);
    expect(said()).toContain("answered by operator");
  });
});

describe("help is what an agent reads first", () => {
  it("says what the work is shaped like, not only which flags exist", () => {
    run(["--help"]);
    const out = said();
    expect(out).toContain("acceptance_test");
    expect(out).toContain("wecode onboard");
    expect(out).toContain("two tasks whose write scopes overlap");
  });

  it("prints an entity's real states and verbs, off the machine table", () => {
    run(["task", "--help"]);
    const out = said();
    expect(out).toContain("planned · ready · done · failed · dropped");
    expect(out).toContain("task_may_be_attempted");
    expect(out).toContain("automatic");
  });

  it("answers create --help with that entity's own flags and an example", () => {
    expect(run(["task", "create", "--help"])).toBe(0);
    const out = said();
    expect(out).toContain("wecode task create [flags]");
    expect(out).toContain("--parent");
    expect(out).toContain("--role");
    expect(out).toContain('wecode task create --parent 1 "send the mail" --role engineer');
    expect(err.join("")).toBe("");
  });

  it("accepts -h, and does not create anything while answering", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    out.length = 0;
    expect(run(["workspace", "create", "-h"])).toBe(0);
    expect(said()).toContain("--path");
    out.length = 0;
    run(["workspaces"]);
    expect(said()).not.toContain("-h");
  });

  it("names only the flags the entity in hand actually takes", () => {
    expect(run(["story", "create", "--help"])).toBe(0);
    const out = said();
    expect(out).toContain("--parent");
    expect(out).not.toContain("--artefact");
    expect(out).not.toContain("--role");
  });

  it("offers --artefact and --kind on the tests, which is where they are read", () => {
    expect(run(["acceptance_test", "create", "--help"])).toBe(0);
    expect(said()).toContain("--artefact");
    expect(said()).toContain("--kind");
  });

  it("says which entity it cannot make, rather than printing empty flags", () => {
    expect(run(["nonsense", "create", "--help"])).toBe(1);
    expect(err.join("")).toContain("no such entity: nonsense");
  });

  it("answers scope --help with --write and --tools and the rule that bites", () => {
    expect(run(["task", "scope", "--help"])).toBe(0);
    const out = said();
    expect(out).toContain("wecode task scope <id>");
    expect(out).toContain("--write");
    expect(out).toContain("--tools");
    expect(out).toContain("overlap");
    expect(err.join("")).toBe("");
  });

  it("falls back to the manual for a word that is not an entity", () => {
    expect(run(["worker", "--help"])).toBe(0);
    expect(said()).toContain("THE SHAPE OF THE WORK");
  });
});

describe("first contact", () => {
  it("says where wecode is not, rather than throwing a stack trace", () => {
    process.env["WECODE_DB"] = "/tmp/wecode-nowhere/does-not-exist.db";
    expect(run(["board"])).toBe(1);
    expect(err.join("")).toContain("no wecode workspace");
    expect(err.join("")).toContain("wecode onboard");
  });
});

describe("onboarding hires the workers the runner needs", () => {
  let repo: string;
  let was: string;

  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repo, stdio: "ignore" });

  const workers = (): { id: number; name: string; role: string; kind: string }[] => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(process.env["WECODE_HOME"] as string, "workspaces", "default", "wecode.db"));
    const rows = db.prepare("SELECT id, name, role, kind FROM worker ORDER BY id").all();
    db.close();
    return rows as { id: number; name: string; role: string; kind: string }[];
  };

  beforeEach(() => {
    was = process.cwd();
    process.env["WECODE_HOME"] = tmp("wecode-home-");
    repo = tmp("wecode-repo-");
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    process.chdir(repo);
    git("init", "-q");
    git("config", "user.name", "A Person");
    git("config", "user.email", "person@example.com");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
  });

  afterEach(() => {
    process.chdir(was);
    delete process.env["WECODE_HOME"];
  });

  it("creates one agent worker per role, named after the role, and says so", () => {
    expect(run(["onboard", "thing"])).toBe(0);

    expect(workers()).toEqual([
      { id: 1, name: "engineer", role: "engineer", kind: "agent" },
      { id: 2, name: "acceptance-tester", role: "acceptance-tester", kind: "agent" },
    ]);
    expect(said()).toContain("worker #1  engineer");
    expect(said()).toContain("worker #2  acceptance-tester");
  });

  it("does not hire a second worker for a role that already has one", () => {
    expect(run(["onboard", "thing"])).toBe(0);
    out.length = 0;

    expect(run(["onboard", "thing"])).toBe(0);
    expect(workers().map((w) => w.role)).toEqual(["engineer", "acceptance-tester"]);
    expect(said()).toContain("already onboarded here");
    expect(said()).toContain("worker #1  engineer  (already there)");
  });
});

describe("workspaces", () => {
  it("says there are none rather than inventing one", () => {
    process.env["WECODE_HOME"] = "/tmp/wecode-empty-home";
    expect(run(["workspaces"])).toBe(1);
    expect(err.join("")).toContain("no workspaces yet");
    delete process.env["WECODE_HOME"];
  });
});

describe("a parent in another project", () => {
  it("is refused, and names both projects", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "one", "--path", process.cwd()]);
    run(["release", "create", "--parent", "1", "0.0.1"]);
    run(["epic", "create", "--parent", "1", "an epic of project one"]);
    run(["project", "create", "--parent", "1", "two", "--path", "/somewhere/else"]);

    out.length = 0;
    err.length = 0;
    // cwd is project one's repo, so an epic of project one is fine…
    expect(run(["story", "create", "--parent", "1", "fine"])).toBe(0);

    // …and pretending to be elsewhere is not.
    const db = process.env["WECODE_DB"] as string;
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const conn = new DatabaseSync(db);
    conn.prepare("UPDATE project SET repo = '/not/here' WHERE id = 1").run();
    conn.prepare("UPDATE project SET repo = ? WHERE id = 2").run(process.cwd());
    conn.close();

    err.length = 0;
    expect(run(["story", "create", "--parent", "1", "wrong tree"])).toBe(1);
    expect(err.join("")).toContain("belongs to project #1");
    expect(err.join("")).toContain("but you are in #2");
  });
});

describe("lessons", () => {
  const conn = (): import("node:sqlite").DatabaseSync =>
    new (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(process.env["WECODE_DB"] as string);

  /** A project whose repo is where the test is standing, so `wecode lessons` finds it. */
  const project = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p", "--path", process.cwd()]);
  };

  const learn = (text: string, assignment: number | null = null, at = "2026-09-14T00:00:00.000Z"): void => {
    const db = conn();
    db.prepare("INSERT INTO lesson (project_id, text, assignment_id, created_at) VALUES (1, ?, ?, ?)").run(text, assignment, at);
    db.close();
  };

  const anAssignment = (): void => {
    const db = conn();
    db.prepare(`INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES ('w','w','engineer','agent','t','t')`).run();
    db.prepare(`INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at) VALUES ('send-mail-1','task',1,1,'{}','{}','/tmp','running','{}','t','t')`).run();
    db.close();
  };

  it("lists them newest first, with the assignment that learned it and how old it is", () => {
    project();
    anAssignment();
    const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString();
    learn("a fresh worktree needs pnpm -r build", 1, hoursAgo(5));
    learn("the mail host rejects TLS 1.1", 1, hoursAgo(1));

    out.length = 0;
    expect(run(["lessons"])).toBe(0);
    const said_ = said();
    expect(said_).toContain("the mail host rejects TLS 1.1");
    expect(said_).toContain("a fresh worktree needs pnpm -r build");
    expect(said_.indexOf("TLS 1.1")).toBeLessThan(said_.indexOf("pnpm -r build"));
    expect(said_).toContain("send-mail-1 #1");
    expect(said_).toContain("1h ago");
    expect(said_).toContain("5h ago");
  });

  it("says the lesson was written by hand when no attempt is behind it", () => {
    project();
    learn("the staging host is slow on Mondays");

    out.length = 0;
    expect(run(["lessons"])).toBe(0);
    expect(said()).toContain("by hand");
  });

  it("says there are none rather than printing nothing", () => {
    project();
    expect(run(["lessons"])).toBe(0);
    expect(said()).toContain("no lessons here yet");
  });

  it("shows another project's when asked by id", () => {
    project();
    run(["project", "create", "--parent", "1", "other", "--path", "/elsewhere"]);
    const db = conn();
    db.prepare("INSERT INTO lesson (project_id, text, created_at) VALUES (2, 'theirs', 't')").run();
    db.close();
    learn("mine");

    out.length = 0;
    expect(run(["lessons", "--project", "2"])).toBe(0);
    expect(said()).toContain("theirs");
    expect(said()).not.toContain("mine");
  });

  it("asks for a project when you are standing outside every one", () => {
    run(["init"]);
    expect(run(["lessons"])).toBe(1);
    expect(err.join("")).toContain("no project here");
  });

  it("drops one by id and leaves the rest", () => {
    project();
    learn("keep this");
    learn("this one is wrong");

    out.length = 0;
    expect(run(["lesson", "drop", "2"])).toBe(0);
    expect(said()).toContain("lesson #2 dropped");

    out.length = 0;
    run(["lessons"]);
    expect(said()).toContain("keep this");
    expect(said()).not.toContain("this one is wrong");
  });

  it("says so when there is no such lesson to drop", () => {
    project();
    expect(run(["lesson", "drop", "404"])).toBe(1);
    expect(err.join("")).toContain("no lesson #404");
  });

  it("names the one verb a lesson has", () => {
    project();
    expect(run(["lesson", "keep", "1"])).toBe(1);
    expect(err.join("")).toContain("wecode lesson drop <id>");
  });
});

describe("show answers a stale id", () => {
  const shaped = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront", "--path", process.cwd()]);
    run(["release", "create", "--parent", "1", "1.0.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
  };

  it("prints the record whatever its state, and names its project", () => {
    shaped();
    run(["story", "drop", "1"]);
    out.length = 0;

    expect(run(["show", "story", "1"])).toBe(0);
    expect(said()).toContain("password reset");
    expect(said()).toContain("dropped");
    expect(said()).toContain("project            #1 storefront");
  });

  it("names the project of a record deep in the tree", () => {
    shaped();
    run(["requirement", "create", "--parent", "1", "one change per link"]);
    out.length = 0;

    expect(run(["show", "requirement", "1"])).toBe(0);
    expect(said()).toContain("project            #1 storefront");
  });

  it("says which ids of that entity do exist, rather than refusing bare", () => {
    shaped();
    // the epic somebody wrote down was rebuilt under another number
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(process.env["WECODE_DB"] as string);
    db.prepare("DELETE FROM story").run();
    db.prepare("UPDATE epic SET id = 7 WHERE id = 1").run();
    db.close();

    expect(run(["show", "epic", "1"])).toBe(1);
    const why = err.join("");
    expect(why).toContain("no epic #1");
    expect(why).toContain("#7");
    expect(why).toContain("recovery");
  });

  it("says the entity is empty rather than listing nothing", () => {
    shaped();
    expect(run(["show", "task", "3"])).toBe(1);
    expect(err.join("")).toContain("no task at all yet");
  });

  it("names the entities there are when the word is not one", () => {
    shaped();
    expect(run(["show", "epick", "1"])).toBe(1);
    expect(err.join("")).toContain("no entity called epick");
    expect(err.join("")).toContain("acceptance_criteria");
  });

  it("shows a record that hangs off no project without inventing one", () => {
    shaped();
    out.length = 0;
    expect(run(["show", "workspace", "1"])).toBe(0);
    expect(said()).toContain("acme");
    expect(said()).not.toContain("project  ");
  });
});

describe("landing a story that will not merge", () => {
  let repo: string;
  let was: string;

  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });

  const sql = (): import("node:sqlite").DatabaseSync => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    return new DatabaseSync(process.env["WECODE_DB"] as string);
  };

  beforeEach(() => {
    was = process.cwd();
    repo = tmp("wecode-land-");
    process.chdir(repo);
    git("init", "-q", "-b", "master");
    git("config", "user.name", "A Person");
    git("config", "user.email", "person@example.com");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "foreman.ts"), "export const tick = () => 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");

    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p", "--path", repo]);
    run(["release", "create", "--parent", "1", "0.0.1"]);
    run(["epic", "create", "--parent", "1", "e"]);
    run(["story", "create", "--parent", "1", "rescue the foreman"]);
    const db = sql();
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = 1").run();
    const slug = (db.prepare("SELECT slug FROM story WHERE id = 1").get() as { slug: string }).slug;
    db.close();

    // the story's branch and master both rewrite the same line — a real conflict
    git("checkout", "-q", "-b", `story/${slug}`);
    writeFileSync(join(repo, "foreman.ts"), "export const tick = () => 2;\n");
    git("commit", "-q", "-am", "the story's answer");
    git("checkout", "-q", "master");
    writeFileSync(join(repo, "foreman.ts"), "export const tick = () => 3;\n");
    git("commit", "-q", "-am", "somebody else's answer");
  });

  afterEach(() => process.chdir(was));

  it("aborts the merge, leaving the tree as it was found and the story unlanded", () => {
    const before = git("rev-parse", "HEAD").trim();

    expect(run(["land", "1"])).toBe(1);

    // the incident: a half-finished merge left behind for the next commit to swallow
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git("rev-parse", "HEAD").trim()).toBe(before);
    expect(readFileSync(join(repo, "foreman.ts"), "utf8")).toBe("export const tick = () => 3;\n");
    expect(readFileSync(join(repo, "foreman.ts"), "utf8")).not.toContain("<<<<<<<");

    const db = sql();
    const story = db.prepare("SELECT state FROM story WHERE id = 1").get() as { state: string };
    db.close();
    expect(story.state).toBe("delivered");
  });

  it("says which files conflicted and that the story needs a merge chore", () => {
    expect(run(["land", "1"])).toBe(1);

    const why = err.join("");
    expect(why).toContain("foreman.ts");
    expect(why).toContain("the merge was aborted");
    expect(why).toContain("merge chore");
    expect(said()).not.toContain("landed");
  });
});

describe("telling the orchestrator, rather than being asked", () => {
  const tree = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p", "--path", process.cwd()]);
    run(["release", "create", "--parent", "1", "0.0.1"]);
    run(["epic", "create", "--parent", "1", "e"]);
    run(["story", "create", "--parent", "1", "s"]);
  };

  it("wait returns 0 when the thing reached what the work wanted", () => {
    tree();
    run(["story", "start", "1"]);
    const db = new (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(process.env["WECODE_DB"] as string);
    db.prepare("UPDATE story SET state = 'delivered' WHERE id = 1").run();
    db.close();

    out.length = 0;
    expect(run(["wait", "story", "1"])).toBe(0);
    expect(said()).toContain("story #1 delivered");
  });

  it("wait returns 1 when it settled the other way", () => {
    tree();
    run(["story", "drop", "1"]);
    expect(run(["wait", "story", "1"])).toBe(1);
  });

  it("watch prints one line per transition, oldest first", () => {
    tree();
    run(["story", "start", "1"]);
    out.length = 0;
    // --since 0 replays, and with no interval left running the first pass is all of it
    const code = run(["watch", "--since", "0", "--once"]);
    expect(code).toBe(0);
    expect(said()).toContain("story #1  planned → in_progress");
    expect(said()).toContain("start by operator");
  });
});

/** The five rungs that exist to hold other rungs live in `verbs/tree.ts`, one exported
 *  function each, and `create` is the dispatch that calls them. Proved from both ends: the
 *  module answers when called directly with a `Rung`, and the command an operator types
 *  reaches the same function and reports the same row. */
describe("the tree verbs", () => {
  const maker = (): Maker => new Maker(open(process.env["WECODE_DB"] as string));

  const rung = (parent: number, text: string): rungs.Rung => ({
    make: maker(),
    text,
    parent: () => parent,
    path: "/tmp/somewhere",
  });

  it("exports one function per rung", () => {
    expect(Object.keys(rungs).sort()).toEqual(["epic", "project", "release", "story", "workspace"]);
  });

  it("makes each rung under the one above it", () => {
    run(["init"]);
    const make = maker();
    expect(rungs.workspace({ make, text: "acme", parent: () => 0, path: "/tmp/acme" })).toBe(1);
    expect(rungs.project(rung(1, "storefront"))).toBe(1);
    expect(rungs.release(rung(1, "1.0.0"))).toBe(1);
    expect(rungs.epic(rung(1, "recovery"))).toBe(1);
    expect(rungs.story(rung(1, "password reset"))).toBe(1);
  });

  it("asks a workspace for no parent, so --parent stays a flag of the rungs that hang", () => {
    run(["init"]);
    const make = maker();
    const absent = (): number => {
      throw new Error("asked for a parent");
    };
    expect(rungs.workspace({ make, text: "acme", parent: absent, path: "/tmp/acme" })).toBe(1);
    expect(() => rungs.story({ make, text: "s", parent: absent, path: "" })).toThrow("asked for a parent");
  });

  it("is what `wecode <rung> create` dispatches to, and says what it joined", () => {
    run(["init"]);
    for (const [entity, text] of [
      ["workspace", "acme"],
      ["project", "storefront"],
      ["release", "1.0.0"],
      ["epic", "recovery"],
      ["story", "password reset"],
    ] as const) {
      out.length = 0;
      const args = entity === "workspace" ? [entity, "create", text] : [entity, "create", "--parent", "1", text];
      expect(run(args)).toBe(0);
      expect(said()).toContain(`${entity} #1`);
    }
    expect(said()).toContain("under epic #1  recovery");
  });

  it("passes --path through to the two rungs that point at a directory", () => {
    run(["init"]);
    expect(run(["workspace", "create", "acme", "--path", "/tmp/acme"])).toBe(0);
    expect(run(["project", "create", "--parent", "1", "storefront", "--path", "/tmp/store"])).toBe(0);
    const db = open(process.env["WECODE_DB"] as string);
    expect((db.prepare("SELECT path FROM workspace WHERE id = 1").get() as { path: string }).path).toBe("/tmp/acme");
    expect((db.prepare("SELECT repo FROM project WHERE id = 1").get() as { repo: string }).repo).toBe("/tmp/store");
    db.close();
  });

  it("refuses a rung with no --parent, by naming the flag", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    expect(run(["epic", "create", "recovery"])).toBe(1);
    expect(err.join("")).toContain('wecode epic create --parent <id> "<text>"');
  });
});

/** The five rungs that are the work itself live in `verbs/work.ts`, one exported function
 *  each, and `create` is the dispatch that calls them. Proved from both ends, as the tree
 *  verbs are: the module answers when called directly with a `Work`, and the command an
 *  operator types reaches the same function and writes the same row. */
describe("the work verbs", () => {
  const maker = (): Maker => new Maker(open(process.env["WECODE_DB"] as string));

  const job = (parent: number, text: string, over: Partial<work.Work> = {}): work.Work => ({
    make: maker(),
    text,
    parent: () => parent,
    kind: "script",
    artefact: "bash x.sh",
    role: "engineer",
    ...over,
  });

  /** Everything above a requirement, so there is something for one to hang off. */
  const upToAStory = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    run(["release", "create", "--parent", "1", "1.0.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
  };

  it("exports one function per work rung", () => {
    expect(Object.keys(work).sort())
      .toEqual(["acceptanceCriteria", "acceptanceTest", "requirement", "task", "taskTest"]);
  });

  it("makes each rung under the one above it", () => {
    upToAStory();
    expect(work.requirement(job(1, "one change per link"))).toBe(1);
    expect(work.acceptanceCriteria(job(1, "emailed in 60s"))).toBe(1);
    expect(work.acceptanceTest(job(1, "mail arrives"))).toBe(1);
    expect(work.task(job(1, "send the mail"))).toBe(1);
    expect(work.taskTest(job(1, "mailer called"))).toBe(1);
  });

  it("asks every one of the five for a parent, because all five hang", () => {
    upToAStory();
    const absent = (): number => {
      throw new Error("asked for a parent");
    };
    for (const make of [work.requirement, work.acceptanceCriteria, work.acceptanceTest, work.task, work.taskTest]) {
      expect(() => make(job(0, "x", { parent: absent }))).toThrow("asked for a parent");
    }
  });

  it("carries --kind and --artefact to the two tests", () => {
    upToAStory();
    work.requirement(job(1, "one change per link"));
    work.acceptanceCriteria(job(1, "emailed in 60s"));
    work.acceptanceTest(job(1, "mail arrives", { kind: "judged", artefact: null }));
    work.task(job(1, "send the mail"));
    work.taskTest(job(1, "mailer called", { artefact: "vitest run" }));
    const db = open(process.env["WECODE_DB"] as string);
    expect(db.prepare("SELECT kind, artefact FROM acceptance_test WHERE id = 1").get())
      .toMatchObject({ kind: "judged", artefact: null });
    expect(db.prepare("SELECT kind, artefact FROM task_test WHERE id = 1").get())
      .toMatchObject({ kind: "script", artefact: "vitest run" });
    db.close();
  });

  it("carries --role to the task, which is the only one that has one", () => {
    upToAStory();
    work.requirement(job(1, "one change per link"));
    work.acceptanceCriteria(job(1, "emailed in 60s"));
    work.acceptanceTest(job(1, "mail arrives"));
    work.task(job(1, "send the mail", { role: "reviewer" }));
    const db = open(process.env["WECODE_DB"] as string);
    expect((db.prepare("SELECT role FROM task WHERE id = 1").get() as { role: string }).role).toBe("reviewer");
    db.close();
  });

  it("is what `wecode <entity> create` dispatches to, and says what it joined", () => {
    upToAStory();
    for (const [entity, text, extra] of [
      ["requirement", "one change per link", []],
      ["acceptance_criteria", "emailed in 60s", []],
      ["acceptance_test", "mail arrives", ["--artefact", "bash x.sh"]],
      ["task", "send the mail", ["--role", "engineer"]],
      ["task_test", "mailer called", ["--artefact", "vitest run"]],
    ] as const) {
      out.length = 0;
      expect(run([entity, "create", "--parent", "1", text, ...extra])).toBe(0);
      expect(said()).toContain(`${entity} #1`);
    }
    expect(said()).toContain("under task #1");
  });

  it("refuses a work rung with no --parent, by naming the flag", () => {
    upToAStory();
    expect(run(["requirement", "create", "one change per link"])).toBe(1);
    expect(err.join("")).toContain('wecode requirement create --parent <id> "<text>"');
  });
});

/** The eleven verbs that run something or show you something live in
 *  `verbs/run-and-see.ts`, one exported function each, and run.ts is the dispatch that
 *  calls them. Proved from three sides: the module exports exactly those eleven names,
 *  run.ts no longer holds their bodies, and the command an operator types still answers
 *  the way it did before the move. */
describe("the run-and-see verbs", () => {
  const source = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

  /** The shallowest tree with something to hang a question or a landing on. */
  const aStory = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    run(["release", "create", "--parent", "1", "1.0.0"]);
    run(["epic", "create", "--parent", "1", "recovery"]);
    run(["story", "create", "--parent", "1", "password reset"]);
  };

  it("exports one function per verb, and nothing else", () => {
    expect(Object.keys(see).sort()).toEqual([
      "answer", "ask", "board", "delivered", "design", "doctor", "explore", "land",
      "onboard", "plan", "worker",
    ]);
  });

  it("leaves run.ts with the dispatch and not the bodies", () => {
    const run_ts = source("run.ts");
    for (const gone of [
      "function showBoard(", "function ask(", "function answer(", "function land(",
      "function onboard(", "function recordLanding(", "function hire(", "function rolesFor(",
    ]) {
      expect(run_ts).not.toContain(gone);
    }
    for (const dispatched of [
      "see.board(", "see.doctor(", "see.delivered(", "see.plan(", "see.land(", "see.ask(",
      "see.answer(", "see.design(", "see.explore(", "see.onboard(", "see.worker(",
    ]) {
      expect(run_ts).toContain(dispatched);
    }
  });

  it("makes a worker when called directly, the way `wecode worker create` does", () => {
    run(["init"]);
    const make = new Maker(open(process.env["WECODE_DB"] as string));
    expect(see.worker({ make, text: "ada", role: "operator", kind: "human" })).toBe(1);
    expect(run(["worker", "create", "grace", "--role", "engineer"])).toBe(0);
    expect(said()).toContain("worker #2");
  });

  it("shows the board through the module, groups and all", () => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront"]);
    out.length = 0;
    expect(run(["board", "--all"])).toBe(0);
    expect(said()).toContain("all 1 projects in this workspace");
    for (const group of ["RUNNING", "NEEDS YOU", "STALE", "QUEUE", "FAILED", "OPEN"]) {
      expect(said()).toContain(`${group} (`);
    }
  });

  it("refuses a board narrowed to a project that is not there", () => {
    run(["init"]);
    expect(run(["board", "--project", "9"])).toBe(1);
    expect(err.join("")).toContain("no project #9");
  });

  it("asks a named person and answers them, both through the module", () => {
    aStory();
    run(["worker", "create", "ada", "--role", "operator", "--kind", "human"]);
    out.length = 0;
    expect(run(["ask", "story", "1", "ship it?", "--option", "yes=a week", "--option", "no"])).toBe(0);
    expect(said()).toContain("approval #1 waits on ada");
    out.length = 0;
    expect(run(["answer", "1", "yes"])).toBe(0);
    expect(said()).toContain("approval #1 answered yes by ada");
  });

  it("says who could be asked when no operator is named and there is no single one", () => {
    aStory();
    expect(run(["ask", "story", "1", "ship it?"])).toBe(1);
    expect(err.join("")).toContain("nobody to ask: wecode worker create");
  });

  it("refuses to land a story that is not delivered, by its state", () => {
    aStory();
    expect(run(["land", "1"])).toBe(1);
    expect(err.join("")).toContain("story #1 is planned. Only a delivered story lands.");
    expect(run(["land", "9"])).toBe(1);
    expect(err.join("")).toContain("no story #9");
  });

  it("refuses to onboard a directory that is not a git repository", () => {
    const bare = tmp("wecode-bare-");
    const was = process.cwd();
    process.chdir(bare);
    try {
      expect(run(["onboard"])).toBe(1);
      expect(err.join("")).toContain("this is not a git repository");
    } finally {
      process.chdir(was);
    }
  });

  it("keeps run.ts's own words out of the new module: it parses no argv it was not given", () => {
    // The context is what run.ts lends; the module reads `at.args` and never process.argv.
    expect(source("verbs/run-and-see.ts")).not.toContain("process.argv");
  });
});
