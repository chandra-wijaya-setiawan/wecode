import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRoles, RoleConfigError, withinCeiling } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmp } from "./tmpdir.js";

const fixture = fileURLToPath(new URL("./fixtures/roles.yaml", import.meta.url));
const write = (body: string): string => {
  const p = join(tmp("wecode-roles-"), "roles.yaml");
  writeFileSync(p, body);
  return p;
};

describe("role config", () => {
  const config = loadRoles(fixture);

  it("reads every role", () => {
    expect(Object.keys(config.roles).sort()).toEqual(["engineer", "reviewer", "tester"]);
  });

  it("falls back to the defaults, and lets a role override them", () => {
    expect(config.roles.engineer?.budget.tokens).toBe(250000);
    expect(config.roles.tester?.budget.tokens).toBe(120000);
    expect(config.roles.engineer?.harness).toBe("claude-code");
  });

  it("a human role gets no tools", () => {
    expect(config.roles.reviewer?.worker_kind).toBe("human");
    expect(config.roles.reviewer?.scope.tools).toEqual([]);
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() => loadRoles(write("roles:\n  a:\n    worker_kind: agent\n    scpoe: {}\n")))
      .toThrow(RoleConfigError);
  });

  it("refuses a role that names something never_touch forbids", () => {
    expect(() =>
      loadRoles(
        write(`invariants:\n  never_touch: ["infra/**"]\nroles:\n  bad:\n    worker_kind: agent\n    scope:\n      write: ["infra/**"]\n`),
      ),
    ).toThrow(/never_touch/);
  });

  it("refuses a worker_kind that is neither", () => {
    expect(() => loadRoles(write("roles:\n  a:\n    worker_kind: robot\n"))).toThrow(RoleConfigError);
  });
});

describe("the ceiling", () => {
  const ceiling = { write: ["src/**", "tests/**"], tools: ["bash", "read"] };

  it("lets a task narrow it", () => {
    expect(withinCeiling(ceiling, { write: ["src/mail/**"], tools: ["bash"] }).ok).toBe(true);
  });

  it("refuses a task that reaches past it", () => {
    const r = withinCeiling(ceiling, { write: ["infra/**"], tools: [] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toContain("infra/**");
  });

  it("refuses a tool the role may not run", () => {
    const r = withinCeiling(ceiling, { write: [], tools: ["write"] });
    expect(!r.ok && r.why).toContain("may not run");
  });
});
