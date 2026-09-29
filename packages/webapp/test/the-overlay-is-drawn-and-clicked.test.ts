// @vitest-environment happy-dom
/** The overlay is drawn, and what the reviewer does to it reaches the machine.
 *
 *  `a-note-reaches-the-agent.test.ts` holds where a round of notes goes once it has been
 *  made. This holds the end nobody could see: the card, the pills, the strip and the mark
 *  actually on a page, and a click or a keypress arriving as the call it means.
 *
 *  The machine is not stubbed and not written again — every statement drives the painter's
 *  own `Overlay` and reads the answers off a real DOM. What is proved is the seam: that the
 *  adapter draws what `view()` says and nothing it invented. The heading is compared against
 *  `view().heading` rather than against the words "Annotate <h1>", and the mark is found by
 *  `view().highlightClass` rather than by a class this file names, because a test that writes
 *  those strings out is one that passes while the two halves quietly disagree. What is handed
 *  in is only what a browser alone can answer — a rectangle, a viewport and a drag — which is
 *  why the card's placing can be stated exactly here rather than eyeballed. */
import { afterEach, describe, expect, it } from "vitest";
import { Overlay } from "@wecode/painter/dist/client/overlay.js";
import { CLASS, pickingCss } from "@wecode/painter/dist/client/overlay.css.js";
import { isPickable, pickElement } from "@wecode/painter/dist/client/pick.js";
import type { TextSelection } from "@wecode/painter/dist/client/pick.js";
import type { QueuedPrompt } from "@wecode/painter/dist/client/queue.js";
import { LABEL, anchor, mount, selectionOf, targetOf } from "../src/browser/overlay-dom.js";
import type { Chrome, Doc, El, Selected } from "../src/browser/overlay-dom.js";

/** How much room there is, and the rectangle every measured node is given: measuring is the
 *  browser's act, so both are this file's to choose and the adapter takes what it is told. */
const VIEWPORT = { width: 1000, height: 800 };
const RECT = { top: 100, left: 40, width: 220, height: 24 };

/** A sketch worth annotating: two paragraphs so a selector has siblings to count, and a
 *  control so the page's own behaviour has something to survive by. */
const PAGE =
  `<main id="sketch"><h1>the board</h1><p>eight tasks</p>` +
  `<p>two blocked</p><button type="button">run</button></main>`;

interface Round {
  readonly prompts: readonly QueuedPrompt[];
  readonly end: boolean;
}

const opened: Chrome[] = [];
afterEach(() => {
  for (const chrome of opened.splice(0)) chrome.release();
});

/** A page with the overlay on it, and a hand on everything only a browser answers. `slow`
 *  holds a round in flight so that state can be read, `release` finally answers it, and
 *  `land` is the answer when it is not slow. */
function open() {
  document.head.innerHTML = "";
  document.body.innerHTML = PAGE;
  const rounds: Round[] = [];
  const state = { land: true, slow: false, drag: null as TextSelection | null, left: 0 };
  let hold: ((landed: boolean) => void) | null = null;
  const overlay = new Overlay({
    deliver: (prompts, end) => {
      rounds.push({ prompts, end });
      return state.slow ? new Promise<boolean>((done) => (hold = done)) : state.land;
    },
    end: () => void (state.left += 1),
  });
  const chrome = mount(overlay, document as unknown as Doc, {
    // A selector the page still matches is measured; one it does not is a node that has gone.
    boxOf: (selector) => (selector !== "" && document.querySelector(selector) ? RECT : null),
    viewport: () => VIEWPORT,
    selection: () => state.drag,
  });
  opened.push(chrome);
  return { overlay, chrome, rounds, state, release: (landed: boolean) => hold?.(landed) };
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

const say = (held: Open, words: string): void => {
  reply(held).value = words;
  reply(held).dispatchEvent(new window.Event("input"));
};

const node = (selector: string, nth = 0): Element => {
  const found = [...document.querySelectorAll(selector)][nth];
  if (!found) throw new Error(`the page has no ${selector}[${nth}]`);
  return found;
};

/** A click as a browser makes one, handed back so a statement can ask whether it was taken. */
const clickOn = (on: Element): MouseEvent => {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  return on.dispatchEvent(event), event;
};

const key = (on: Element, name: string, hold: { ctrl?: boolean; shift?: boolean } = {}): void => {
  const how = { key: name, bubbles: true, cancelable: true };
  on.dispatchEvent(
    new window.KeyboardEvent("keydown", { ...how, ctrlKey: !!hold.ctrl, shiftKey: !!hold.shift }),
  );
};

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/** Point the machine at a node of the page, as a click would, and draw. */
const pick = (held: Open, selector: string, nth = 0): void => {
  held.overlay.setPicking(true);
  held.overlay.pick(targetOf(node(selector, nth) as unknown as El));
  held.chrome.draw();
};

const note = (held: Open, selector: string, said: string, nth = 0): void => {
  pick(held, selector, nth);
  field(held).value = said;
  press(held, LABEL.queue);
};

describe("what the machine says is on screen", () => {
  it("is the strip and nothing else, before the reviewer has done anything", () => {
    const held = open();
    expect(one(held, `.${CLASS.strip}`)).not.toBeNull();
    expect(one(held, `.${CLASS.card}`)).toBeNull();
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(0);
    expect(control(held, LABEL.send).disabled).toBe(true);
  });

  it("is the overlay's own furniture, which the machine will not let anyone annotate", () => {
    const held = open();
    expect(isPickable(targetOf(held.chrome.host))).toBe(false);
  });

  it("is a card saying exactly what the view says, over the node it points at", () => {
    const held = open();
    pick(held, "h1");
    const view = held.overlay.view();
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe(view.card?.heading);
    expect(field(held).getAttribute("placeholder")).toBe(view.card?.placeholder);
    expect(one(held, `.${CLASS.hint}`)?.textContent).toBe(view.card?.hint);
    expect(one(held, `.${view.highlightClass}`)?.getAttribute("style")).toBe(
      `top:${RECT.top}px;left:${RECT.left}px;width:${RECT.width}px;height:${RECT.height}px`,
    );
  });

  it("keeps the card but drops the mark when the page no longer holds the node", () => {
    const held = open();
    pick(held, "h1");
    node("h1").remove();
    held.chrome.draw();
    expect(one(held, `.${CLASS.card}`)).not.toBeNull();
    const { highlightClass } = held.overlay.view();
    expect(one(held, `.${highlightClass}`)?.getAttribute("style")).toBe("display:none");
  });

  it("is one pill per queued note, and a pill's × takes that note back", () => {
    const held = open();
    note(held, "p", "too quiet", 0);
    note(held, "p", "say how many", 1);
    expect(all(held, `.${CLASS.pillText}`).map((pill) => pill.textContent)).toEqual(
      held.overlay.view().pills,
    );
    (all(held, `.${CLASS.pillClose}`)[0] as HTMLElement).click();
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(["say how many"]);
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(1);
  });

  it("is what the agent said back, kept after the session has ended", () => {
    const held = open();
    held.overlay.receive("  I moved the heading.  ");
    held.chrome.draw();
    expect(all(held, `.${CLASS.logLine}`).map((line) => line.textContent)).toEqual([
      "I moved the heading.",
    ]);
    press(held, LABEL.end);
    expect(all(held, `.${CLASS.logLine}`)).toHaveLength(1);
    expect(reply(held).disabled).toBe(true);
    expect(control(held, LABEL.send).disabled).toBe(true);
    expect(held.state.left).toBe(1);
  });

  it("is `canSend`, and never this file's opinion of when a round is worth sending", () => {
    const held = open();
    say(held, "the whole page is too dark");
    // The machine takes an unqueued draft with the round, but `canSend` counts the queue, so
    // the button stays off until something is queued and the adapter does not argue.
    expect(held.overlay.view().strip.canSend).toBe(false);
    expect(control(held, LABEL.send).disabled).toBe(true);
    expect(control(held, LABEL.sendAndEnd).disabled).toBe(true);
    key(reply(held), "Enter");
    expect(control(held, LABEL.send).disabled).toBe(false);
  });
});

describe("an open card", () => {
  it("keeps what has been typed until the reviewer queues it, and not one redraw longer", () => {
    const held = open();
    pick(held, "h1");
    field(held).value = "half a sen";
    // A redraw for something else entirely must not rebuild the card under the reviewer.
    held.overlay.receive("meanwhile, from the agent");
    held.chrome.draw();
    expect(field(held).value).toBe("half a sen");
    // But the same node picked as words is a different card, and comes back fresh.
    held.overlay.pickSelection({
      ancestor: targetOf(node("h1") as unknown as El),
      text: "the board",
      collapsed: false,
    });
    held.chrome.draw();
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe(held.overlay.view().card?.heading);
    expect(one(held, `.${CLASS.heading}`)?.textContent).toBe("Annotate text");
    expect(field(held).value).toBe("");
  });
});

describe("a click on the page", () => {
  it("opens a card about the node under it, and is taken", () => {
    const held = open();
    held.overlay.setPicking(true);
    held.chrome.draw();
    const heard: string[] = [];
    const h1 = node("h1");
    h1.addEventListener("click", () => heard.push("the page"));
    const event = clickOn(h1);
    expect(held.overlay.open?.selector).toBe("main#sketch > h1");
    expect(event.defaultPrevented).toBe(true);
    expect(heard).toEqual([]);
    expect(one(held, `.${CLASS.card}`)).not.toBeNull();
  });

  it("is refused and left to the page by everything the machine refuses", () => {
    const held = open();
    const heard: string[] = [];
    for (const at of ["h1", "button"]) node(at).addEventListener("click", () => heard.push(at));
    // Picking is off: the overlay is not in the way of a page nobody is reviewing.
    expect(clickOn(node("h1")).defaultPrevented).toBe(false);
    held.overlay.setPicking(true);
    // A live control — a reviewer aiming at a button wanted the button.
    expect(clickOn(node("button")).defaultPrevented).toBe(false);
    // The overlay's own furniture — no card is ever opened about a card.
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
    expect(held.overlay.open?.text).toBe("eight tasks");
    // A drag that is really a click is refused by the machine, and the node is tried instead.
    held.state.drag = { ancestor, text: "", collapsed: true };
    clickOn(node("p"));
    expect(held.overlay.open?.kind).toBe("element");
    expect(held.overlay.open?.selector).toBe("main#sketch > p:nth-of-type(1)");
  });
});

describe("what the reviewer types", () => {
  it("is queued on Enter, left alone on Shift+Enter, and abandoned on Escape", () => {
    const held = open();
    pick(held, "h1");
    field(held).value = "too quiet";
    key(field(held), "Enter", { shift: true });
    expect(held.overlay.queued()).toHaveLength(0);
    expect(one(held, `.${CLASS.card}`)).not.toBeNull();
    key(field(held), "Enter");
    expect(held.overlay.queued().map((item) => item.prompt)).toEqual(["too quiet"]);
    expect(one(held, `.${CLASS.card}`)).toBeNull();
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(1);
    pick(held, "p");
    field(held).value = "never mind";
    key(field(held), "Escape");
    expect(held.overlay.queued()).toHaveLength(1);
    expect(one(held, `.${CLASS.card}`)).toBeNull();
  });

  it("goes with the round on Ctrl+Enter, unqueued though it is", async () => {
    const held = open();
    pick(held, "h1");
    field(held).value = "too quiet";
    key(field(held), "Enter", { ctrl: true });
    await settle();
    expect(held.rounds).toHaveLength(1);
    expect(held.rounds[0]?.prompts.map((item) => item.prompt)).toEqual(["too quiet"]);
    expect(held.rounds[0]?.end).toBe(false);
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(0);
  });

  it("reaches the machine's own draft as it is typed into the strip", () => {
    const held = open();
    say(held, "the whole page is too dark");
    expect(held.overlay.view().strip.draft).toBe("the whole page is too dark");
    key(reply(held), "Enter");
    expect(held.overlay.queued()[0]?.pick.kind).toBe("message");
    expect(reply(held).value).toBe("");
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(1);
  });
});

describe("a round", () => {
  it("is sent and ended in one act, and takes an unqueued draft with it", async () => {
    const held = open();
    note(held, "h1", "too quiet");
    say(held, "and that will do");
    press(held, LABEL.sendAndEnd);
    await settle();
    expect(held.rounds[0]?.prompts.map((item) => item.prompt)).toEqual([
      "too quiet",
      "and that will do",
    ]);
    expect(held.rounds[0]?.end).toBe(true);
    expect(held.overlay.ended).toBe(true);
    expect(held.state.left).toBe(1);
    expect(control(held, LABEL.send).disabled).toBe(true);
  });

  it("puts the reviewer's words back on screen when it does not land", async () => {
    const held = open();
    held.state.slow = true;
    note(held, "p", "too quiet", 0);
    say(held, "and the whole page is dark");
    press(held, LABEL.send);
    // In flight: the round is gone up and there is nothing further to send until it answers.
    expect(control(held, LABEL.send).disabled).toBe(true);
    expect(held.rounds[0]?.prompts).toHaveLength(2);
    held.release(false);
    await settle();
    expect(all(held, `.${CLASS.pill}`)).toHaveLength(2);
    expect(control(held, LABEL.send).disabled).toBe(false);
  });

  it("leaves the arrow rule in the page's own head only while picking", () => {
    const held = open();
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
    held.overlay.setPicking(true);
    held.chrome.draw();
    expect([...document.head.querySelectorAll("style")].map((at) => at.textContent)).toEqual([
      pickingCss(),
    ]);
    held.overlay.setPicking(false);
    held.chrome.draw();
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
  });
});

describe("what only this half decides", () => {
  it("places the card under the node, above it rather than off the bottom, always in view", () => {
    expect(anchor(RECT, VIEWPORT)).toEqual({ top: 132, left: 40 });
    expect(anchor({ ...RECT, top: 700 }, VIEWPORT)).toEqual({ top: 492, left: 40 });
    expect(anchor({ ...RECT, left: 980 }, VIEWPORT).left).toBe(668);
    expect(anchor(RECT, { width: 400, height: 220 })).toEqual({ top: 12, left: 40 });
  });

  it("describes a node once and live, so its selector can count its siblings", () => {
    open();
    const second = targetOf(node("p", 1) as unknown as El);
    expect(second.parent?.children).toContain(second);
    expect(pickElement(second).selector).toBe("main#sketch > p:nth-of-type(2)");
    // And reads it as it is now, not as it was when it was first described.
    node("p", 1).textContent = "three blocked";
    expect(second.text).toBe("three blocked");
  });

  it("takes the element holding a text node when a drag ends inside one, and no range as none", () => {
    open();
    const paragraph = node("p");
    const said = selectionOf({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ commonAncestorContainer: paragraph.firstChild as unknown as El }),
      toString: () => "eight tasks",
    });
    expect(said?.ancestor).toBe(targetOf(paragraph as unknown as El));
    expect(said?.text).toBe("eight tasks");
    expect(said?.collapsed).toBe(false);
    const empty: Selected = {
      isCollapsed: true,
      rangeCount: 0,
      getRangeAt: () => ({ commonAncestorContainer: null }),
      toString: () => "",
    };
    expect(selectionOf(null)).toBeNull();
    expect(selectionOf(empty)).toBeNull();
  });
});
