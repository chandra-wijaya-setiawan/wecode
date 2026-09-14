import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";

let out: string[];
let err: string[];

beforeEach(() => {
  process.env["WECODE_DB"] = join(mkdtempSync(join(tmpdir(), "wecode-cli-")), "wecode.db");
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
    expect(run(["task", "start", "1"])).toBe(0);

    out.length = 0;
    run(["task_test", "pass", "1"]);
    expect(said()).toContain("task #1  ready → done  (cascade)");

    out.length = 0;
    run(["acceptance_test", "deliver", "1"]);
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
    db.prepare(
      `INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES ('w','w','engineer','agent','t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,kind,question,spent,created_at,updated_at)
       VALUES ('a','task',1,1,'{}','{}','/tmp','waiting','approval','may I?','{}','t','t')`,
    ).run();
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

  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };

  const workers = (): { id: number; name: string; role: string; kind: string }[] => {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(process.env["WECODE_HOME"] as string, "workspaces", "default", "wecode.db"));
    const rows = db.prepare("SELECT id, name, role, kind FROM worker ORDER BY id").all();
    db.close();
    return rows as { id: number; name: string; role: string; kind: string }[];
  };

  beforeEach(() => {
    was = process.cwd();
    process.env["WECODE_HOME"] = mkdtempSync(join(tmpdir(), "wecode-home-"));
    repo = mkdtempSync(join(tmpdir(), "wecode-repo-"));
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
    repo = mkdtempSync(join(tmpdir(), "wecode-land-"));
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
    const db = new (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(
      process.env["WECODE_DB"] as string,
    );
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
