/** The orchestrator's guidance is configuration wecode ships, not a file somebody typed
 *  once on one machine.
 *
 *  It used to live only at `~/.claude/skills/wecode/SKILL.md`, hand-placed. Nothing in the
 *  repository carried it, so nobody could review a change to it, and a second machine got
 *  whatever its owner remembered to copy. It is now `packages/cli/config/orchestrator-
 *  skill.md`, and `wecode onboard` installs it.
 *
 *  Three things are held here: the text opens with the line that sends a worker away,
 *  because every runner-started session reads this same file; onboarding writes it into
 *  the operator's skills directory and says where; and a second onboard carries an edited
 *  source forward rather than leaving a stale copy installed. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

const SOURCE = fileURLToPath(new URL("../config/orchestrator-skill.md", import.meta.url));

const out: string[] = [];
const said = (): string => out.join("");

let repo: string;
let claude: string;
let was: string;

const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repo, stdio: "ignore" });

/** Where onboarding is asked to install: Claude Code's own config directory knob, pointed
 *  at a temporary one so the test never touches the operator's real skills. */
const installed = (): string => join(claude, "skills", "wecode", "SKILL.md");

beforeEach(() => {
  was = process.cwd();
  claude = tmp("wecode-claude-");
  process.env["CLAUDE_CONFIG_DIR"] = claude;
  process.env["WECODE_HOME"] = tmp("wecode-home-");
  repo = tmp("wecode-repo-");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  process.chdir(repo);
  git("init", "-q");
  git("config", "user.name", "A Person");
  git("config", "user.email", "person@example.com");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed");
  out.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
});

afterEach(() => {
  process.chdir(was);
  vi.restoreAllMocks();
  delete process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["WECODE_HOME"];
});

describe("the guidance is in the repository", () => {
  it("opens with the line that tells a runner-started session to stop reading", () => {
    const body = readFileSync(SOURCE, "utf8").split(/^---$/m)[2] as string;

    expect(body.trim().split("\n")[0]).toBe(
      "**If a wecode runner started you, stop reading here.** You were spawned with `claude -p`",
    );
  });

  it("is a skill Claude Code can find, named wecode and invocable", () => {
    const front = readFileSync(SOURCE, "utf8").split(/^---$/m)[1] as string;

    expect(front).toContain("name: wecode");
    expect(front).toContain("user-invocable: true");
  });
});

describe("wecode onboard", () => {
  it("installs the guidance into the operator's skills directory, and says where", () => {
    expect(existsSync(installed())).toBe(false);

    expect(run(["onboard", "thing"])).toBe(0);

    expect(readFileSync(installed(), "utf8")).toBe(readFileSync(SOURCE, "utf8"));
    expect(said()).toContain(`skill       ${installed()}`);
  });

  it("carries an edited source forward over an installed copy that has gone stale", () => {
    expect(run(["onboard", "thing"])).toBe(0);
    writeFileSync(installed(), "whatever somebody left here\n");
    out.length = 0;

    expect(run(["onboard", "thing"])).toBe(0);

    expect(readFileSync(installed(), "utf8")).toBe(readFileSync(SOURCE, "utf8"));
    expect(said()).toContain("already onboarded here");
    expect(said()).toContain(`skill       ${installed()}`);
  });
});
