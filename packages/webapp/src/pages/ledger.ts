/** What the day bought, what it is taking, and what bought nothing.
 *
 *  The board says what is happening and the tree says what there is to do; neither adds
 *  them up. That is three questions and they are asked together, because two of them are
 *  only readable against the third: a hundred thousand tokens is a bargain or a disaster
 *  depending on whether anything landed, and a failed attempt is the price of learning
 *  something or money set on fire depending on how many there were. So one page, three
 *  sections, in that order.
 *
 *  Waste is named rather than totalled. A page saying "39k bought nothing" hands a reader a
 *  number to wince at and nothing to do; the same page saying which objective, in what
 *  state, for whose stated reason, hands them the thing to go and look at. What counts as
 *  waste is the record's own word and never this page's inference — the board's `failed`
 *  box is the runner saying an attempt bought nothing, while a `running` one has not bought
 *  anything *yet*, which is a different sentence and is counted in the middle section.
 *
 *  It is served from the board and from nothing else. `@wecode/core` exports no reading of
 *  the `ledger` table and none of an assignment's `spent`, so a page that wanted the day cut
 *  at midnight would need a reading of its own in `bin.ts` — and this page is discovered,
 *  which means `bin.ts` does not know it exists. What the board does carry is the whole of
 *  what is open: the stories that are delivered and not yet merged, the attempts that are
 *  running with their spend in the row, and the tasks the runner has failed. That is the
 *  standing account rather than a calendar day, and the page says so in its own words
 *  instead of claiming a boundary it cannot prove. */
import type { Board, Row } from "@wecode/core";
import { html, type Page, type Reply } from "../server.js";
import { escape } from "./board.js";
import { document, shelled } from "./shell.js";

/** The reading this page is served from. Not the record: the record is the shape of the
 *  work and holds no spend, and the board is the one reading that does. */
export const READS = "board";

/** What a running row cost, read back off the row rather than counted a second time here.
 *  `board()` writes a running attempt's detail as `name · 12m · 34k`; a second count is a
 *  second opinion about the same spend, and the two disagree the first time either moves. */
export interface Spend {
  readonly worker: string;
  readonly minutes: number;
  /** Thousands of tokens, as the board already truncated them. */
  readonly thousands: number;
}

const number = (said: string | undefined, unit: string): number => {
  const at = new RegExp(`^(\\d+)${unit}$`).exec(said ?? "");
  return at === null ? 0 : Number(at[1]);
};

/** The spend a running row is carrying. A row whose detail says something else is a row
 *  nobody can price — it still appears, at nothing, because an attempt the page dropped is
 *  an attempt the reader is not told about. */
export function spend(detail: string): Spend {
  const [worker, age, tokens] = detail.split(" · ");
  return { worker: worker ?? "?", minutes: number(age, "m"), thousands: number(tokens, "k") };
}

/** Minutes as a person says them. Hours appear only when there are hours: `3h 12m` on a long
 *  day, `12m` on a short one, and never `0h 12m`. */
export function span(minutes: number): string {
  const total = Math.max(0, Math.trunc(minutes));
  const hours = Math.trunc(total / 60);
  return hours === 0 ? `${total}m` : `${hours}h ${total % 60}m`;
}

/** The plural of a count, with the count on the front. `1 attempt`, `0 attempts`. */
const many = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The arithmetic, once. Every number the page says is here, so the page cannot say two that
 *  disagree — a total and a list that do not add up is the one defect a ledger cannot
 *  survive. */
export interface Reckoning {
  /** Delivered stories: what the work bought, waiting on nothing but a merge. */
  readonly lands: readonly Row[];
  /** Delivered stories whose branch will not merge — bought, and not yet banked. */
  readonly stuck: readonly Row[];
  readonly running: readonly Row[];
  readonly waste: readonly Row[];
  readonly thousands: number;
  readonly minutes: number;
}

export function reckon(board: Board): Reckoning {
  const stuck = new Set(board.unmergeable.map((r) => r.id));
  const spends = board.running.map((r) => spend(r.detail));
  const sum = (of: (s: Spend) => number): number => spends.reduce((n, s) => n + of(s), 0);
  return {
    lands: board.delivered.filter((r) => !stuck.has(r.id)),
    stuck: board.unmergeable,
    running: board.running,
    waste: board.failed,
    thousands: sum((s) => s.thousands),
    minutes: sum((s) => s.minutes),
  };
}

const section = (name: string, title: string, body: string): string =>
  `<section class="ledger" id="${name}"><h2>${escape(title)}</h2>${body}</section>`;

const empty = (said: string): string => `<p class="empty">${escape(said)}</p>`;

const row = (id: string, code: string, what: string, sum: string, why = ""): string =>
  `<li id="${escape(id)}"><span class="code">${escape(code)}</span>` +
  `<span class="what">${escape(what)}</span>` +
  `<span class="sum">${escape(sum)}</span>` +
  (why === "" ? "" : `<span class="why">${escape(why)}</span>`) +
  `</li>`;

/** What it bought. Each land named by the row it is, so the reader can go and read it — and
 *  a land that will not merge is said in the same list, marked, rather than left out of the
 *  count: it was bought, and somebody has to go and bank it. */
function bought(r: Reckoning): string {
  const all = [...r.lands, ...r.stuck];
  if (all.length === 0) return empty("nothing is waiting to land");
  const rows = all
    .map((s) =>
      row(
        `land-${s.id}`,
        `story #${s.id}`,
        s.what,
        r.stuck.includes(s) ? "stuck" : "delivered",
        r.stuck.includes(s) ? s.detail : "",
      ),
    )
    .join("");
  const stuck = r.stuck.length === 0 ? "" : `, ${r.stuck.length} not merging`;
  return `<p class="total">${escape(many(all.length, "land"))}${escape(stuck)}</p><ol>${rows}</ol>`;
}

/** What it is taking: how many seats are spending, and what they have spent between them.
 *  One line, because the reader who wants the goes one at a time wants the section below. */
function taking(r: Reckoning): string {
  if (r.running.length === 0) return empty("nothing is being attempted");
  const each = Math.trunc(r.thousands / r.running.length);
  return (
    `<p class="total">${escape(many(r.running.length, "attempt"))} · ` +
    `${escape(`${r.thousands}k`)} · ${escape(span(r.minutes))}` +
    `<span class="apiece">${escape(`${each}k`)} apiece</span></p>`
  );
}

/** The waste, named. Not a number: the failures themselves, each with the objective it was
 *  on and the reason the record kept for it. */
function nothing(r: Reckoning): string {
  if (r.waste.length === 0) return empty("nothing has been spent for nothing");
  const rows = r.waste
    .map((t) => row(`waste-${t.id}`, `task #${t.id}`, t.what, t.state, t.detail))
    .join("");
  return `<p class="total">${escape(many(r.waste.length, "attempt"))} bought nothing</p><ol>${rows}</ol>`;
}

/** What the page says: three sections, and nothing around them. The frame and the look are
 *  the shell's, so this file writes no document and no stylesheet — it writes what goes
 *  inside one. */
export function ledgerSections(board: Board): string {
  const r = reckon(board);
  return (
    section("lands", "what it bought", bought(r)) +
    section("cost", "what it is taking", taking(r)) +
    section("waste", "what bought nothing", nothing(r))
  );
}

/** The whole document: the account, in the shell design.yaml declares. */
export const ledgerPage = (board: Board): Reply => html(document(ledgerSections(board)));

/** The page, bound to a way of reading the board.
 *
 *  Read fresh on every request, for the reason the board is: an account served from a
 *  snapshot taken at boot is an account of whenever the process started. */
export const ledgerAt = (board: () => Board): Page => shelled(() => ledgerSections(board()));
