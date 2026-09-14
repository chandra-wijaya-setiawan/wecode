import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Symlinked temp roots and `..`-shaped paths are the same directory spelled differently. */
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export class GitError extends Error {}

/** What cleanup did, and what it refused to do. The refusals are the half that matters:
 *  they are what the board reports instead of a deletion. */
export interface LandingCleanup {
  readonly removed: readonly string[];
  readonly left: readonly { readonly what: string; readonly why: string }[];
}

interface Checkout {
  readonly path: string;
  readonly branch: string | null;
}

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
  private resolved: string | null;

  constructor(
    private readonly repo: string,
    integration: string | null = null,
  ) {
    this.resolved = integration;
  }

  /** The branch everything is cut from. Asked of the repository rather than assumed: a
   *  default of "main" is wrong on every repository that says "master", and the failure is
   *  silent — every tree simply fails to cut. */
  async integrationBranch(): Promise<string> {
    if (this.resolved !== null) return this.resolved;
    const head = await git(this.repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    this.resolved = head === "" ? "main" : head;
    return this.resolved;
  }

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
    if (!(await this.has(name))) await git(this.repo, ["branch", name, await this.integrationBranch()]);
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

  /** True when `ancestor` is reachable from `descendant`. */
  private async isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await git(path, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /** The tree is cut `--detach`, so an attempt that commits for itself — a merge, a revert,
   *  a rebase, or just an agent that ran `git commit` — moves HEAD and leaves the branch
   *  where it was cut. Nothing else moves the ref, so that work becomes unreachable. Carried
   *  forward here, before the working tree is committed on top of it. */
  private async fastForwardToHead(path: string, branch: string): Promise<string | null> {
    const head = await git(path, ["rev-parse", "HEAD"]);
    const tip = await git(this.repo, ["rev-parse", `refs/heads/${branch}`]);
    if (head === tip) return null;
    if (!(await this.isAncestor(path, tip, head))) {
      throw new GitError(
        `commitAttempt refused ${path}: HEAD ${head} has diverged from ${branch} ${tip}; ` +
          `no fast-forward can express it`,
      );
    }
    await git(this.repo, ["update-ref", `refs/heads/${branch}`, head, tip]);
    return head;
  }

  /** Everything the attempt wrote, on its branch. A rejected attempt still commits: the
   *  next one must be able to see what is already there. */
  async commitAttempt(path: string, branch: string, message: string): Promise<string | null> {
    await this.refuseBaseCheckout(path, "commitAttempt");
    await this.refuseAttached(path, "commitAttempt");
    const forwarded = await this.fastForwardToHead(path, branch);
    await git(path, ["add", "-A"]);
    const staged = await git(path, ["diff", "--cached", "--name-only"]);
    if (staged === "") return forwarded;
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
    await this.refuseBaseCheckout(path, "release");
    await this.refuseAttached(path, "release");
    await git(this.repo, ["worktree", "remove", "--force", path]);
  }

  /** The primary checkout: the first tree git lists, and the one a person works in. */
  private async rootPath(): Promise<string> {
    const list = await git(this.repo, ["worktree", "list", "--porcelain"]).catch(() => "");
    return /^worktree (.+)$/m.exec(list)?.[1] ?? this.repo;
  }

  /** A wecode attempt only ever commits in a detached worktree it cut. The primary checkout
   *  belongs to a person: an `add -A` there stages their work, and a `worktree remove`
   *  there is their repository. Named, with what was found, rather than silently skipped. */
  private async refuseBaseCheckout(path: string, what: string): Promise<void> {
    const top = await git(path, ["rev-parse", "--show-toplevel"]).catch(() => path);
    if (real(top) !== real(await this.rootPath())) return;
    throw new GitError(`${what} refused ${path}: it is the repository root`);
  }

  /** A branch checked out means the commit lands on a ref nobody pointed this attempt at. */
  private async refuseAttached(path: string, what: string): Promise<void> {
    const branch = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (branch === "") return;
    throw new GitError(`${what} refused ${path}: branch ${branch} is checked out, not detached`);
  }

  /** One reusable tree at the story branch tip. Acceptance tests run here, after the
   *  tasks they depend on have merged, and this is where a merge happens — the integration
   *  checkout is never touched. */
  async storyTree(storySlug: string, path: string): Promise<string> {
    await this.refuseBaseCheckout(path, "storyTree");
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
    return (await this.checkouts()).some((c) => c.path === path);
  }

  private async checkouts(): Promise<Checkout[]> {
    const list = await git(this.repo, ["worktree", "list", "--porcelain"]).catch(() => "");
    const out: Checkout[] = [];
    for (const block of list.split("\n\n")) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (path === undefined) continue;
      out.push({ path, branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null });
    }
    return out;
  }

  /** Uncommitted files nobody has seen. Untracked counts: an agent that wrote a file and
   *  never staged it left work here, and a removed tree takes it with it. */
  private async isDirty(path: string): Promise<boolean> {
    try {
      return (await git(path, ["status", "--porcelain"])) !== "";
    } catch {
      return true;
    }
  }

  /** docs/design/14. Landing — "Cleanup, at the one moment it is safe". Called where
   *  `landed_sha` is set and nowhere else: before the merge the branch is the only copy of
   *  the work. Anything dirty is left standing and named, never deleted. */
  async cleanupLanded(
    storySlug: string,
    storyTreePath: string,
    taskSlugs: readonly string[],
  ): Promise<LandingCleanup> {
    const removed: string[] = [];
    const left: { what: string; why: string }[] = [];
    await git(this.repo, ["worktree", "prune"]).catch(() => "");

    const storyBranch = `story/${storySlug}`;
    const held = await this.releaseIfClean(storyTreePath, removed, left);
    if (held) left.push({ what: storyBranch, why: `its tree is still standing at ${storyTreePath}` });
    else await this.deleteBranch(storyBranch, removed, left);

    for (const slug of taskSlugs) {
      const branch = `task/${slug}`;
      const tree = (await this.checkouts()).find((c) => c.branch === branch);
      if (tree !== undefined && (await this.releaseIfClean(tree.path, removed, left))) {
        left.push({ what: branch, why: `its tree is still standing at ${tree.path}` });
        continue;
      }
      await this.deleteBranch(branch, removed, left);
    }
    return { removed, left };
  }

  /** True when the tree was kept. */
  private async releaseIfClean(
    path: string,
    removed: string[],
    left: { what: string; why: string }[],
  ): Promise<boolean> {
    if (!(await this.isWorktree(path))) return false;
    if (await this.isDirty(path)) {
      left.push({ what: path, why: "uncommitted files nobody has seen" });
      return true;
    }
    await git(this.repo, ["worktree", "remove", path]);
    removed.push(path);
    return false;
  }

  private async deleteBranch(
    name: string,
    removed: string[],
    left: { what: string; why: string }[],
  ): Promise<void> {
    if (!(await this.has(name))) return;
    try {
      await git(this.repo, ["branch", "-D", name]);
      removed.push(name);
    } catch (err) {
      left.push({ what: name, why: (err as Error).message });
    }
  }

  /** Guarded by the task's tests passing. Runs in the story tree, so nothing an agent can
   *  be dispatched into is ever the tree holding the integration branch. */
  async mergeTaskIntoStory(taskBranch: string, storySlug: string, storyTreePath: string): Promise<void> {
    await this.refuseBaseCheckout(storyTreePath, "mergeTaskIntoStory");
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
