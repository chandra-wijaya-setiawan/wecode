/** The session store: everything the painter remembers, and no socket and no disk.
 *
 *  A session is one artefact under review. The person reading it in a browser queues
 *  prompts against it; an agent waits on `poll` until one arrives. Both sides are here as
 *  plain functions over a store, so what the painter decides — which session an artefact
 *  resumes, when a waiter wakes, what an ended session still owes — is provable without a
 *  port and without a file.
 *
 *  The artefact's text is passed in rather than read: the store keeps the body it was
 *  given and `reload` replaces it. Reading a file is the caller's, which is what keeps this
 *  module a store rather than half a server. */

/** One thing the person sent from the browser. `tag` is what kind of feedback it is —
 *  the playbooks call one "whiteboard" — and is absent on a plain prompt. */
export interface Prompt {
  readonly id: number;
  readonly text: string;
  readonly tag?: string;
}

/** A session, as anyone outside this module may read it. `revision` is bumped by `reload`
 *  and by nothing else: it is how a browser knows the artefact under it changed. */
export interface Session {
  readonly id: string;
  readonly artefact: string;
  readonly body: string;
  readonly revision: number;
  readonly status: "open" | "ended";
  readonly pending: readonly Prompt[];
}

/** What a waiter woke up for. `prompts` is never empty on a `feedback`; on an `ended` it
 *  carries whatever the person sent with `Send & End`, so a final prompt is delivered once
 *  rather than lost with the session. */
export interface Woken {
  readonly kind: "feedback" | "ended";
  readonly prompts: readonly Prompt[];
}

interface Held {
  id: string;
  artefact: string;
  body: string;
  revision: number;
  status: "open" | "ended";
  pending: Prompt[];
  waiters: ((woken: Woken) => void)[];
  nextPrompt: number;
}

/** Every session, by id. A store is handed about explicitly so two of them never share
 *  state — a test makes its own, and the process that serves makes one. */
export interface Store {
  readonly sessions: Map<string, Held>;
}

export const store = (): Store => ({ sessions: new Map() });

export class SessionError extends Error {}

/** The id of the session an artefact belongs to. One artefact is one session forever, so
 *  the id is derived from the path rather than handed out: opening the same file twice
 *  resumes the review that is already there instead of starting a second one beside it. */
export function idOf(artefact: string): string {
  let hash = 0x811c9dc5;
  for (const ch of artefact) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const held = (store: Store, id: string): Held => {
  const session = store.sessions.get(id);
  if (session === undefined) throw new SessionError(`no session ${id}`);
  return session;
};

const read = (session: Held): Session => ({
  id: session.id,
  artefact: session.artefact,
  body: session.body,
  revision: session.revision,
  status: session.status,
  pending: [...session.pending],
});

/** Look a session up without opening one. */
export const sessionOf = (store: Store, id: string): Session | undefined => {
  const session = store.sessions.get(id);
  return session === undefined ? undefined : read(session);
};

/** Open an artefact for review, or resume the one that is already open for it — in which
 *  case the body is refreshed the way `reload` refreshes it, because the caller has just
 *  read the file and the person is about to look at it.
 *
 *  A session the person ended is not reopened by a passing `open`: they closed the review,
 *  and an agent that reopens it uninvited has taken a decision that was theirs. `reopen`
 *  is how a caller says the person asked. */
export function open(
  store: Store,
  artefact: string,
  body: string,
  options: { readonly reopen?: boolean } = {},
): Session {
  const id = idOf(artefact);
  const existing = store.sessions.get(id);
  if (existing === undefined) {
    const fresh: Held = {
      id,
      artefact,
      body,
      revision: 1,
      status: "open",
      pending: [],
      waiters: [],
      nextPrompt: 1,
    };
    store.sessions.set(id, fresh);
    return read(fresh);
  }
  if (existing.status === "ended" && options.reopen !== true) {
    throw new SessionError(
      `session ${id} was ended by the person reviewing ${artefact} — reopen it only when they ask`,
    );
  }
  existing.status = "open";
  return read(reloaded(existing, body));
}

const reloaded = (session: Held, body: string): Held => {
  if (body !== session.body) {
    session.body = body;
    session.revision += 1;
  }
  return session;
};

/** The artefact again, as it now reads on disk. The revision moves only when the text
 *  actually changed, so a browser polling it is not told to redraw for nothing. */
export const reload = (store: Store, id: string, body: string): Session =>
  read(reloaded(held(store, id), body));

/** What the person has sent that nobody has taken yet. Reading is not taking: `prompts`
 *  leaves the queue alone so a browser can show the backlog, and only `poll` drains it. */
export const prompts = (store: Store, id: string): readonly Prompt[] => [...held(store, id).pending];

/** The person sends one prompt. It wakes the waiter that has been waiting longest; with
 *  nobody waiting it queues, and the next `poll` gets it immediately — queued feedback is
 *  never lost, which is the whole reason a killed poll is safe to re-run. */
export function reply(store: Store, id: string, text: string, tag?: string): Prompt {
  const session = held(store, id);
  if (session.status === "ended") throw new SessionError(`session ${id} has ended`);
  const prompt: Prompt =
    tag === undefined
      ? { id: session.nextPrompt, text }
      : { id: session.nextPrompt, text, tag };
  session.nextPrompt += 1;
  session.pending.push(prompt);
  wake(session, "feedback");
  return prompt;
}

/** Hand every queued prompt to one waiter, if there is one. Exactly one: two agents
 *  waiting on the same session must not each act on the same feedback. */
function wake(session: Held, kind: Woken["kind"]): void {
  const waiter = session.waiters.shift();
  if (waiter === undefined) return;
  const taken = session.pending;
  session.pending = [];
  waiter({ kind, prompts: taken });
}

/** Wait for the person. Resolves at once when something is already queued or the session
 *  has already ended, so a caller never has to ask whether it missed anything before
 *  waiting. */
export function poll(store: Store, id: string): Promise<Woken> {
  const session = held(store, id);
  if (session.pending.length > 0 || session.status === "ended") {
    const taken = session.pending;
    session.pending = [];
    return Promise.resolve({
      kind: session.status === "ended" ? "ended" : "feedback",
      prompts: taken,
    });
  }
  return new Promise<Woken>((resolve) => session.waiters.push(resolve));
}

/** End the review. Every waiter is woken rather than one — the session is over, and a
 *  waiter left holding a promise that can no longer resolve is a hung agent. The first of
 *  them is given the final prompts; the rest are told it ended. */
export function end(store: Store, id: string): Session {
  const session = held(store, id);
  session.status = "ended";
  while (session.waiters.length > 0) wake(session, "ended");
  return read(session);
}
