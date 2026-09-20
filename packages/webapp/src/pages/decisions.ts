/** Every approval waiting on a person, one card each.
 *
 *  The board shows the same rows in its `needs_human` box, as a line apiece. A line is
 *  enough to notice a question by and not enough to answer one: what a person needs in
 *  front of them is the question in full, the work it hangs on in the words that work
 *  already carries, and the answers the question will take. So this page is cards rather
 *  than rows — a card is the unit that fits a whole question — and it is the same rows,
 *  read through `waitingApprovals`, not a second opinion about what is waiting.
 *
 *  The page itself draws no control. `POST /answer` — `answer.ts` — is the surface's one
 *  verb and will answer a card's question, but what this document offers is still the
 *  question and the command that settles it: a card that grew a button would be a design
 *  change to `renderers.webapp`, which says the web surface has no bars, and design.yaml
 *  is where that is decided rather than here. So the verb exists, reachable by anything
 *  that can post, and the card goes on naming the command a reader has to hand.
 *
 *  The approvals arrive as a function, not as a database: what is proved here is the page,
 *  and where a workspace is, is `bin.ts`'s.
 *
 *  What a card looks like is not here either. The surface has one stylesheet and it is the
 *  shell's; this file writes the markup its rules are selected on. */
import type { Approval, Evidence } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** What the page says when nobody owes wecode an answer. A page that came back blank reads
 *  as a page that failed. */
const NOTHING_WAITING = "nothing is waiting on a person";

/** What is done about a card, said on the card. The id is what the command takes, so it is
 *  spelled out rather than described. */
const answerWith = (id: number): string => `wecode answer ${id} "<text>"`;

/** The work the question hangs on, in that work's own words and in the state it is in now
 *  — an approval read a week later is read against the work as it stands.
 *
 *  An objective deleted under a question already raised leaves no evidence, and the card
 *  says that plainly: a question with nothing behind it is a thing a person needs told,
 *  not a card that renders empty. */
function evidence(said: Evidence | null): string {
  if (said === null) return `<dd class="open">the work this asked about is gone</dd>`;
  return (
    `<dd>${escape(said.type)} #${said.id} · ${escape(said.statement)}` +
    ` · ${escape(said.state)}</dd>`
  );
}

/** The answers the question will take. No options is an open question, and any non-empty
 *  answer settles it — said as a sentence, because an empty list of choices reads as a
 *  question with no way to answer it. */
function options(offered: readonly string[] | null): string {
  if (offered === null || offered.length === 0) {
    return `<dd class="open">any answer settles it</dd>`;
  }
  return `<dd><ul>${offered.map((o) => `<li>${escape(o)}</li>`).join("")}</ul></dd>`;
}

/** One approval, whole. */
function card(approval: Approval): string {
  const asked = approval.question ?? "";
  return (
    `<article id="approval-${approval.id}">` +
    `<h2><span class="id">#${approval.id}</span>${escape(asked)}</h2>` +
    `<dl><dt>about</dt>${evidence(approval.evidence)}` +
    `<dt>answers</dt>${options(approval.options)}</dl>` +
    `<p class="how">${escape(answerWith(approval.id))}</p>` +
    `</article>`
  );
}

/** What the page says: its cards, and nothing around them. The frame is the shell's. */
export function decisionCards(approvals: readonly Approval[]): string {
  if (approvals.length === 0) return `<p class="empty">${NOTHING_WAITING}</p>`;
  return approvals.map(card).join("");
}

/** The whole document: the cards, in the shell design.yaml declares. */
export function decisionsPage(approvals: readonly Approval[]): Reply {
  return html(document(decisionCards(approvals)));
}

/** Which reading of the workspace this page is served from. What is waiting on a person is
 *  not a shape of the record, so it is asked for by name. See `discover.ts`. */
export const READS = "approvals";

/** The page, bound to a way of getting the approvals that are waiting now.
 *
 *  Read fresh on every request, for the reason the board is: a question answered on the
 *  command line is gone from the record the moment it is answered, and a page served from
 *  a snapshot would still be asking it. */
export const decisionsAt = (approvals: () => readonly Approval[]): Page =>
  shelled(() => decisionCards(approvals()));
