/** The painter overlay: pick, annotate, queue, send, end, and the reply strip.
 *
 *  This is the whole review loop as a state machine. A reviewer turns picking on, points
 *  at something, says what is wrong, queues it, repeats, and sends the round; the agent
 *  answers into the strip along the bottom and the loop goes round again until somebody
 *  ends it.
 *
 *  The machine draws nothing. `view()` returns exactly what should be on screen and a
 *  browser adapter renders it — the same split lens draws between a screen and the thing
 *  that puts it in front of a person. That split is what lets the interesting rules here
 *  (a send that fails keeps the reviewer's words; ending is final; picking is refused on
 *  the overlay's own furniture) be tested as rules rather than through a browser.
 *
 *  Ported from Lavish without the whiteboard: no Mermaid, no Excalidraw, no scene files.
 *  A pick is a node or a stretch of prose, and that is all it is. */

import { CLASS } from "./overlay.css.js";
import { isPickable, pickElement, pickMessage, pickText } from "./pick.js";
import type { Pick, PickTarget, TextSelection } from "./pick.js";
import { PromptQueue, pillText } from "./queue.js";
import type { QueuedPrompt } from "./queue.js";

/** Where a round of prompts goes. The adapter posts to the chrome; the machine only cares
 *  whether the round arrived, because that is what decides whether the queue may empty. */
export interface OverlayHost {
  /** Hand a round to the agent. Resolving `false`, or rejecting, means it did not land. */
  deliver(prompts: readonly QueuedPrompt[], end: boolean): boolean | Promise<boolean>;
  /** The session is over and nothing further will be sent. */
  end(): void;
}

/** The card over a picked thing. */
export interface CardView {
  readonly heading: string;
  readonly placeholder: string;
  readonly hint: string;
  /** Where the card points, so the adapter can anchor it and mark the node. */
  readonly selector: string;
  readonly kind: Pick["kind"];
}

/** The strip along the bottom: what came back, and the box for saying more. */
export interface StripView {
  readonly log: readonly string[];
  readonly draft: string;
  /** False while a round is in flight, and once the session has ended. */
  readonly canSend: boolean;
  readonly sending: boolean;
}

/** Everything that should be on screen. */
export interface OverlayView {
  readonly picking: boolean;
  readonly ended: boolean;
  readonly card: CardView | null;
  readonly pills: readonly string[];
  readonly strip: StripView;
  /** The class the adapter marks the picked node with, so it does not name it itself. */
  readonly highlightClass: string;
}

const HINT = "Enter to queue · Ctrl+Enter to send now";

const HEADING: Readonly<Record<Pick["kind"], string>> = {
  element: "Annotate",
  text: "Annotate text",
  message: "Message",
};

const PLACEHOLDER: Readonly<Record<Pick["kind"], string>> = {
  element: "Tell the agent what to change about this element…",
  text: "Tell the agent what to change about this text…",
  message: "Tell the agent anything about this page…",
};

/** What a card says at the top. An element names its tag, because "Annotate <button>"
 *  tells the reviewer what they actually hit when they aimed at the label inside it. */
function headingFor(pick: Pick): string {
  return pick.kind === "element" ? `${HEADING.element} <${pick.tag}>` : HEADING[pick.kind];
}

export class Overlay {
  readonly #host: OverlayHost;
  readonly #queue = new PromptQueue();
  #picking = false;
  #open: Pick | null = null;
  #log: string[] = [];
  #draft = "";
  #sending = false;
  #ended = false;

  constructor(host: OverlayHost) {
    this.#host = host;
  }

  // ---- what is on screen -------------------------------------------------------------

  view(): OverlayView {
    const open = this.#open;
    return {
      picking: this.#picking,
      ended: this.#ended,
      card: open
        ? {
            heading: headingFor(open),
            placeholder: PLACEHOLDER[open.kind],
            hint: HINT,
            selector: open.selector,
            kind: open.kind,
          }
        : null,
      pills: this.#queue.list().map(pillText),
      strip: {
        log: [...this.#log],
        draft: this.#draft,
        canSend: !this.#sending && !this.#ended && !this.#queue.isEmpty,
        sending: this.#sending,
      },
      highlightClass: CLASS.highlight,
    };
  }

  /** The queue itself, for an adapter that persists it across a reload. */
  queued(): readonly QueuedPrompt[] {
    return this.#queue.list();
  }

  // ---- picking -----------------------------------------------------------------------

  /** Turn picking on or off.
   *
   *  Turning it off abandons an open card. That is deliberate: the card belongs to a node
   *  the reviewer can no longer see marked, so leaving it floating would invite them to
   *  write a note against a target they have lost track of. Queued notes are untouched —
   *  those are already said, and leaving picking mode is not retracting them. */
  setPicking(enabled: boolean): void {
    if (this.#ended) return;
    this.#picking = enabled;
    if (!enabled) this.#open = null;
  }

  get picking(): boolean {
    return this.#picking;
  }

  /** Point at a node. Refused unless picking is on and the node is the page's own —
   *  clicking the overlay's card must not open a card about the card. Returns whether a
   *  card opened, which is also the adapter's answer to "should I swallow this click". */
  pick(target: PickTarget | null): boolean {
    if (!this.#picking || this.#ended || !target || !isPickable(target)) return false;
    this.#open = pickElement(target);
    return true;
  }

  /** Point at a stretch of prose. Returns false for what is really a click — a collapsed
   *  or blank selection — so the adapter can fall back to picking the element under it. */
  pickSelection(selection: TextSelection | null): boolean {
    if (!this.#picking || this.#ended) return false;
    const picked = pickText(selection);
    if (!picked) return false;
    this.#open = picked;
    return true;
  }

  /** What the open card points at, if one is open. */
  get open(): Pick | null {
    return this.#open;
  }

  // ---- annotating and queueing -------------------------------------------------------

  /** Queue what was typed into the open card, and close it.
   *
   *  A blank note closes the card without queueing: the reviewer opened it, thought
   *  better of it, and pressing Queue on an empty box means cancel. Returns whether
   *  anything was actually queued. */
  annotate(prompt: string): boolean {
    const open = this.#open;
    if (!open || this.#ended) return false;
    const queued = this.#queue.enqueue(open, prompt);
    this.#open = null;
    return queued;
  }

  /** Close the card, queueing nothing. */
  cancel(): void {
    this.#open = null;
  }

  /** Drop a queued note by the pill the reviewer clicked. */
  unqueue(index: number): void {
    this.#queue.remove(index);
  }

  // ---- the reply strip ---------------------------------------------------------------

  /** What the reviewer is typing into the strip. Kept here so the view is the whole of
   *  what is on screen, rather than half of it living in an input the adapter owns. */
  type(draft: string): void {
    this.#draft = draft;
  }

  /** Queue the strip's text as a note about the page rather than any node, and clear the
   *  box. Blank drafts are ignored, so Enter on an empty strip does nothing. */
  message(): boolean {
    if (this.#ended) return false;
    const queued = this.#queue.enqueue(pickMessage(), this.#draft);
    if (queued) this.#draft = "";
    return queued;
  }

  /** Something the agent said. Shown in the strip even after the session ends, because
   *  the last word is usually the one worth reading. */
  receive(reply: string): void {
    const text = reply.trim();
    if (text) this.#log.push(text);
  }

  // ---- sending and ending ------------------------------------------------------------

  /** Send the round.
   *
   *  A half-typed strip draft goes with it: a reviewer who writes a note and presses
   *  Send means to send that note, and making them press Enter first would silently drop
   *  it. An open card's text is the adapter's until it is queued, so an adapter that
   *  wants the same courtesy there calls `annotate` before `send`.
   *
   *  The queue empties only once the host confirms the round landed. If delivery fails
   *  the words go back, in their original order, ahead of anything queued while the round
   *  was in flight — a failed send must never cost the reviewer what they wrote. */
  async send(end = false): Promise<boolean> {
    if (this.#sending || this.#ended) return false;
    this.#flushDrafts();
    if (this.#queue.isEmpty) return false;
    const round = this.#queue.take();
    this.#sending = true;
    try {
      const landed = await this.#host.deliver(round, end);
      if (!landed) {
        this.#queue.restore(round);
        return false;
      }
    } catch {
      this.#queue.restore(round);
      return false;
    } finally {
      this.#sending = false;
    }
    if (end) this.#finish();
    return true;
  }

  /** Send what is queued and end the session in one act — Lavish's "Send & End". */
  sendAndEnd(): Promise<boolean> {
    return this.send(true);
  }

  /** End without sending. Whatever was queued is abandoned, because the reviewer chose to
   *  leave rather than to send. Ending twice is a no-op: the host is told once. */
  end(): void {
    if (this.#ended) return;
    this.#finish();
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Move an unqueued strip draft into the queue, so Send takes it too. */
  #flushDrafts(): void {
    if (this.#draft.trim()) this.message();
  }

  #finish(): void {
    this.#ended = true;
    this.#picking = false;
    this.#open = null;
    this.#draft = "";
    this.#queue.clear();
    this.#host.end();
  }
}
