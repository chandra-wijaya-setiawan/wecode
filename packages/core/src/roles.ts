import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Budget, Scope } from "./entities.js";
import { WORKER_KINDS, type WorkerKind } from "./types.js";

export class RoleConfigError extends Error {}

export interface RoleDef {
  readonly name: string;
  readonly worker_kind: WorkerKind;
  readonly scope: Scope;
  readonly budget: Budget;
  readonly harness: string | null;
}

export interface Invariants {
  readonly never_touch: readonly string[];
  readonly never_run: readonly string[];
}

export interface RoleConfig {
  readonly invariants: Invariants;
  readonly roles: Readonly<Record<string, RoleDef>>;
}

const DEFAULT_BUDGET: Budget = { tokens: 250000, seconds: 3600 };

/** docs/design/08. An unknown key is an error: a typo that silently grants nothing is
 *  worse than a refusal to start. */
export function loadRoles(path: string): RoleConfig {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") throw new RoleConfigError("roles.yaml is not a mapping");
  const top = raw as Record<string, unknown>;

  for (const key of Object.keys(top)) {
    if (!["invariants", "defaults", "roles"].includes(key)) {
      throw new RoleConfigError(`unknown key: ${key}`);
    }
  }

  const invariants: Invariants = {
    never_touch: strings(top["invariants"], "never_touch"),
    never_run: strings(top["invariants"], "never_run"),
  };

  const defaults = (top["defaults"] ?? {}) as Record<string, unknown>;
  const defaultBudget = budgetOf(defaults["budget"]) ?? DEFAULT_BUDGET;
  const defaultHarness = typeof defaults["harness"] === "string" ? defaults["harness"] : null;

  const rolesRaw = top["roles"];
  if (rolesRaw === null || typeof rolesRaw !== "object") throw new RoleConfigError("no roles");

  const roles: Record<string, RoleDef> = {};
  for (const [name, value] of Object.entries(rolesRaw as Record<string, unknown>)) {
    roles[name] = role(name, value, defaultBudget, defaultHarness, invariants);
  }
  return { invariants, roles };
}

function strings(holder: unknown, key: string): readonly string[] {
  if (holder === null || holder === undefined || typeof holder !== "object") return [];
  const v = (holder as Record<string, unknown>)[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new RoleConfigError(`${key} must be a list of strings`);
  }
  return v as string[];
}

function budgetOf(v: unknown): Budget | null {
  if (v === null || v === undefined || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (typeof b["tokens"] !== "number" || typeof b["seconds"] !== "number") {
    throw new RoleConfigError("budget needs tokens and seconds, both numbers");
  }
  return { tokens: b["tokens"], seconds: b["seconds"] };
}

function role(
  name: string,
  value: unknown,
  defaultBudget: Budget,
  defaultHarness: string | null,
  invariants: Invariants,
): RoleDef {
  if (value === null || typeof value !== "object") throw new RoleConfigError(`${name}: not a mapping`);
  const r = value as Record<string, unknown>;

  for (const key of Object.keys(r)) {
    if (!["worker_kind", "scope", "budget", "harness"].includes(key)) {
      throw new RoleConfigError(`${name}: unknown key ${key}`);
    }
  }

  const kind = r["worker_kind"];
  if (typeof kind !== "string" || !(WORKER_KINDS as readonly string[]).includes(kind)) {
    throw new RoleConfigError(`${name}: worker_kind must be agent or human`);
  }

  const scope: Scope = {
    write: strings(r["scope"], "write"),
    tools: strings(r["scope"], "tools"),
  };

  // An invariant is a ceiling above the ceiling. A role that names one is a config error,
  // not a permission.
  for (const glob of scope.write) {
    if (invariants.never_touch.includes(glob)) {
      throw new RoleConfigError(`${name}: scope.write names ${glob}, which never_touch forbids`);
    }
  }

  return {
    name,
    worker_kind: kind as WorkerKind,
    scope,
    budget: budgetOf(r["budget"]) ?? defaultBudget,
    harness: typeof r["harness"] === "string" ? r["harness"] : defaultHarness,
  };
}

/** A task may narrow a role's scope and never exceed it. Checked at `task scope`, and
 *  again when an assignment is created. */
export function withinCeiling(ceiling: Scope, asked: Scope): { ok: true } | { ok: false; why: string } {
  const outsideWrite = asked.write.filter((g) => !covers(ceiling.write, g));
  if (outsideWrite.length > 0) {
    return { ok: false, why: `outside the role's write scope: ${outsideWrite.join(", ")}` };
  }
  const outsideTools = asked.tools.filter((t) => !ceiling.tools.includes(t));
  if (outsideTools.length > 0) {
    return { ok: false, why: `the role may not run: ${outsideTools.join(", ")}` };
  }
  return { ok: true };
}

/** Does any ceiling glob cover this one? A glob covers another when everything the second
 *  matches, the first matches too — approximated by prefix up to the first wildcard, which
 *  is the shape every scope in practice uses. */
function covers(ceiling: readonly string[], glob: string): boolean {
  return ceiling.some((c) => {
    if (c === glob || c === "**") return true;
    const stem = c.replace(/\*+.*$/, "");
    return stem !== "" && glob.startsWith(stem);
  });
}
