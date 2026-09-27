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
import { noteOf } from "./round.js";
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
  /** The adapter: the half that draws `view()` into a page and turns clicks back into calls. */
  adapter: `${REVIEW_AT}/overlay-dom.js`,
  /** What a round of notes is worded as, on the reviewer's side of the wire. */
  round: `${REVIEW_AT}/round.js`,
  /** The line that starts all of it. Without this the rest is a class nobody constructs. */
  boot: `${REVIEW_AT}/boot.js`,
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
    [REVIEW.adapter]: ours("overlay-dom"),
    [REVIEW.round]: ours("round"),
    [REVIEW.boot]: { status: 200, type: `${JS}; charset=utf-8`, body: bootScript() },
  };
  return Object.fromEntries(Object.entries(held).map(([at, reply]) => [at, () => reply]));
};


/** One of this surface's own browser modules, compiled.
 *
 *  `tsc` leaves the specifiers it was given, so the built file asks for
 *  `@wecode/painter/dist/client/overlay.css.js` — which a bundler would resolve and a browser
 *  cannot. It is rewritten to the path this surface already serves that same file on, so the
 *  browser gets one copy of it and not two. */
const ours = (module: string): Reply => ({
  status: 200,
  type: `${JS}; charset=utf-8`,
  body: readFileSync(fileURLToPath(new URL(`../../dist/browser/${module}.js`, import.meta.url)), "utf8")
    .replace(/"@wecode\/painter\/dist\/client\/overlay\.css\.js"/g, `"${REVIEW.look}"`)
    .replace(/"@wecode\/painter\/dist\/client\/([\w.-]+)\.js"/g, `"${REVIEW_AT}/$1.js"`),
});

/** The line that turns four served files into a working review loop.
 *
 *  Every other file here is a module the painter or this package already compiled; this is the
 *  only one written as text, because it is the only one whose job is to *start* things. It is
 *  the counterpart of `dock.ts`'s own script, and it is here rather than in the page for the
 *  same reason: what a reviewer's browser runs against a drawing is this surface's decision,
 *  not a decision of whichever agent wrote the drawing.
 *
 *  A frame is `JSON.stringify` — the painter's `encode` is exactly that — so the browser half
 *  needs none of the painter's wire code to speak to the dock's own route. */
const bootScript = (): string => `
import { Overlay } from "${REVIEW.overlay}";
import { mount, selectionOf } from "${REVIEW.adapter}";
import { noteOf } from "${REVIEW.round}";

const about = document.title || "this drawing";
const host = {
  deliver: async (prompts, end) => {
    const body = JSON.stringify({ kind: "prompt", text: noteOf(prompts, about, end) });
    try {
      const reply = await fetch(${JSON.stringify(NOTES_AT)}, { method: "POST", body });
      return reply.status === ${LANDED};
    } catch {
      return false;
    }
  },
  end: () => undefined,
};

const overlay = new Overlay(host);
const chrome = mount(overlay, document, {
  boxOf: (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const box = node.getBoundingClientRect();
    return { top: box.top, left: box.left, width: box.width, height: box.height };
  },
  viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  // Converted, not handed over raw: a DOM Selection is not the TextSelection the machine
  // reads, and selectionOf is the one place that knows the difference.
  selection: () => selectionOf(window.getSelection()),
});

// Picking starts on, because a drawing served at the annotating route is a drawing somebody
// opened to annotate. Arriving with it off would make the first click a navigation.
overlay.setPicking(true);
chrome.draw();
`;

// ─── a round, as words typed at a shell ─────────────────────────────────────────────

/** One line, whatever the reviewer typed.
 *
 *  A note written into the card's `<textarea>` carries newlines, and the far end submits a
 *  prompt by writing it followed by a return — so it flattens the newlines itself, or each
 *  one would submit early and turn one round into several half-rounds. Flattening here as
 *  well is not that guard repeated: it is what makes `noteOf` one line *by construction*, so
 *  the thing a test reads and the thing the shell receives are the same string. */
export { lineOf, noteOf } from "./round.js";

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
