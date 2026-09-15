import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GitError, Trees } from "../src/index.js";
import { tmp } from "../../core/test/tmpdir.js";

/** A conflicting task merge is aborted and the error names the task branch, the story it
 *  was being merged into, and every file that would not reconcile. Without the files a
 *  person reads "merge task/x into story/y failed" and still has to reproduce the merge to
 *  find out what to look at — and the tree that held the conflicted index is gone by then. */

let repo: string;
let trees: Trees;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, files: Record<string, string>): void => {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), body);
  }
  run(cwd, "add", "-A");
  run(cwd, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "-m", "w");
};

beforeEach(() => {
  repo = tmp("wecode-task-merge-");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.name", "test");
  run(repo, "config", "user.email", "test@localhost");
  commit(repo, { "README.md": "seed\n", "src/a.ts": "seed\n", "src/b.ts": "seed\n" });
  trees = new Trees(repo, "main");
});

/** A task and a story that rewrote the same files different ways, plus one file only the
 *  task touched — so the message has something it must *not* name. */
async function twoWaysApart(storySlug: string, taskSlug: string): Promise<string> {
  const task = await trees.taskBranch(storySlug, taskSlug);
  const cut = await trees.cut(task, tmp("wecode-task-merge-task-"));
  commit(cut, { "src/a.ts": "the task\n", "src/b.ts": "the task\n", "src/c.ts": "new\n" });
  run(repo, "update-ref", `refs/heads/${task}`, run(cut, "rev-parse", "HEAD"));

  const tree = await trees.storyTree(storySlug, tmp("wecode-task-merge-story-"));
  commit(tree, { "src/a.ts": "the story\n", "src/b.ts": "the story\n" });
  run(repo, "update-ref", `refs/heads/story/${storySlug}`, run(tree, "rev-parse", "HEAD"));
  return tree;
}

const failureOf = async (branch: string, slug: string, tree: string): Promise<Error | null> =>
  trees.mergeTaskIntoStory(branch, slug, tree).then(
    () => null,
    (e: Error) => e,
  );

describe("a task merge that conflicts", () => {
  it("names the task, the story and the files that conflicted", async () => {
    const tree = await twoWaysApart("password-reset", "send-mail");

    const err = await failureOf("task/send-mail", "password-reset", tree);

    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).toContain("merge task/send-mail into story/password-reset failed");
    expect(err?.message).toContain("conflicted in: src/a.ts, src/b.ts");
    // the file only the task wrote merged cleanly, so it is not one of the conflicts
    expect(err?.message).not.toContain("src/c.ts");
  });

  it("still aborts the merge, and says so after naming the files", async () => {
    const tree = await twoWaysApart("password-reset", "send-mail");
    const was = run(tree, "rev-parse", "HEAD");

    const err = await failureOf("task/send-mail", "password-reset", tree);

    expect(err?.message).toContain("no merge is left standing: the tree is as it was");
    expect(err?.message.indexOf("conflicted in:")).toBeLessThan(
      err?.message.indexOf("no merge is left standing") ?? -1,
    );
    // and the tree agrees with the sentence
    const gitDir = run(tree, "rev-parse", "--absolute-git-dir");
    expect(existsSync(join(gitDir, "MERGE_HEAD"))).toBe(false);
    expect(run(tree, "status", "--porcelain")).toBe("");
    expect(run(tree, "rev-parse", "HEAD")).toBe(was);
  });

  it("claims no conflicted files when the merge failed for another reason", async () => {
    const tree = await trees.storyTree("password-reset", tmp("wecode-task-merge-none-"));

    const err = await failureOf("task/never-existed", "password-reset", tree);

    expect(err).toBeInstanceOf(GitError);
    expect(err?.message).not.toContain("conflicted in:");
    expect(err?.message).toContain("no merge is left standing: the tree is as it was");
  });
});
