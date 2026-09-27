/** The drawing half of the painter's overlay: what `view()` says should be on screen, put
 *  on screen, and what the reviewer does to it, handed back to the machine.
 *
 *  The machine is `client/overlay.ts` and it is not written again here. It holds the whole
 *  review loop — picking, the open card, the queue, the round in flight, the end — and draws
 *  nothing on purpose, which is the only reason its interesting rules (a failed send keeps
 *  the reviewer's words; ending is final; the overlay refuses to annotate itself) can be
 *  proved with no browser at all. The half it deliberately leaves out is this one, and this
 *  one decides nothing in return: every mark below is read back out of `view()` and every act
 *  below is one call into the machine. Nothing here keeps a second copy of what is queued,
 *  what is open or whether a send is in flight — a copy is a second answer, and the reviewer
 *  would eventually be shown the wrong one.
 *
 *  Three things need a browser, and they are all this file adds. A DOM node must be
 *  *described* before `pick.ts` will look at it, and that description has to be the same
 *  object its parent lists among its children, because `selectorFor` counts same-tag siblings
 *  by identity — so descriptions are memoised, and that is not a cache for speed. A card has
 *  to go somewhere, which is arithmetic on a rectangle only a browser can measure, so the
 *  measuring is a parameter and the arithmetic is here. And a click or a keypress has to
 *  become the one call it means.
 *
 *  Nothing here reaches for a node API and nothing reads a global: the only values imported
 *  are the painter's class names and sheet, which `browser/annotate.ts` already serves, so
 *  what a browser is sent can one day be this file rather than a copy typed into a string.
 *  Wiring it into a served document is that file's sentence, not this one's. */
import {
  CHROME_ATTRIBUTE,
  CLASS,
  overlayCss,
  pickingCss,
} from "@wecode/painter/dist/client/overlay.css.js";
import type { Overlay, OverlayView } from "@wecode/painter/dist/client/overlay.js";
import type { PickTarget, TextSelection } from "@wecode/painter/dist/client/pick.js";
/** A rectangle's extent, in pixels — the painter's own word for one, so a surface that
 *  already measures a terminal's screen does not grow a second vocabulary for a box. */
import type { Box } from "@wecode/painter/dist/client/terminal.js";

// ─── as much of a browser as the chrome needs ───────────────────────────────────────

/** An element, in the few ways this file touches one. A named shape and not the DOM's own
 *  type, for the reason `browser/dock.ts` names its own: this package compiles without the
 *  DOM library, and a shape a statement can hand in is what lets the drawing be driven.
 *  `tagName` is optional because a range's two ends often meet in a text node, which has
 *  none — that absence is exactly how `selectionOf` tells the two apart. */
export interface El {
  readonly tagName?: string;
  readonly id?: string;
  readonly innerText?: string;
  readonly children: ArrayLike<El>;
  readonly parentElement: El | null;
  textContent: string;
  className: string;
  value?: string;
  disabled?: boolean;
  getAttributeNames(): readonly string[];
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: readonly El[]): void;
  replaceChildren(...nodes: readonly El[]): void;
  remove(): void;
  focus?(): void;
  addEventListener(type: string, listen: (event: Ev) => void): void;
  attachShadow?(init: { mode: string }): { append(...nodes: readonly El[]): void };
}

/** A click or a keypress, in the parts that decide anything. */
export interface Ev {
  readonly target: El | null;
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface Doc {
  readonly head: El;
  readonly body: El;
  createElement(tag: string): El;
  addEventListener(type: string, listen: (event: Ev) => void, options?: unknown): void;
  removeEventListener(type: string, listen: (event: Ev) => void, options?: unknown): void;
}

/** A rectangle with a corner: where something is, as well as how big. */
export interface Rect extends Box {
  readonly top: number;
  readonly left: number;
}

/** The answers only a browser has, handed in rather than reached for: measuring a rectangle
 *  and reading a drag are a browser's acts and nothing else here is, which is what lets every
 *  rule below be stated without one. `boxOf` is null once the page no longer holds the node a
 *  selector names — a sketch that redrew under the reviewer, rather than a fault. */
export interface Browser {
  readonly boxOf: (selector: string) => Rect | null;
  readonly viewport: () => Box;
  readonly selection: () => TextSelection | null;
}

// ─── the page, as picking knows it ──────────────────────────────────────────────────

const attributesOf = (element: El): Record<string, string> =>
  Object.fromEntries(element.getAttributeNames().map((at) => [at, element.getAttribute(at) ?? ""]));

/** Every node already described, so that a node is described once and only once.
 *
 *  Not a cache for speed. `selectorFor` disambiguates a step by counting the parent's
 *  same-tag children and asking `indexOf` where this node sits among them — by identity. A
 *  wrapper built fresh on each read is never found in its own parent's list, so every
 *  `:nth-of-type` comes out `(0)` and the agent is handed a selector matching nothing. Weak,
 *  so describing a page does not stop a browser throwing it away. */
const described = new WeakMap<El, PickTarget>();

/** A DOM node as `pick.ts` needs it: the tag, the words showing, the attributes that decide
 *  whether it may be picked at all, and the way up and down the tree. All but the tag are
 *  getters, so a description read a minute later is still about the node as it is now — the
 *  page under a reviewer is work in progress, and stale text is a note about words gone. */
export function targetOf(element: El): PickTarget {
  const had = described.get(element);
  if (had) return had;
  const made: PickTarget = {
    tagName: element.tagName ?? "",
    get id(): string { return element.id ?? ""; },
    get text(): string { return element.innerText ?? element.textContent ?? ""; },
    get attributes(): Readonly<Record<string, string>> { return attributesOf(element); },
    get parent(): PickTarget | null { return element.parentElement ? targetOf(element.parentElement) : null; },
    get children(): readonly PickTarget[] { return Array.from(element.children).map(targetOf); },
  };
  described.set(element, made);
  return made;
}

/** As much of a DOM selection as picking reads. */
export interface Selected {
  readonly isCollapsed: boolean;
  readonly rangeCount: number;
  getRangeAt(index: number): { readonly commonAncestorContainer: El | null };
  toString(): string;
}

/** The reviewer's drag, described — or nothing, when there is no drag to describe. The node
 *  both ends share is a text node as often as an element, and a text node is not something
 *  `pick.ts` can walk up from, so the element holding it stands in. Whether the drag is worth
 *  anything is the machine's judgement: a collapsed or blank range is reported as it is, and
 *  `pickText` is what refuses it. */
export function selectionOf(selection: Selected | null): TextSelection | null {
  if (!selection || selection.rangeCount === 0) return null;
  const inside = selection.getRangeAt(0).commonAncestorContainer;
  const ancestor = inside?.tagName !== undefined ? inside : (inside?.parentElement ?? null);
  if (!ancestor) return null;
  const text = selection.toString();
  return { ancestor: targetOf(ancestor), text, collapsed: selection.isCollapsed };
}

// ─── where the card goes ────────────────────────────────────────────────────────────

/** The gap between the card and the thing it is about, the margin it keeps off every edge,
 *  and its own size — the sheet's `width:min(320px,…)` and the height a heading, field, hint
 *  and row come to. Stated rather than measured: a card is placed before it has been drawn,
 *  and one that jumps once it has is worse than one a pixel out. */
export const GAP = 8;
export const MARGIN = 12;
export const CARD: Box = { width: 320, height: 200 };

const clamp = (value: number, least: number, most: number): number =>
  Math.min(Math.max(value, least), Math.max(least, most));

/** Where the card sits, given the rectangle of the node it points at. Under the node, so the
 *  card does not cover the thing the reviewer is writing about — unless it would fall off the
 *  bottom, in which case above it, unless that would fall off the top as well, in which case
 *  under it again and clamped. Left-aligned with the node and clamped into the viewport,
 *  because a card half off the right edge takes its Queue button with it. */
export function anchor(box: Rect, screen: Box, card: Box = CARD): { top: number; left: number } {
  const under = box.top + box.height + GAP;
  const over = box.top - card.height - GAP;
  const fits = under + card.height + MARGIN <= screen.height;
  return {
    top: clamp(fits || over < MARGIN ? under : over, MARGIN, screen.height - card.height - MARGIN),
    left: clamp(box.left, MARGIN, screen.width - card.width - MARGIN),
  };
}

const at = (spot: { top: number; left: number }): string => `top:${spot.top}px;left:${spot.left}px`;

// ─── the words on the chrome ────────────────────────────────────────────────────────

/** What the buttons say — here rather than buried in the markup, so a statement can press
 *  one by the word on it without keeping a second copy of that word. */
export const LABEL = {
  queue: "Queue",
  cancel: "Cancel",
  send: "Send",
  sendAndEnd: "Send & End",
  end: "End",
  drop: "×",
  reply: "Say something to the agent…",
} as const;

// ─── drawing it ─────────────────────────────────────────────────────────────────────

/** The overlay in a page: `draw` puts `view()` on screen and is safe to call at any time,
 *  `host` is the shadow host — marked as the overlay's own, so the machine refuses to pick it
 *  — and `release` stops listening and takes the chrome off the page. */
export interface Chrome {
  readonly draw: () => void;
  readonly host: El;
  readonly release: () => void;
}

/** Is this the overlay's own furniture? Walks up: a click lands on the deepest node, and it
 *  is the card, not the field inside it, that carries the mark. */
const ours = (node: El | null): boolean => {
  for (let up = node; up; up = up.parentElement) {
    if (up.getAttribute(CHROME_ATTRIBUTE) !== null) return true;
  }
  return false;
};

/** Draw the overlay into a page and wire it to the machine. Everything the reviewer can do
 *  is here, and each is a call and a redraw: the machine is asked what changed, never told. */
export function mount(overlay: Overlay, doc: Doc, browser: Browser): Chrome {
  const make = (tag: string, className = "", said = ""): El =>
    Object.assign(doc.createElement(tag), { className, textContent: said });
  const button = (className: string, label: string, act: () => void): El => {
    const made = make("button", className, label);
    made.setAttribute("type", "button");
    made.addEventListener("click", (event) => (event.preventDefault(), act()));
    return made;
  };

  const host = make("div", CLASS.root);
  host.setAttribute(CHROME_ATTRIBUTE, "");
  const root = host.attachShadow?.({ mode: "open" }) ?? host;
  root.append(make("style", "", overlayCss()));

  // The one rule that goes in the *page's* document rather than the shadow root: while
  // picking every cursor is an arrow, because a pointer over a link promises a navigation the
  // overlay is about to swallow. Made once, in and out of the head as picking turns.
  const arrows = make("style", "", pickingCss());
  let pointing = false;

  // ─── the parts, made once ─────────────────────────────────────────────────────────
  // The mark is given no class here: it wears the one the view names, because the machine
  // publishes it so the adapter does not get to name it a second time.
  const highlight = make("div");
  const strip = make("div", CLASS.strip);
  strip.setAttribute(CHROME_ATTRIBUTE, "");
  const log = make("div", CLASS.log);
  const pills = make("div", CLASS.queue);
  const row = make("div", CLASS.row);
  const reply = make("input", CLASS.reply);
  reply.setAttribute("type", "text");
  reply.setAttribute("placeholder", LABEL.reply);
  const sends = button(CLASS.send, LABEL.send, () => send(false));
  const lasts = button(CLASS.sendAndEnd, LABEL.sendAndEnd, () => send(true));
  const ends = button(CLASS.cancel, LABEL.end, () => (overlay.end(), draw()));
  row.append(reply, sends, lasts, ends);
  strip.append(log, pills, row);
  root.append(highlight, strip);

  /** Which pick a card is open against — how a redraw knows whether this is still the same
   *  card. One that is, is left alone down to its field, because what is typed there belongs
   *  to the reviewer until they queue it and rebuilding the card under them throws their
   *  sentence away. The kind is part of that identity and not decoration: dragging over words
   *  inside a paragraph already picked whole gives the same selector, and only the kind says
   *  the card must come back as "Annotate text" with the placeholder that goes with it. */
  const which = (view: NonNullable<OverlayView["card"]>): string => `${view.kind} ${view.selector}`;
  let card: El | null = null;
  let field: El | null = null;
  let about: string | null = null;

  const drop = (): void => {
    card?.remove(), (card = field = null), (about = null);
  };

  const said = (): string => field?.value ?? "";

  /** Queue what is in the open card, if anything, and close it. */
  const queue = (): void => {
    if (field) overlay.annotate(said());
    draw();
  };

  /** Send the round. The open card's words go with it — `send` takes the strip's draft itself
   *  and says an adapter wanting that courtesy for a card calls `annotate` first — and the
   *  redraw happens twice, once for the round going out and once for what came back, because
   *  `sending` is true from the call until the host answers. */
  const send = (end: boolean): void => {
    if (said().trim()) overlay.annotate(said());
    const gone = overlay.send(end);
    draw();
    void gone.then(draw, draw);
  };

  const build = (view: NonNullable<OverlayView["card"]>): void => {
    drop();
    const made = make("div", CLASS.card);
    made.setAttribute(CHROME_ATTRIBUTE, "");
    const box = make("textarea", CLASS.field);
    box.setAttribute("placeholder", view.placeholder);
    const keys = make("div", CLASS.row);
    keys.append(
      button(CLASS.cancel, LABEL.cancel, () => (overlay.cancel(), draw())),
      button(CLASS.send, LABEL.queue, queue),
    );
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") return event.preventDefault(), overlay.cancel(), draw();
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) return send(false);
      queue();
    });
    made.append(make("div", CLASS.heading, view.heading), box, make("div", CLASS.hint, view.hint), keys);
    root.append(made);
    card = made;
    field = box;
    about = which(view);
    box.focus?.();
  };

  const draw = (): void => {
    const view = overlay.view();
    if (view.card === null) drop();
    else if (about !== which(view.card)) build(view.card);

    // The card is placed even when the node it points at has gone — the reviewer is mid
    // sentence, and taking the card would take the sentence — and only the mark goes, because
    // a mark over nothing is a lie about where the note lands.
    const box = view.card ? browser.boxOf(view.card.selector) : null;
    const spot = box ? anchor(box, browser.viewport()) : { top: MARGIN, left: MARGIN };
    card?.setAttribute("style", at(spot));
    highlight.className = view.highlightClass;
    const shape = box ? `${at(box)};width:${box.width}px;height:${box.height}px` : "display:none";
    highlight.setAttribute("style", shape);

    pills.replaceChildren(
      ...view.pills.map((text, index) => {
        const pill = make("span", CLASS.pill);
        const drops = button(CLASS.pillClose, LABEL.drop, () => (overlay.unqueue(index), draw()));
        pill.append(make("span", CLASS.pillText, text), drops);
        return pill;
      }),
    );
    log.replaceChildren(...view.strip.log.map((line) => make("p", CLASS.logLine, line)));

    // Only when it differs: the machine owns the draft, but writing the same string back
    // into a live input is how a caret jumps to the end mid-word.
    if ((reply.value ?? "") !== view.strip.draft) reply.value = view.strip.draft;
    reply.disabled = view.ended;
    sends.disabled = !view.strip.canSend;
    lasts.disabled = !view.strip.canSend;
    ends.disabled = view.ended;

    if (view.picking !== pointing) {
      pointing = view.picking;
      if (pointing) doc.head.append(arrows);
      else arrows.remove();
    }
  };

  // ─── what the reviewer does ───────────────────────────────────────────────────────

  reply.addEventListener("input", () => overlay.type(reply.value ?? ""));
  reply.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    overlay.type(reply.value ?? "");
    if (event.ctrlKey || event.metaKey) return send(false);
    overlay.message();
    draw();
  });

  /** A click on the page while picking. Offered as a drag first, because a reviewer who
   *  dragged over a sentence meant the sentence and not the paragraph holding it; the machine
   *  refuses a drag that is really a click, and the node under it is tried instead. Swallowed
   *  only when a card opened, so a click the machine refused — the overlay's own furniture, a
   *  live control, picking turned off — still does what the page meant it to. */
  const clicked = (event: Ev): void => {
    if (!overlay.picking || ours(event.target)) return;
    const node = event.target;
    if (!(overlay.pickSelection(browser.selection()) || overlay.pick(node && targetOf(node)))) return;
    event.preventDefault();
    event.stopPropagation();
    draw();
  };
  doc.addEventListener("click", clicked, { capture: true });
  doc.body.append(host);
  draw();

  return {
    draw,
    host,
    release: (): void => {
      doc.removeEventListener("click", clicked, { capture: true }), arrows.remove(), host.remove();
    },
  };
}
