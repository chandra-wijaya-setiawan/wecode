// @vitest-environment happy-dom
/** The overlay is drawn over the drawing, and a round of notes reaches the shell the dock
 *  is already holding.
 *
 *  The criterion, end to end, with nothing stood in for between its two ends: the machine is
 *  the painter's own `Overlay`, the drawing is a real document the browser adapter mounts
 *  itself into, the host is this package's `sending`, and the far end is the dock's own
 *  `shellAt` route reached through the surface's `answer`. Two things are stood in for, and
 *  they are the two a statement may not have — a pty, which cannot be spawned per claim, and
 *  the answers only a browser has: a rectangle, a viewport and a drag.
 *
 *  Four sentences, in the criterion's own order. A click on an element opens a card. A queued
 *  note becomes a pill. Sending the round posts exactly one prompt frame to the dock's route,
 *  carrying per note the CSS path, the tag and the words that were showing. And a send that
 *  does not land keeps the reviewer's words.
 *
 *  Wherever the machine has an opinion the adapter is read through `view()` — the heading
 *  against `view().card.heading`, the mark by `view().highlightClass`, the pills against
 *  `view().pills` — because a statement that writes those strings out for itself goes on
 *  passing while the two halves quietly disagree about what is on screen. */
import { afterEach, describe, expect, it } from "vitest";
import { Overlay } from "@wecode/painter/dist/client/overlay.js";
import { CLASS } from "@wecode/painter/dist/client/overlay.css.js";
import { decode } from "@wecode/painter/dist/client/terminal.js";
import type { TextSelection } from "@wecode/painter/dist/client/pick.js";
import { LANDED, NOTES_AT, noteOf, sending } from "../src/browser/annotate.js";
import { SHELL_AT, shellAt, type Opens, type Shelled } from "../src/pages/shell.js";
import { answer, type Routes } from "../src/server.js";
import { LABEL, mount, targetOf } from "../src/browser/overlay-dom.js";
import type { Chrome, Doc, El } from "../src/browser/overlay-dom.js";

/** What is being reviewed. A selector with nothing to hold it is ambiguous across two
 *  sketches, so a round says which drawing its selectors are inside. */
const ABOUT = "sketch 491";

/** How much room there is, and the rectangle every measured node is given. Measuring is the
 *  browser's act, so both are this file's to choose and the adapter takes what it is told. */
const VIEWPORT = { width: 1000, height: 800 };
const RECT = { top: 100, left: 40, width: 220, height: 24 };

/** The drawing under review: two paragraphs, so a selector has siblings to count, and a live
 *  control, so a click the machine must refuse has somewhere to land. */
const DRAWING =
  `<main id="sketch"><h1>the board</h1><p>eight tasks</p>` +
  `<p>two blocked</p><button type="button">run</button></main>`;

// ─── the far end, which is the dock's ───────────────────────────────────────────────

/** A shell that hears what is typed at it and that can be told to leave — which is how a
 *  send that does not land is arranged. The painter's `Session` is one of these. */
class Pretend implements Shelled {
  output = "";
  running = true;
  exit: number | null = null;
  /** Kept apart, because the two doors are different sentences: keys are bytes the far end
   *  reads itself, a prompt is a whole thing a person finished writing and the session
   *  guarantees the submit for — a round sent as keys would look sent and not be. */
  readonly heard: string[] = [];
  readonly prompted: string[] = [];
  keys(input: string): void { this.heard.push(input); }
  prompt(text: string): void { this.prompted.push(text); }
  close(): Promise<number> { this.running = false; return Promise.resolve(0); }
  leaves(code: number): void { this.running = false; this.exit = code; }
}

/** The dock's own route over a stand-in shell: a poll, which is what opens it, and a post,
 *  which is the one way in. Every frame below goes through `answer` and the route's own
 *  decisions — a round refused by a shell that has left is refused by that code and not by
 *  this file agreeing to say 409. */
function farEnd() {
  const shells: Pretend[] = [];
  const { route, close } = shellAt(() => "/a/workspace", (() => {
    const shell = new Pretend();
    shells.push(shell);
    return shell;
  }) as Opens);
  const routes: Routes = { [NOTES_AT]: route };
  const posted: string[] = [];
  return {
    posted,
    held: (): Pretend => {
      const last = shells.at(-1);
      if (last === undefined) throw new Error("no shell has been opened");
      return last;
    },
    open: (): void => void answer(routes, "GET", `${NOTES_AT}?from=0`),
    post: async (frame: string): Promise<{ status: number }> =>
      (posted.push(frame), answer(routes, "POST", NOTES_AT, frame)),
    close,
  };
}

// ─── a drawing with the overlay drawn over it ───────────────────────────────────────

const opened: Array<() => void> = [];
afterEach(() => {
  for (const shut of opened.splice(0)) shut();
});

/** A page holding the drawing, the machine, the adapter and the far end — the whole of the
 *  criterion, wired the way it ships. `drag` is the reviewer's selection, which only a
 *  browser has; `left` counts the machine telling the surface the reviewer has gone; `slow`
 *  holds a round in flight, which is the one state a round has that nothing else can reach. */
function open() {
  document.head.innerHTML = "";
  document.body.innerHTML = DRAWING;
  const end = farEnd();
  end.open();
  const state = { drag: null as TextSelection | null, left: 0, slow: false };
  let hold: ((reply: { readonly status: number }) => void) | null = null;
  const post = async (frame: string): Promise<{ readonly status: number }> => {
    if (!state.slow) return end.post(frame);
    end.posted.push(frame);
    return new Promise<{ readonly status: number }>((done) => (hold = done));
  };
  const overlay = new Overlay(sending(post, ABOUT, () => void (state.left += 1)));
  const chrome: Chrome = mount(overlay, document as unknown as Doc, {
    // A selector the page still matches is measured; one it does not is a node that has gone.
    boxOf: (selector) => (selector !== "" && document.querySelector(selector) ? RECT : null),
    viewport: () => VIEWPORT,
    selection: () => state.drag,
  });
  opened.push(() => (chrome.release(), end.close()));
  return { overlay, chrome, end, state, answered: (status: number) => hold?.({ status }) };
}

type Open = ReturnType<typeof open>;

// ─── reading the chrome, and acting on it ───────────────────────────────────────────

const look = (held: Open) => (held.chrome.host as unknown as Element).shadowRoot as ShadowRoot;
const one = (held: Open, selector: string): Element | null => look(held).querySelector(selector);
const all = (held: Open, selector: string): Element[] => [...look(held).querySelectorAll(selector)];

const control = (held: Open, label: string): HTMLButtonElement => {
  const found = all(held, "button").find((button) => button.textContent === label);
  if (!found) throw new Error(`the overlay draws no ${label}`);
  return found as HTMLButtonElement;
};
const press = (held: Open, label: string): void => control(held, label).click();

const field = (held: Open) => one(held, `.${CLASS.field}`) as HTMLTextAreaElement;
const reply = (held: Open): HTMLInputElement => one(held, `.${CLASS.reply}`) as HTMLInputElement;

const pills = (held: Open): (string | null)[] =>
  all(held, `.${CLASS.pillText}`).map((pill) => pill.textContent);

const node = (selector: string, nth = 0): Element => {
  const found = [...document.querySelectorAll(selector)][nth];
  if (!found) throw new Error(`the drawing has no ${selector}[${nth}]`);
  return found;
};

/** A click as a browser makes one, handed back so a statement can ask whether it was taken. */
const clickOn = (on: Element): MouseEvent => {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  return on.dispatchEvent(event), event;
};

const key = (on: Element, name: string, hold: { ctrl?: boolean; shift?: boolean } = {}): void => {
  const how = { bubbles: true, cancelable: true, ctrlKey: !!hold.ctrl, shiftKey: !!hold.shift };
  on.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, ...how }));
};

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** Point at a node of the drawing the way a reviewer does: by clicking it, while picking. */
const clickPick = (held: Open, selector: string, nth = 0): void =>
  void (held.overlay.setPicking(true), clickOn(node(selector, nth)));

const note = (held: Open, selector: string, said: string, nth = 0): void => {
  clickPick(held, selector, nth);
  field(held).value = said;
  press(held, LABEL.queue);
};

// ─── the overlay is drawn over the drawing ──────────────────────────────────────────

describe("the overlay is drawn over the drawing", () => {
  it("is on the page the drawing is on, and is the strip until the reviewer points", () => {
    const held = open();
    expect(document.body.contains(held.chrome.host as unknown as Element)).toBe(true);
    // The drawing itself is untouched: an overlay that rewrote the page would be reviewing
    // something other than what the reviewer was shown.
    expect(document.querySelector("main#sketch")?.innerHTML).toBe(
      new DOMParser().parseFromString(DRAWING, "text/html").querySelector("main")?.innerHTML,
    );
    expect(one(held, `.${CLASS.strip}`)).not.toBeNull();
    expect(one(held, `.${CLASS.card}`)).toBeNull();
    expect(pills(held)).toEqual([]);
  });
});

describe("a click on an element", () => {
  it("opens a card saying what the view says, marked over the node it points at", () => {
    const held = open();
    clickPick(held, "h1");
    const view = held.overlay.view();
    expect(view.card?.selector).toBe("main#sketch > h1");
    expect(one(held, `.${CLASS.card}`)).not.toBeNull();
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe(view.card?.heading);
    expect(field(held).getAttribute("placeholder")).toBe(view.card?.placeholder);
    // The mark wears the class the machine publishes, over the rectangle the browser gave.
    expect(one(held, `.${view.highlightClass}`)?.getAttribute("style")).toBe(
      `top:${RECT.top}px;left:${RECT.left}px;width:${RECT.width}px;height:${RECT.height}px`,
    );
  });

  it("is swallowed, so a reviewer aiming at a link does not navigate away from the drawing", () => {
    const held = open();
    const heard: string[] = [];
    node("h1").addEventListener("click", () => heard.push("the drawing"));
    held.overlay.setPicking(true);
    expect(clickOn(node("h1")).defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
  });

  it("is left to the drawing by everything the machine refuses", () => {
    const held = open();
    const heard: string[] = [];
    for (const at of ["h1", "button"]) node(at).addEventListener("click", () => heard.push(at));
    // Picking is off: the overlay is not in the way of a page nobody is reviewing.
    expect(clickOn(node("h1")).defaultPrevented).toBe(false);
    held.overlay.setPicking(true);
    // A live control — a reviewer aiming at a button wanted the button.
    expect(clickOn(node("button")).defaultPrevented).toBe(false);
    // And no card is ever opened about a card.
    expect(clickOn(held.chrome.host as unknown as Element).defaultPrevented).toBe(false);
    expect(held.overlay.open).toBeNull();
    expect(one(held, `.${CLASS.card}`)).toBeNull();
    expect(heard).toEqual(["h1", "button"]);
  });

  it("is offered as the words dragged over before the node under them", () => {
    const held = open();
    held.overlay.setPicking(true);
    const ancestor = targetOf(node("p") as unknown as El);
    held.state.drag = { ancestor, text: "eight tasks", collapsed: false };
    clickOn(node("p"));
    expect(held.overlay.open?.kind).toBe("text");
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe(held.overlay.view().card?.heading);
  });
});

// ─── a queued note becomes a pill ───────────────────────────────────────────────────

describe("a queued note", () => {
  it("becomes a pill, one per note, saying what the view says it says", () => {
    const held = open();
    note(held, "p", "too quiet", 0);
    note(held, "p", "say how many", 1);
    expect(pills(held)).toEqual(held.overlay.view().pills);
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(2);
    // And the card is gone: the note has been said, and a card left open over it would
    // invite the reviewer to say it a second time.
    expect(one(held, `.${CLASS.card}`)).toBeNull();
  });

  it("is queued by the Queue button and by Enter, and abandoned by Escape", () => {
    const held = open();
    clickPick(held, "h1");
    field(held).value = "too quiet";
    key(field(held), "Enter", { shift: true });
    expect(held.overlay.queued()).toHaveLength(0);
    key(field(held), "Enter");
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(["too quiet"]);
    clickPick(held, "p");
    field(held).value = "never mind";
    key(field(held), "Escape");
    expect(held.overlay.queued()).toHaveLength(1);
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(1);
  });

  it("is taken back by its own ×, which is the only way a queue shrinks", () => {
    const held = open();
    note(held, "p", "too quiet", 0);
    note(held, "p", "say how many", 1);
    (all(held, `.${CLASS.pillClose}`)[0] as HTMLElement).click();
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(["say how many"]);
    expect(pills(held)).toEqual(held.overlay.view().pills);
  });
});

// ─── sending the round ──────────────────────────────────────────────────────────────

describe("sending the round", () => {
  it("goes to the dock's own far end and not to a route of its own", () => {
    expect(NOTES_AT).toBe(SHELL_AT);
  });

  it("posts exactly one prompt frame, however many notes the reviewer queued", async () => {
    const held = open();
    note(held, "h1", "the heading is too quiet");
    note(held, "p", "say how many", 1);
    press(held, LABEL.send);
    await settle();
    // One frame for the round, not one per note: a round is a whole thing a person
    // finished writing, and six frames are six half-rounds the agent answers separately.
    expect(held.end.posted).toHaveLength(1);
    const frame = decode(held.end.posted[0] as string);
    expect(frame?.kind).toBe("prompt");
    // A prompt and not keys, which is what guarantees the submit at the far end.
    expect(held.end.held().heard).toEqual([]);
    expect(held.end.held().prompted).toHaveLength(1);
  });

  it("carries, per note, the css path, the tag and the words that were showing", async () => {
    const held = open();
    note(held, "h1", "the heading is too quiet");
    note(held, "p", "say how many", 1);
    const round = held.overlay.queued();
    press(held, LABEL.send);
    await settle();
    const [line] = held.end.held().prompted;
    // All three parts of each pick travel, because the agent never sees the drawing: the
    // path finds the node in the source, the tag is what it turned out to be, and the words
    // are how a person recognises it. A note saying only "too quiet" is unactionable.
    expect(line).toContain("main#sketch > h1");
    expect(line).toContain("<h1>");
    expect(line).toContain(`showing "the board"`);
    expect(line).toContain("the heading is too quiet");
    expect(line).toContain("main#sketch > p:nth-of-type(2)");
    expect(line).toContain("<p>");
    expect(line).toContain(`showing "two blocked"`);
    expect(line).toContain("say how many");
    // In the order the reviewer worked in, and as the one line this surface already makes.
    expect(line?.indexOf("too quiet")).toBeLessThan(line?.indexOf("say how many") ?? -1);
    expect(line).toBe(noteOf(round, ABOUT));
  });

  it("clears the queue it landed, and says so on the strip", async () => {
    const held = open();
    note(held, "h1", "too quiet");
    press(held, LABEL.send);
    await settle();
    expect(held.end.held().prompted).toHaveLength(1);
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(0);
    expect(control(held, LABEL.send).disabled).toBe(true);
  });

  it("is sent and ended in one act, and takes an unqueued draft with it", async () => {
    const held = open();
    note(held, "h1", "too quiet");
    reply(held).value = "and that will do";
    reply(held).dispatchEvent(new window.Event("input"));
    press(held, LABEL.sendAndEnd);
    await settle();
    const [line] = held.end.held().prompted;
    expect(line).toContain("2 notes, and the last");
    expect(line).toContain("and that will do");
    expect(held.overlay.ended).toBe(true);
    expect(held.state.left).toBe(1);
    expect(reply(held).disabled).toBe(true);
  });
});

// ─── a send that does not land ──────────────────────────────────────────────────────

describe("a send that does not land", () => {
  it("keeps the reviewer's words on screen, and offers the round again", async () => {
    const held = open();
    note(held, "h1", "the heading is too quiet");
    note(held, "p", "say how many", 1);
    // The shell has left. The route answers 409 and `sending` reads that as "did not land".
    held.end.held().leaves(1);
    press(held, LABEL.send);
    await settle();
    expect(held.end.posted).toHaveLength(1);
    expect((await held.end.post(held.end.posted[0] as string)).status).not.toBe(LANDED);
    // Both notes are back on screen, said in the machine's own words rather than in a second
    // set this file made up, and still readable as what the reviewer actually wrote.
    expect(pills(held)).toEqual(held.overlay.view().pills);
    expect(pills(held).join(" ")).toContain("the heading is too quiet");
    expect(pills(held).join(" ")).toContain("say how many");
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual([
      "the heading is too quiet",
      "say how many",
    ]);
    expect(control(held, LABEL.send).disabled).toBe(false);
    expect(held.overlay.ended).toBe(false);
  });

  it("has nothing further to send while the round is still in flight", async () => {
    const held = open();
    held.state.slow = true;
    note(held, "h1", "too quiet");
    press(held, LABEL.send);
    // Gone up and not yet answered: the queue is the far end's for now, and a second Send
    // would be the same notes twice.
    expect(held.end.posted).toHaveLength(1);
    expect(control(held, LABEL.send).disabled).toBe(true);
    // 400 for a frame the far end could not read: another way not to land, and the words
    // come back the same way.
    held.answered(400);
    await settle();
    expect(pills(held)).toEqual(held.overlay.view().pills);
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(["too quiet"]);
    expect(control(held, LABEL.send).disabled).toBe(false);
  });
});
