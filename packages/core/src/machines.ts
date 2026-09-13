import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { GUARD_NAMES, type GuardName, type GuardRegistry, type GuardResult, refuse } from "./guards.js";
import { STATEFUL, type Machine, type MachineSet, type StatefulEntity, type Transition } from "./types.js";

const CONFIG = fileURLToPath(new URL("../config/machines.yaml", import.meta.url));

export class MachineError extends Error {}

/** Read the machine table and check it against itself. Every complaint here is a config
 *  error the interpreter refuses to start with, never a warning. */
export function loadMachines(path: string = CONFIG): MachineSet {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new MachineError("machines.yaml is not a mapping");

  const declared = new Set(Object.keys(raw as Record<string, unknown>));
  for (const entity of STATEFUL) {
    if (!declared.delete(entity)) throw new MachineError(`no machine for ${entity}`);
  }
  if (declared.size > 0) {
    throw new MachineError(`machine for unknown entity: ${[...declared].join(", ")}`);
  }

  const set: Record<string, Machine> = {};
  for (const entity of STATEFUL) {
    set[entity] = validate(entity, (raw as Record<string, unknown>)[entity]);
  }
  return set as MachineSet;
}

const guardNames = new Set<string>(GUARD_NAMES);

function validate(entity: string, m: unknown): Machine {
  if (m === null || typeof m !== "object") throw new MachineError(`${entity}: not a mapping`);
  const { states, initial, terminal, transitions } = m as Record<string, unknown>;

  if (!Array.isArray(states) || states.length === 0) throw new MachineError(`${entity}: no states`);
  const known = new Set<string>(states as string[]);

  if (typeof initial !== "string" || !known.has(initial)) {
    throw new MachineError(`${entity}: initial state ${String(initial)} is not one of its states`);
  }
  if (!Array.isArray(terminal)) throw new MachineError(`${entity}: terminal must be a list`);
  for (const t of terminal as string[]) {
    if (!known.has(t)) throw new MachineError(`${entity}: terminal state ${t} is not one of its states`);
  }
  if (!Array.isArray(transitions)) throw new MachineError(`${entity}: transitions must be a list`);

  const checked: Transition[] = [];
  for (const t of transitions as Record<string, unknown>[]) {
    const verb = t["verb"];
    const to = t["to"];
    const from = t["from"];
    const guard = t["guard"];
    if (typeof verb !== "string") throw new MachineError(`${entity}: a transition has no verb`);
    if (typeof to !== "string" || !known.has(to)) {
      throw new MachineError(`${entity}.${verb}: unknown target state ${String(to)}`);
    }
    if (!Array.isArray(from) || from.length === 0) {
      throw new MachineError(`${entity}.${verb}: no source states`);
    }
    for (const f of from as string[]) {
      if (!known.has(f)) throw new MachineError(`${entity}.${verb}: unknown source state ${f}`);
    }
    if (guard !== undefined) {
      if (typeof guard !== "string" || !guardNames.has(guard)) {
        throw new MachineError(`${entity}.${verb}: unknown guard ${String(guard)}`);
      }
    }
    checked.push({
      verb,
      from: from as string[],
      to,
      ...(typeof guard === "string" ? { guard } : {}),
      ...(t["automatic"] === true ? { automatic: true as const } : {}),
    });
  }

  return { states: states as string[], initial, terminal: terminal as string[], transitions: checked };
}

export function machineOf(set: MachineSet, entity: StatefulEntity): Machine {
  return set[entity];
}

/** The transition this verb makes from this state, or nothing. */
export function transitionFor(m: Machine, from: string, verb: string): Transition | undefined {
  return m.transitions.find((t) => t.verb === verb && t.from.includes(from));
}

export interface Applied {
  readonly to: string;
  readonly transition: Transition;
}

/** Ask whether a verb is legal here, and what its guard says. Nothing is written. */
export function check(
  m: Machine,
  from: string,
  verb: string,
  guards: GuardRegistry,
  ctx: { entity: string; id: number },
): { readonly ok: true; readonly applied: Applied } | { readonly ok: false; readonly why: string } {
  if (!m.states.includes(from)) return { ok: false, why: `${from} is not a state of this entity` };

  const transition = transitionFor(m, from, verb);
  if (transition === undefined) {
    const verbs = [...new Set(m.transitions.filter((t) => t.from.includes(from)).map((t) => t.verb))];
    return {
      ok: false,
      why: verbs.length === 0
        ? `${from} is terminal; nothing may be done to it`
        : `${verb} is not legal from ${from}. Legal here: ${verbs.join(", ")}`,
    };
  }

  if (transition.guard !== undefined) {
    const guard = guards[transition.guard as GuardName];
    const result: GuardResult = guard === undefined
      ? refuse(`guard ${transition.guard} is not implemented`)
      : guard(ctx);
    if (!result.ok) return { ok: false, why: result.why };
  }

  return { ok: true, applied: { to: transition.to, transition } };
}

/** Transitions no actor may invoke. They fire when their guard becomes true. */
export function automaticFrom(m: Machine, from: string): readonly Transition[] {
  return m.transitions.filter((t) => t.automatic === true && t.from.includes(from));
}

export function isTerminal(m: Machine, state: string): boolean {
  return m.terminal.includes(state);
}
