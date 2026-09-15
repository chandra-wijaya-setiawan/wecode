import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plan } from "../src/plan.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const said = (): string => out.join("");

describe("wecode plan --help", () => {
  it("succeeds and says nothing on stderr", () => {
    expect(plan(["--help"])).toBe(0);
    expect(err.join("")).toBe("");
    expect(said()).not.toBe("");
  });

  it("answers -h the same way", () => {
    plan(["--help"]);
    const long = said();
    out.length = 0;
    expect(plan(["-h"])).toBe(0);
    expect(said()).toBe(long);
  });

  it("leads with the usage line and its flags", () => {
    plan(["--help"]);
    expect(said().split("\n")[0]).toBe("wecode plan <file.yaml> [--epic <id>] [--dry-run]");
    expect(said()).toContain("--dry-run");
  });

  it("prints a yaml schema a file can be written from", () => {
    plan(["--help"]);
    const text = said();
    for (const line of ["story:", "requirements:", "- statement:", "criteria:", "tasks:", "- title:"]) {
      expect(text).toContain(line);
    }
  });

  it("names every key of every level", () => {
    plan(["--help"]);
    const text = said();
    for (const key of ["statement", "criteria", "test", "tasks", "title", "scope", "role"]) {
      expect(text).toContain(key);
    }
    // The three roots, and what each one holds.
    for (const pair of ["requirements", "stories", "epics"]) expect(text).toContain(pair);
    for (const root of ["story", "epic", "release"]) expect(text).toContain(root);
  });

  it("says which keys are optional and what fills them in", () => {
    const text = (plan(["--help"]), said());
    expect(text).toContain("config/project.yaml");
    expect(text).toContain("--epic <id>");
    expect(text).toContain("engineer");
    expect(text).toContain("acceptance-tester");
  });

  it("warns that an unknown key is refused", () => {
    expect((plan(["--help"]), said())).toContain("unknown key");
  });

  // --help wins over everything else on the line: it must never touch a workspace, a file,
  // or parseArgs — which would call it an unknown option and throw past this command.
  it("does not read a file or a workspace, whatever else is on the line", () => {
    expect(plan(["--help", "no-such-file.yaml", "--epic", "7"])).toBe(0);
    expect(err.join("")).toBe("");
    expect(said()).toContain("wecode plan <file.yaml>");
  });

  it("answers --help given after the file, which is where a person types it", () => {
    expect(plan(["no-such-file.yaml", "--help"])).toBe(0);
    expect(err.join("")).toBe("");
    expect(said()).toContain("keys");
  });
});
