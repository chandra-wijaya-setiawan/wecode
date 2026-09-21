/** Tokens and seconds — what an assignment was given, and what it has used. The same two
 *  numbers both ways: a spend is only readable against the allowance it is a spend of. */
export interface Spend {
  readonly tokens: number;
  readonly seconds: number;
}

const NOTHING: Spend = { tokens: 0, seconds: 0 };

/** `budget` and `spent` are JSON in a text column. Malformed JSON reads as nothing, the way
 *  `thousands` already reads it: a board that throws on one bad row is no board at all. */
export const spend = (raw: string | null): Spend => {
  let v: { tokens?: unknown; seconds?: unknown } | null = null;
  try {
    v = raw === null ? null : (JSON.parse(raw) as { tokens?: unknown; seconds?: unknown });
  } catch {
    v = null;
  }
  if (v === null || typeof v !== "object") return NOTHING;
  return { tokens: typeof v.tokens === "number" ? v.tokens : 0, seconds: typeof v.seconds === "number" ? v.seconds : 0 };
};

/** What the record says about how one assignment is going: the half a list of four columns
 *  has no room for — the allowance, the spend against it, and when the runner last
 *  reported. The board's row says the rest, so neither restates the other and the two
 *  cannot disagree. */
export interface AssignmentFacts {
  readonly worktree: string;
  readonly budget: Spend;
  readonly spent: Spend;
  /** When the runner last wrote to the record, or null when it never has — a pending
   *  assignment has been dispatched and has said nothing yet. */
  readonly beat: string | null;
  /** Milliseconds since that beat. Null when there has been none, or when the timestamp is
   *  one nothing can parse: an unreadable beat is no evidence of life. */
  readonly silent: number | null;
  /** Whether the record still expects the assignment to be working. A finished one is not
   *  silent, it is over, and a page that called it silent would read as an alarm. */
  readonly open: boolean;
}
