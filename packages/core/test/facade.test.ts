import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Engine,
  FACADE,
  STATEFUL,
  TRANSITIONS,
  Verbs,
  facadeSource,
  loadMachines,
  methodName,
  transitionsOf,
  type MachineSet,
} from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

const machines: MachineSet = loadMachines();

/** Every method the class actually has, other than the constructor. */
const methodsOf = (): readonly string[] =>
  Object.getOwnPropertyNames(Verbs.prototype).filter((n) => n !== "constructor").sort();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let verbs: Verbs;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  verbs = new Verbs(new Engine(db));
});

/** The facade is checked in, because a client imports it and the compiler has to read it.
 *  Checked-in generated code is the thing that drifts, so the file is held against what the
 *  generator says the current machines.yaml produces — not against a copy of the list. */
describe("the facade cannot drift from the machine table", () => {
  it("is exactly what the generator writes from machines.yaml", () => {
    expect(readFileSync(FACADE, "utf8")).toBe(facadeSource(machines));
  });

  it("declares every transition the machine table declares, and no other", () => {
    const declared = STATEFUL.flatMap((entity) =>
      [...new Set(machines[entity].transitions.map((t) => t.verb))].map((verb) => `${entity}.${verb}`),
    ).sort();
    expect(TRANSITIONS.map((t) => `${t.entity}.${t.verb}`).sort()).toEqual(declared);
  });

  it("carries each transition's own source and target states", () => {
    for (const t of TRANSITIONS) {
      const config = machines[t.entity].transitions.filter((c) => c.verb === t.verb);
      expect([...t.from].sort(), `${t.entity}.${t.verb} from`).toEqual(
        config.flatMap((c) => c.from).sort(),
      );
      expect(t.to, `${t.entity}.${t.verb} to`).toBe(config[0]?.to);
    }
  });

  it("has a method for exactly the transitions an actor may invoke", () => {
    const invocable = TRANSITIONS.filter((t) => t.method !== null);
    expect(methodsOf()).toEqual(invocable.map((t) => t.method as string).sort());

    for (const t of invocable) {
      const config = machines[t.entity].transitions.filter((c) => c.verb === t.verb);
      expect(config.every((c) => c.automatic !== true), `${t.entity}.${t.verb}`).toBe(true);
    }
  });

  /** An automatic transition fires on its own guard. A method for it would be a way to
   *  deliver a story whose requirements are not met by asking nicely, so there is none. */
  it("offers no way to spell a transition nobody invokes", () => {
    const automatic = STATEFUL.flatMap((entity) =>
      machines[entity].transitions.filter((t) => t.automatic === true).map((t) => ({ entity, verb: t.verb })),
    );
    expect(automatic.length).toBeGreaterThan(0);

    for (const a of automatic) {
      expect(TRANSITIONS.find((t) => t.entity === a.entity && t.verb === a.verb)?.method).toBeNull();
      expect(methodsOf(), `${a.entity}.${a.verb}`).not.toContain(methodName(a.entity, a.verb));
    }
  });

  /** The proof that the list is read rather than remembered: a transition that exists only
   *  in a machine set handed to the generator still gets its method. */
  it("grows a method when the machine table grows a transition", () => {
    const grown: MachineSet = {
      ...machines,
      project: {
        ...machines["project"],
        states: [...machines["project"].states, "archived"],
        transitions: [
          ...machines["project"].transitions,
          { verb: "archive", from: ["dropped"], to: "archived" },
        ],
      },
    };
    expect(transitionsOf(grown).map((t) => t.method)).toContain("archiveProject");
    expect(facadeSource(grown)).toContain("  archiveProject(id: number, actor: string): Outcome {");
    expect(facadeSource(grown)).toContain('export type ProjectState = "planned"');
    expect(facadeSource(grown)).toContain('| "archived";');
  });

  /** Two names can collapse onto one method — `release.give_up_project` would take
   *  `giveUpProjectRelease`, but a differently spelled pair need not. The generator refuses
   *  to write a shadowed method rather than dropping one silently, and today's table has no
   *  such pair, which is what this holds. */
  it("names every method distinctly", () => {
    const names = TRANSITIONS.map((t) => t.method).filter((m): m is string => m !== null);
    expect(new Set(names).size).toBe(names.length);
    expect(methodName("task", "give_up")).toBe("giveUpTask");
  });
});

/** A method is a verb, not a new path into the record: it applies through the same engine,
 *  so the same guards refuse it and the same ledger line is written. */
describe("a facade method is the engine's verb", () => {
  it("applies the transition it names", () => {
    const r = verbs.holdStory(tree.story, "chandra");
    expect(r.ok).toBe(true);
    expect(stateOf(db, "story", tree.story)).toBe("on_hold");
  });

  it("is refused from a state the transition does not leave", () => {
    expect(verbs.holdStory(tree.story, "chandra").ok).toBe(true);
    const again = verbs.holdStory(tree.story, "chandra");
    expect(again.ok).toBe(false);
    expect(!again.ok && again.why).toContain("hold is not legal from on_hold");
  });

  it("is refused by the transition's own guard", () => {
    const r = verbs.passAcceptanceTest(tree.acceptance, "chandra");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("has never been seen to fail");
    expect(stateOf(db, "acceptance_test", tree.acceptance)).toBe("ready");
  });

  it("ledgers the actor it was given", () => {
    verbs.startTask(tree.task, "chandra");
    const line = db
      .prepare("SELECT entity, verb, actor FROM ledger ORDER BY id DESC LIMIT 1")
      .get() as unknown as { entity: string; verb: string; actor: string };
    expect(line).toEqual({ entity: "task", verb: "start", actor: "chandra" });
  });
});
