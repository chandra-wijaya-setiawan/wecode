import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", [...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitError(`git ${args.join(" ")}: ${(e.stderr ?? e.message ?? "").trim()}`);
  }
}

/** docs/design/09. A branch per story and per task, a worktree per assignment. */
export class Trees {
  constructor(
    private readonly repo: string,
    private readonly integration = "main",
  ) {}

  private async has(ref: string): Promise<boolean> {
    try {
      await git(this.repo, ["rev-parse", "--verify", "--quiet", ref]);
      return true;
    } catch {
      return false;
    }
  }

  /** Cut from the integration branch, once. */
  async storyBranch(storySlug: string): Promise<string> {
    const name = `story/${storySlug}`;
    if (!(await this.has(name))) await git(this.repo, ["branch", name, this.integration]);
    return name;
  }

  /** Cut from the story branch, once. */
  async taskBranch(storySlug: string, taskSlug: string): Promise<string> {
    const story = await this.storyBranch(storySlug);
    const name = `task/${taskSlug}`;
    if (!(await this.has(name))) await git(this.repo, ["branch", name, story]);
    return name;
  }

  /** A fresh tree at the task branch tip. A retry is an agent with no memory; it must not
   *  inherit the last attempt's dirty tree. */
  async cut(branch: string, path: string): Promise<string> {
    await git(this.repo, ["worktree", "add", "--detach", path, branch]);
    return path;
  }

  /** Everything the attempt wrote, on its branch. A rejected attempt still commits: the
   *  next one must be able to see what is already there. */
  async commitAttempt(path: string, branch: string, message: string): Promise<string | null> {
    await git(path, ["add", "-A"]);
    const staged = await git(path, ["diff", "--cached", "--name-only"]);
    if (staged === "") return null;
    await git(path, [
      "-c",
      "user.name=wecode",
      "-c",
      "user.email=wecode@localhost",
      "commit",
      "-q",
      "-m",
      message,
    ]);
    const sha = await git(path, ["rev-parse", "HEAD"]);
    await git(this.repo, ["update-ref", `refs/heads/${branch}`, sha]);
    return sha;
  }

  /** Released once the attempt is committed — the branch is the surviving copy, and the
   *  directory beside it is a checkout held against a retry nobody has promised. */
  async release(path: string): Promise<void> {
    await git(this.repo, ["worktree", "remove", "--force", path]);
  }

  /** One reusable tree at the story branch tip. Acceptance tests run here, after the
   *  tasks they depend on have merged, and this is where a merge happens — the integration
   *  checkout is never touched. */
  async storyTree(storySlug: string, path: string): Promise<string> {
    const branch = await this.storyBranch(storySlug);
    if (!(await this.isWorktree(path))) {
      await git(this.repo, ["worktree", "add", path, branch]);
    } else {
      await git(path, ["checkout", "-q", branch]);
      await git(path, ["reset", "--hard", "-q", branch]);
    }
    return path;
  }

  private async isWorktree(path: string): Promise<boolean> {
    try {
      const list = await git(this.repo, ["worktree", "list", "--porcelain"]);
      return list.split("\n").some((l) => l === `worktree ${path}`);
    } catch {
      return false;
    }
  }

  /** Guarded by the task's tests passing. Runs in the story tree, so nothing an agent can
   *  be dispatched into is ever the tree holding the integration branch. */
  async mergeTaskIntoStory(taskBranch: string, storySlug: string, storyTreePath: string): Promise<void> {
    const tree = await this.storyTree(storySlug, storyTreePath);
    await git(tree, [
      "-c",
      "user.name=wecode",
      "-c",
      "user.email=wecode@localhost",
      "merge",
      "--no-ff",
      "-q",
      "-m",
      `merge ${taskBranch}`,
      taskBranch,
    ]);
  }
}
