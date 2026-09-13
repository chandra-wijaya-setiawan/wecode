import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const STACKS = fileURLToPath(new URL("../config/stacks.yaml", import.meta.url));

export class StackError extends Error {}

export interface Stack {
  readonly name: string;
  readonly marker: string;
  readonly test: string;
  readonly typecheck: string | null;
  readonly source: readonly string[];
  readonly tests: readonly string[];
}

export function loadStacks(path: string = STACKS): readonly Stack[] {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  const stacks = (raw as Record<string, unknown> | null)?.["stacks"];
  if (stacks === null || typeof stacks !== "object") throw new StackError("stacks.yaml has no stacks");

  return Object.entries(stacks as Record<string, Record<string, unknown>>).map(([name, s]) => {
    const marker = s["marker"];
    const test = s["test"];
    if (typeof marker !== "string" || typeof test !== "string") {
      throw new StackError(`${name}: a stack needs a marker and a test command`);
    }
    return {
      name,
      marker,
      test,
      typecheck: typeof s["typecheck"] === "string" ? s["typecheck"] : null,
      source: list(s["source"]),
      tests: list(s["tests"]),
    };
  });
}

const list = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The first stack whose marker is in the repository. Order in the file is the tie-break,
 *  which is why lock files come before the manifests they sit beside. */
export function detect(repo: string, stacks: readonly Stack[] = loadStacks()): Stack | null {
  return stacks.find((s) => existsSync(join(repo, s.marker))) ?? null;
}

/** What onboarding learned. Everything else defaults to it rather than retyping it. */
export interface ProjectConfig {
  readonly stack: string;
  readonly test: string;
  readonly typecheck: string | null;
  readonly source: readonly string[];
  readonly tests: readonly string[];
}

export function writeProjectConfig(path: string, stack: Stack): ProjectConfig {
  const config: ProjectConfig = {
    stack: stack.name,
    test: stack.test,
    typecheck: stack.typecheck,
    source: stack.source,
    tests: stack.tests,
  };
  writeFileSync(path, stringify(config));
  return config;
}

export function readProjectConfig(path: string): ProjectConfig | null {
  if (!existsSync(path)) return null;
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c["test"] !== "string") return null;
  return {
    stack: typeof c["stack"] === "string" ? c["stack"] : "unknown",
    test: c["test"],
    typecheck: typeof c["typecheck"] === "string" ? c["typecheck"] : null,
    source: list(c["source"]),
    tests: list(c["tests"]),
  };
}
