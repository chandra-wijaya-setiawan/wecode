import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { tmp } from "../../core/test/tmpdir.js";

/** The repository's own files, not fixtures. The claim is about the real install: that it
 *  declares every harness the runner can start, so the real files are what is read. */
const AGENTS = fileURLToPath(new URL("../../../config/agents.yaml", import.meta.url));
const ROLES = fileURLToPath(new URL("../../../config/roles.yaml", import.meta.url));
const ADAPTERS = fileURLToPath(new URL("../src/adapters/", import.meta.url));

/** The keys a block states, all of them, every time. `model` and `provider` may be null —
 *  that is the harness having no such flag, declared rather than left out. */
const KEYS = ["bin", "model", "provider"] as const;

class AgentConfigError extends Error {}

interface AgentDef {
  readonly bin: string;
  readonly model: string | null;
  readonly provider: string | null;
}

type AgentConfig = Readonly<Record<string, AgentDef>>;

/** The harnesses the runner can start, read off the tree rather than restated here.
 *
 *  An adapter file is a harness iff it declares a worker adapter — which is what leaves
 *  `denials.ts`, the confinement helper the adapters share, out without a list of
 *  exceptions anyone has to keep. Deriving it is the point: a hand-kept copy of this list
 *  would be a second definition of what the runner can start, and the gap this story
 *  closes is exactly two definitions disagreeing. */
function harnesses(): readonly string[] {
  return readdirSync(ADAPTERS)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readFileSync(join(ADAPTERS, f), "utf8").includes("implements WorkerAdapter"))
    .map((f) => f.slice(0, -".ts".length))
    .sort();
}

/** Read the harness table and check it in both directions — against itself, and against the
 *  adapters that exist. Every complaint is a config error, refused rather than defaulted. */
function loadAgents(path: string, known: readonly string[] = harnesses()): AgentConfig {
  const raw: unknown = parse(readFileSync(path, "utf8"));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentConfigError("agents.yaml is not a mapping of harness to block");
  }

  const config: Record<string, AgentDef> = {};
  for (const [name, block] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.includes(name)) throw new AgentConfigError(`no adapter for harness ${name}`);
    config[name] = agent(name, block);
  }
  for (const name of known) {
    if (config[name] === undefined) throw new AgentConfigError(`no block for harness ${name}`);
  }
  return config;
}

function agent(name: string, block: unknown): AgentDef {
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new AgentConfigError(`${name}: not a mapping`);
  }
  const b = block as Record<string, unknown>;

  for (const key of Object.keys(b)) {
    if (!KEYS.includes(key as (typeof KEYS)[number])) {
      throw new AgentConfigError(`${name}: unknown key ${key}`);
    }
  }

  const bin = b["bin"];
  if (typeof bin !== "string" || bin.trim() === "") {
    throw new AgentConfigError(`${name}: bin must name an executable`);
  }
  return { bin, model: stated(name, b, "model"), provider: stated(name, b, "provider") };
}

/** A key that must be there and may be null, but may not be missing. */
function stated(name: string, b: Record<string, unknown>, key: string): string | null {
  const value = b[key];
  if (value === undefined) throw new AgentConfigError(`${name}: no ${key}, not even null`);
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentConfigError(`${name}: ${key} must be a name or null`);
  }
  return value;
}

/** The block for this harness, or a refusal naming it. The one way a harness is reached:
 *  a role carrying a name the file does not declare stops here rather than reaching a spawn
 *  that would have run whatever was on PATH under that name. */
function agentFor(config: AgentConfig, harness: string): AgentDef {
  const def = config[harness];
  if (def === undefined) {
    throw new AgentConfigError(
      `no block for harness ${harness}. Declared: ${Object.keys(config).sort().join(", ")}`,
    );
  }
  return def;
}

/** Every harness the real roles file names, defaults included. */
function namedByRoles(): readonly string[] {
  const roles = parse(readFileSync(ROLES, "utf8")) as Record<string, unknown>;
  const named = new Set<string>();
  const take = (row: unknown): void => {
    const h = (row as Record<string, unknown> | null)?.["harness"];
    if (typeof h === "string") named.add(h);
  };
  take(roles["defaults"]);
  for (const role of Object.values((roles["roles"] ?? {}) as Record<string, unknown>)) take(role);
  return [...named];
}

const written = (body: string): string => {
  const path = join(tmp(), "agents.yaml");
  writeFileSync(path, body);
  return path;
};

/** A well-formed two-harness file, for the tests about what a bad one does. */
const TWO = `claude-code:
  bin: claude
  model: claude-opus-5
  provider: null
codex:
  bin: codex
  model: null
  provider: null
`;
const PAIR = ["claude-code", "codex"];

describe("config/agents.yaml", () => {
  it("declares a block for every harness the runner has an adapter for", () => {
    expect(Object.keys(loadAgents(AGENTS)).sort()).toEqual([...harnesses()]);
  });

  it("finds the adapters it is checked against, and not the helper they share", () => {
    expect(harnesses()).toEqual(["claude-code", "codex", "pi", "script"]);
  });

  it("gives each harness the binary that starts it", () => {
    const agents = loadAgents(AGENTS);
    expect(agentFor(agents, "claude-code").bin).toBe("claude");
    expect(agentFor(agents, "codex").bin).toBe("codex");
    expect(agentFor(agents, "pi").bin).toBe("pi");
    // Not an agent: the instruction is a shell command and this is the shell.
    expect(agentFor(agents, "script").bin).toBe("bash");
  });

  it("states the model a role that names none is run on, and where there is none says so", () => {
    const agents = loadAgents(AGENTS);
    expect(agentFor(agents, "claude-code").model).toBe("claude-opus-5");
    expect(agentFor(agents, "pi").model).toBe("claude-opus-5");
    // `codex exec` takes no model flag; a script has no model at all. Declared, not omitted.
    expect(agentFor(agents, "codex").model).toBeNull();
    expect(agentFor(agents, "script").model).toBeNull();
  });

  it("names the provider for the harness that reaches a model through one", () => {
    const agents = loadAgents(AGENTS);
    expect(agentFor(agents, "pi").provider).toBe("anthropic");
    for (const h of ["claude-code", "codex", "script"]) {
      expect(agentFor(agents, h).provider, h).toBeNull();
    }
  });

  it("declares every harness the real roles file names", () => {
    const agents = loadAgents(AGENTS);
    expect(namedByRoles().length).toBeGreaterThan(0);
    for (const h of namedByRoles()) expect(() => agentFor(agents, h)).not.toThrow();
  });
});

describe("a harness with no block", () => {
  it("is refused at lookup, by name", () => {
    const agents = loadAgents(written(TWO), PAIR);
    expect(() => agentFor(agents, "aider")).toThrow(AgentConfigError);
    expect(() => agentFor(agents, "aider")).toThrow(/no block for harness aider/);
  });

  it("is refused before anything spawns, so nothing on PATH is guessed at", () => {
    const agents = loadAgents(written(TWO), PAIR);
    // The near-miss a role typo makes. The refusal says what is declared, so it is visible.
    expect(() => agentFor(agents, "claude_code")).toThrow(/Declared: claude-code, codex/);
  });

  it("refuses the whole file when an adapter's harness is left out", () => {
    const path = written("claude-code:\n  bin: claude\n  model: claude-opus-5\n  provider: null\n");
    expect(() => loadAgents(path, PAIR)).toThrow(/no block for harness codex/);
  });

  it("refuses a block for a harness no adapter can start", () => {
    const path = written(`${TWO}aider:\n  bin: aider\n  model: null\n  provider: null\n`);
    expect(() => loadAgents(path, PAIR)).toThrow(/no adapter for harness aider/);
  });
});

describe("a malformed block", () => {
  it("refuses a file that is not a mapping of harness to block", () => {
    expect(() => loadAgents(written("- claude-code\n"), PAIR)).toThrow(/not a mapping/);
    expect(() => loadAgents(written(""), PAIR)).toThrow(/not a mapping/);
  });

  it("refuses a harness whose block is not a mapping", () => {
    const path = written(`claude-code: claude\ncodex:\n  bin: codex\n  model: null\n  provider: null\n`);
    expect(() => loadAgents(path, PAIR)).toThrow(/claude-code: not a mapping/);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    const path = written(TWO.replace("  bin: claude\n", "  bin: claude\n  binary: claude\n"));
    expect(() => loadAgents(path, PAIR)).toThrow(/claude-code: unknown key binary/);
  });

  it("refuses a block with no binary", () => {
    expect(() => loadAgents(written(TWO.replace("  bin: claude\n", "")), PAIR)).toThrow(
      /claude-code: bin must name an executable/,
    );
    expect(() => loadAgents(written(TWO.replace("bin: claude", "bin: ''")), PAIR)).toThrow(
      /claude-code: bin must name an executable/,
    );
  });

  it("refuses a block that omits a key instead of declaring it null", () => {
    expect(() => loadAgents(written(TWO.replace("  model: claude-opus-5\n", "")), PAIR)).toThrow(
      /claude-code: no model, not even null/,
    );
    expect(() => loadAgents(written(TWO.replace("  provider: null\n", "")), PAIR)).toThrow(
      /claude-code: no provider, not even null/,
    );
  });

  it("refuses a model or provider that is not a name", () => {
    expect(() => loadAgents(written(TWO.replace("claude-opus-5", "true")), PAIR)).toThrow(
      /claude-code: model must be a name or null/,
    );
    expect(() => loadAgents(written(TWO.replace("provider: null", "provider: 7")), PAIR)).toThrow(
      /claude-code: provider must be a name or null/,
    );
  });
});
