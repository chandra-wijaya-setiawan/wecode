import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every file the repository root itself carries — a workspace root holds only the files
 *  that configure the workspace, so anything else here is a stray that belongs in a package.
 *  The list would normally live in `config/`, but this story's scope is the test file alone. */
const ALLOWED: readonly string[] = [
  ".gitignore",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
];

/** The tracked files directly in the root, with everything under a directory dropped. */
function rootFiles(): readonly string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return listing
    .split("\0")
    .filter((path) => path !== "" && !path.includes("/"))
    .sort();
}

describe("the repository root", () => {
  it("holds no strays", () => {
    expect(rootFiles().filter((file) => !ALLOWED.includes(file))).toEqual([]);
  });

  it("no longer carries mail.ts", () => {
    expect(rootFiles()).not.toContain("mail.ts");
  });

  it("still carries every file the workspace is configured by", () => {
    expect(rootFiles()).toEqual([...ALLOWED].sort());
  });
});
