import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** The rename that gave the view package its current name moved every tracked file out of the
 *  old directory, and it was still there afterwards: `node_modules` and `dist` live in it, git neither
 *  tracks them nor deletes them, so the merge that removed the last tracked file left the folder
 *  standing. A ghost package — nothing in it anybody wrote, a stale `dist` that imports resolve
 *  into, a tree audit still counting the component. So a merge that empties a directory of
 *  tracked files sweeps the ignored leftovers with it, and only there: a directory git still
 *  holds a file under belongs to somebody, build output and all. */

let repo: string;
let root: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = (cwd: string, files: Record<string, string>): void => {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), body);
  }
};

const commit = (cwd: string, files: Record<string, string>): void => {
  write(cwd, files);
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "w");
};

beforeEach(() => {
  root = tmp("wecode-ghost-root-");
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.name", "test");
  run(root, "config", "user.email", "test@localhost");
  commit(root, {
    ".gitignore": "node_modules/\ndist/\n",
    // A made-up package in a temporary tree: the name is a fixture, not this repository's.
    "packages/ui/package.json": '{"name":"@fixture/ui"}\n',
    "packages/ui/src/panel.ts": "export const panel = 1;\n",
    "packages/core/src/core.ts": "export const core = 1;\n",
  });
  repo = root;
  trees = new Trees(repo, "main");
});

/** The rename, on a story branch: every tracked file under `packages/ui` moves to
 *  `packages/lens`, and nothing else changes. */
const renameStory = async (slug: string): Promise<string> => {
  const tree = await trees.storyTree(slug, tmp("wecode-ghost-story-"));
  run(tree, "mv", "packages/ui", "packages/lens");
  run(tree, "add", "-A");
  run(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "rename");
  return tree;
};

describe("a story merge that empties a directory", () => {
  it("takes the ignored leftovers of the emptied directory with it", async () => {
    // the build output a person's checkout is full of, none of it tracked
    write(root, {
      "packages/ui/node_modules/react/index.js": "module.exports = 1;\n",
      "packages/ui/dist/panel.js": "export const panel = 1;\n",
    });
    await renameStory("rename-ui");

    await trees.landStory("rename-ui", root);

    expect(existsSync(join(root, "packages/ui"))).toBe(false);
    // and the directory the rename moved the work to is untouched
    expect(existsSync(join(root, "packages/lens/src/panel.ts"))).toBe(true);
  });

  it("leaves the ignored files of a directory the merge did not empty", async () => {
    write(root, {
      "packages/ui/node_modules/react/index.js": "module.exports = 1;\n",
      "packages/core/dist/core.js": "export const core = 1;\n",
    });
    await renameStory("rename-ui-too");

    await trees.landStory("rename-ui-too", root);

    // `packages/core` still holds a tracked file: its build output is nobody's to delete
    expect(existsSync(join(root, "packages/core/dist/core.js"))).toBe(true);
    // nor is the parent of an emptied directory swept out from under its siblings
    expect(existsSync(join(root, "packages"))).toBe(true);
  });

  it("sweeps a directory emptied by deletions rather than by a rename", async () => {
    write(root, { "packages/ui/dist/panel.js": "export const panel = 1;\n" });
    const tree = await trees.storyTree("drop-ui", tmp("wecode-ghost-drop-"));
    run(tree, "rm", "-q", "-r", "packages/ui");
    run(tree, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "drop");

    await trees.landStory("drop-ui", root);

    expect(existsSync(join(root, "packages/ui"))).toBe(false);
  });

  it("removes the emptied directory when nothing ignored was left in it at all", async () => {
    await renameStory("rename-ui-clean");

    await trees.landStory("rename-ui-clean", root);

    expect(existsSync(join(root, "packages/ui"))).toBe(false);
  });
});
