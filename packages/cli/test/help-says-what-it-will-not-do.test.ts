import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";

let out: string[];

beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

const help = (argv: string[]): string => {
  out.length = 0;
  run(argv);
  return out.join("");
};

/** The heading and the lines under it, up to the blank line that ends the section. */
const nonGoals = (text: string): string[] => {
  const lines = text.split("\n");
  const at = lines.indexOf("WHAT WECODE WILL NOT DO");
  if (at === -1) return [];
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    body.push(line);
  }
  return body;
};

describe("the manual says what wecode will not do", () => {
  it("has a non-goals section", () => {
    expect(help([])).toContain("WHAT WECODE WILL NOT DO");
  });

  it("gives that section more than one non-goal", () => {
    expect(nonGoals(help([])).length).toBeGreaterThan(1);
  });

  it("writes every non-goal as a refusal, not an offer", () => {
    for (const line of nonGoals(help([]))) expect(line).toMatch(/\bwill not\b/);
  });

  it("indents them like every other section's entries", () => {
    for (const line of nonGoals(help([]))) expect(line.startsWith("  ")).toBe(true);
  });

  it("refuses the three things the machine exists to refuse", () => {
    const said = nonGoals(help([])).join("\n");
    expect(said).toContain("scope");
    expect(said).toContain("test");
    expect(said).toContain("decide what to build");
  });

  it("says it stops at a merge rather than shipping", () => {
    expect(nonGoals(help([])).join("\n")).toMatch(/deploy|release|push/);
  });

  it("keeps the section out of the way of the rules that bite", () => {
    const text = help([]);
    expect(text.indexOf("RULES THAT BITE")).toBeLessThan(text.indexOf("WHAT WECODE WILL NOT DO"));
  });

  it("says the same thing for --help and -h", () => {
    const dash = help(["--help"]);
    expect(nonGoals(dash)).toEqual(nonGoals(help([])));
    expect(nonGoals(help(["-h"]))).toEqual(nonGoals(dash));
  });
});
