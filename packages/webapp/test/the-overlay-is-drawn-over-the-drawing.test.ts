// @vitest-environment happy-dom
/** The overlay is drawn over the drawing.
 *
 *  The criterion says four things and this file says four things. The overlay is drawn over the
 *  drawing. A click on an element opens a card. A queued note becomes a pill. Sending the round
 *  posts exactly one prompt frame to the dock's route, carrying per note the CSS path, the tag
 *  and the words that were showing — and a send that does not land keeps the reviewer's words.
 *
 *  Every one of them is said against the thing that ships. The machine is the painter's own
 *  `Overlay`, the drawing is a real document, the card is read out of whatever the chrome was
 *  drawn into, the host is this surface's `sending`, and the far end is the dock's own
 *  `shellAt` route reached through `answer` — so "posts exactly one prompt frame to the dock's
 *  route" is counted at that route and nowhere nearer. Two things are stood in for, and they
 *  are the two a statement may not have: a pty, which cannot be spawned per claim, and the
 *  answers only a browser holds — a rectangle and a viewport. The reviewer's acts are the
 *  reviewer's: a click dispatched at a node of the drawing, words typed into the field that
 *  click opened, and a press on the button that says Send.
 *
 *  The drawing half is loaded rather than imported, so that its absence is a statement failing
 *  on a named expectation instead of a suite that could not be collected at all: "could not
 *  start" and "the reviewer cannot review" are different reports. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "@wecode/painter/dist/client/overlay.js";
import { CHROME_ATTRIBUTE, CLASS } from "@wecode/painter/dist/client/overlay.css.js";
import { decode, encode } from "@wecode/painter/dist/client/terminal.js";
import { NOTES_AT, sending, type Posts } from "../src/browser/annotate.js";
import { SHELL_AT, shellAt, type Opens, type Shelled } from "../src/pages/shell.js";
import { answer, type Page, type Routes, type Verb } from "../src/server.js";
import type { Doc } from "../src/browser/overlay-dom.js";

/** The drawing half, reached for when a statement needs it. */
let drawn: typeof import("../src/browser/overlay-dom.js");
const loaded = async (): Promise<void> => {
  drawn ??= await vi.importActual<typeof drawn>("../src/browser/overlay-dom.js");
};

/** A thing the criterion needs on screen that is not there: said, rather than read past. */
const raise = (why: string): never => {
  throw new Error(why);
};

/** What is being reviewed. A selector with nothing to hold it is ambiguous the moment there
 *  are two sketches, so a round says which drawing its paths are inside. */
const ABOUT = "sketch 512";

/** The drawing under review: something with an id to hang a path off, two paragraphs so a
 *  path has same-tag siblings to tell apart, and a live control so a click the machine must
 *  refuse has somewhere to land. */
const DRAWING =
  `<main id="sketch"><h1>the ledger</h1><p>seven tasks</p>` +
  `<p>three blocked</p><button type="button">run it</button></main>`;

/** The two paths the round is expected to carry, and the words showing at each. */
const HEADING_AT = "main#sketch > h1";
const SECOND_AT = "main#sketch > p:nth-of-type(2)";

/** How much room there is, and the rectangle every node of the drawing is measured at.
 *  Measuring is a browser's act, so both are handed in and the adapter takes what it is told. */
const VIEWPORT = { width: 1000, height: 800 };
const RECT = { top: 120, left: 40, width: 240, height: 28 };

// ─── the far end, which is the dock's own ───────────────────────────────────────────

/** A shell that hears what is typed at it and that can be told to leave — which is how a send
 *  that does not land is arranged, without asking any code here to invent a refusal. The
 *  painter's `Session` is one of these. Keys and prompts are kept apart because they are
 *  different acts, and a round arriving as keys would sit half-typed in the agent's composer
 *  looking sent. */
class Pretend implements Shelled {
  output = "";
  running = true;
  exit: number | null = null;
  readonly typed: string[] = [];
  readonly prompts: string[] = [];
  keys(input: string): void { this.typed.push(input); }
  prompt(text: string): void { this.prompts.push(text); }
  close(): Promise<number> { this.running = false; return Promise.resolve(0); }
  leaves(code: number): void { this.running = false; this.exit = code; }
}

/** The dock's route over a stand-in shell, with a tally of every frame that reached it. The
 *  tally is at the route rather than at the caller: "posts exactly one prompt frame to the
 *  dock's route" is a claim about what arrived there. */
function farEnd() {
  const shells: Pretend[] = [];
  const opens = ((): Shelled => shells[shells.push(new Pretend()) - 1] as Pretend) as Opens;
  const { route, close } = shellAt(() => "/a/workspace", opens);
  const served = route as { get: Page; post: Verb };
  const frames: string[] = [];
  const routes: Routes = {
    [NOTES_AT]: { get: served.get, post: (url, body) => (frames.push(body), served.post(url, body)) },
  };
  return {
    frames,
    close,
    /** The shell the route holds now: the newest, since a restart puts one in place of one
     *  that left. */
    shell: (): Pretend => shells.at(-1) ?? raise("no shell has been opened"),
    /** What the dock does on opening: the poll that opens the shell behind the route. */
    attach: (): void => void answer(routes, "GET", `${NOTES_AT}?from=0`),
    /** A shell in place of one that left, by the route's own door rather than by reaching
     *  past it — which is how a round refused once can be offered again. */
    restart: (): void => void answer(routes, "POST", NOTES_AT, encode({ kind: "restart" })),
    post: (async (frame) => answer(routes, "POST", NOTES_AT, frame)) as Posts,
  };
}

// ─── a drawing, with the overlay drawn over it ──────────────────────────────────────

const opened: Array<() => void> = [];
afterEach(() => {
  for (const shut of opened.splice(0)) shut();
});

/** The whole of the criterion, wired as it ships: the drawing on the page, the machine over
 *  it, the adapter drawing what the machine says, and the dock's far end at the other end. */
async function open() {
  await loaded();
  document.head.innerHTML = "";
  document.body.innerHTML = DRAWING;
  const end = farEnd();
  end.attach();
  let left = 0;
  const overlay = new Overlay(sending(end.post, ABOUT, () => void (left += 1)));
  const chrome = drawn.mount(overlay, document as unknown as Doc, {
    // A path the drawing still matches is measured; one it does not is a node that has gone.
    boxOf: (selector) => (selector !== "" && document.querySelector(selector) ? RECT : null),
    viewport: () => VIEWPORT,
    selection: () => null,
  });
  opened.push(() => (chrome.release(), end.close()));
  return { overlay, chrome, end, ended: (): number => left };
}

type Open = Awaited<ReturnType<typeof open>>;

// ─── reading what is on screen, and acting on it ────────────────────────────────────

/** Where the chrome was drawn. Through the host's shadow root when there is one, because
 *  whether the overlay hides inside one is its own decision and not this criterion's. */
const chromeOf = (held: Open): Element => held.chrome.host as unknown as Element;
const look = (held: Open): ParentNode => chromeOf(held).shadowRoot ?? chromeOf(held);
const one = (held: Open, selector: string): Element | null => look(held).querySelector(selector);
const all = (held: Open, selector: string): Element[] => [...look(held).querySelectorAll(selector)];

const control = (held: Open, label: string): HTMLButtonElement =>
  (all(held, "button").find((button) => button.textContent === label) ??
    raise(`the overlay draws no ${label}`)) as HTMLButtonElement;
const press = (held: Open, label: string): void => control(held, label).click();

const card = (held: Open): Element | null => one(held, `.${CLASS.card}`);
const field = (held: Open): HTMLTextAreaElement =>
  (one(held, `.${CLASS.field}`) ?? raise("the open card has no field to write in")) as
    HTMLTextAreaElement;
const pills = (held: Open): string[] =>
  all(held, `.${CLASS.pillText}`).map((pill) => pill.textContent ?? "");

const node = (selector: string, nth = 0): Element =>
  [...document.querySelectorAll(selector)][nth] ?? raise(`the drawing has no ${selector}[${nth}]`);

/** A click as a browser makes one, handed back so a statement can ask whether the overlay
 *  took it or left it to the drawing. */
const clickOn = (on: Element): MouseEvent => {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  return on.dispatchEvent(event), event;
};

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** Point at something in the drawing the way a reviewer does: while reviewing, by clicking it. */
const pointAt = (held: Open, selector: string, nth = 0): MouseEvent =>
  (held.overlay.setPicking(true), clickOn(node(selector, nth)));

/** Say something about it and queue it, by the button that says so. */
const note = (held: Open, selector: string, said: string, nth = 0): void => {
  pointAt(held, selector, nth);
  field(held).value = said;
  press(held, drawn.LABEL.queue);
};

/** The two notes every sentence about a round is said against. */
const twoNotes = (held: Open): void => {
  note(held, "h1", "the heading is too quiet");
  note(held, "p", "say which three", 1);
};

// ─── the overlay is drawn over the drawing ──────────────────────────────────────────

describe("the overlay is drawn over the drawing", () => {
  it("is on the drawing's own page, over it rather than in it", async () => {
    const held = await open();
    expect(document.body.contains(chromeOf(held))).toBe(true);
    // Over it: the chrome is not a node of the drawing, and the drawing is what it was
    // served as. An overlay that rewrote the page would be reviewing something else.
    expect(node("main#sketch").contains(chromeOf(held))).toBe(false);
    expect(document.body.innerHTML).toContain(DRAWING);
    expect(node("main#sketch").innerHTML).toBe(
      `<h1>the ledger</h1><p>seven tasks</p><p>three blocked</p>` +
        `<button type="button">run it</button>`,
    );
  });

  it("is the strip and nothing else until the reviewer says something", async () => {
    const held = await open();
    expect(one(held, `.${CLASS.strip}`)).not.toBeNull();
    expect(card(held)).toBeNull();
    expect(pills(held)).toEqual([]);
  });

  it("is marked as its own, so the reviewer can never annotate the overlay", async () => {
    const held = await open();
    expect(chromeOf(held).getAttribute(CHROME_ATTRIBUTE)).not.toBeNull();
    held.overlay.setPicking(true);
    expect(clickOn(chromeOf(held)).defaultPrevented).toBe(false);
    expect(held.overlay.open).toBeNull();
    expect(card(held)).toBeNull();
  });
});

// ─── a click on an element opens a card ─────────────────────────────────────────────

describe("a click on an element", () => {
  it("opens a card about the node clicked, and marks that node", async () => {
    const held = await open();
    pointAt(held, "h1");
    const view = held.overlay.view();
    expect(card(held)).not.toBeNull();
    // The card is about the thing hit: it names the tag the reviewer actually reached, and
    // points at the path the agent will be given.
    expect(view.card?.selector).toBe(HEADING_AT);
    expect(one(held, `.${CLASS.heading}`)?.textContent).toContain("<h1>");
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe(view.card?.heading);
    // And the node is marked, wearing the class the machine publishes rather than one this
    // adapter chose, over the rectangle the browser measured.
    const mark = one(held, `.${view.highlightClass}`)?.getAttribute("style");
    expect(mark).toContain(`top:${RECT.top}px;left:${RECT.left}px`);
  });

  it("opens one card at a time, about whatever was clicked last", async () => {
    const held = await open();
    pointAt(held, "h1");
    pointAt(held, "p", 1);
    expect(all(held, `.${CLASS.card}`)).toHaveLength(1);
    expect(held.overlay.view().card?.selector).toBe(SECOND_AT);
    // The card on screen is about the second node and not still about the first: a card left
    // saying <h1> over a paragraph is a reviewer writing a note against the wrong thing.
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe(held.overlay.view().card?.heading);
  });

  it("is swallowed, so a reviewer aiming at the drawing stays on it", async () => {
    const held = await open();
    const heard: string[] = [];
    node("h1").addEventListener("click", () => heard.push("the drawing"));
    expect(pointAt(held, "h1").defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
  });

  it("is left to the drawing when no card opens", async () => {
    const held = await open();
    const heard: string[] = [];
    for (const at of ["h1", "button"]) node(at).addEventListener("click", () => heard.push(at));
    // Nobody is reviewing, and then a live control: the overlay is not in the way of a page
    // being read, and a reviewer who aimed at a button wanted the button.
    expect(clickOn(node("h1")).defaultPrevented).toBe(false);
    held.overlay.setPicking(true);
    expect(clickOn(node("button")).defaultPrevented).toBe(false);
    expect(card(held)).toBeNull();
    expect(heard).toEqual(["h1", "button"]);
  });
});

// ─── a queued note becomes a pill ───────────────────────────────────────────────────

describe("a queued note", () => {
  it("becomes a pill, one per note, saying where it points and what was said", async () => {
    const held = await open();
    twoNotes(held);
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(2);
    expect(pills(held)[0]).toContain(HEADING_AT);
    expect(pills(held)[0]).toContain("the heading is too quiet");
    expect(pills(held)[1]).toContain(SECOND_AT);
    expect(pills(held)[1]).toContain("say which three");
    // What the machine says is on screen is what is on screen.
    expect(pills(held)).toEqual([...held.overlay.view().pills]);
  });

  it("takes the card with it, so the same thing is not said twice over", async () => {
    const held = await open();
    note(held, "h1", "the heading is too quiet");
    expect(card(held)).toBeNull();
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(["the heading is too quiet"]);
  });

  it("is only a note that was said: an empty card queues nothing and draws no pill", async () => {
    const held = await open();
    pointAt(held, "h1");
    press(held, drawn.LABEL.queue);
    expect(pills(held)).toEqual([]);
    expect(held.overlay.queued()).toHaveLength(0);
  });
});

// ─── sending the round ──────────────────────────────────────────────────────────────

describe("sending the round", () => {
  it("goes to the dock's route and not to a second way into the shell", () => {
    expect(NOTES_AT).toBe(SHELL_AT);
  });

  it("posts exactly one prompt frame, however many notes were queued", async () => {
    const held = await open();
    twoNotes(held);
    press(held, drawn.LABEL.send);
    await settle();
    // One frame for the round, not one per note: two frames are two half-rounds an agent
    // answers separately, having been told neither is the whole of what was said.
    expect(held.end.frames).toHaveLength(1);
    expect(held.end.frames.filter((frame) => decode(frame)?.kind === "prompt")).toHaveLength(1);
    // As a prompt and not as keystrokes, which is what guarantees the submit at the far end.
    expect(held.end.shell().prompts).toHaveLength(1);
    expect(held.end.shell().typed).toEqual([]);
  });

  it("carries, per note, the css path, the tag and the words that were showing", async () => {
    const held = await open();
    twoNotes(held);
    press(held, drawn.LABEL.send);
    await settle();
    const [round] = held.end.shell().prompts;
    // All three parts of every pick travel, because the agent never sees the drawing: the
    // path finds the node in the source, the tag is what it turned out to be, and the words
    // are how a person recognises it there. A note saying only "too quiet" is unactionable.
    expect(round).toContain(HEADING_AT);
    expect(round).toContain("<h1>");
    expect(round).toContain(`showing "the ledger"`);
    expect(round).toContain("the heading is too quiet");
    expect(round).toContain(SECOND_AT);
    expect(round).toContain("<p>");
    expect(round).toContain(`showing "three blocked"`);
    expect(round).toContain("say which three");
    // In the order the reviewer worked in, so an agent answering the second can say so.
    expect(round?.indexOf("too quiet")).toBeLessThan(round?.indexOf("say which three") ?? -1);
  });

  it("empties the queue it landed, so the round is not offered a second time", async () => {
    const held = await open();
    twoNotes(held);
    press(held, drawn.LABEL.send);
    await settle();
    expect(pills(held)).toEqual([]);
    expect(held.overlay.queued()).toHaveLength(0);
    expect(control(held, drawn.LABEL.send).disabled).toBe(true);
  });
});

// ─── a send that does not land ──────────────────────────────────────────────────────

describe("a send that does not land", () => {
  it("keeps the reviewer's words on screen and offers the round again", async () => {
    const held = await open();
    twoNotes(held);
    // The shell has left. The route answers 409 of its own accord and the host reads that
    // as a round that did not land.
    held.end.shell().leaves(1);
    press(held, drawn.LABEL.send);
    await settle();
    expect(held.end.frames).toHaveLength(1);
    expect(held.end.shell().prompts).toEqual([]);
    // Both notes are still on screen, still readable as what the reviewer actually wrote,
    // still in the order they wrote them, and the send is offered again.
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(2);
    expect(pills(held)[0]).toContain("the heading is too quiet");
    expect(pills(held)[1]).toContain("say which three");
    const said = ["the heading is too quiet", "say which three"];
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(said);
    expect(held.overlay.ended).toBe(false);
    expect(held.ended()).toBe(0);
    expect(control(held, drawn.LABEL.send).disabled).toBe(false);
  });

  it("costs the reviewer nothing: the same round goes once there is a shell again", async () => {
    const held = await open();
    twoNotes(held);
    held.end.shell().leaves(1);
    press(held, drawn.LABEL.send);
    await settle();
    held.end.restart();
    press(held, drawn.LABEL.send);
    await settle();
    // Whole, on the second try, with nothing of the first left out.
    const [round] = held.end.shell().prompts;
    expect(held.end.shell().prompts).toHaveLength(1);
    expect(round).toContain(HEADING_AT);
    expect(round).toContain("the heading is too quiet");
    expect(round).toContain(SECOND_AT);
    expect(round).toContain("say which three");
    expect(pills(held)).toEqual([]);
  });
});
