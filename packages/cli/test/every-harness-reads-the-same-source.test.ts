/** One source, and every harness reading it.
 *
 *  `wecode onboard` installed the orchestrator's guidance as a Claude skill and stopped
 *  there. Claude Code found it; codex, pi and opencode read nothing, because each of them
 *  discovers a file in the repository instead — CLAUDE.md for Claude Code, AGENTS.md for
 *  the other three. So onboarding now writes the same text into both, generated from
 *  `packages/cli/config/orchestrator-skill.md`.
 *
 *  Generated, not symlinked. A symlink is what you would reach for, and it is what breaks:
 *  git records one as mode 120000, and a checkout on NTFS materialises that as a nine-byte
 *  text file holding only the target's name — which is what the firstmate repository on
 *  this machine has, an AGENTS.md whose whole content is `CLAUDE.md`. These tests hold the
 *  three properties that follow: each generated file carries the source's own sentences,
 *  each is a real file git would record as a blob, and a copy that has drifted from the
 *  source — hand-edited, or left behind as a symlink or its nine-byte stub — is refused
 *  rather than carried forward. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

const SOURCE = fileURLToPath(new URL("../config/orchestrator-skill.md", import.meta.url));

/** What each harness discovers on its own, in the repository being onboarded. */
const HARNESS = ["CLAUDE.md", "AGENTS.md"] as const;

const out: string[] = [];
const said = (): string => out.join("");

let repo: string;
let was: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const at = (name: string): string => join(repo, name);
const read = (name: string): string => readFileSync(at(name), "utf8");

/** The source as the operator wrote it, and the part of it that is guidance rather than
 *  Claude Code's skill machinery: everything below the frontmatter. */
const source = (): string => readFileSync(SOURCE, "utf8");
const guidance = (): string => source().split(/^---$/m).slice(2).join("---").trimStart();

/** Every sentence the source says, as lines: prose, headings, table rows and the commands
 *  in the fenced blocks, with the blank lines dropped. A file "carries the source's own
 *  sentences" when it carries all of these, verbatim and in order. */
const sentences = (): string[] => guidance().split("\n").filter((l) => l.trim() !== "");

beforeEach(() => {
  was = process.cwd();
  process.env["CLAUDE_CONFIG_DIR"] = tmp("wecode-claude-");
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

describe("onboarding a repository", () => {
  beforeEach(() => {
    expect(run(["onboard", "thing"])).toBe(0);
  });

  it.each(HARNESS)("writes %s, so that harness has something to read", (name) => {
    expect(lstatSync(at(name)).isFile()).toBe(true);
  });

  it.each(HARNESS)("gives %s every sentence the source says, in the source's order", (name) => {
    const written = read(name);

    for (const sentence of sentences()) expect(written).toContain(sentence);
    expect(written).toContain(guidance());
  });

  it.each(HARNESS)("puts nothing of its own into %s but a line naming the source", (name) => {
    const extra = read(name).replace(guidance(), "").trim();

    expect(extra).toMatch(/packages\/cli\/config\/orchestrator-skill\.md/);
    expect(extra.split("\n")).toHaveLength(1);
  });

  it("gives codex, pi and opencode the same bytes Claude Code gets", () => {
    expect(read("AGENTS.md")).toBe(read("CLAUDE.md"));
  });

  it("keeps the installed skill the source itself, frontmatter and all", () => {
    const skill = join(process.env["CLAUDE_CONFIG_DIR"] as string, "skills", "wecode", "SKILL.md");

    expect(readFileSync(skill, "utf8")).toBe(source());
    expect(read("CLAUDE.md")).not.toContain("user-invocable: true");
  });

  it("says where it wrote each of them", () => {
    for (const name of HARNESS) expect(said()).toContain(at(name));
  });
});

/** The reason these are generated rather than symlinked. A symlink reads correctly on the
 *  machine that made it and nowhere else: git stores mode 120000, and a checkout on a
 *  filesystem without symlinks writes a small text file holding the target's name. */
describe("what git would record", () => {
  it("is a regular blob for each file, not a symlink", () => {
    expect(run(["onboard", "thing"])).toBe(0);
    git("add", "-A");

    const staged = new Map(
      git("ls-files", "-s")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => [l.split("\t")[1] as string, l.split(" ")[0] as string]),
    );

    for (const name of HARNESS) expect(staged.get(name)).toBe("100644");
  });

  it("is the whole guidance in each blob, not a nine-byte name", () => {
    expect(run(["onboard", "thing"])).toBe(0);

    for (const name of HARNESS) expect(read(name).length).toBeGreaterThan(1000);
  });
});

describe("a copy that has drifted from the source", () => {
  it("is refused when somebody edited it, however much of it they kept", () => {
    expect(run(["onboard", "thing"])).toBe(0);
    const generated = read("CLAUDE.md");
    writeFileSync(at("CLAUDE.md"), `${generated}\n## My own rules\n\nAlways use tabs.\n`);
    writeFileSync(at("AGENTS.md"), "never mind the source, do what I say\n");

    expect(run(["onboard", "thing"])).toBe(0);

    expect(read("CLAUDE.md")).toBe(generated);
    expect(read("CLAUDE.md")).not.toContain("Always use tabs");
    expect(read("AGENTS.md")).toBe(generated);
  });

  it("is refused when the source moved on under it", () => {
    expect(run(["onboard", "thing"])).toBe(0);
    writeFileSync(at("CLAUDE.md"), read("CLAUDE.md").replace("wecode board", "wecode bored"));

    expect(run(["onboard", "thing"])).toBe(0);

    for (const name of HARNESS) expect(read(name)).toContain("wecode board");
    expect(read("CLAUDE.md")).not.toContain("wecode bored");
  });

  it("is refused when it is the nine-byte stub an NTFS checkout leaves", () => {
    writeFileSync(at("AGENTS.md"), "CLAUDE.md");

    expect(run(["onboard", "thing"])).toBe(0);

    expect(read("AGENTS.md")).toBe(read("CLAUDE.md"));
    expect(lstatSync(at("AGENTS.md")).isSymbolicLink()).toBe(false);
  });

  it("is refused when it is a symlink, which is replaced rather than written through", () => {
    // The far end is a copy of the source, never the source itself: writing through the
    // link destroys whatever is on the other side of it, and this test proves that happens
    // by letting it happen — a test must not be able to rewrite the repository it proves.
    const target = join(tmp("wecode-target-"), "orchestrator-skill.md");
    writeFileSync(target, source());
    symlinkSync(target, at("CLAUDE.md"));
    symlinkSync("CLAUDE.md", at("AGENTS.md")); // what firstmate has: one link pointing at the other

    expect(run(["onboard", "thing"])).toBe(0);

    for (const name of HARNESS) {
      expect(lstatSync(at(name)).isSymbolicLink()).toBe(false);
      expect(read(name)).toContain(guidance());
    }
    expect(readFileSync(target, "utf8")).toBe(source()); // the write went to the link, not through it
  });
});
