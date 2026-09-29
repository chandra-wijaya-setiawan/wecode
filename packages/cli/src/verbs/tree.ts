/** Creating the five rungs of the tree: workspace, project, release, epic, story.
 *
 *  These are the entities that exist to hold other entities. Nothing about them is about a
 *  test, an artefact or a worker, so they are the part of `create` that can be read without
 *  reading the rest of it — one exported function per rung, each the whole of what that
 *  word means, called from run.ts's dispatch on the entity name.
 *
 *  Each takes the same argument because argv gives them the same argument: the maker, the
 *  text the positionals spelled, the `--parent` the row hangs off and the `--path` a
 *  workspace or a project points at. `parent` is a thunk rather than a number so the two
 *  rungs that need no parent never ask for one — a workspace has nothing above it, and
 *  demanding `--parent` of it was the older shape of this code. */
import type { Maker } from "@wecode/core";

export interface Rung {
  readonly make: Maker;
  /** What the positionals spelled: the workspace's, project's, release's, epic's or
   *  story's own name. */
  readonly text: string;
  /** The `--parent` id, or a throw naming the flag when argv did not give one. */
  readonly parent: () => number;
  /** Where on disk. Only a workspace and a project have one; the rest ignore it. */
  readonly path: string;
}

export const workspace = (at: Rung): number => at.make.workspace(at.text, at.path);

export const project = (at: Rung): number => at.make.project(at.parent(), at.text, at.path);

export const release = (at: Rung): number => at.make.release(at.parent(), at.text);

export const epic = (at: Rung): number => at.make.epic(at.parent(), at.text);

export const story = (at: Rung): number => at.make.story(at.parent(), at.text);
