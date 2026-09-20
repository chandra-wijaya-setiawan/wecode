/** What the reviewer has said but not yet sent.
 *
 *  The queue is the whole reason the overlay is worth more than a comment box. A reviewer
 *  reads a page and finds six things wrong with it; sending six messages gets six separate
 *  replies and an agent with no idea which of them is the point. Queueing lets them say
 *  all six against the places they belong and hand the agent one coherent round.
 *
 *  So the queue is a first-class thing with its own rules, not an array in the overlay's
 *  state, and it is pure: no storage, no posting, no DOM. Where a queue is *kept* between
 *  reloads is the adapter's business, and `restore` is the door it comes back through. */

import type { Pick } from "./pick.js";

/** One thing said, against one place. */
export interface QueuedPrompt {
  readonly pick: Pick;
  readonly prompt: string;
}

/** What makes two prompts the same prompt.
 *
 *  Annotating a node twice before sending means the reviewer changed their mind, not that
 *  they have two notes about it — the second should replace the first, in place, so the
 *  queue keeps the order they worked in. Keying on the selector is what makes that
 *  judgement, and it deliberately does *not* apply to text picks or freeform messages:
 *  two sentences inside one paragraph are two real notes, and so are two messages. */
export function queueKey(pick: Pick): string {
  return pick.kind === "element" && pick.selector ? `element:${pick.selector}` : "";
}

/** How much of a prompt a pill shows before it is cut. A pill is a reminder of something
 *  the reviewer wrote a moment ago, not the text itself. */
export const PILL_CAP = 48;

/** A prompt as one short line: where it points, and what was said about it. */
export function pillText(item: QueuedPrompt): string {
  const label = item.pick.kind === "message" ? "page" : item.pick.selector || item.pick.tag;
  const said =
    item.prompt.length > PILL_CAP ? `${item.prompt.slice(0, PILL_CAP - 1).trimEnd()}…` : item.prompt;
  return `${label}: ${said}`;
}

/** The queue. Mutable on purpose: it is one reviewer's working set for the length of one
 *  visit, and threading a new array through every keystroke would buy nothing. */
export class PromptQueue {
  #items: QueuedPrompt[] = [];

  /** What is queued, oldest first. A copy, so a caller holding the view cannot edit it. */
  list(): readonly QueuedPrompt[] {
    return [...this.#items];
  }

  get size(): number {
    return this.#items.length;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  /** Add a note, or replace the one already standing against the same place.
   *
   *  A blank prompt is not queued and not an error: it is the reviewer opening a card,
   *  thinking better of it, and pressing Queue anyway. Returns whether anything landed,
   *  so the caller knows whether to close the card on a real note or on nothing. */
  enqueue(pick: Pick, prompt: string): boolean {
    const text = prompt.trim();
    if (!text) return false;
    const item: QueuedPrompt = { pick, prompt: text };
    const key = queueKey(pick);
    const at = key ? this.#items.findIndex((existing) => queueKey(existing.pick) === key) : -1;
    if (at === -1) this.#items.push(item);
    else this.#items[at] = item;
    return true;
  }

  /** Drop one note. Out-of-range is a no-op rather than a throw: the index came from a
   *  pill the reviewer clicked, and a stale pill is a race, not a bug to crash on. */
  remove(index: number): void {
    if (index < 0 || index >= this.#items.length) return;
    this.#items.splice(index, 1);
  }

  /** Hand over everything and empty out, as one step.
   *
   *  One step because the two halves must not come apart. Reading the queue, posting it,
   *  and then clearing it leaves a window in which a note queued mid-flight is thrown
   *  away unsent — the reviewer's words, lost silently, which is the worst thing this
   *  overlay could do. Taking first means anything queued during the post is simply in
   *  the next round. */
  take(): readonly QueuedPrompt[] {
    const taken = this.#items;
    this.#items = [];
    return taken;
  }

  /** Put back a round that never reached the agent, ahead of anything queued since, so
   *  the reviewer's order survives a failed send. */
  restore(prompts: readonly QueuedPrompt[]): void {
    this.#items = [...prompts, ...this.#items];
  }

  clear(): void {
    this.#items = [];
  }
}
