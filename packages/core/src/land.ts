/** docs/design/14. Field report 105. Where a landing merge is allowed to happen.
 *
 *  The merge that lands a story belongs in the checkout that holds the base branch, and
 *  nowhere else. Run from the story's own worktree, `git merge story/x` merges the branch
 *  into itself: git says "Already up to date", the operator is told it landed, and the base
 *  never gained the commit. Any other tree is worse — a wrong-tree merge is how a conflicted
 *  merge commit reached master once.
 *
 *  So land never retargets silently. It names the tree it was called in, names the tree it
 *  should be run in, and merges nothing. This module is the rule alone: no git, no clock, no
 *  filesystem, so the command half and the runner half can be held to the same words. */

/** Where a story landed when it did not land here: the repository, and the commit in that
 *  repository when anybody recorded one. `sha` is null for a landing somebody knows the
 *  repository of and not the commit — by hand, after the fact, which is how most of them
 *  are recorded. */
export interface ForeignLanding {
  readonly repo: string;
  readonly sha: string | null;
}

/** A tail is read as a commit only when it looks like one. `git@github.com:org/repo` is a
 *  repository whose name contains an `@`, and splitting it as `repo@sha` names a repository
 *  called `git` that nobody has. */
const LOOKS_LIKE_A_SHA = /^[0-9a-f]{7,40}$/;

/** The marker a story carries when its work shipped in another repository, read.
 *
 *  Not every story a workspace tracks lands in the repository the workspace sits in: the
 *  change is made in a downstream repo, a vendored copy, a fork somebody else owns. Until
 *  this, such a story was delivered forever with no `landed_sha`, so the record accused it
 *  of never having reached the base — true of this base and false of the work — and every
 *  tick offered it to the lander again, which refused it again, because `story/<slug>` is
 *  not here.
 *
 *  So the marker is a second kind of landing rather than a second kind of sha. It is written
 *  `<repo>` or `<repo>@<sha>`, and it is kept out of `landed_sha` on purpose: that column
 *  names a commit in *this* repository — the doctor heals it from `land story/x` and every
 *  reader slices it to twelve characters and prints it — and a foreign sha put there is a
 *  commit `git show` cannot find, reported as if it could. */
export function foreignLanding(marker: string | null | undefined): ForeignLanding | null {
  const text = (marker ?? "").trim();
  if (text === "") return null;
  const at = text.lastIndexOf("@");
  const tail = at === -1 ? "" : text.slice(at + 1).trim();
  if (at > 0 && LOOKS_LIKE_A_SHA.test(tail)) {
    const repo = text.slice(0, at).trim();
    if (repo !== "") return { repo, sha: tail };
  }
  return { repo: text, sha: null };
}

/** Whether a story's marker says it landed somewhere other than here. The question the
 *  record asks: a story that shipped in another repository has reached no base of ours and
 *  never will, so neither the unlanded accusation nor the lander's list is about it. */
export const landedElsewhere = (marker: string | null | undefined): boolean => foreignLanding(marker) !== null;

/** What to say about such a story where a local landing would name its commit, or null when
 *  no marker says it landed elsewhere. */
export function landedElsewhereNote(marker: string | null | undefined): string | null {
  const landing = foreignLanding(marker);
  return landing === null ? null : saidLandedElsewhere(landing);
}

/** The marker to write, and the sentence for the ledger, for a landing made elsewhere. The
 *  pair `landingRecord` returns for a landing made here, so the two are recorded alike. */
export function markLandedElsewhere(repo: string, sha?: string | null): {
  readonly marker: string;
  readonly note: string;
} {
  const name = repo.trim();
  const commit = (sha ?? "").trim();
  const landing: ForeignLanding = { repo: name, sha: commit === "" ? null : commit };
  return { marker: commit === "" ? name : `${name}@${commit}`, note: saidLandedElsewhere(landing) };
}

/** What such a story is called, wherever it is said. The `not in this repository` half is
 *  not decoration: "landed in acme-web" beside a board of local landings reads like a branch
 *  name, and an operator who then looks for the merge in `git log` finds nothing and files a
 *  bug against the lander. */
export function saidLandedElsewhere(landing: ForeignLanding): string {
  const as = landing.sha === null ? "" : ` as ${landing.sha.slice(0, 12)}`;
  return `landed in ${landing.repo}${as}, not in this repository`;
}

/** Why this story may not be landed here at all, or null when no marker says it landed
 *  elsewhere. Asked before `refuseLand`, because where the merge would be run is the wrong
 *  argument to have with an operator about work that is not in this repository to merge. */
export function refuseForeignLand(place: LandingPlace, marker: string | null | undefined): string | null {
  const landing = foreignLanding(marker);
  if (landing === null) return null;
  return (
    `land ${place.branch} refused in ${place.here}: the record says it ${saidLandedElsewhere(landing)}.\n` +
    `  there is nothing here to merge into ${place.base}, and a branch of that name here ` +
    `would be a second copy of work that has already shipped.\n` +
    `  if the marker is wrong, clear it, then land again.`
  );
}

/** One entry of `git worktree list --porcelain`. `branch` is null for a detached checkout. */
export interface Checkout {
  readonly path: string;
  readonly branch: string | null;
}

export interface LandingPlace {
  /** The repository root of the directory land was invoked in. */
  readonly here: string;
  /** The story branch being landed, e.g. `story/add-a-guard`. */
  readonly branch: string;
  /** The branch the story lands on, e.g. `master`. */
  readonly base: string;
  /** Every checkout of this repository, the invoking one included. */
  readonly trees: readonly Checkout[];
}

/** A branch the landing may be allowed to remove. The ref is safe to delete only when
 * the merge actually carried it; an unmerged branch may still be somebody's unread work. */
export interface LandedBranch {
  readonly branch: string;
  readonly merged: boolean;
}

/** The refs cleanup may remove after the landing. Git cleanup is performed by the runner;
 * this pure rule keeps it from turning "under this story" into permission to delete work. */
export function branchesToRemoveAfterLanding(
  storyBranch: string,
  tasks: readonly LandedBranch[],
): readonly string[] {
  return [...new Set([storyBranch, ...tasks.filter((task) => task.merged).map((task) => task.branch)])];
}

/** Why this tree may not land the story, or null when it may.
 *
 *  Paths are compared as given: a caller holding symlinked paths — a macOS `/tmp`, a
 *  worktree reached through one — resolves them before asking, or two names for one
 *  directory read as two trees and the operator is refused in the tree they are owed. */
export function refuseLand(place: LandingPlace): string | null {
  const { here, branch, base, trees } = place;
  const baseTree = trees.find((c) => c.branch === base);
  if (baseTree === undefined) {
    return (
      `land ${branch} refused in ${here}: no checkout has ${base} checked out, ` +
      `so there is no tree the merge into ${base} could happen in`
    );
  }
  if (here === baseTree.path) return null;
  return `land ${branch} refused in ${here}: ${whyNotHere(here, branch, base, trees)}. ` +
    `Run it in ${baseTree.path}, the checkout that holds ${base}.`;
}

/** The half of the refusal that says what this tree is. A story worktree is named as the
 *  self-merge it would be, because "wrong tree" does not tell an operator standing in
 *  `story/x` that the merge they asked for has no effect at all. */
function whyNotHere(
  here: string,
  branch: string,
  base: string,
  trees: readonly Checkout[],
): string {
  const holds = trees.find((c) => c.path === here)?.branch;
  if (holds === branch) {
    return `it is the ${branch} worktree, and merging ${branch} there merges it into itself`;
  }
  // Null is a detached checkout — every agent attempt tree is one — and undefined is a
  // directory no checkout claims. Neither holds the base, and neither has a branch to name.
  if (holds === null || holds === undefined) return "it is not the tree that holds the base branch";
  return `it holds ${holds}, not ${base}`;
}

/** What the base checkout looks like just before, or just after, a landing merge. */
export interface BaseState {
  /** The repository root of the base checkout. */
  readonly here: string;
  /** The branch the story lands on, e.g. `master`. */
  readonly base: string;
  /** `git status --porcelain -uno` split into lines, empty when no tracked file has changed.
   *  Untracked files are left out on purpose: they do not affect a merge, git refuses on its
   *  own if one would be overwritten, and counting them blocked a landing over wecode's own
   *  config directory. */
  readonly dirty: readonly string[];
  /** True when a merge is half-finished — `.git/MERGE_HEAD` exists. A tree can be mid-merge
   *  and report nothing dirty, so status alone does not see this. */
  readonly merging: boolean;
}

/** Why the base may not be merged onto, or null when it may.
 *
 *  A landing merge commits whatever is in the index, so a dirty base does not stay a dirty
 *  base: the operator's unrelated edits ship inside the landing commit under the story's
 *  name. Refusing is cheap and the mixed commit is not, so land refuses. */
export function refuseDirtyBase(state: BaseState): string | null {
  const { here, base, dirty, merging } = state;
  if (merging) {
    return (
      `land refused in ${here}: a merge is already in progress on ${base}, so landing now ` +
      `would commit somebody else's half-finished merge.\n` +
      `  finish it with git merge --continue, or undo it with git merge --abort, then land again.`
    );
  }
  if (dirty.length === 0) return null;
  return (
    `land refused in ${here}: ${base} has uncommitted changes, and the landing merge would ` +
    `commit them as part of the story.\n${indent(dirty)}\n  commit or stash them first.`
  );
}

/** What to tell the operator after an aborted merge. `git merge --abort` is best effort, and
 *  when it does not restore the tree the old sentence — "your tree is as you left it" — was a
 *  lie that ends with conflict markers committed onto the base. So the state is read again
 *  after the abort, and a base that did not come back clean is said out loud. */
export function reportAbort(state: BaseState, branch: string): string {
  const chore =
    `  the story needs a merge chore: rebase or merge your branch into ${branch}, ` +
    `redeliver, then land again.`;
  const left = reportLeftover(state);
  if (left === null) {
    return `  the merge was aborted, so your tree is as you left it and the story has not landed.\n${chore}`;
  }
  return `  the merge was NOT undone.\n${left}\n${chore}`;
}

/** The staged half of `git status --porcelain`: the lines whose index column is neither a
 *  space nor `?`. Exported because staged-or-not is the whole difference between a leftover
 *  somebody will notice and one that disappears into the next commit. */
export function stagedLeftover(dirty: readonly string[]): readonly string[] {
  return dirty.filter((l) => l.length > 0 && l[0] !== " " && l[0] !== "?");
}

/** What the base was left holding that it did not start with, or null when it is clean.
 *
 *  Said after the merge as well as after an abort: land promises the base it touched is a
 *  base somebody else can land on next, and the only way to keep that promise is to look.
 *
 *  A staged leftover is called by that name. An unstaged edit sits in the tree where the
 *  next `git status` shows it and the next commit leaves it alone; a staged one is already
 *  in the index, so the next commit made in that tree — by the operator, by an agent, by a
 *  hook — carries it under somebody else's message. Same three lines of output, but the
 *  remedy is `git restore --staged`, not `git merge --abort`, and an operator told the
 *  wrong one of those twice is an operator who stops reading. */
export function reportLeftover(state: BaseState): string | null {
  const { here, base, dirty, merging } = state;
  if (!merging && dirty.length === 0) return null;
  const staged = merging ? [] : stagedLeftover(dirty);
  const what = merging
    ? `${base} in ${here} is still mid-merge`
    : staged.length > 0
      ? `${base} in ${here} was left with a staged diff, already in the index`
      : `${base} in ${here} was left with uncommitted changes`;
  const it = staged.length === 1 ? "it" : "them";
  const how =
    staged.length > 0
      ? `  the next commit made in that tree carries ${it}, whoever makes it.\n` +
        `  run git restore --staged . in that tree to unstage ${it}, then git status.`
      : `  run git merge --abort in that tree, or git status to see what is left.`;
  return (
    `  ${what} — do not commit there until it is clean:\n` +
    `${dirty.length === 0 ? "  (no tracked file differs)" : indent(dirty)}\n${how}`
  );
}

/** The two path sets a landing merge has to be judged on, as git answers them.
 *
 *  Both are relative to the merge base, because that is what decides a merge: a path the
 *  base deleted *after* the fork point is deleted by the merge too and needs no rule, while
 *  a path the base deleted *before* it is absent from the merge base, so a branch that has
 *  the path is a branch that added it. */
export interface LandingDiff {
  readonly branch: string;
  readonly base: string;
  /** Paths the branch adds against the merge base —
   *  `git diff --name-only --diff-filter=A <merge-base> <branch>`. */
  readonly added: readonly string[];
  /** Paths the base's history removed and the base tip does not hold —
   *  `git log --diff-filter=D --name-only <base>` less `git ls-tree -r --name-only <base>`. */
  readonly removedByBase: readonly string[];
}

/** Why this branch may not land, or null when it may.
 *
 *  A removal is a decision, and a merge is the one place it can be undone without anybody
 *  deciding anything: git adds back a path the branch carries and the base's merge base does
 *  not hold, says nothing, and exits 0. That is how a deleted file reached master twice —
 *  an attempt commit re-added it and the landing merge carried it in.
 *
 *  So the path is named. Not "your branch conflicts" and not a count: the operator has to
 *  decide whether the removal or the re-add was the mistake, and they cannot do that without
 *  knowing which file it is about. */
export function refuseResurrection(diff: LandingDiff): string | null {
  const { branch, base, added, removedByBase } = diff;
  const gone = new Set(removedByBase);
  const back = [...new Set(added.filter((p) => gone.has(p)))].sort();
  if (back.length === 0) return null;
  const these = back.length === 1 ? "a path" : `${back.length} paths`;
  return (
    `land ${branch} refused: it would restore ${these} ${base} removed.\n${indent(back)}\n` +
    `  ${base} deleted ${back.length === 1 ? "it" : "them"} on purpose, and the merge would ` +
    `add ${back.length === 1 ? "it" : "them"} back without saying so.\n` +
    `  drop the commit on ${branch} that re-adds ${back.length === 1 ? "it" : "them"} — or ` +
    `delete ${back.length === 1 ? "it" : "them"} on ${branch} — then redeliver and land again.`
  );
}

/** What the primary checkout looks like once the base ref has been moved by a merge made
 *  somewhere else. */
export interface PrimaryDrift {
  /** The repository root of the primary checkout — the folder a person works in. */
  readonly path: string;
  /** The branch the story landed on. */
  readonly base: string;
  /** True when the primary checkout has `base` checked out. When it does not, its files
   *  were never showing the base and nothing is owed. */
  readonly onBase: boolean;
  /** True when its index and working tree already hold the landing commit — the operator
   *  landed it themselves, or a previous tick brought the tree forward. */
  readonly alreadyCurrent: boolean;
  /** True when its index and working tree still hold exactly the commit the base pointed
   *  at before the landing — nothing of the operator's is in there to lose. */
  readonly wasTheOldTip: boolean;
  /** Anything of the operator's the update would write over: tracked edits, or untracked
   *  files sitting on a path the landing changed. Empty when there is none. */
  readonly ownWork: readonly string[];
}

/** Either the primary checkout is already showing the landing, or it is clean at the old
 *  tip and wecode brings it forward itself, or it holds something of the operator's and
 *  they are told the command. Never a stale tree left without either. */
export type PrimaryUpdate =
  | { readonly kind: "current" }
  | { readonly kind: "forward" }
  | { readonly kind: "tell"; readonly instruction: string };

/** docs/design/14. A landing merge made in a tree of wecode's own moves `refs/heads/<base>`
 *  and writes nobody's checkout. That is the rule that keeps an operator's folder safe, and
 *  it is also how a landed story went invisible: the board said delivered, `git log` showed
 *  the merge, and the folder on disk still held the pre-land files — at worst with the
 *  landed paths reading as staged deletions, because HEAD moved under an index that never
 *  saw them. It reads exactly like lost work.
 *
 *  So the ref moving is never the end of it — but what is owed depends on what is there.
 *  A checkout clean at the old tip holds nothing of anybody's: its index and working files
 *  are the pre-land tree exactly, so bringing it to the new tip loses nothing and stages
 *  nothing, and there is no instruction worth writing about a folder wecode can simply make
 *  correct. Leaving it stale instead is the expensive half: the operator is handed a staged
 *  diff they did not make, a command to run before they may commit, and the shape lost work
 *  has — over a tree git itself says is untouched.
 *
 *  Everything else is words. The moment the checkout differs from the old tip at all —
 *  tracked edits, staged ones, an untracked file on a path the landing wrote — it is theirs
 *  and wecode writes none of it: it is told what moved, what of theirs is in the way, and
 *  the command in full with the path to run it in.
 *
 *  What those words have to carry is the index. A behind checkout is not merely showing old
 *  files: its index still holds the pre-land tree while HEAD holds the landing, so every
 *  path the story touched reads as staged there — the added ones as staged deletions. That
 *  is the shape lost work has, it is the reason the silence frightened somebody, and an
 *  instruction that says only "still shows the files from before the landing" leaves the
 *  operator looking at a staged diff nobody has accounted for. So it is named, and said to
 *  be the landing's rather than theirs. */
export function updatePrimary(drift: PrimaryDrift): PrimaryUpdate {
  const { path, base, onBase, alreadyCurrent, wasTheOldTip, ownWork } = drift;
  if (!onBase || alreadyCurrent) return { kind: "current" };
  // Clean at the old tip, with nothing of the operator's in the way: the tree is the
  // pre-land tree, so wecode puts it on the new tip itself and leaves no staged diff behind.
  if (wasTheOldTip && ownWork.length === 0) return { kind: "forward" };
  const what =
    ownWork.length > 0
      ? `${path} has work of yours that bringing it forward would write over:\n${indent(ownWork)}`
      : `${path} is not at the commit ${base} was landed from`;
  return {
    kind: "tell",
    instruction:
      `${base} moved: ${path} still shows the files from before the landing.\n` +
      `  ${what}\n` +
      `  ${phantomStage(ownWork.length > 0)}\n` +
      `  in ${path}: git restore --source=HEAD --staged --worktree . ` +
      `(commit or stash your own changes first — this discards them).`,
  };
}

/** The sentence about the index a behind checkout is holding. Two of them, because whether
 *  the staged diff is entirely the landing's decides what the operator may safely do with
 *  it: on an untouched tree `git restore --staged .` alone would be a mistake — it would
 *  stage nothing back and leave the tree behind — while on a tree with the operator's own
 *  work in it, nothing there may be discarded until they have looked. */
function phantomStage(mixed: boolean): string {
  const shape =
    `git status there reads the story's paths as a staged diff — the files it added as ` +
    `staged deletions — because HEAD moved under an index that never saw them`;
  return mixed
    ? `${shape}, so what is staged there is your work and the landing's mixed together: ` +
      `look before you discard any of it.`
    : `${shape}. None of it is yours and none of it is lost; the restore below clears it.`;
}

const indent = (lines: readonly string[]): string => lines.map((l) => `  ${l}`).join("\n");
