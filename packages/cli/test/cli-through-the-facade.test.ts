/** The cli's verbs, on the typed facade.
 *
 *  `engine.apply(entity, id, verb, actor)` takes the entity and the verb as strings. Nothing
 *  checked them: `apply("story", id, "delivar", …)` compiled, and a verb dropped from
 *  machines.yaml compiled too — both came back as a refusal at runtime, in a sentence about
 *  the state machine rather than about the caller. `Verbs` is generated from that same
 *  config with one method per transition an actor may invoke, so a name that is no longer
 *  there is a build error instead.
 *
 *  Two things are proved here.
 *
 *  The first is that the string call is gone where the compiler could have been reading it:
 *  `plan.ts` holds none at all, and the dispatching half of the cli — `run.ts` together with
 *  the verb modules the split moved its bodies into — holds exactly one, the
 *  `wecode <entity> <verb>` surface, where both words arrive from argv and the facade may
 *  genuinely have no method for them, which is a case the port must not answer differently
 *  than before. Reading `run.ts` alone would have let a string call ride into `verbs/` and
 *  still leave this green, so every module under `verbs/` is read with it.
 *
 *  The second is that it answers no differently. The port is behaviour-preserving or it is
 *  nothing, so every refusal, every printed line, every cascade and the actor that rides on
 *  the ledger are pinned against the commands an operator actually types.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open, TRANSITIONS, Verbs } from "@wecode/core";
import { run } from "../src/run.js";
import { recordRed } from "../../core/test/helpers.js";
import { tmp } from "../../core/test/tmpdir.js";

const read = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${module}`, import.meta.url)), "utf8");

/** A module with its prose taken out. The commentary names what it replaced — the whole
 *  point of a comment on a port — and a sentence reaches no state machine. What must be
 *  gone is the call that runs. */
const code = (module: string): string =>
  read(module).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Every module under `src/verbs/`, listed off the directory rather than written down here,
 *  so a module added tomorrow is held to the same rule without anyone remembering to add it. */
const VERB_MODULES: string[] = readdirSync(fileURLToPath(new URL("../src/verbs", import.meta.url)))
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => `verbs/${f}`);

/** The dispatching half of the cli: the argv reader and the verb bodies the split moved out
 *  of it. The verbs did not stop being run.ts's work by moving house. */
const DISPATCH: string[] = ["run.ts", ...VERB_MODULES];

const dispatch = (): string => DISPATCH.map(code).join("\n");

let out: string[];
let err: string[];
let repo: string;

const PROJECT = `stack: node
test: pnpm test
typecheck: tsc -b
source: ["src/**"]
tests: ["test/**"]
`;

beforeEach(() => {
  repo = tmp("wecode-facade-cli-");
  mkdirSync(join(repo, "config"));
  process.env["WECODE_DB"] = join(repo, "wecode.db");
  delete process.env["WECODE_ACTOR"];
  out = [];
  err = [];
  vi.spyOn(process, "cwd").mockReturnValue(repo);
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  delete process.env["WECODE_ACTOR"];
  vi.restoreAllMocks();
});

const said = (): string => out.join("");
const complained = (): string => err.join("");

const db = (): DatabaseSync => open(process.env["WECODE_DB"] as string);

const row = <T>(sql: string, ...args: (string | number)[]): T => db().prepare(sql).get(...args) as T;

const stateOf = (entity: string, id: number): string =>
  row<{ state: string }>(`SELECT state FROM ${entity} WHERE id = ?`, id)?.state;

/** This repository, onboarded, with one in-progress epic to hang a plan off. */
function project(): void {
  run(["init"]);
  run(["workspace", "create", "acme"]);
  run(["project", "create", "--parent", "1", "storefront"]);
  run(["release", "create", "--parent", "1", "0.0.1"]);
  run(["epic", "create", "--parent", "1", "the cockpit"]);
  run(["epic", "start", "1"]);
  writeFileSync(join(repo, "config", "project.yaml"), PROJECT);
  out.length = 0;
  err.length = 0;
}

/** One story, one requirement, one criteria, one task — every rung `begin` starts and every
 *  test it delivers, so a single `plan` exercises the whole table it dispatches through. */
const STORY = `story: password reset
requirements:
  - statement: a user may reset their password
    criteria:
      - statement: the mail arrives
        test: pnpm test -- mail
        tasks:
          - title: send the mail
            test: pnpm test -- send
`;

function planned(): void {
  project();
  const path = join(repo, "plan.yaml");
  writeFileSync(path, STORY);
  expect(run(["plan", path])).toBe(0);
  out.length = 0;
  err.length = 0;
}

describe("the string call is gone from where the compiler could read it", () => {
  it("leaves no apply() in plan.ts at all", () => {
    expect(code("plan.ts")).not.toMatch(/\.apply\(/);
  });

  it("reads the verb modules the split moved run.ts's bodies into", () => {
    // The guard on every assertion below: were this list empty or stale, reading it would
    // prove nothing at all, so the modules the verbs actually live in are named here.
    expect(VERB_MODULES).toEqual(expect.arrayContaining(["verbs/act.ts", "verbs/entity.ts"]));
    expect(VERB_MODULES.length).toBeGreaterThan(5);
  });

  it("leaves exactly one across the dispatch, and it is the surface argv spells both words of", () => {
    expect([...dispatch().matchAll(/\.apply\(/g)]).toHaveLength(1);
    // In run.ts, and nowhere the split could have carried one off to.
    expect([...code("run.ts").matchAll(/\.apply\(/g)]).toHaveLength(1);
    for (const module of VERB_MODULES) expect(code(module), module).not.toMatch(/\.apply\(/);
    // And it is reached only when the facade answered with no method for those two words.
    expect(code("run.ts")).toContain("invoke === null ? engine.apply(entity, id, name, actor) : invoke(id, actor)");
  });

  it("names the verbs it invokes as methods rather than as strings", () => {
    // The dispatch and plan.ts together hold every verb the operator's commands reach.
    // Spelled as a method, each one is a name the build resolves.
    for (const method of ["startProject", "startRelease", "retryTask"]) {
      expect(dispatch()).toContain(method);
    }
    for (const method of ["startStory", "startRequirement", "startTask", "deliverAcceptanceTest", "deliverTaskTest"]) {
      expect(code("plan.ts")).toContain(method);
    }
  });

  it("holds no second copy of the machine table: the lookup is keyed off TRANSITIONS", () => {
    expect(code("run.ts")).toMatch(/TRANSITIONS\.find\(\(t\) => t\.entity === entity && t\.verb === name\)/);
  });
});

describe("the name TRANSITIONS carries is a method on Verbs", () => {
  /** What run.ts's lookup rests on. Every invocable row names a method that is there, so
   *  the resolution can never come back empty for a verb an actor may invoke — and a row
   *  whose method went missing fails here rather than falling quietly back to the engine. */
  it("resolves every invocable transition to a function of an id and an actor", () => {
    const invocable = TRANSITIONS.filter((t) => t.method !== null);
    expect(invocable.length).toBeGreaterThan(20);
    for (const t of invocable) {
      const found = Object.getOwnPropertyDescriptor(Verbs.prototype, t.method as string);
      expect(typeof found?.value, `${t.entity} ${t.verb}`).toBe("function");
      expect(found?.value.length, `${t.entity} ${t.verb}`).toBe(2);
    }
  });

  it("resolves an automatic verb to nothing, which is why the engine is still reached", () => {
    // `story deliver` is declared and automatic. The facade offers no way to spell it, so
    // the fallback in run.ts is not a leftover — it is the only path this command has.
    expect(TRANSITIONS.find((t) => t.entity === "story" && t.verb === "deliver")?.method).toBeNull();
  });
});

describe("what the operator's commands answer, unchanged", () => {
  it("starts a row and prints the transition it made", () => {
    project();
    run(["story", "create", "--parent", "1", "password reset"]);
    out.length = 0;

    expect(run(["story", "start", "1"])).toBe(0);
    expect(said()).toBe("story #1  planned → in_progress\n");
    expect(stateOf("story", 1)).toBe("in_progress");
  });

  it("refuses a verb the state does not allow, in the machine's own words", () => {
    project();
    run(["story", "create", "--parent", "1", "password reset"]);
    run(["story", "start", "1"]);
    out.length = 0;

    expect(run(["story", "start", "1"])).toBe(1);
    expect(complained()).toContain("start is not legal from in_progress. Legal here:");
    expect(stateOf("story", 1)).toBe("in_progress");
  });

  it("says there is no such row before it says anything about the verb", () => {
    project();
    // The order matters: the row is read first, so a typo against a row that is not there
    // is answered by the id and not by the verb. Resolving the verb up front would have
    // changed which of the two sentences an operator sees.
    expect(run(["story", "start", "404"])).toBe(1);
    expect(complained()).toContain("no story #404");

    err.length = 0;
    expect(run(["story", "delivar", "404"])).toBe(1);
    expect(complained()).toContain("no story #404");
  });

  it("answers a verb nobody declared with what is legal here", () => {
    project();
    run(["story", "create", "--parent", "1", "password reset"]);
    err.length = 0;

    expect(run(["story", "delivar", "1"])).toBe(1);
    expect(complained()).toContain("delivar is not legal from planned. Legal here:");
  });

  it("sends a completion verb to the engine, which is what has always judged it", () => {
    planned();
    // `story deliver` is automatic: no facade method exists, and the guard refuses because
    // the requirement under it is not met. The sentence is the guard's, as before.
    expect(run(["story", "deliver", "1"])).toBe(1);
    expect(complained()).not.toBe("");
    expect(stateOf("story", 1)).toBe("in_progress");
  });

  it("carries the actor the environment names onto the ledger", () => {
    project();
    run(["story", "create", "--parent", "1", "password reset"]);
    run(["story", "start", "1"]);
    process.env["WECODE_ACTOR"] = "agent/mairead";

    expect(run(["story", "hold", "1"])).toBe(0);
    const last = row<{ actor: string; verb: string }>(
      "SELECT actor, verb FROM ledger WHERE entity = 'story' ORDER BY id DESC LIMIT 1",
    );
    expect(last).toEqual({ actor: "agent/mairead", verb: "hold" });
  });

  it("prints the cascade a verb set off, still marked as nobody's doing", () => {
    planned();
    // A test that was never seen red may not be passed, which is a guard and not this
    // story's business — so the base it was red at is written in, as core's own tests do.
    recordRed(db(), 1);
    expect(run(["acceptance_test", "pass", "1"])).toBe(0);
    const lines = said().trim().split("\n");

    expect(lines[0]).toBe("acceptance_test #1  ready → passed");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line).toContain("(cascade)");
    expect(stateOf("acceptance_criteria", 1)).toBe("accepted");
  });

  it("resets the attempts a retry is for, and prints the count", () => {
    planned();
    // give_up is refused while attempts are left, so the counter is run out first: that is
    // the only way to a failed task, and a failed task is the only thing retry answers.
    db().prepare("UPDATE task SET attempts = 3 WHERE id = 1").run();
    expect(run(["task", "give_up", "1"])).toBe(0);
    out.length = 0;

    expect(run(["task", "retry", "1", "--reason", "the scope was wrong"])).toBe(0);
    expect(said()).toContain("task #1  failed → ready");
    expect(said()).toContain("attempts 3 → 0 of");
    expect(said()).toContain("operator: the scope was wrong");
    expect(row<{ attempts: number }>("SELECT attempts FROM task WHERE id = 1").attempts).toBe(0);
  });

  it("leaves the counter alone when the retry itself is refused", () => {
    planned();
    db().prepare("UPDATE task SET attempts = 2 WHERE id = 1").run();
    err.length = 0;

    // The task is ready, not failed, so there is nothing to retry.
    expect(run(["task", "retry", "1", "--reason", "no reason at all"])).toBe(1);
    expect(row<{ attempts: number }>("SELECT attempts FROM task WHERE id = 1").attempts).toBe(2);
  });
});

describe("the commands that start a tree without being asked to", () => {
  it("leaves onboard's project and release in progress", () => {
    // onboard reads the repository it is standing in, so this one stands in a real one.
    const git = (...args: string[]): void => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    git("init", "-q");
    git("config", "user.name", "A Person");
    git("config", "user.email", "person@example.com");
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
    vi.restoreAllMocks();
    const was = process.cwd();
    const home = tmp("wecode-home-");
    process.env["WECODE_HOME"] = home;
    process.chdir(repo);
    vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));

    try {
      expect(run(["onboard", "storefront"])).toBe(0);
    } finally {
      process.chdir(was);
      delete process.env["WECODE_HOME"];
    }

    // Onboarding writes into the workspace it picked, which is where the two rows are read.
    const conn = open(join(home, "workspaces", "default", "wecode.db"));
    const state = (entity: string): string =>
      (conn.prepare(`SELECT state FROM ${entity} WHERE id = 1`).get() as { state: string }).state;

    expect(state("project")).toBe("in_progress");
    expect(state("release")).toBe("in_progress");
    conn.close();
  });

  it("starts every rung a plan file made, and delivers both of its tests", () => {
    planned();
    expect(stateOf("story", 1)).toBe("in_progress");
    expect(stateOf("requirement", 1)).toBe("in_progress");
    expect(stateOf("acceptance_criteria", 1)).toBe("in_progress");
    expect(stateOf("acceptance_test", 1)).toBe("ready");
    expect(stateOf("task_test", 1)).toBe("ready");
    // The task is startable only because its test was delivered first, which is the order
    // `begin` walks and the one thing the port could have quietly reversed.
    expect(stateOf("task", 1)).toBe("ready");
  });

  it("leaves a rung that was already underway where it was", () => {
    project();
    run(["story", "create", "--parent", "1", "password reset"]);
    run(["story", "start", "1"]);
    run(["story", "hold", "1"]);
    const path = join(repo, "plan.yaml");
    writeFileSync(path, STORY.replace("story: password reset", "story: 1"));
    out.length = 0;

    expect(run(["plan", path])).toBe(0);
    // on_hold is not planned, so nothing starts it — a held story is not quietly resumed.
    expect(stateOf("story", 1)).toBe("on_hold");
  });
});
