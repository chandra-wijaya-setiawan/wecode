/** `wecode capabilities --json`, held against the surface it describes.
 *
 *  The hassle this answers: on 16 Sep an orchestrating agent drove this repository, could
 *  not ask what wecode does, and recommended building `wecode delivered` — which had
 *  already landed. A self-description is only worth reading if it cannot drift, so nothing
 *  below is compared against a list typed out here. The commands are read from the dispatch
 *  table in run.ts, the verbs and states from the loaded machine set, the entity lines from
 *  docs/design/03. The two tests that matter are the ones that make drift fatal: every
 *  command the document names exists, and a command that exists without a line in the
 *  manual stops the document being written at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe as suite, expect, it, vi } from "vitest";
import { loadMachines, STATEFUL } from "@wecode/core";
import {
  CapabilityError,
  NON_GOALS,
  capabilities,
  commandsIn,
  describe as selfDescription,
  linesIn,
  undocumented,
  verbsIn,
  type SelfDescription,
} from "../src/capabilities.js";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

const RUN = fileURLToPath(new URL("../src/run.ts", import.meta.url));
const runSource = readFileSync(RUN, "utf8");
const machines = loadMachines();

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");

/** The command's own output, parsed — the artefact an agent actually consumes. */
function asked(...args: string[]): SelfDescription {
  expect(capabilities(args)).toBe(0);
  expect(err.join("")).toBe("");
  return JSON.parse(said()) as SelfDescription;
}

suite("wecode capabilities --json", () => {
  it("writes json, and nothing that is not json", () => {
    expect(capabilities(["--json"])).toBe(0);
    expect(() => JSON.parse(said())).not.toThrow();
    expect(said().endsWith("\n")).toBe(true);
  });

  it("names every command the cli dispatches, with one line each", () => {
    const doc = asked("--json");
    expect(doc.commands.map((c) => c.name).sort()).toEqual([...commandsIn(runSource)].sort());
    for (const c of doc.commands) expect(c.line.trim(), `${c.name} has no line`).not.toBe("");
  });

  it("names every command the manual documents, so the two halves of the surface agree", () => {
    const doc = asked("--json");
    const named = new Set(doc.commands.map((c) => c.name));
    for (const name of linesIn(runSource).keys()) expect(named.has(name), `${name} is in the manual only`).toBe(true);
  });

  it("names every verb, its guard, and whether anybody invokes it", () => {
    const doc = asked("--json");
    for (const entity of STATEFUL) {
      for (const t of machines[entity].transitions) {
        const found = doc.verbs.find((v) => v.entity === entity && v.verb === t.verb);
        expect(found, `${entity} ${t.verb}`).toBeDefined();
        expect(found?.line).toBe(`${t.from.join(" | ")} → ${t.to}`);
        expect(found?.guard).toBe(t.guard ?? null);
        expect(found?.automatic).toBe(t.automatic === true);
      }
    }
    // The cascade, as the document reports it: `epic deliver` is nobody's move.
    expect(doc.verbs.find((v) => v.entity === "epic" && v.verb === "deliver")?.automatic).toBe(true);
  });

  it("names the verbs the cli answers itself, which no machine holds", () => {
    const doc = asked("--json");
    for (const verb of verbsIn(runSource)) {
      const found = doc.verbs.find((v) => v.verb === verb && v.entity === "<entity>");
      expect(found, `${verb} is intercepted by the cli and unnamed here`).toBeDefined();
      expect(found?.line.trim()).not.toBe("");
    }
    expect(doc.verbs.some((v) => v.verb === "create")).toBe(true);
  });

  it("names every entity with one line each, its states and its verbs", () => {
    const doc = asked("--json");
    const named = new Map(doc.entities.map((e) => [e.name, e]));
    for (const entity of STATEFUL) {
      const e = named.get(entity);
      expect(e, entity).toBeDefined();
      expect(e?.line.trim()).not.toBe("");
      expect(e?.states).toEqual([...machines[entity].states]);
      expect(e?.verbs).toEqual(machines[entity].transitions.map((t) => t.verb));
    }
  });

  it("names the three entities that have no state, without inventing one", () => {
    const doc = asked("--json");
    for (const name of ["workspace", "role", "worker"]) {
      const e = doc.entities.find((x) => x.name === name);
      expect(e, name).toBeDefined();
      expect(e?.states).toEqual([]);
      expect(e?.verbs).toEqual([]);
    }
  });

  it("names the non-goals, so the edge of the product is as readable as the middle", () => {
    const doc = asked("--json");
    expect(doc.nonGoals.length).toBeGreaterThanOrEqual(5);
    expect(doc.nonGoals).toEqual(NON_GOALS);
    for (const n of doc.nonGoals) {
      expect(n.name.trim()).not.toBe("");
      expect(n.line.trim()).not.toBe("");
    }
    expect(doc.nonGoals.map((n) => n.name)).toContain("writing the code");
  });

  it("does not claim as a non-goal anything it also offers as a command", () => {
    const doc = asked("--json");
    const commands = new Set(doc.commands.map((c) => c.name));
    for (const n of doc.nonGoals) expect(commands.has(n.name), `${n.name} is both`).toBe(false);
  });
});

/** What the cli says about a name that reaches no command: verb() takes it as an entity and
 *  either asks for a verb or reports that it has no states. */
const FELL_THROUGH = /<verb> …|has no states/;

suite("every command the document names", () => {
  const doc = selfDescription();

  it("is a name dispatch answers to", () => {
    for (const c of doc.commands) {
      expect(runSource.includes(`head === "${c.name}"`), `wecode ${c.name} reaches nothing`).toBe(true);
    }
  });

  it("reaches its command when typed, rather than falling through to the entity verbs", () => {
    // What a name that does not exist produces: verb() takes it as an entity and answers
    // about states. Driven for real on the commands that only read, so the suite changes
    // no record — the database is a path in a fresh temporary directory either way.
    process.env["WECODE_DB"] = join(tmp("wecode-capabilities-"), "wecode.db");
    for (const name of ["board", "workspaces", "delivered", "lessons", "tree", "doctor"]) {
      expect(doc.commands.some((c) => c.name === name), `${name} is not in the document`).toBe(true);
      out = [];
      err = [];
      run([name]);
      expect(`${said()}${err.join("")}`, `wecode ${name}`).not.toMatch(FELL_THROUGH);
    }
  });

  it("would notice the fall-through, on a name no command has", () => {
    process.env["WECODE_DB"] = join(tmp("wecode-capabilities-"), "wecode.db");
    run(["frobnicate"]);
    expect(err.join("")).toMatch(FELL_THROUGH);
  });
});

suite("a command added without a line in the manual", () => {
  /** run.ts with one more command in dispatch and nothing about it in usage() — the exact
   *  drift this whole file exists to catch. The anchor is whatever line dispatches `board`
   *  today, found rather than typed out: a fixture that names the body of that line turns
   *  into a copy of run.ts the moment the line is rewritten, and then proves nothing. */
  const DISPATCHES_BOARD = /^.*head === "board".*$/m;
  const undocumentedCommand = runSource.replace(
    DISPATCHES_BOARD,
    (line) => `${line}\n  if (head === "frobnicate") return frobnicate(rest);`,
  );

  it("is built on a line run.ts actually has, so the fixture cannot become a no-op", () => {
    expect(DISPATCHES_BOARD.test(runSource), "run.ts dispatches no board").toBe(true);
    expect(undocumentedCommand.split("\n").length).toBe(runSource.split("\n").length + 1);
  });

  it("is named as undocumented", () => {
    expect(undocumentedCommand).not.toBe(runSource);
    expect(commandsIn(undocumentedCommand)).toContain("frobnicate");
    expect(undocumented(undocumentedCommand)).toEqual(["frobnicate"]);
  });

  it("stops the description being written, rather than being left out of it quietly", () => {
    expect(() => selfDescription({ run: undocumentedCommand })).toThrow(CapabilityError);
    expect(() => selfDescription({ run: undocumentedCommand })).toThrow(/frobnicate/);
  });

  it("leaves the real surface documented, which is the state the tree is in", () => {
    expect(undocumented(runSource)).toEqual([]);
  });
});

suite("an entity the design pages stopped describing", () => {
  it("stops the description too, naming the entity", () => {
    const page = "| entity | short description |\n|---|---|\n| **task** | one piece of work |\n";
    expect(() => selfDescription({ entities: page })).toThrow(CapabilityError);
    expect(() => selfDescription({ entities: page })).toThrow(/story/);
  });
});

suite("wecode capabilities", () => {
  it("answers in lines when nobody asked for json, and the lines carry the non-goals", () => {
    expect(capabilities([])).toBe(0);
    expect(said()).toContain("wecode board");
    expect(said()).toContain("NOT WHAT WECODE IS FOR");
    expect(said()).toContain("wecode dispatches a session to write it");
    expect(() => JSON.parse(said())).toThrow();
  });
});
