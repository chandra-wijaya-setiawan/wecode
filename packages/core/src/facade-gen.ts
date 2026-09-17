import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMachines } from "./machines.js";
import { STATEFUL, type MachineSet, type StatefulEntity } from "./types.js";

/** Where the generated facade is written, and read back from when it is checked for drift.
 *  Spelled through `../src/` so a run out of `dist/` rewrites the source, not a build
 *  artefact nobody reads. */
export const FACADE = fileURLToPath(new URL("../src/facade.ts", import.meta.url));

/** Who a transition is attributed to: the name that goes on the ledger line beside it.
 *
 *  A nominal brand is not available here. Every client outside the facade — `approval.ts`,
 *  the runner's examiner, the tui — holds the actor in a `string` it was handed, and a brand
 *  would refuse all of them. So the identity is enforced where one is made, by `actorOf`,
 *  and the name says in a signature what the string is for. */
export type Actor = string;

/** The actor a command run by a person is attributed to when the environment names nobody.
 *  One spelling, so no command invents a second name for the same identity. */
export const OPERATOR: Actor = "operator";

/** An actor, or null when the name is no identity at all.
 *
 *  Blank is nobody. `""` on the ledger names no one who could be asked about the line, and
 *  surrounding space makes two spellings of one identity, so the name is trimmed and an
 *  empty one is refused rather than written. */
export function actorOf(who: string | undefined | null): Actor | null {
  const name = (who ?? "").trim();
  return name === "" ? null : name;
}

/** An actor carrying why they did it, for the one verb that demands a reason. The ledger's
 *  actor column is the only one that survives beside the transition it explains. */
export function attributedTo(who: Actor, reason: string): Actor {
  return `${who}: ${reason}`;
}

/** One transition of the machine table and the facade method that fires it. An actor's verb
 *  gets a `method` on `Verbs`; an automatic transition gets a `completion` on `Completions`
 *  instead, and never both. The table is generated beside the methods, which is what lets a
 *  test hold the two against machines.yaml without parsing TypeScript. */
export interface FacadeTransition {
  readonly entity: StatefulEntity;
  readonly verb: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly method: string | null;
  readonly completion: string | null;
}

const pascal = (name: string): string =>
  name.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");

const camel = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** `startProject`, `giveUpTask`, `deliverAcceptanceTest`. Verb first, because the verb is
 *  what the caller came for. */
export const methodName = (entity: string, verb: string): string => `${camel(verb)}${pascal(entity)}`;

const stateType = (entity: string): string => `${pascal(entity)}State`;

/** Every transition the machine table declares, in the order it declares them, with the
 *  method name each one gets. Two transitions that would take the same method name are a
 *  config error, not a silently shadowed method. */
export function transitionsOf(set: MachineSet): readonly FacadeTransition[] {
  // A verb is one method however many source states it names, so rows are keyed by
  // entity and verb and their from-states merged.
  const rows = new Map<string, FacadeTransition>();
  const taken = new Map<string, string>();

  for (const entity of STATEFUL) {
    for (const t of set[entity].transitions) {
      const key = `${entity}.${t.verb}`;
      const automatic = t.automatic === true;
      const name = methodName(entity, t.verb);
      const method = automatic ? null : name;
      const completion = automatic ? name : null;

      // Keyed by the class the name lands on: Verbs and Completions are separate surfaces,
      // so the same name on each is no shadowing.
      const owner = taken.get(`${automatic}.${name}`);
      if (owner !== undefined && owner !== key) {
        throw new Error(`${key} and ${owner} both want the method ${name}`);
      }
      taken.set(`${automatic}.${name}`, key);

      const prior = rows.get(key);
      rows.set(
        key,
        prior === undefined
          ? { entity, verb: t.verb, from: [...t.from], to: t.to, method, completion }
          : { ...prior, from: [...prior.from, ...t.from] },
      );
    }
  }
  return [...rows.values()];
}

const quoted = (states: readonly string[]): readonly string[] => states.map((s) => `"${s}"`);
const union = (states: readonly string[]): string => quoted(states).join(" | ");
const list = (states: readonly string[]): string => quoted(states).join(", ");

/** One class, one method per row the naming function gives a name to. Both classes have the
 *  same shape — an engine in, an id and an actor per method — so they are written once. */
function emitClass(
  out: string[],
  name: string,
  rows: readonly FacadeTransition[],
  named: (row: FacadeTransition) => string | null,
): void {
  out.push(`export class ${name} {`);
  out.push("  constructor(private readonly engine: Engine) {}");

  for (const row of rows) {
    const method = named(row);
    if (method === null) continue;
    out.push("");
    out.push(`  /** ${row.entity}: ${row.from.join(", ")} → ${row.to} */`);
    out.push(`  ${method}(id: number, actor: string): Outcome {`);
    out.push(`    return this.engine.apply("${row.entity}", id, "${row.verb}", actor);`);
    out.push("  }");
  }
  out.push("}");
}

/** The facade, as source. Nothing here is hand-written: the method list, the doc comment on
 *  each method and the state unions all come off the machine table, so the only way to add
 *  a method is to add a transition. */
export function facadeSource(set: MachineSet = loadMachines()): string {
  const rows = transitionsOf(set);
  const out: string[] = [];

  out.push("// Generated from packages/core/config/machines.yaml by facade-gen.ts. Do not edit:");
  out.push("// facade.test.ts regenerates this file and fails on any difference.");
  out.push("//");
  out.push("// One method per transition an actor may invoke, on Verbs. One per transition that fires");
  out.push("// on its own guard, on Completions — a class apart, because delivering a story is the");
  out.push("// tree's own doing and asking for it by hand is not the same act.");
  out.push("");
  out.push('import type { Engine, Outcome } from "./apply.js";');
  out.push('import type { FacadeTransition } from "./facade-gen.js";');
  out.push("");

  for (const entity of STATEFUL) {
    out.push(`export type ${stateType(entity)} = ${union(set[entity].states)};`);
  }
  out.push("");
  out.push("/** Every verb of the record, one method each. A method exists exactly when the machine");
  out.push(" *  table has a transition an actor may invoke, and it can say nothing else. */");
  emitClass(out, "Verbs", rows, (row) => row.method);
  out.push("");
  out.push("/** Every transition that fires on its own guard, one method each.");
  out.push(" *");
  out.push(" *  Nobody needs these: the cascade and settle() fire them as soon as the guard holds. They");
  out.push(" *  exist because the engine has always let a name off the command line through — asking for");
  out.push(" *  `story deliver` runs the same guard, which refuses unless the story was deliverable");
  out.push(" *  anyway. Spelled here, that surface is a method the compiler resolves. */");
  emitClass(out, "Completions", rows, (row) => row.completion);
  out.push("");
  out.push("/** The machine table as the facade read it. Held against machines.yaml by a test, so a");
  out.push(" *  transition added to the config and not to the facade is a red test, not a gap. */");
  out.push("export const TRANSITIONS: readonly FacadeTransition[] = [");
  for (const row of rows) {
    const method = row.method === null ? "null" : `"${row.method}"`;
    const completion = row.completion === null ? "null" : `"${row.completion}"`;
    out.push(
      `  { entity: "${row.entity}", verb: "${row.verb}", from: [${list(row.from)}], to: "${row.to}", method: ${method}, completion: ${completion} },`,
    );
  }
  out.push("];");
  out.push("");
  return out.join("\n");
}

/** Rewrite the checked-in facade. The one way to make the drift test green again. */
export function writeFacade(path: string = FACADE, set: MachineSet = loadMachines()): void {
  writeFileSync(path, facadeSource(set));
}
