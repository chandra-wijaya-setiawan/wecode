/** A round of review as one line of input — the half of `annotate.ts` a browser can load.
 *
 *  Split out for exactly one reason: `annotate.ts` reads files off disk to serve them, so it
 *  imports `node:fs` and can never be handed to a browser. These functions decide what an
 *  agent *reads*, and the reviewer's own page is where a round is composed, so they have to
 *  run on both sides. One definition, imported by the server half and served to the browser
 *  half, rather than a second copy here to drift from the first.
 *
 *  Nothing in this file imports anything at runtime, which is what keeps that true. */
import type { QueuedPrompt } from "@wecode/painter/dist/client/queue.js";

const flat = (said: string): string => said.replace(/\s+/g, " ").trim();

/** The words, quoted — or nothing at all, for a node that had none. Quoted by the encoder
 *  rather than by hand, so a reviewer who picked a node containing a quotation mark does not
 *  hand the agent a sentence it has to guess the end of. */
const quoted = (text: string): string => (text === "" ? "" : ` ${JSON.stringify(text)}`);

/** The words that were showing inside a node, which is how a person recognises it. */
const showing = (text: string): string => (text === "" ? "" : ` showing${quoted(text)}`);

/** One note, as the agent reads it.
 *
 *  All three parts of the pick travel, because all three are what `pick.ts` made them for:
 *  the CSS path is how the agent finds the node again, the tag is what it turned out to be,
 *  and the words are how a person recognises it in the source. A note that said only "this is
 *  too quiet" is a note nobody can act on.
 *
 *  A message belongs to the page rather than to any node — the reply strip makes those — so
 *  it carries no selector and does not pretend to. */
export function lineOf(item: QueuedPrompt): string {
  const { kind, selector, tag, text } = item.pick;
  const said = flat(item.prompt);
  if (kind === "message") return `about the page — ${said}`;
  // A stretch of prose is the exact words to change, so it is quoted and nothing else: the
  // tag a text pick carries is the word "text", and `<text>` is not an element of any page.
  const what = kind === "text" ? `the words${quoted(text)}` : `<${tag}>${showing(text)}`;
  return `at ${selector} (${what}) — ${said}`;
}

/** A round of notes as one line of input.
 *
 *  Numbered and in the order they were queued, because that is the order the reviewer worked
 *  in and an agent answering six notes needs to be able to say which one it is answering.
 *  `about` is what was being reviewed — the notes are all selectors within it, and a selector
 *  with nothing to hold it is ambiguous the moment there are two sketches.
 *
 *  `end` is send-and-end: the round goes as it would have anyway, and the agent is told in the
 *  same breath that nothing further is coming, rather than being left waiting for a reviewer
 *  who has gone. */
export function noteOf(prompts: readonly QueuedPrompt[], about: string, end = false): string {
  const many = prompts.length === 1 ? "1 note" : `${prompts.length} notes`;
  const notes = prompts.map((item, at) => `(${at + 1}) ${lineOf(item)}`).join(" ");
  return `review of ${flat(about)} — ${many}${end ? ", and the last" : ""}: ${notes}`;
}
