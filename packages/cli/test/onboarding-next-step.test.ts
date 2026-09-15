/** First contact, twice over.
 *
 *  A directory that is not a project and a workspace that does not exist yet are the two
 *  places somebody meets wecode before wecode knows anything about them. Both used to
 *  answer with a fact and no move: "no project here", and — inside an onboarded repo —
 *  "workspace at …/acme", which named the workspace you were already in and created
 *  nothing. These tests hold the answers to the command the operator should run, and hold
 *  `init` to making the workspace it was asked for rather than the one the directory
 *  points at.
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseOf } from "@wecode/core";
import { run } from "../src/run.js";
import { tmp } from "../../core/test/tmpdir.js";

let out: string[];
let err: string[];
let home: string;

beforeEach(() => {
  home = tmp("wecode-home-");
  process.env["WECODE_HOME"] = home;
  process.env["WECODE_DB"] = join(tmp("wecode-cli-"), "wecode.db");
  delete process.env["WECODE_WORKSPACE"];
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["WECODE_HOME"];
});

const complained = (): string => err.join("");
const said = (): string => out.join("");

/** A directory that looks like a repository joined to `workspace`, without being one. */
const pointedAt = (workspace: string): string => {
  const repo = tmp("wecode-repo-");
  mkdirSync(join(repo, ".wecode"), { recursive: true });
  writeFileSync(join(repo, ".wecode", "workspace"), `${workspace}\n`);
  return repo;
};

describe("a directory with no project", () => {
  it("names the command that would put one here", () => {
    expect(run(["init"])).toBe(0);
    const here = tmp("wecode-elsewhere-");
    vi.spyOn(process, "cwd").mockReturnValue(here);
    err.length = 0;

    expect(run(["lessons"])).toBe(1);
    expect(complained()).toContain(here);
    expect(complained()).toContain("wecode onboard");
  });

  it("does not offer --project when the workspace has no project to ask for", () => {
    expect(run(["init"])).toBe(0);
    vi.spyOn(process, "cwd").mockReturnValue(tmp("wecode-elsewhere-"));
    err.length = 0;

    expect(run(["lessons"])).toBe(1);
    expect(complained()).not.toContain("--project");
  });

  it("offers the ids that do exist, by name, when the workspace holds projects", () => {
    expect(run(["init"])).toBe(0);
    run(["workspace", "create", "acme"]);
    run(["project", "create", "--parent", "1", "storefront", "--path", tmp("wecode-storefront-")]);
    vi.spyOn(process, "cwd").mockReturnValue(tmp("wecode-elsewhere-"));
    err.length = 0;

    expect(run(["lessons"])).toBe(1);
    expect(complained()).toContain("wecode lessons --project <id>");
    expect(complained()).toContain("#1  storefront");
  });
});

describe("wecode init", () => {
  it("makes the workspace it was named, not the one it was standing in", () => {
    delete process.env["WECODE_DB"];
    vi.spyOn(process, "cwd").mockReturnValue(pointedAt("acme"));

    expect(run(["init", "fresh"])).toBe(0);
    expect(existsSync(databaseOf("fresh"))).toBe(true);
    expect(existsSync(databaseOf("acme"))).toBe(false);
    expect(said()).toContain(databaseOf("fresh"));
  });

  it("takes the name as --workspace too", () => {
    delete process.env["WECODE_DB"];
    expect(run(["init", "--workspace", "fresh"])).toBe(0);
    expect(existsSync(databaseOf("fresh"))).toBe(true);
  });

  it("makes default, not this repository's workspace, when no name is given", () => {
    delete process.env["WECODE_DB"];
    vi.spyOn(process, "cwd").mockReturnValue(pointedAt("acme"));

    expect(run(["init"])).toBe(0);
    expect(existsSync(databaseOf("default"))).toBe(true);
    expect(existsSync(databaseOf("acme"))).toBe(false);
  });

  it("still answers to an explicit database, which is how a test points it anywhere", () => {
    const path = process.env["WECODE_DB"] as string;
    vi.spyOn(process, "cwd").mockReturnValue(pointedAt("acme"));

    expect(run(["init"])).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(databaseOf("acme"))).toBe(false);
  });

  it("prefers a named workspace over an explicit database", () => {
    expect(run(["init", "fresh"])).toBe(0);
    expect(existsSync(databaseOf("fresh"))).toBe(true);
    expect(existsSync(process.env["WECODE_DB"] as string)).toBe(false);
  });
});
