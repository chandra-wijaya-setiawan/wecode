# harness-contract — any coding agent is a seat

The owner, 24 Aug: "we want pidev, hermes, opencode as coding harnesses, or any
other; wecode must not be tied to a few harnesses — that is what A2A is
fundamentally for."

## What exists

- Execution is already modeled as an A2A task; `wecode start --json` emits it.
- Agent templates already carry a `protocol` field — one value ("claude-stream-json")
  and unfinished.
- The envelope-out / result.json-back / judged-on-the-diff convention is already
  harness-agnostic.

## The three couplings to break, each becoming template config

1. **Grant → flag dialect.** `{{tools}}` renders claude's `--allowedTools Bash(...)`
   syntax. Becomes per-template: a `tools_style` (claude | none | ...) — a harness
   with no allow-list flag simply gets none, and the scope check + deny rules remain
   the enforcement (they always were the real gate; the flag is a courtesy).
2. **Stream protocol.** `claude-stream-json` metering/tail parsing becomes one of:
   `claude-stream-json` | `plain` (lines; no token metering — spend rows show wall
   only, honestly NULL not zero) | `a2a` (the harness consumes the A2A task JSON on
   stdin and emits A2A status/artifact events — the native citizen path).
3. **Model naming.** `--model sonnet` is claude's dialect; the intelligence→model
   mapping already lives on the post; the template renders it with its own flag or
   not at all.

## Acceptance shaped for the point

A company.toml gaining
    [[agents]] name = "opencode"  command = "opencode run --task {{envelope}}"
    protocol = "plain"
dispatches a task to it with zero wecode code changes. Docs show worked templates
for opencode, pidev, hermes as config examples (not integrations — the whole point
is there is nothing to integrate).

## Not doing
- No harness SDKs, no per-harness adapters in the crate. Config renders; the ledger
  judges artifacts; A2A is the only wire with semantics.
