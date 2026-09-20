/** Turning a place on the page into a target an agent can find again.
 *
 *  A reviewer points at something and says what is wrong with it. For that to be worth
 *  anything the agent has to be able to find the same thing in the source, so a pick is
 *  not a node — it is a *description*: a CSS path, the tag, and the words that were
 *  showing. Those three survive the round trip to an agent that never sees the page.
 *
 *  Nothing here touches a real `Element`. `PickTarget` is the shape a browser adapter
 *  wraps a DOM node in, the same way lens states its ports apart from the renderer that
 *  satisfies them. The reason is testability: a selector is fiddly enough to deserve
 *  tests, and tests that need a browser to check a string are tests nobody runs. */

import { CHROME_ATTRIBUTE } from "./overlay.css.js";

/** A node, as picking needs to know it. A browser adapter passes a real element through
 *  unchanged except for `children`, which it takes from `element.children`. */
export interface PickTarget {
  readonly tagName: string;
  readonly id?: string;
  readonly parent: PickTarget | null;
  readonly children: readonly PickTarget[];
  /** The words showing inside it — the adapter's `innerText`, untrimmed. */
  readonly text?: string;
  /** The attributes that decide whether this node may be picked at all. */
  readonly attributes?: Readonly<Record<string, string>>;
}

/** A stretch of prose the reviewer dragged over, rather than a whole node. */
export interface TextSelection {
  /** The lowest node containing both ends of the drag. */
  readonly ancestor: PickTarget;
  readonly text: string;
  /** True when the drag ended where it began, which is a click and not a selection. */
  readonly collapsed?: boolean;
}

/** What the reviewer chose. `kind` is what the agent reads to know how literally to take
 *  `text`: for an element it is a label, for text it is the exact words to change, and for
 *  a message it is nothing at all — a freeform note belongs to the page, not to a node. */
export interface Pick {
  readonly kind: "element" | "text" | "message";
  readonly selector: string;
  readonly tag: string;
  readonly text: string;
}

/** How many steps up the tree a selector keeps.
 *
 *  Five is enough to be unambiguous on a real page and short enough that a person can read
 *  the path in a pill. A full path from `html` would be both unreadable and *more* brittle:
 *  every wrapper the agent later adds would invalidate it. */
export const SELECTOR_DEPTH = 5;

/** How much of a node's words travel with the pick. Enough to recognise it by; not so much
 *  that a picked `<body>` sends the whole page to the agent. */
export const TEXT_CAP = 240;

/** Controls that already mean something when clicked. Picking must not shadow them:
 *  a reviewer pressing a button in a prototype wants the prototype's behaviour, and says
 *  so by the fact that they aimed at a button. */
const INTERACTIVE = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "label",
  "summary",
  "video",
  "audio",
]);

/** CSS.escape, for the identifiers a selector embeds. The browser has one; this module
 *  does not assume a browser, and an id is the only thing escaped here. */
function escapeIdentifier(value: string): string {
  return value.replace(/[^\w-]/g, (char) => `\\${char}`);
}

/** The path back to a node, as a CSS selector.
 *
 *  Walks up at most `SELECTOR_DEPTH` steps, disambiguating each step by `:nth-of-type`
 *  only when the parent holds more than one child of that tag — an unqualified `div` is
 *  both shorter and likelier to survive an edit than `div:nth-of-type(1)`. An `id` ends
 *  the walk immediately: it is already unique, so anything to its left is noise. */
export function selectorFor(target: PickTarget | null): string {
  const parts: string[] = [];
  let node = target;
  while (node && parts.length < SELECTOR_DEPTH) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${escapeIdentifier(node.id)}`);
      break;
    }
    const parent = node.parent;
    if (parent) {
      const sameTag = parent.children.filter((c) => c.tagName === node?.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
}

/** A node's words, on one line and capped. Runs of whitespace collapse because the source
 *  wrapped the text for its own reasons and the agent should not have to see them. */
export function textOf(target: PickTarget): string {
  return (target.text ?? "").trim().replace(/\s+/g, " ").slice(0, TEXT_CAP);
}

/** Is this node part of the overlay rather than the page? Walks up, because a click lands
 *  on the deepest node and it is the card, not its `<textarea>`, that carries the mark. */
export function isChrome(target: PickTarget | null): boolean {
  for (let node = target; node; node = node.parent) {
    if (node.attributes?.[CHROME_ATTRIBUTE] !== undefined) return true;
  }
  return false;
}

/** Does this node do something of its own when clicked? Unlike `isChrome` this does not
 *  walk up: a `<div>` inside a `<button>` is still the button's, but a `<span>` merely
 *  next to one is not, and the deepest node is the one the reviewer aimed at. */
export function isInteractive(target: PickTarget | null): boolean {
  if (!target) return false;
  if (INTERACTIVE.has(target.tagName.toLowerCase())) return true;
  const editable = target.attributes?.["contenteditable"];
  return editable !== undefined && editable !== "false";
}

/** May the reviewer annotate this node? The overlay's own furniture and the page's live
 *  controls are both off limits, for opposite reasons: one is not the page, and the other
 *  is too much of it. */
export function isPickable(target: PickTarget | null): boolean {
  if (!target) return false;
  return !isChrome(target) && !isInteractive(target);
}

/** The node the reviewer clicked, described. */
export function pickElement(target: PickTarget): Pick {
  return {
    kind: "element",
    selector: selectorFor(target),
    tag: target.tagName.toLowerCase(),
    text: textOf(target),
  };
}

/** The prose the reviewer dragged over, described — or nothing, when there is no drag to
 *  speak of. A collapsed range and a whitespace-only one are both just a click, and the
 *  caller handles a click by picking the element under it instead. */
export function pickText(selection: TextSelection | null): Pick | null {
  if (!selection || selection.collapsed) return null;
  const text = selection.text.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (!isPickable(selection.ancestor)) return null;
  return {
    kind: "text",
    selector: selectorFor(selection.ancestor),
    tag: "text",
    text: text.slice(0, TEXT_CAP),
  };
}

/** A note about the page as a whole, belonging to no node. The reply strip makes these. */
export function pickMessage(): Pick {
  return { kind: "message", selector: "", tag: "message", text: "" };
}
