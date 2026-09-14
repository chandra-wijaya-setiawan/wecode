import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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

describe("lessons", () => {
  const conn = (): import("node:sqlite").DatabaseSync =>
    new (require("node:sqlite") as typeof import("node:sqlite")).DatabaseSync(
      process.env["WECODE_DB"] as string,
    );

  /** A project whose repo is where the test is standing, so `wecode lessons` finds it. */
  const project = (): void => {
    run(["init"]);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "p", "--path", process.cwd()]);
  };

  const learn = (text: string, assignment: number | null = null, at = "2026-09-14T00:00:00.000Z"): void => {
    const db = conn();
    db.prepare(
      "INSERT INTO lesson (project_id, text, assignment_id, created_at) VALUES (1, ?, ?, ?)",
    ).run(text, assignment, at);
    db.close();
  };

  const anAssignment = (): void => {
    const db = conn();
    db.prepare(
      `INSERT INTO worker (slug,name,role,kind,created_at,updated_at) VALUES ('w','w','engineer','agent','t','t')`,
    ).run();
    db.prepare(
      `INSERT INTO assignment (slug,objective_type,objective_id,worker_id,scope,budget,worktree,phase,spent,created_at,updated_at)
       VALUES ('send-mail-1','task',1,1,'{}','{}','/tmp','running','{}','t','t')`,
    ).run();
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
