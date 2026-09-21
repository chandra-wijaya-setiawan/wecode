import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, SEALED } from "../src/adapters/claude-code.js";
import type { Work } from "../src/ports.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A worker inherits none of the operator's configuration.
 *
 *  The complaint this answers: the adapter spawned a plain `claude -p`, which is the same
 *  command a person types. So every worker discovered the operator's global CLAUDE.md,
 *  resolved every skill installed in their home directory, and started every MCP server
 *  they had configured. An attempt was then run under instructions the record cannot show
 *  and with reach its scope never granted, and the same assignment on two machines was not
 *  the same assignment.
 *
 *  The flags are read off `claude --help`, not guessed:
 *
 *  | flag                       | what it stops                                          |
 *  | -------------------------- | ------------------------------------------------------- |
 *  | `--safe-mode`              | CLAUDE.md discovery, skills, plugins, hooks, MCP, agents |
 *  | `--setting-sources ""`     | the user, project and local settings files               |
 *  | `--strict-mcp-config`      | every MCP server not named on a `--mcp-config` we omit   |
 *  | `--disable-slash-commands` | skill resolution, said again on its own                 |
 *
 *  Deliberately not `--bare`: it seals the same ground but makes Anthropic auth strictly
 *  ANTHROPIC_API_KEY, and a worker here authenticates by the operator's subscription
 *  login, so `--bare` would fail to reach the API at all.
 *
 *  A shim on `bin` is how the spawn line is read: the adapter spawns whatever binary it was
 *  given, so a script that writes its own argv says exactly what the real harness was told. */

/** A shim `claude` that records its arguments, one per line, and succeeds. A NUL separator
 *  rather than a newline, because one of the flags this proves takes an empty argument and
 *  a line-separated record cannot tell an empty argument from the end of the list. */
function shim(dir: string): { bin: string; argv: () => readonly string[] } {
  const bin = join(dir, "claude-shim");
  const out = join(dir, "argv");
  writeFileSync(bin, ["#!/usr/bin/env bash", 'printf "%s\\0" "$@" > ' + JSON.stringify(out), "exit 0", ""].join("\n"));
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () => (existsSync(out) ? readFileSync(out, "utf8").split("\0").slice(0, -1) : []),
  };
}

function work(dir: string, over: Partial<Work> = {}): Work {
  return {
    id: 1,
    objective_type: "task",
    objective_id: 7,
    instruction: "make the thing",
    scope: { write: ["packages/runner/src/**"], tools: ["read", "edit"] },
    budget: { tokens: 1000, seconds: 60 },
    worktree: dir,
    session: null,
    history: null,
    ...over,
  };
}

/** Wait for the shim to have run. `start` returns before the child does. */
async function ran(argv: () => readonly string[]): Promise<readonly string[]> {
  for (let i = 0; i < 400; i++) {
    const seen = argv();
    if (seen.length > 0) return seen;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the shim never ran");
}

const adapterIn = (dir: string, bin: string): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter(bin, join(dir, "logs"), "acceptEdits");

/** The value that follows a flag, insisting the flag is there exactly once. */
function after(argv: readonly string[], flag: string): string {
  const at = argv.indexOf(flag);
  expect(at, `${flag} is not in the spawn line`).toBeGreaterThanOrEqual(0);
  expect(argv.lastIndexOf(flag), `${flag} is passed twice`).toBe(at);
  return argv[at + 1] as string;
}

describe("the spawn line of a Claude Code worker", () => {
  it("forbids CLAUDE.md discovery, so no instruction reaches the worker off the record", async () => {
    const dir = tmp("sealed-claude-md");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    // `--safe-mode`, per `claude --help`, disables CLAUDE.md along with the rest of the
    // operator's customizations. It is the only flag that does so without forcing an API key.
    expect(await ran(argv)).toContain("--safe-mode");
  });

  it("forbids skill resolution", async () => {
    const dir = tmp("sealed-skills");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    expect(await ran(argv)).toContain("--disable-slash-commands");
  });

  it("loads no MCP server the operator configured", async () => {
    const dir = tmp("sealed-mcp");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    const seen = await ran(argv);
    expect(seen).toContain("--strict-mcp-config");
    // Strictness is only a seal because nothing is let in through the front door.
    expect(seen).not.toContain("--mcp-config");
  });

  it("reads no settings file — not the user's, not the project's, not the local one", async () => {
    const dir = tmp("sealed-settings");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    const seen = await ran(argv);
    expect(after(seen, "--setting-sources")).toBe("");
    expect(seen).not.toContain("--settings");
  });

  it("carries every flag of the seal, and the seal is the adapter's declared list", async () => {
    const dir = tmp("sealed-whole");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    const seen = await ran(argv);
    for (const flag of SEALED) expect(seen).toContain(flag);
    expect(SEALED).toEqual(["--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"]);
  });

  it("is not `--bare`, which would force API-key auth on a worker that logs in by subscription", async () => {
    const dir = tmp("sealed-not-bare");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir));

    expect(await ran(argv)).not.toContain("--bare");
  });

  it("still names the model, the worktree and the tool list — the seal disturbs nothing", async () => {
    const dir = tmp("sealed-with-scope");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).start(work(dir, { model: "claude-sonnet-5" }));

    const seen = await ran(argv);
    expect(after(seen, "--model")).toBe("claude-sonnet-5");
    expect(after(seen, "--add-dir")).toBe(dir);
    expect(after(seen, "--permission-mode")).toBe("acceptEdits");
    expect(after(seen, "--allowedTools")).toBe("Read,Edit");
    expect(after(seen, "--output-format")).toBe("stream-json");
    expect(seen).toContain("-p");
  });
});

describe("the seal on a session that was not started here", () => {
  it("is carried by a resumed session, which is where the operator's config would creep back", async () => {
    const dir = tmp("sealed-resume");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).resume(work(dir, { session: "sess-1" }));

    const seen = await ran(argv);
    for (const flag of SEALED) expect(seen).toContain(flag);
    expect(after(seen, "--resume")).toBe("sess-1");
  });

  it("is carried when an asking session is answered", async () => {
    const dir = tmp("sealed-answer");
    const { bin, argv } = shim(dir);

    await adapterIn(dir, bin).answer(work(dir, { session: "sess-1" }), "yes, go on");

    const seen = await ran(argv);
    for (const flag of SEALED) expect(seen).toContain(flag);
    expect(seen).toContain("yes, go on");
  });
});

describe("the seal's one place", () => {
  /** Three entry points spawn a session. If each spelled the seal out, a fourth would
   *  arrive spelling it out nearly. It is in `scopeFlags`, which all three go through. */
  it("is `scopeFlags`, so no entry point can be added without it", () => {
    const source = readFileSync(new URL("../src/adapters/claude-code.ts", import.meta.url), "utf8");
    expect(source.match(/\.\.\.SEALED/g)).toHaveLength(1);
    expect(source).toContain('const flags = [...SEALED, "--add-dir", work.worktree');
    // The flags themselves are named once, in the exported list, and nowhere else.
    for (const flag of SEALED.filter((f) => f !== "")) {
      expect(source.match(new RegExp(`"${flag}"`, "g")), `${flag} is written twice`).toHaveLength(1);
    }
  });
});
