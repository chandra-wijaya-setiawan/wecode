import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMachines } from "./machines.js";
import { STATEFUL, type MachineSet, type StatefulEntity } from "./types.js";

/** Where the generated facade is written, and read back from when it is checked for drift.
 *  Spelled through `../src/` so a run out of `dist/` rewrites the source, not a build
 *  artefact nobody reads. */
export const FACADE = fileURLToPath(new URL("../src/facade.ts", import.meta.url));

/** One transition of the machine table, and the facade method that invokes it — `null` for
 *  an automatic transition, which no actor may invoke, so the facade gives no way to spell
 *  it. The table is generated beside the methods, which is what lets a test hold the two
 *  against machines.yaml without parsing TypeScript. */
export interface FacadeTransition {
  readonly entity: StatefulEntity;
  readonly verb: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly method: string | null;
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
      const method = t.automatic === true ? null : methodName(entity, t.verb);

      if (method !== null) {
        const owner = taken.get(method);
        if (owner !== undefined && owner !== key) {
          throw new Error(`${key} and ${owner} both want the method ${method}`);
        }
        taken.set(method, key);
      }

      const prior = rows.get(key);
      rows.set(
        key,
        prior === undefined
          ? { entity, verb: t.verb, from: [...t.from], to: t.to, method }
          : { ...prior, from: [...prior.from, ...t.from] },
      );
    }
  }
  return [...rows.values()];
}

const quoted = (states: readonly string[]): readonly string[] => states.map((s) => `"${s}"`);
const union = (states: readonly string[]): string => quoted(states).join(" | ");
const list = (states: readonly string[]): string => quoted(states).join(", ");

/** The facade, as source. Nothing here is hand-written: the method list, the doc comment on
 *  each method and the state unions all come off the machine table, so the only way to add
 *  a method is to add a transition. */
export function facadeSource(set: MachineSet = loadMachines()): string {
  const rows = transitionsOf(set);
  const out: string[] = [];

  out.push("// Generated from packages/core/config/machines.yaml by facade-gen.ts. Do not edit:");
  out.push("// facade.test.ts regenerates this file and fails on any difference.");
  out.push("//");
  out.push("// One method per transition an actor may invoke. An automatic transition gets none —");
  out.push("// nobody invokes it, so the facade offers no way to spell it.");
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
  out.push("export class Verbs {");
  out.push("  constructor(private readonly engine: Engine) {}");

  for (const row of rows) {
    if (row.method === null) continue;
    out.push("");
    out.push(`  /** ${row.entity}: ${row.from.join(", ")} → ${row.to} */`);
    out.push(`  ${row.method}(id: number, actor: string): Outcome {`);
    out.push(`    return this.engine.apply("${row.entity}", id, "${row.verb}", actor);`);
    out.push("  }");
  }
  out.push("}");
  out.push("");
  out.push("/** The machine table as the facade read it. Held against machines.yaml by a test, so a");
  out.push(" *  transition added to the config and not to the facade is a red test, not a gap. */");
  out.push("export const TRANSITIONS: readonly FacadeTransition[] = [");
  for (const row of rows) {
    const method = row.method === null ? "null" : `"${row.method}"`;
    out.push(
      `  { entity: "${row.entity}", verb: "${row.verb}", from: [${list(row.from)}], to: "${row.to}", method: ${method} },`,
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
