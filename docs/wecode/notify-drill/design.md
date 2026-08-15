# notification drill — design

A throwaway task whose only purpose is to exercise the approval path end to end:
notification, document, decision, and whatever record the decision leaves.

## What is being tested

1. A `design` task reaching `needs-approval` fires the notify hook exactly once.
2. The hook sends **one** message: this document, with the decision on it.
3. A reply — typed `approve #N` or a tap — resolves to the chief seat and signs.
4. The ledger records it as `via telegram`, distinguishable from a terminal signature.

## What is known to be missing

Nothing tells the chat whether the decision took effect. A typed reply is its own
receipt because the words stay in the history; a tap leaves nothing at all. That is
`tap-receipt`, and this drill is what it should be measured against.

## Approve or hold — either answers the drill

Holding is as useful a result as approving: it proves the refusal path records
something too, rather than only the happy one.
