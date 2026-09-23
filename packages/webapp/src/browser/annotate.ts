/** The reviewer's half of a sketch: the painter's review loop, served to a browser, and the
 *  one sentence that loop does not already have — where a round of notes goes.
 *
 *  The loop itself is not written here and must not be. `client/overlay.ts` is the whole
 *  pick → annotate → queue → send → reply → end machine, and `client/pick.ts` turns a click
 *  into a CSS path, a tag and the words that were showing, which is the only reason a note is
 *  worth anything: the agent never sees the page, and those three are what let it find the
 *  same thing in the source. Both are the painter's, both are proved in the painter's own
 *  tests, and both are handed to a browser here as the files they already are — the way
 *  `browser/dock.ts` hands over the painter's terminal rather than keeping a second copy of
 *  one. The painter did write its own terminal emulator once; that is the one thing this
 *  surface had to throw away, and the lesson is not to write a second review loop beside it.
 *
 *  What is left over is the host. `OverlayHost.deliver` is the overlay's one question about
 *  the world — "did this round land?" — and answering it is a decision about *this* surface:
 *  a round of notes is typed at the shell the dock is already holding, on the route that
 *  already carries the operator's keystrokes, so the operator watches the agent receive it on
 *  the screen they were already watching. That is `noteOf` and `sending`, and it is all this
 *  file decides.
 *
 *  Nothing here renders. The overlay states what should be on screen as `view()` and leaves
 *  the drawing to a browser adapter, which is what keeps every rule worth having testable
 *  without a browser — and it is why everything below can be driven against the real route
 *  with no DOM in the way. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { encode } from "@wecode/painter/dist/client/terminal.js";
import type { OverlayHost } from "@wecode/painter/dist/client/overlay.js";
import type { QueuedPrompt } from "@wecode/painter/dist/client/queue.js";
import { SHELL_AT } from "../pages/shell.js";
import type { Reply, Routes } from "../server.js";

/** Where a round of notes goes: the dock's own far end, which is where a keystroke already
 *  goes. Named rather than opened a second time, because a note and a keypress must arrive
 *  at one session in the order the reviewer made them — a route of this file's own would be a
 *  second way into the shell, and two ways in is two screens the next word could land on. */
export const NOTES_AT = SHELL_AT;

/** Where the review loop is served from.
 *
 *  A directory and not four paths of its own choosing: `overlay.js` imports `./pick.js`,
 *  `./queue.js` and `./overlay.css.js` by the relative specifiers it was compiled with, so
 *  the four have to answer beside one another or a browser resolves three of them against the
 *  root of this surface and fetches three 404s. */
export const REVIEW_AT = "/review";

/** The four files, at the four paths. `overlay` is the machine, `pick` is the description of
 *  a place on the page, `queue` is what has been said but not yet sent, and `look` is the
 *  sheet the chrome is unreadable without. */
export const REVIEW = {
  overlay: `${REVIEW_AT}/overlay.js`,
  pick: `${REVIEW_AT}/pick.js`,
  queue: `${REVIEW_AT}/queue.js`,
  look: `${REVIEW_AT}/overlay.css.js`,
} as const;

const JS = "text/javascript";

/** Where a dependency's files sit is the package manager's business, so they are resolved
 *  rather than reached for by path. */
const here = createRequire(fileURLToPath(import.meta.url));

/** A module of the painter's browser half, handed over as it is and read when the route is
 *  wired: it does not change under a running board. */
const fileAt = (module: string): Reply => ({
  status: 200,
  type: `${JS}; charset=utf-8`,
  body: readFileSync(here.resolve(`@wecode/painter/dist/client/${module}.js`), "utf8"),
});

/** The review loop, at the paths a browser asks for it on. Every one of them is a file the
 *  painter already ships, so what a reviewer runs is what the painter's tests proved. */
export const review = (): Routes => {
  const held: Readonly<Record<string, Reply>> = {
    [REVIEW.overlay]: fileAt("overlay"),
    [REVIEW.pick]: fileAt("pick"),
    [REVIEW.queue]: fileAt("queue"),
    [REVIEW.look]: fileAt("overlay.css"),
  };
  return Object.fromEntries(Object.entries(held).map(([at, reply]) => [at, () => reply]));
};

// ─── a round, as words typed at a shell ─────────────────────────────────────────────

/** One line, whatever the reviewer typed.
 *
 *  A note written into the card's `<textarea>` carries newlines, and the far end submits a
 *  prompt by writing it followed by a return — so it flattens the newlines itself, or each
 *  one would submit early and turn one round into several half-rounds. Flattening here as
 *  well is not that guard repeated: it is what makes `noteOf` one line *by construction*, so
 *  the thing a test reads and the thing the shell receives are the same string. */
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
 *  `end` is Lavish's "Send & End": the round goes as it would have anyway, and the agent is
 *  told in the same breath that nothing further is coming, rather than being left waiting for
 *  a reviewer who has gone. */
export function noteOf(prompts: readonly QueuedPrompt[], about: string, end = false): string {
  const many = prompts.length === 1 ? "1 note" : `${prompts.length} notes`;
  const notes = prompts.map((item, at) => `(${at + 1}) ${lineOf(item)}`).join(" ");
  return `review of ${flat(about)} — ${many}${end ? ", and the last" : ""}: ${notes}`;
}

// ─── the host ───────────────────────────────────────────────────────────────────────

/** What posting a frame answers with. A browser's `fetch` hands back a `Response` and this
 *  surface's own route hands back a `Reply`; they agree on `status` and on nothing else, so
 *  that is the one field read — which is also what lets the overlay be driven against the
 *  route itself, with no socket and no browser in the way. */
export type Posts = (frame: string) => Promise<{ readonly status: number }>;

/** The one status that means the far end took it. Anything else — 400 for a frame it did not
 *  understand, 409 for a shell that has left — is a round that did not land, and the overlay
 *  puts the reviewer's words back rather than losing them. */
export const LANDED = 200;

const NOTHING = (): void => undefined;

/** Where a round of review goes.
 *
 *  As a `prompt` frame and not as keystrokes, because they are different acts and the far end
 *  knows the difference: keys are bytes a keyboard made, and a prompt is a whole thing the
 *  person finished writing, which the session guarantees the submit for. A round sent as
 *  keystrokes would arrive as a half-typed line sitting in the agent's composer looking sent.
 *
 *  The frame is the painter's own wire, encoded by the painter's own `encode`, so the round
 *  and the keypress beside it are one message format and not two to keep right. */
export function sending(post: Posts, about: string, leave: () => void = NOTHING): OverlayHost {
  return {
    deliver: async (prompts, end): Promise<boolean> => {
      const reply = await post(encode({ kind: "prompt", text: noteOf(prompts, about, end) }));
      return reply.status === LANDED;
    },
    end: leave,
  };
}
