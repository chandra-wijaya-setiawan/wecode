/** Every command a refusal names, proved against the machine set and the cli's verb table.
 *
 *  A refusal is read at the moment the operator has least reason to doubt it, so a wrong
 *  command in one costs more than a wrong comment anywhere else. `wecode acceptance-test
 *  invalidate` was wrong twice over — `acceptance-test` is not an entity the cli accepts,
 *  and `invalidate` is not legal from `failed`, which is the state the refusal was raised
 *  in — and it was followed twice on 15 Sep before anybody noticed.
 *
 *  Nothing here is checked against a person's memory of the surface. The entity names and
 *  the verbs the cli intercepts are read out of `packages/cli/src/run.ts`; the state verbs
 *  and where each is legal from are read out of the loaded machine set. The last test
 *  closes the loop: it takes the message a real refusal produced, extracts the command out
 *  of it, and runs it through the cli — the operator's move, made by the suite.
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_REFUSALS, CreateError, Engine, Maker, commandOf, open } from "../src/index.js";
import { loadMachines } from "../src/machines.js";
import { STATEFUL } from "../src/types.js";
import { run } from "../../cli/src/run.js";
import { seed } from "./helpers.js";
import { tmp } from "./tmpdir.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const CLI = fileURLToPath(new URL("../../cli/src/run.ts", import.meta.url));

const cliSource = readFileSync(CLI, "utf8");

/** The entities the cli's `create` switch will answer to, and therefore the only spellings
 *  `wecode <entity> …` has. Read from the switch rather than listed here: a table typed out
 *  in a test is another copy of the thing under test. */
const CLI_ENTITIES = new Set([...cliSource.matchAll(/^\s*case "([a-z_]+)":/gm)].map((m) => m[1] as string));

/** The verbs the cli handles itself, before a name ever reaches a machine. */
const CLI_VERBS = new Set([...cliSource.matchAll(/name === "([a-z_]+)"/g)].map((m) => m[1] as string));

const machines = loadMachines();

/** Comment lines, dropped. Every comment in this package is a `//` line or a `*`-prefixed
 *  block line, so this is exact for the source it reads — and it only has to keep prose
 *  like "`wecode plan` creates a tree" out of the scrape below. */
const code = (body: string): string =>
  body
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");

/** Every backticked `wecode …` in this package's compiled-from source, by file. */
function scraped(): { file: string; command: string }[] {
  const out: { file: string; command: string }[] = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts"))) {
    const body = code(readFileSync(join(SRC, file), "utf8"));
    for (const hit of body.matchAll(/`(wecode [^`$]*)`/g)) out.push({ file, command: (hit[1] as string).trim() });
  }
  return out;
}

describe("every refusal command names a real entity", () => {
  for (const row of COMMAND_REFUSALS) {
    it(`${row.site}: ${row.entity} is an entity the cli accepts`, () => {
      // `acceptance-test` fails here: the cli's first argument is always the underscored
      // table name, and a hyphen reaches the `no such entity` default.
      expect([...CLI_ENTITIES]).toContain(row.entity);
    });

    it(`${row.site}: ${row.raisedIn} is a state of ${row.entity}`, () => {
      expect(STATEFUL as readonly string[]).toContain(row.entity);
      expect(machines[row.entity as (typeof STATEFUL)[number]].states).toContain(row.raisedIn);
    });
  }
});

describe("every refusal command names a verb that is legal where it was raised", () => {
  for (const row of COMMAND_REFUSALS) {
    const machine = machines[row.entity as (typeof STATEFUL)[number]];
    const isStateVerb = machine !== undefined && machine.transitions.some((t) => t.verb === row.verb);

    it(`${row.site}: ${row.verb} is a verb something answers to`, () => {
      expect(isStateVerb || CLI_VERBS.has(row.verb)).toBe(true);
    });

    if (isStateVerb) {
      it(`${row.site}: ${row.verb} is legal from ${row.raisedIn}`, () => {
        // This is the part memory keeps getting wrong. `invalidate` is a real verb of
        // acceptance_test and reads like the way back from any verdict; it is legal from
        // `passed` and from nowhere else, so from `failed` the operator's next command
        // errors and they are no better off than before the refusal.
        const legal = machine.transitions.filter((t) => t.from.includes(row.raisedIn)).map((t) => t.verb);
        expect(legal).toContain(row.verb);
      });
    }

    if (!isStateVerb) {
      it(`${row.site}: ${row.verb} is a verb the cli handles itself`, () => {
        // A verb that is neither the machine's nor the cli's is a command that cannot run.
        expect([...CLI_VERBS]).toContain(row.verb);
      });
    }
  }

  it("no automatic transition is ever suggested", () => {
    // An automatic verb fires on its guard; no operator may invoke it, so naming one sends
    // them to a command that refuses on principle.
    for (const row of COMMAND_REFUSALS) {
      const machine = machines[row.entity as (typeof STATEFUL)[number]];
      const t = machine?.transitions.find((x) => x.verb === row.verb && x.from.includes(row.raisedIn));
      expect(t?.automatic ?? false).toBe(false);
    }
  });
});

describe("the table is the only place a refusal gets a command from", () => {
  it("every backticked `wecode …` in packages/core is a registered command", () => {
    const known = new Set(COMMAND_REFUSALS.map((r) => commandOf(r.site)));
    const stray = scraped().filter((s) => !known.has(s.command));
    // A new refusal that types its own command is the failure this catches: it would go
    // out unchecked, which is exactly how the last one did.
    expect(stray).toEqual([]);
  });

  it("a command with no site throws rather than rendering blank", () => {
    expect(() => commandOf("nothing.registered.here")).toThrow(/no refusal command registered/);
  });
});

describe("the refusals themselves carry the checked command", () => {
  let db: DatabaseSync;
  let tree: ReturnType<typeof seed>;

  beforeEach(() => {
    db = open(join(tmp(), "wecode.db"));
    tree = seed(db);
  });

  const why = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(CreateError);
      return (err as Error).message;
    }
    throw new Error("nothing was refused");
  };

  for (const state of ["passed", "failed"] as const) {
    it(`a ${state} parent is answered with the verb that is legal from ${state}`, () => {
      db.prepare("UPDATE acceptance_test SET state = ? WHERE id = ?").run(state, tree.acceptance);
      const message = why(() => new Maker(db).task(tree.acceptance, "do the thing"));
      expect(message).toContain(commandOf(`create.settled.${state}`));
      expect(message).not.toContain("acceptance-test");
    });
  }

  it("the two verdict states are not given the same command", () => {
    expect(commandOf("create.settled.passed")).not.toEqual(commandOf("create.settled.failed"));
  });

  it("a task with no write scope is answered with the command that sets one", () => {
    // Raised from `planned` — the only state `start` is legal from, and so the only state
    // this refusal can be read in.
    db.prepare("UPDATE task SET scope = ? WHERE id = ?").run(
      JSON.stringify({ write: [], tools: ["bash"] }),
      tree.task,
    );
    const out = new Engine(db).apply("task", tree.task, "start", "operator");
    expect(out.ok).toBe(false);
    expect(out.ok === false ? out.why : "").toContain(
      commandOf("checks.task_may_be_attempted.no_write_scope"),
    );
  });
});

/** The operator's move, made by the suite: read the refusal, type what it says, get unstuck.
 *
 *  The cli reads its database from WECODE_HOME, so the fixture is seeded at the path the cli
 *  will open rather than handed to it. */
describe("following the refusal gets the operator unstuck", () => {
  const home = tmp();
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env["WECODE_HOME"];
    process.env["WECODE_HOME"] = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env["WECODE_HOME"];
    else process.env["WECODE_HOME"] = previous;
  });

  it("a task under a failed acceptance_test, after running what the refusal said", () => {
    const where = join(home, "workspaces", "default");
    mkdirSync(where, { recursive: true });
    const db = open(join(where, "wecode.db"));
    const tree = seed(db);
    db.prepare("UPDATE acceptance_test SET state = 'failed' WHERE id = ?").run(tree.acceptance);

    let message = "";
    try {
      new Maker(db).task(tree.acceptance, "send the reset mail again");
    } catch (err) {
      message = (err as Error).message;
    }

    const command = /`wecode ([^`]+)`/.exec(message)?.[1];
    expect(command).toBeDefined();
    // Typed as printed, with the placeholder filled in — which is all the operator does.
    const argv = (command as string).split(/\s+/).map((a) => (a === "<id>" ? String(tree.acceptance) : a));
    expect(run(argv)).toBe(0);

    const after = db.prepare("SELECT state FROM acceptance_test WHERE id = ?").get(tree.acceptance) as {
      state: string;
    };
    expect(after.state).toBe("ready");
    expect(() => new Maker(db).task(tree.acceptance, "send the reset mail again")).not.toThrow();
  });
});
