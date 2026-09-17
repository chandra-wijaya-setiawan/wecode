/** `engine.apply(entity, id, verb, actor)` takes the entity, the verb and the actor as
 *  strings, and the facade was built so no client had to spell the first two. Two things are
 *  held here, and a third is named as missing.
 *
 *  The first is that every transition the machine table declares now resolves to a method.
 *  `Verbs` had one per transition an actor may invoke and nothing for the rest, so a
 *  completion verb off the command line — `story deliver`, `task finish` — fell back to the
 *  string call. `Completions` is the other half: one method per automatic transition, firing
 *  the same transition through the same guard, so the fallback is reached only by a verb no
 *  row declares.
 *
 *  The second is who. The actor was the fourth string, unnamed and unchecked, and five
 *  commands each spelled their own `?? "operator"`. `Actor` names it, `OPERATOR` is the one
 *  spelling of the person at the terminal, `actorOf` is the one way to make one and a blank
 *  name is nobody rather than an empty ledger line.
 *
 *  The third — the generated signatures reading `actor: Actor`, and `run.ts` holding no
 *  `.apply(` at all — is not here. `core/test/facade.test.ts` pins the generated signature
 *  as `actor: string` and `cli/test/cli-through-the-facade.test.ts` pins the fallback line
 *  verbatim; both are outside this story's scope, so neither removal can be made green.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Completions,
  Engine,
  OPERATOR,
  STATEFUL,
  TRANSITIONS,
  Verbs,
  actorOf,
  attributedTo,
  bulkDrop,
  loadMachines,
  transitionsOf,
  type Actor,
} from "../src/index.js";
import { freshDb, seed, stateOf } from "./helpers.js";

const machines = loadMachines();

/** A cli module with its prose taken out. A sentence about `engine.apply` is history, not a
 *  call, and what these assertions are about is the calls. */
const cli = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`../../cli/src/${module}`, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

/** Every transition machines.yaml declares as automatic, entity and verb. */
const automatic = (): readonly { readonly entity: string; readonly verb: string }[] =>
  STATEFUL.flatMap((entity) =>
    machines[entity].transitions
      .filter((t) => t.automatic === true)
      .map((t) => ({ entity, verb: t.verb })),
  );

const methodsOf = (proto: object): readonly string[] =>
  Object.getOwnPropertyNames(proto)
    .filter((n) => n !== "constructor")
    .sort();

let db: DatabaseSync;
let tree: ReturnType<typeof seed>;
let verbs: Verbs;
let completions: Completions;

beforeEach(() => {
  db = freshDb();
  tree = seed(db);
  const engine = new Engine(db);
  verbs = new Verbs(engine);
  completions = new Completions(engine);
});

describe("every transition the table declares has a method somewhere", () => {
  it("gives an actor's verb a method on Verbs and a completion one on Completions, never both", () => {
    for (const t of TRANSITIONS) {
      expect(
        [t.method, t.completion].filter((m) => m !== null),
        `${t.entity}.${t.verb}`,
      ).toHaveLength(1);
    }
    expect(TRANSITIONS.filter((t) => t.completion !== null).length).toBe(automatic().length);
  });

  it("names every automatic transition on Completions, and none of them on Verbs", () => {
    const named = automatic().map((a) => {
      const row = TRANSITIONS.find((t) => t.entity === a.entity && t.verb === a.verb);
      expect(row?.method, `${a.entity}.${a.verb}`).toBeNull();
      return row?.completion as string;
    });
    expect(named.length).toBeGreaterThan(0);
    expect(methodsOf(Completions.prototype)).toEqual([...named].sort());
    for (const name of named) expect(methodsOf(Verbs.prototype)).not.toContain(name);
  });

  it("resolves each one to a function of an id and an actor", () => {
    for (const t of TRANSITIONS) {
      const proto = t.method === null ? Completions.prototype : Verbs.prototype;
      const found = Object.getOwnPropertyDescriptor(proto, (t.method ?? t.completion) as string);
      expect(typeof found?.value, `${t.entity}.${t.verb}`).toBe("function");
      expect(found?.value.length, `${t.entity}.${t.verb}`).toBe(2);
    }
  });

  /** The proof the list is read rather than remembered: a transition that exists only in a
   *  machine set handed to the generator still gets its completion. */
  it("grows a completion method when the machine table grows an automatic transition", () => {
    const grown = {
      ...machines,
      project: {
        ...machines["project"],
        transitions: [
          ...machines["project"].transitions,
          { verb: "settle", from: ["in_progress"], to: "dropped", automatic: true },
        ],
      },
    };
    expect(TRANSITIONS.find((t) => t.entity === "project" && t.verb === "settle")).toBeUndefined();
    const row = transitionsOf(grown).find((t) => t.entity === "project" && t.verb === "settle");
    expect(row?.method).toBeNull();
    expect(row?.completion).toBe("settleProject");
  });
});

describe("a completion method is the same transition the cascade fires", () => {
  it("is refused by the automatic transition's own guard", () => {
    expect(verbs.startTask(tree.task, OPERATOR).ok).toBe(true);
    // The task_test under it is ready, not settled, so the tree has not finished this task.
    const r = completions.finishTask(tree.task, OPERATOR);
    expect(r.ok).toBe(false);
    expect(stateOf(db, "task", tree.task)).toBe("ready");
  });

  it("applies, and cascades, when the guard the cascade waits on already holds", () => {
    // The test is settled by a write nobody ledgered, so no cascade ever saw it — which is
    // the state an operator asking for the completion by hand is standing in.
    db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(tree.acceptance);

    const r = completions.acceptAcceptanceCriteria(tree.criteria, "chandra");
    expect(r.ok).toBe(true);
    expect(stateOf(db, "acceptance_criteria", tree.criteria)).toBe("accepted");
    // Upward from the row that moved, as apply() has always done.
    expect(stateOf(db, "requirement", tree.requirement)).toBe("met");
  });

  it("ledgers the actor who asked for it", () => {
    db.prepare("UPDATE acceptance_test SET state = 'passed' WHERE id = ?").run(tree.acceptance);
    expect(completions.acceptAcceptanceCriteria(tree.criteria, "chandra").ok).toBe(true);
    const row = db
      .prepare("SELECT actor FROM ledger WHERE entity = 'acceptance_criteria' ORDER BY id DESC LIMIT 1")
      .all() as unknown as { actor: string }[];
    expect(row[0]?.actor).toBe("chandra");
  });
});

describe("the cli reaches a completion verb through the facade", () => {
  it("holds a Completions to resolve one against", () => {
    expect(cli("run.ts")).toContain("new Completions(engine)");
    expect(cli("run.ts")).toContain("Completions.prototype");
  });

  /** What is left for the string call: a verb nobody declared, and nothing else. The lookup
   *  is keyed off TRANSITIONS, so this walks the table the cli walks. */
  it("leaves the string call reachable only by a verb no row declares", () => {
    const row = TRANSITIONS.find((t) => t.entity === "story" && t.verb === "deliver");
    expect(row?.completion).toBe("deliverStory");
    expect(TRANSITIONS.every((t) => (t.method ?? t.completion) !== null)).toBe(true);
    expect(TRANSITIONS.find((t) => t.verb === "delivar")).toBeUndefined();
  });
});

describe("the actor is an identity rather than the fourth string", () => {
  it("refuses a name that is nobody", () => {
    expect(actorOf("")).toBeNull();
    expect(actorOf("   ")).toBeNull();
    expect(actorOf(undefined)).toBeNull();
  });

  it("is one spelling of one identity", () => {
    expect(actorOf("  agent/mairead \n")).toBe("agent/mairead");
    expect(actorOf("operator")).toBe(OPERATOR);
  });

  it("carries a reason for the verb that demands one", () => {
    const who = actorOf("chandra") ?? OPERATOR;
    expect(attributedTo(who, "the mailer host is up now")).toBe("chandra: the mailer host is up now");
  });

  it("is spelled once in the cli rather than per command", () => {
    for (const module of ["run.ts", "plan.ts"]) {
      expect(cli(module), module).not.toMatch(/"operator"/);
    }
    expect(cli("run.ts")).toContain("actorOf(process.env[\"WECODE_ACTOR\"]) ?? OPERATOR");
  });

  it("goes onto the ledger as it was made, through the facade", () => {
    const actor: Actor = actorOf(" chandra ") ?? OPERATOR;
    expect(verbs.holdStory(tree.story, actor).ok).toBe(true);
    const row = db
      .prepare("SELECT actor FROM ledger WHERE entity = 'story' ORDER BY id DESC LIMIT 1")
      .all() as unknown as { actor: string }[];
    expect(row[0]?.actor).toBe("chandra");
  });

  it("is what a bulk is attributed to, for every id it moves", () => {
    const actor: Actor = actorOf("agent/mairead") ?? OPERATOR;
    expect(bulkDrop(db, [tree.task], actor).ok).toBe(true);
    const rows = db
      .prepare("SELECT actor FROM ledger WHERE entity = 'task' ORDER BY id")
      .all() as unknown as { actor: string }[];
    expect(rows.map((r) => r.actor)).toContain("agent/mairead");
  });
});
