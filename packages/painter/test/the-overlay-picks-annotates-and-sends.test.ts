/** The painter overlay's review loop — pick → annotate → queue → send → reply → end —
 *  held to the rules a browser would hide: that a selector points back at the right node,
 *  that a second note about one element replaces the first, that a failed send keeps the
 *  reviewer's words, and that ending is final. None of that needs a DOM, because the
 *  overlay states its page as a port: this file builds pages out of plain objects and
 *  reads `view()`, which is the same thing a browser adapter renders. */

import { describe, expect, it } from "vitest";
import { CHROME_ATTRIBUTE, CLASS, overlayCss, pickingCss } from "../src/client/overlay.css.js";
import { SELECTOR_DEPTH, TEXT_CAP, isPickable } from "../src/client/pick.js";
import { pickElement, pickText, selectorFor } from "../src/client/pick.js";
import type { PickTarget } from "../src/client/pick.js";
import { PILL_CAP, PromptQueue, pillText, queueKey } from "../src/client/queue.js";
import type { QueuedPrompt } from "../src/client/queue.js";
import { Overlay } from "../src/client/overlay.js";
import type { OverlayHost } from "../src/client/overlay.js";

interface NodeSpec {
  readonly tag: string;
  readonly id?: string;
  readonly text?: string;
  readonly attributes?: Record<string, string>;
  readonly children?: readonly NodeSpec[];
}

/** Build a tree of `PickTarget`s, wiring each child's `parent` back up. The browser
 *  adapter wraps DOM nodes the same way; this one wraps literals. */
function page(spec: NodeSpec, parent: PickTarget | null = null): PickTarget {
  const children: PickTarget[] = [];
  const { tag, id, text, attributes } = spec;
  const node: PickTarget = { tagName: tag, id, text, attributes, parent, children };
  for (const child of spec.children ?? []) children.push(page(child, node));
  return node;
}
/** The nth descendant matching a tag, depth-first — how these tests name a node. */
function find(tag: string, nth = 0, root: PickTarget = ARTICLE): PickTarget {
  const hits: PickTarget[] = [];
  (function walk(node: PickTarget): void {
    if (node.tagName === tag) hits.push(node);
    for (const child of node.children) walk(child);
  })(root);
  const hit = hits[nth];
  if (!hit) throw new Error(`no ${tag}[${nth}] in the page`);
  return hit;
}

interface Host extends OverlayHost {
  rounds: QueuedPrompt[][];
  ends: number;
  fail: boolean;
  throws: boolean;
}

/** A host that records the rounds it is handed, and can be told to fail or to throw. */
function host(): Host {
  const h: Host = {
    rounds: [],
    ends: 0,
    fail: false,
    throws: false,
    deliver(prompts) {
      if (h.throws) throw new Error("the chrome is gone");
      if (h.fail) return false;
      h.rounds.push([...prompts]);
      return true;
    },
    end: () => void (h.ends += 1),
  };
  return h;
}

const ARTICLE = page({
  tag: "body",
  children: [
    {
      tag: "main",
      id: "content",
      children: [
        { tag: "p", text: "  first   paragraph\n" },
        { tag: "p", text: "second paragraph" },
        { tag: "button", text: "Send" },
        { tag: "div", attributes: { [CHROME_ATTRIBUTE]: "card" }, children: [{ tag: "span" }] },
      ],
    },
  ],
});
const P1 = "main#content > p:nth-of-type(1)";
const P2 = "main#content > p:nth-of-type(2)";
const MAIN = "main#content";

/** Pick the nth paragraph and say something about it — the loop's one common move. */
function note(o: Overlay, nth: number, prompt: string): void {
  o.setPicking(true);
  o.pick(find("p", nth));
  o.annotate(prompt);
}

const said = (r: readonly QueuedPrompt[] | undefined): readonly string[] =>
  (r ?? []).map((i) => i.prompt);
describe("picking a place on the page", () => {
  it("names a node by the shortest path that still finds it", () => {
    expect(selectorFor(find("p", 1))).toBe(P2);
    // An only child of its tag stays unqualified: `section > p` survives an edit that
    // `section > p:nth-of-type(1)` would not. An id ends the walk, and is escaped.
    const only = page({ tag: "section", children: [{ tag: "h1" }, { tag: "p" }] });
    expect(selectorFor(find("p", 0, only))).toBe("section > p");
    expect(selectorFor(find("main"))).toBe(MAIN);
    const odd = page({ tag: "div", children: [{ tag: "span", id: "a.b:c" }] });
    expect(selectorFor(find("span", 0, odd))).toBe("span#a\\.b\\:c");
  });
  it("keeps a path readable rather than rooting it at the document", () => {
    let deep: NodeSpec = { tag: "i" };
    for (let i = 0; i < 12; i += 1) deep = { tag: "div", children: [deep] };
    const parts = selectorFor(find("i", 0, page(deep))).split(" > ");
    expect(parts).toHaveLength(SELECTOR_DEPTH);
    expect(parts.at(-1)).toBe("i");
  });
  it("describes a node by its tag and the words showing, on one line and capped", () => {
    expect(pickElement(find("p"))).toEqual({
      kind: "element",
      selector: P1,
      tag: "p",
      text: "first paragraph",
    });
    const wordy = page({ tag: "div", text: "x".repeat(TEXT_CAP * 2) });
    expect(pickElement(wordy).text).toHaveLength(TEXT_CAP);
  });
  it("picks the page's own plain nodes, and neither the overlay nor a live control", () => {
    expect(isPickable(find("span")), "the overlay's own card, clicked deep").toBe(false);
    expect(isPickable(find("button")), "a control that already does something").toBe(false);
    expect(isPickable(find("p")), "a plain node beside a control").toBe(true);
  });
  it("takes a dragged stretch of prose as its own kind of target", () => {
    expect(pickText({ ancestor: find("main"), text: "  some   words " })).toEqual({
      kind: "text",
      selector: MAIN,
      tag: "text",
      text: "some words",
    });
  });
  it("treats a collapsed or blank drag as no selection at all", () => {
    const ancestor = find("main");
    expect(pickText({ ancestor, text: "words", collapsed: true })).toBeNull();
    expect(pickText({ ancestor, text: "   " })).toBeNull();
    expect(pickText(null)).toBeNull();
  });
});

describe("the queue of things said but not sent", () => {
  const first = pickElement(find("p"));
  const second = pickElement(find("p", 1));
  it("keeps notes in the order they were made", () => {
    const q = new PromptQueue();
    q.enqueue(first, "tighten this");
    q.enqueue(second, "cut this");
    expect(said(q.list())).toEqual(["tighten this", "cut this"]);
  });
  it("replaces a second note about one element, in place", () => {
    const q = new PromptQueue();
    q.enqueue(first, "tighten this");
    q.enqueue(second, "cut this");
    q.enqueue(pickElement(find("p")), "actually, delete it");
    expect(said(q.list())).toEqual(["actually, delete it", "cut this"]);
  });
  it("keeps two notes about two stretches of one paragraph, because they are two notes", () => {
    const ancestor = find("main");
    const one = pickText({ ancestor, text: "one" });
    const q = new PromptQueue();
    q.enqueue(one!, "a");
    q.enqueue(pickText({ ancestor, text: "two" })!, "b");
    expect(q.size).toBe(2);
    expect(queueKey(one!)).toBe("");
  });
  it("refuses a blank note, trims what it keeps, and shrugs off a stale pill", () => {
    const q = new PromptQueue();
    expect(q.enqueue(first, "   ")).toBe(false);
    expect(q.isEmpty).toBe(true);
    q.enqueue(first, "  spaced  ");
    q.remove(7);
    q.remove(-1);
    expect(said(q.list())).toEqual(["spaced"]);
  });
  it("empties as it hands a round over, and puts a failed one back ahead of the rest", () => {
    const q = new PromptQueue();
    q.enqueue(first, "one");
    const round = q.take();
    q.enqueue(second, "queued while sending");
    expect(said(round)).toEqual(["one"]);
    expect(said(q.list())).toEqual(["queued while sending"]);
    q.restore(round);
    expect(said(q.list())).toEqual(["one", "queued while sending"]);
  });
  it("labels a pill by where it points and what was said, cut to fit", () => {
    expect(pillText({ pick: first, prompt: "tighten this" })).toBe(`${P1}: tighten this`);
    const long = pillText({ pick: first, prompt: "x".repeat(PILL_CAP * 2) });
    expect(long).toContain(`: ${"x".repeat(PILL_CAP - 1)}…`);
  });
});

describe("the review loop", () => {
  it("picks nothing until picking is turned on, and never the overlay itself", () => {
    const o = new Overlay(host());
    expect(o.pick(find("p"))).toBe(false);
    expect(o.view().card).toBeNull();
    o.setPicking(true);
    expect(o.pick(find("span"))).toBe(false);
    expect(o.view().card).toBeNull();
    expect(o.pick(find("p"))).toBe(true);
    expect(o.view().card).toMatchObject({ heading: "Annotate <p>", selector: P1, kind: "element" });
  });
  it("opens a different card for prose than for a node", () => {
    const o = new Overlay(host());
    o.setPicking(true);
    o.pickSelection({ ancestor: find("main"), text: "some words" });
    expect(o.view().card).toMatchObject({ heading: "Annotate text", kind: "text" });
  });
  it("reports a click dressed as a selection, so the adapter can pick the node instead", () => {
    const o = new Overlay(host());
    o.setPicking(true);
    expect(o.pickSelection({ ancestor: find("main"), text: "", collapsed: true })).toBe(false);
    expect(o.view().card).toBeNull();
  });
  it("queues a note, closes the card, and shows a pill", () => {
    const o = new Overlay(host());
    note(o, 0, "tighten this");
    expect(o.view().card).toBeNull();
    expect(o.view().pills).toEqual([`${P1}: tighten this`]);
  });
  it("queues nothing on Cancel, nor on Queue with an empty box", () => {
    const o = new Overlay(host());
    o.setPicking(true);
    o.pick(find("p"));
    o.cancel();
    expect(o.view()).toMatchObject({ card: null, pills: [] });
    o.pick(find("p"));
    expect(o.annotate("  ")).toBe(false);
    expect(o.view()).toMatchObject({ card: null, pills: [] });
  });
  it("abandons an open card when picking is turned off, but keeps what was queued", () => {
    const o = new Overlay(host());
    note(o, 0, "tighten this");
    o.pick(find("p", 1));
    o.setPicking(false);
    expect(o.view().card).toBeNull();
    expect(o.view().pills).toHaveLength(1);
  });
  it("drops a note when its pill is dismissed", () => {
    const o = new Overlay(host());
    note(o, 0, "one");
    note(o, 1, "two");
    o.unqueue(0);
    expect(o.view().pills).toEqual([`${P2}: two`]);
  });
  it("will not send an empty round", async () => {
    const h = host();
    const o = new Overlay(h);
    expect(await o.send()).toBe(false);
    expect(h.rounds).toEqual([]);
    expect(o.view().strip.canSend).toBe(false);
  });
  it("sends the whole round at once and empties the queue", async () => {
    const h = host();
    const o = new Overlay(h);
    note(o, 0, "one");
    note(o, 1, "two");
    expect(o.view().strip.canSend).toBe(true);
    expect(await o.send()).toBe(true);
    expect(h.rounds).toHaveLength(1);
    expect(said(h.rounds[0])).toEqual(["one", "two"]);
    expect(o.view().pills).toEqual([]);
  });
  it("keeps the reviewer's words when a send does not land", async () => {
    const h = host();
    const o = new Overlay(h);
    note(o, 0, "one");
    h.fail = true;
    expect(await o.send()).toBe(false);
    expect(o.view().pills).toEqual([`${P1}: one`]);
    h.fail = false;
    expect(await o.send()).toBe(true);
    expect(said(h.rounds[0])).toEqual(["one"]);
  });
  it("keeps them when the host throws, and is not left stuck sending", async () => {
    const h = host();
    const o = new Overlay(h);
    note(o, 0, "one");
    h.throws = true;
    expect(await o.send()).toBe(false);
    expect(o.view().pills).toHaveLength(1);
    expect(o.view().strip.sending).toBe(false);
  });
});

describe("the reply strip", () => {
  it("queues a freeform message against the page rather than any node", async () => {
    const h = host();
    const o = new Overlay(h);
    o.type("   ");
    expect(o.message(), "an empty strip says nothing").toBe(false);
    o.type("the whole layout is too tight");
    expect(o.message()).toBe(true);
    expect(o.view().pills).toEqual(["page: the whole layout is too tight"]);
    expect(o.view().strip.draft).toBe("");
    await o.send();
    expect(h.rounds[0]?.[0]?.pick.kind).toBe("message");
  });
  it("sends a half-typed draft rather than dropping it", async () => {
    const h = host();
    const o = new Overlay(h);
    o.type("one last thing");
    expect(await o.send()).toBe(true);
    expect(said(h.rounds[0])).toEqual(["one last thing"]);
    expect(o.view().strip.draft).toBe("");
  });
  it("shows what the agent said back, in order, ignoring empty replies", () => {
    const o = new Overlay(host());
    o.receive("done — tightened the paragraph");
    o.receive("   ");
    o.receive("anything else?");
    expect(o.view().strip.log).toEqual(["done — tightened the paragraph", "anything else?"]);
  });
});

describe("ending the session", () => {
  it("sends the round and ends, in one act", async () => {
    const h = host();
    const o = new Overlay(h);
    note(o, 0, "one");
    expect(await o.sendAndEnd()).toBe(true);
    expect(said(h.rounds[0])).toEqual(["one"]);
    expect(h.ends).toBe(1);
    expect(o.ended).toBe(true);
  });
  it("does not end when the final send failed to land", async () => {
    const h = host();
    const o = new Overlay(h);
    o.type("one");
    h.fail = true;
    expect(await o.sendAndEnd()).toBe(false);
    expect(h.ends).toBe(0);
    expect(o.ended).toBe(false);
    expect(o.view().pills).toHaveLength(1);
  });
  it("is final: nothing can be picked, queued or sent afterwards", async () => {
    const h = host();
    const o = new Overlay(h);
    o.setPicking(true);
    o.end();
    o.end();
    expect(h.ends, "the host is told once, however often it is ended").toBe(1);
    expect(o.view()).toMatchObject({ picking: false, ended: true, card: null, pills: [] });
    expect(o.pick(find("p"))).toBe(false);
    expect(o.pickSelection({ ancestor: find("main"), text: "words" })).toBe(false);
    o.setPicking(true);
    expect(o.view().picking).toBe(false);
    o.type("too late");
    expect(o.message()).toBe(false);
    expect(await o.send()).toBe(false);
    expect(h.rounds).toEqual([]);
    expect(o.view().strip.canSend).toBe(false);
  });
  it("still shows the agent's last word after the session is over", () => {
    const o = new Overlay(host());
    o.end();
    o.receive("all done");
    expect(o.view().strip.log).toEqual(["all done"]);
  });
});

describe("the overlay's stylesheet", () => {
  it("styles every class the overlay writes, and none it does not", () => {
    const css = overlayCss();
    for (const name of Object.values(CLASS)) {
      if (name === CLASS.root) continue;
      expect(css, `${name} is written but never styled`).toContain(`.${name}`);
    }
    for (const selector of css.match(/\.painter-[\w-]+/g) ?? []) {
      expect(Object.values(CLASS) as string[], `${selector} is styled but never written`).toContain(
        selector.slice(1),
      );
    }
    expect(css, "the page's styles must neither leak in nor out").toContain(":host{all:initial");
  });
  it("names the class the adapter should mark a picked node with", () => {
    expect(new Overlay(host()).view().highlightClass).toBe(CLASS.highlight);
  });
  it("keeps the page from promising a click the overlay is about to swallow", () => {
    const css = pickingCss();
    expect(css).toContain("*{cursor:default!important}");
    expect(css).toContain(`[${CHROME_ATTRIBUTE}]`);
    expect(css).toContain("cursor:text!important");
  });
  it("has no whiteboard in it", () => {
    const everything = `${overlayCss()} ${pickingCss()}`.toLowerCase();
    for (const word of ["mermaid", "excalidraw", "whiteboard", "canvas", "scene"]) {
      expect(everything, `${word} should not have come across from Lavish`).not.toContain(word);
    }
  });
});
