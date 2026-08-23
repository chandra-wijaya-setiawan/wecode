# UX and AX — one set of requirements, two perceivers

The owner, 24 Aug: "UI/UX and AI/AX — agent interface, agent experience. The agent
should have the same level of understanding as the user, perceiving differently, but
with the same level of requirements. If a user wants to do action A, what does the
agent do to do the same A?"

## The principle

**Parity of affordance under one authority.** For every action a user can take, the
agent has a path to the same action — same semantics, same information in hand, same
gates on the way through. What differs is perception: the user gets pixels and keys,
the agent gets structured artifacts. Neither surface carries private state; both
render the same ledger. A capability that exists on one surface only is a bug with a
direction: human-only means agents re-derive or work blind; agent-only means humans
rubber-stamp what they cannot see.

## The parity question, made mechanical

Every feature spec answers one table — this is the enforceable form of "what should
the agent do to do A the same":

| Action | User does it via | Agent does it via | Same gate? |
|---|---|---|---|
| read a thread | tree UI, j/k | GET /threads/{id} (same fields the UI renders) | read-only both |
| search | search box | /search (same ranking, same snippets) | same |
| ask the mailbox | Ask box | A2A task → cited artifact | citation rule binds both |
| approve a merge | Telegram tap / CLI | (deliberately none — authority is a seat property, not a surface property) | — |

The last row is the boundary that keeps parity honest: parity of *capability*, never
parity of *authority*. Who may act is the Broker's question; HOW an actor acts once
permitted must be equally possible from either kind of hands.

## Evidence this was already being violated, one week's worth

- an agent permitted to write scripts/ could not chmod; permitted web/** could not
  npm install; permitted a split could not delete the original — user affordances
  its charter forgot to mirror
- a re-run after a withheld signature carried no reason: the user knew why, the
  agent could not perceive it — an information-parity failure that cost 3 attempts
- the #238 manual task reached a human with no steps: the envelope discipline built
  for agents had no human rendering — the same bug, reflected

## Where it binds

- specification.md gains an "Interfaces — parity" table (§ alongside ACs); a spec
  claiming a user-facing action with an empty agent column argues why, or fails review
- wemail: the UI and the A2A surface are the two renderings of one capability set
- wecode itself: the board (human) and the envelope/A2A (agent) are the same parity
  pair; every board fact should be queryable, every envelope fact renderable
