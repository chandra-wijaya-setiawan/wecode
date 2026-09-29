import { execFile } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withinCeiling } from "@wecode/core";
// By path: the landing rules belong to core but nothing exports them from the barrel.
import { type PrimaryDrift, updatePrimary } from "@wecode/core/dist/land.js";

const exec = promisify(execFile);

/** Symlinked temp roots and `..`-shaped paths are the same directory spelled differently. */
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** `made` is the commit an attempt had already made when the error stopped it, when there is
 *  one: no branch was moved onto it, so only its tree's HEAD holds it. */
export class GitError extends Error { made: string | null = null; }

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

/** What a retry finds already on its branch. A rejected attempt still commits, so the tree
 *  a retry is cut into is not the base: some of the history is a previous attempt's work and
 *  the rest is what the story was at when the task was cut. Those two are indistinguishable
 *  from inside the tree — `git log` shows one list — and a retry that cannot tell them apart
 *  either redoes work that is already there or "fixes" the base. */
export interface Inherited {
  /** The story tip the task branch was cut from: the last commit that is not an attempt's. */
  readonly base: { readonly ref: string; readonly sha: string };
  /** The previous attempts' commits, newest first. */
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
}

const short = (sha: string): string => sha.slice(0, 12);

/** One vocabulary for it, so whatever tells a retry cannot describe the branch differently
 *  from what `inherited` read. The base is named by sha and not only by ref: the ref moves
 *  under the branch as siblings merge, and `git diff story/s` next week is a different diff. */
export function inheritedReport(branch: string, inherited: Inherited): string {
  const { ref, sha } = inherited.base;
  const at = `${ref} ${short(sha)}`;
  if (inherited.commits.length === 0) {
    return `${branch} has no commits of its own: all of it is the base, ${at}.`;
  }
  const lines = inherited.commits.map((c) => `  ${short(c.sha)} ${c.subject}`).join("\n");
  const n = inherited.commits.length;
  const oldest = inherited.commits[n - 1]?.sha ?? sha;
  return (
    `${branch} carries ${n} commit${n === 1 ? "" : "s"} from a previous attempt, newest first:\n` +
    `${lines}\nEverything below ${short(oldest)} is the base, ${at}. ` +
    `Diff against ${short(sha)} to see only the attempt's work.`
  );
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
   *  later re-proposes the old base as a change.
   *
   *  So: descendant of the story, reuse it; behind the story with nothing of its own, move
   *  it to the tip. Diverged — it carries commits the story does not — used to refuse, and
   *  a refusal here stalls the queue: nothing else can dispatch that task, and the branch
   *  the operator has to inspect is the one thing the refusal will not name durably. Tagged
   *  instead. The tip becomes an `attempt/<slug>/<n>` tag, which is a ref, so the commits
   *  stay reachable and survive the `branch -f` that follows. No attempt is lost and the
   *  next assignment cuts from the story tip. */
  private async recut(branch: string, story: string): Promise<void> {
    const tip = await git(this.repo, ["rev-parse", `refs/heads/${branch}`]);
    const storyTip = await git(this.repo, ["rev-parse", `refs/heads/${story}`]);
    if (await this.isAncestor(this.repo, storyTip, tip)) return;
    if (!(await this.isAncestor(this.repo, tip, storyTip))) await this.tagAttempt(branch, tip);
    await git(this.repo, ["branch", "-f", branch, storyTip]);
  }

  /** Numbered, never reused: attempt 1 is the first tip that was set aside, and the number
   *  is the order they were set aside in. Read off the tags that exist rather than counted
   *  anywhere, because the tags are the only record that outlives the branch. */
  async tagAttempt(branch: string, sha: string): Promise<string> {
    const existing = await this.attemptTags(branch);
    const next = existing.reduce((max, t) => Math.max(max, Number(t.slice(t.lastIndexOf("/") + 1)) || 0), 0) + 1;
    const tag = `attempt/${branch.replace(/^task\//, "")}/${next}`;
    await git(this.repo, ["tag", tag, sha]);
    return tag;
  }

  /** Every tip set aside for this task branch, oldest first. */
  async attemptTags(branch: string): Promise<readonly string[]> {
    const prefix = `attempt/${branch.replace(/^task\//, "")}/`;
    const out = await git(this.repo, ["tag", "--list", `${prefix}*`]).catch(() => "");
    return out === ""
      ? []
      : out
          .split("\n")
          .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  }

  /** Split the task branch into what a previous attempt wrote and what it was cut from.
   *
   *  The boundary is the merge base with the story branch, not the story tip: the story
   *  moves under a task branch every time a sibling merges, so "everything not in the story
   *  tip" would count a sibling's landed work as this attempt's, and "the story tip" is a
   *  commit the branch may not even contain. The merge base is the last commit both agree
   *  on, which is exactly the base the attempt built on.
   *
   *  A branch that does not exist yet is not an error — it is the first attempt, and the
   *  answer is the base with nothing on top. */
  async inherited(taskSlug: string, storySlug: string): Promise<Inherited> {
    const branch = `task/${taskSlug}`;
    const story = `story/${storySlug}`;
    const ref = (await this.has(story)) ? story : await this.integrationBranch();
    const tip = await git(this.repo, ["rev-parse", ref]);
    if (!(await this.has(branch))) return { base: { ref, sha: tip }, commits: [] };
    const sha = await git(this.repo, ["merge-base", ref, branch]).catch(() => tip);
    const log = await git(this.repo, ["log", "--format=%H %s", `${sha}..${branch}`]);
    const commits = log === "" ? [] : log.split("\n").map((line) => ({
      sha: line.slice(0, line.indexOf(" ")),
      subject: line.slice(line.indexOf(" ") + 1),
    }));
    return { base: { ref, sha }, commits };
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

  /** Move a branch onto a commit an attempt made, naming that commit when git refuses. The
   *  update can be stopped after the commit exists — by a hook, or by a ref that moved — and
   *  only the tree's HEAD holds it then: an error that did not name it loses the work. */
  private async moveOnto(branch: string, sha: string, ...from: readonly string[]): Promise<void> {
    await git(this.repo, ["update-ref", `refs/heads/${branch}`, sha, ...from]).catch((err: Error) => {
      const stopped = new GitError(`${sha} is committed and ${branch} would not move: ${err.message}`);
      stopped.made = sha;
      throw stopped;
    });
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
    await this.moveOnto(branch, head, tip);
    return head;
  }

  /** The paths of the tree the scope covers: changed against HEAD — a deletion included —
   *  and untracked. Asked as two plain lists rather than of `status --porcelain`, whose
   *  status letters have to be sliced off a line whose leading column may be a space.
   *  Ignored files are left out, as `add -A` leaves them out.
   *
   *  Covered is asked of `withinCeiling` rather than of a second matcher: a path is a glob
   *  that matches itself, and a matcher here that had to agree with the one the scope was
   *  checked by would be the defect. */
  private async inScope(path: string, scope: readonly string[]): Promise<string[]> {
    const lines = async (args: readonly string[]): Promise<string[]> =>
      (await git(path, args)).split("\n").filter((f) => f !== "");
    const touched = [
      ...(await lines(["diff", "--name-only", "--no-renames", "HEAD"])),
      ...(await lines(["ls-files", "--others", "--exclude-standard"])),
    ];
    return touched.filter((f) => withinCeiling({ write: scope, tools: [] }, { write: [f], tools: [] }).ok);
  }

  /** Everything the attempt wrote, on its branch. A rejected attempt still commits: the
   *  next one must be able to see what is already there.
   *
   *  `scope` is the assignment's write globs, and it is what gets staged — nothing else.
   *  The harness holds the scope for the tools it grants, but a shell, a generator or a test
   *  run writes around it, and `add -A` then carried those strays onto the branch, where a
   *  merge put them on master (the tracked root `mail.ts` got there exactly this way). A
   *  stray is left in the tree instead: uncommitted, so cleanup reports it rather than
   *  landing it. Omitted — not an empty list, which is a role that may write nothing —
   *  stages the whole tree, as before. */
  async commitAttempt(
    path: string,
    branch: string,
    message: string,
    scope?: readonly string[],
  ): Promise<string | null> {
    await this.refuseBaseCheckout(path, "commitAttempt");
    await this.refuseAttached(path, "commitAttempt");
    const forwarded = await this.fastForwardToHead(path, branch);
    if (scope === undefined) await git(path, ["add", "-A"]);
    else {
      // What the attempt staged for itself is no exemption: the index is rebuilt from the
      // scope, so an out-of-scope `git add` it ran does not survive into the commit.
      await git(path, ["reset", "-q"]);
      const inScope = await this.inScope(path, scope);
      if (inScope.length > 0) await git(path, ["add", "--", ...inScope]);
    }
    const staged = await git(path, ["diff", "--cached", "--name-only"]);
    if (staged === "") return forwarded;
    const who = ["-c", "user.name=wecode", "-c", "user.email=wecode@localhost"];
    await git(path, [...who, "commit", "-q", "-m", message]);
    const sha = await git(path, ["rev-parse", "HEAD"]);
    await this.moveOnto(branch, sha);
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
  async cleanupLanded(storySlug: string, storyTreePath: string, taskSlugs: readonly string[]): Promise<LandingCleanup> {
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
  private async releaseIfClean(path: string, removed: string[], left: { what: string; why: string }[]): Promise<boolean> {
    if (!(await this.isWorktree(path))) return false;
    if (await this.isDirty(path)) {
      left.push({ what: path, why: "uncommitted files nobody has seen" });
      return true;
    }
    await git(this.repo, ["worktree", "remove", path]);
    removed.push(path);
    return false;
  }

  private async deleteBranch(name: string, removed: string[], left: { what: string; why: string }[]): Promise<void> {
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
      const why = `no checkout has ${base} checked out, so there is no tree the merge into ${base} could happen in`;
      throw new GitError(`land ${branch} refused in ${here}: ${why}`);
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
    if (sha === before) return { kind: "nothing", why: "already-ancestor" };
    await this.sweepEmptied(here, before, sha);
    return { kind: "merged", sha };
  }

  /** docs/design/14. Renaming a package moves every tracked file out of its old directory and
   *  the directory stays: `node_modules` and `dist` live in it, and git neither
   *  tracks them nor removes them. What survives is a ghost package — no package in it, a stale
   *  `dist` that imports still resolve into, and a tree audit counting a component renamed away.
   *  Swept only where the merge emptied it and git holds nothing under it any more: one tracked
   *  file left anywhere below and the directory is somebody's, ignored build output and all.
   *  Silent: there is nothing here anybody wrote, and nothing a person has to be told to run. */
  private async sweepEmptied(tree: string, before: string, after: string): Promise<void> {
    // `--no-renames`: a rename is the case this exists for, and git scores it `R`, not `D`.
    const args = ["diff", "--name-only", "--no-renames", "--diff-filter=D", before, after];
    const deleted = await git(tree, args).catch(() => "");
    const dirs = new Set<string>();
    for (const file of deleted.split("\n").filter((f) => f !== "")) {
      for (let d = dirname(file); d !== "." && d !== "/"; d = dirname(d)) dirs.add(d);
    }
    // Deepest first: emptying a package's `src` is what makes the package itself removable.
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      if (!existsSync(join(tree, dir))) continue;
      if ((await git(tree, ["ls-files", "--", dir]).catch(() => "kept")) !== "") continue;
      await git(tree, ["clean", "-xfdq", "--", dir]).catch(() => "");
      rmSync(join(tree, dir), { recursive: true, force: true });
    }
  }

  /** docs/design/14. The other half of a landing made in a tree of wecode's own.
   *
   *  `update-ref` moves the base branch and writes no checkout, so the folder a person works
   *  in keeps showing the pre-land files — with the landed paths as phantom staged deletions,
   *  because HEAD moved under an index that never saw them. It reads as lost work, and
   *  nothing said so.
   *
   *  Called with the base tip as it was before the landing and as it is after. A primary
   *  checkout on the base holding nothing but the old tip is brought forward; one holding
   *  the operator's own work is left exactly as it is and the command is returned for the
   *  caller to say. Null is nothing to say: it is current, or it was never on the base. */
  async syncPrimaryCheckout(base: string, before: string, after: string): Promise<string | null> {
    const path = await this.rootPath();
    const drift = await this.primaryDrift(path, base, before, after);
    const verdict = updatePrimary(drift);
    if (verdict.kind === "tell") return verdict.instruction;
    if (verdict.kind === "current") return null;
    // Not `checkout`: the branch is already at `after` and only the index and the working
    // files are behind, which is the one thing `reset --hard` is for. It moves no ref here.
    await git(path, ["reset", "--hard", "-q", after]);
    return null;
  }

  /** The facts the rule in core is decided on, read off the primary checkout. Staleness is
   *  measured against the *old* tip rather than against HEAD: HEAD is already the landing
   *  commit, so a perfectly untouched tree reports the landed paths as deletions and every
   *  cleanliness test built on HEAD calls it dirty. */
  private async primaryDrift(path: string, base: string, before: string, after: string): Promise<PrimaryDrift> {
    const blank = { path, base, onBase: false, alreadyCurrent: false, wasTheOldTip: false, ownWork: [] };
    const held = (await this.checkouts()).find((c) => real(c.path) === real(path));
    if (held?.branch !== base) return blank;
    const same = async (args: readonly string[]): Promise<boolean> =>
      (await git(path, args).then(() => true).catch(() => false));
    const matches = async (commit: string): Promise<boolean> =>
      (await same(["diff", "--quiet", commit])) && (await same(["diff", "--cached", "--quiet", commit]));
    return {
      ...blank,
      onBase: true,
      alreadyCurrent: await matches(after),
      wasTheOldTip: await matches(before),
      ownWork: await this.wouldOverwrite(path, before, after),
    };
  }

  /** The operator's own files the update would write over. A difference from the old tip is
   *  theirs by definition: the tree was at that commit when the landing was made. Untracked
   *  files count only on a path the landing touched — everything else survives the update
   *  untouched, and refusing over an untracked build directory would leave the checkout
   *  stale for ever. */
  private async wouldOverwrite(path: string, before: string, after: string): Promise<string[]> {
    const tracked = await git(path, ["diff", "--name-only", before]).catch(() => "");
    const staged = await git(path, ["diff", "--cached", "--name-only", before]).catch(() => "");
    const untracked = await git(path, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
    const landedPaths = new Set(
      (await git(this.repo, ["diff", "--name-only", before, after]).catch(() => "")).split("\n"),
    );
    const lines = (out: string): string[] => out.split("\n").filter((l) => l !== "");
    const mine = [...lines(tracked), ...lines(staged), ...lines(untracked).filter((p) => landedPaths.has(p))];
    return [...new Set(mine)].sort();
  }

  /** Guarded by the task's tests passing. Runs in the story tree, so nothing an agent can
   *  be dispatched into is ever the tree holding the integration branch.
   *
   *  The same trap `land` has: `git merge` exits 0 and says "Already up to date" when there
   *  was nothing to merge, so a task whose work never reached the story reads as merged and
   *  the daemon records the landing. So the story tip is read either side of the merge, and
   *  a merge that left the branch where it was is refused rather than reported. */
  async mergeTaskIntoStory(taskBranch: string, storySlug: string, storyTreePath: string): Promise<void> {
    await this.refuseBaseCheckout(storyTreePath, "mergeTaskIntoStory");
    const tree = await this.storyTree(storySlug, storyTreePath);
    const branch = `story/${storySlug}`;
    const before = await git(tree, ["rev-parse", "HEAD"]);
    await this.mergeInto(tree, taskBranch, `merge ${taskBranch}`, `merge ${taskBranch} into ${branch}`);
    const after = await git(tree, ["rev-parse", "HEAD"]);
    if (after !== before) return;
    const why = (await this.isAncestor(tree, taskBranch, "HEAD"))
      ? `${taskBranch} is already in ${branch}, so the merge had nothing to add`
      : `${taskBranch} is not in ${branch} either, so the merge did not happen`;
    throw new GitError(
      `merge ${taskBranch} into ${branch} moved nothing: ${branch} is still at ${short(before)} — ${why}`,
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
      const who = ["-c", "user.name=wecode", "-c", "user.email=wecode@localhost"];
      await git(tree, [...who, "merge", "--no-ff", "-q", "-m", message, branch]);
    } catch (err) {
      const conflicted = await this.conflictedPaths(tree);
      await git(tree, ["merge", "--abort"]).catch(() => "");
      const after = (await this.midMerge(tree))
        ? `the merge would not abort: ${tree} is left mid-merge and wants a person`
        : "no merge is left standing: the tree is as it was";
      const where = conflicted.length > 0 ? ` — conflicted in: ${conflicted.join(", ")}` : "";
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
