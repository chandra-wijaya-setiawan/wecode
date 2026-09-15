import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
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

/** What a landing did. Field report: `land` printed "story/x landed" whether the base
 *  gained a commit or git said "Already up to date", so a story read unlanded on the next
 *  sweep and nobody could tell the two apart. There is no third outcome: either the base
 *  moved and there is a sha to show, or nothing happened and there is a reason. */
export type Landing =
  | { readonly kind: "merged"; readonly sha: string }
  | { readonly kind: "nothing"; readonly why: "no-branch" | "already-ancestor" };

/** One vocabulary for the outcome, so the cli and the runner cannot describe the same
 *  landing differently. */
export function landingReport(branch: string, base: string, landing: Landing): string {
  if (landing.kind === "merged") return `${branch} landed on ${base}: ${landing.sha.slice(0, 12)}`;
  return landing.why === "no-branch"
    ? `nothing to land: there is no ${branch}`
    : `nothing to land: ${branch} is already in ${base}`;
}

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

  /** Cut from the story branch, once — and re-cut if the story branch has moved past it. */
  async taskBranch(storySlug: string, taskSlug: string): Promise<string> {
    const story = await this.storyBranch(storySlug);
    const name = `task/${taskSlug}`;
    if (!(await this.has(name))) await git(this.repo, ["branch", name, story]);
    else await this.recut(name, story);
    return name;
  }

  /** A task branch outlives its cut. The story branch moves under it every time a sibling
   *  task merges, and a slug can be started again after a drop, so "it already exists" is
   *  not the same as "it is cut from the story". Reusing a tip the story has left behind
   *  gives the assignment a tree without its siblings' work in it, and merging that back
   *  later re-proposes the old base as a change. So: descendant of the story, reuse it;
   *  behind the story with nothing of its own, move it to the tip; anything else and it
   *  carries commits — an attempt — that only a person can decide to lose. */
  private async recut(branch: string, story: string): Promise<void> {
    const tip = await git(this.repo, ["rev-parse", `refs/heads/${branch}`]);
    const storyTip = await git(this.repo, ["rev-parse", `refs/heads/${story}`]);
    if (await this.isAncestor(this.repo, storyTip, tip)) return;
    if (!(await this.isAncestor(this.repo, tip, storyTip))) {
      throw new GitError(
        `taskBranch refused ${branch}: its tip ${tip} is not a descendant of ${story} ` +
          `${storyTip}, and it carries commits ${story} does not — re-cutting it would lose them`,
      );
    }
    await git(this.repo, ["branch", "-f", branch, storyTip]);
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

  /** docs/design/14. Field report 105. The merge that lands a story belongs in the checkout
   *  that holds the base branch, and nowhere else. Run from the story's own worktree,
   *  `git merge story/x` merges the branch into itself: git says "Already up to date", the
   *  operator is told it landed, and the base never gained the commit. Any other tree is
   *  worse — a wrong-tree merge is how a conflicted merge commit reached master once — so
   *  land never retargets silently. It names the tree it was called in, names the tree it
   *  should be run in, and merges nothing. */
  async landStory(storySlug: string, from: string): Promise<string> {
    const landing = await this.land(storySlug, from);
    if (landing.kind === "merged") return landing.sha;
    throw new GitError(
      `land story/${storySlug} did nothing: ${landingReport(`story/${storySlug}`, await this.integrationBranch(), landing)}`,
    );
  }

  /** The same merge, reporting what it found instead of a sha it cannot always have. */
  async land(storySlug: string, from: string): Promise<Landing> {
    const branch = `story/${storySlug}`;
    const base = await this.integrationBranch();
    const here = real(await git(from, ["rev-parse", "--show-toplevel"]).catch(() => from));
    const trees = await this.checkouts();
    const baseTree = trees.find((c) => c.branch === base);
    if (baseTree === undefined) {
      throw new GitError(
        `land ${branch} refused in ${here}: no checkout has ${base} checked out, ` +
          `so there is no tree the merge into ${base} could happen in`,
      );
    }
    if (here !== real(baseTree.path)) {
      const holds = trees.find((c) => real(c.path) === here)?.branch;
      const what = holds === branch
        ? `it is the ${branch} worktree, and merging ${branch} there merges it into itself`
        : holds === null || holds === undefined
          ? "it is not the tree that holds the base branch"
          : `it holds ${holds}, not ${base}`;
      throw new GitError(
        `land ${branch} refused in ${here}: ${what}. ` +
          `Run it in ${baseTree.path}, the checkout that holds ${base}.`,
      );
    }
    if (!(await this.has(branch))) return { kind: "nothing", why: "no-branch" };
    // Asked before the merge, because git answers "Already up to date" and exit 0 for it —
    // indistinguishable, afterwards, from a merge that happened.
    if (await this.isAncestor(here, branch, "HEAD")) return { kind: "nothing", why: "already-ancestor" };
    const before = await git(here, ["rev-parse", "HEAD"]);
    await this.mergeInto(here, branch, `land ${branch}`, `land ${branch}`);
    const sha = await git(here, ["rev-parse", "HEAD"]);
    return sha === before ? { kind: "nothing", why: "already-ancestor" } : { kind: "merged", sha };
  }

  /** Guarded by the task's tests passing. Runs in the story tree, so nothing an agent can
   *  be dispatched into is ever the tree holding the integration branch. */
  async mergeTaskIntoStory(taskBranch: string, storySlug: string, storyTreePath: string): Promise<void> {
    await this.refuseBaseCheckout(storyTreePath, "mergeTaskIntoStory");
    const tree = await this.storyTree(storySlug, storyTreePath);
    await this.mergeInto(
      tree,
      taskBranch,
      `merge ${taskBranch}`,
      `merge ${taskBranch} into story/${storySlug}`,
    );
  }

  /** Every merge this class makes goes through here. A merge that conflicts exits non-zero
   *  with the tree it ran in left mid-merge — a conflicted index, `MERGE_HEAD` written, and
   *  half of someone else's branch in the working files. Nothing downstream wants that: the
   *  story tree is reused by the next task merge and by the examiner, and the base checkout
   *  belongs to a person. So the merge is aborted here and the caller is told which of the
   *  two things is true, because the failure alone read the same either way.
   *
   *  Whether the abort worked is read back off the tree rather than off its exit code —
   *  `merge --abort` also fails when there was no merge to abort, and such a tree is not
   *  wedged. A tree still holding `MERGE_HEAD` is, and then the sentence has to say so. */
  private async mergeInto(tree: string, branch: string, message: string, what: string): Promise<void> {
    try {
      await git(tree, [
        "-c",
        "user.name=wecode",
        "-c",
        "user.email=wecode@localhost",
        "merge",
        "--no-ff",
        "-q",
        "-m",
        message,
        branch,
      ]);
    } catch (err) {
      const conflicted = await this.conflictedPaths(tree);
      await git(tree, ["merge", "--abort"]).catch(() => "");
      const after = (await this.midMerge(tree))
        ? `the merge would not abort: ${tree} is left mid-merge and wants a person`
        : "no merge is left standing: the tree is as it was";
      const where =
        conflicted.length > 0 ? ` — conflicted in: ${conflicted.join(", ")}` : "";
      throw new GitError(`${what} failed: ${(err as Error).message}${where} — ${after}`);
    }
  }

  /** Which files the merge could not reconcile. Read from the conflicted index *before* the
   *  abort, because the abort is what throws that index away — afterwards there is nothing
   *  left to name. A non-conflict failure (a dirty tree, an unknown branch) has no such
   *  paths, and then the sentence leaves them out rather than claiming none conflicted. */
  private async conflictedPaths(tree: string): Promise<readonly string[]> {
    const out = await git(tree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    return out === "" ? [] : out.split("\n");
  }

  /** Is this tree still in the middle of a merge? `MERGE_HEAD` is git's own record of it,
   *  and it lives in the tree's own git dir, not the repository's. */
  private async midMerge(tree: string): Promise<boolean> {
    const dir = await git(tree, ["rev-parse", "--absolute-git-dir"]).catch(() => "");
    return dir !== "" && existsSync(join(dir, "MERGE_HEAD"));
  }
}
