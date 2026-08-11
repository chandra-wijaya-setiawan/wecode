#!/usr/bin/env bash
# Seeds the cws workspace with wecode's own migration plan.
#
# This is the self-hosting check. Every command below is one an operator types, so
# if the plan cannot be expressed here it cannot be expressed at all — and twice
# already it could not: the admission gate refused two of these objectives for
# naming more than one outcome, which is the gate doing its job on its own author.
#
# Idempotent only in the sense that re-running it on a seeded workspace will report
# duplicate ids and change nothing.
set -euo pipefail

W="${WECODE:-./target/release/wecode} --org ${ORG:-cws}"

$W project add migration "replace the intent tree with a two-level plan" \
  --repo wecode \
  --measure-cmd "cargo test --workspace" \
  --measure-cmd "cargo clippy --all-targets -- -D warnings" \
  --tokens 800000 --wall 28800

# The two independent tasks first. Everything else waits on one of them, which is
# why the dependency graph is worth having rather than a checklist.
$W task add store-sqlite --project migration \
  "move the store from append-only logs to SQLite" \
  --accept-cmd "cargo test -p wecode-store" \
  --write "crates/wecode-store/**" --tokens 120000 --wall 5400

$W task add org-toml --project migration \
  "parse company.toml with serde" \
  --accept-cmd "cargo test -p wecode-org" \
  --write "crates/wecode-org/**" --tokens 90000 --wall 3600

# The join: the workspace does not build until this lands.
$W task add cli-commands --project migration \
  "rewrite the CLI onto the two-level plan" \
  --after store-sqlite --after org-toml \
  --accept-cmd "cargo test -p wecode-cli" \
  --write "crates/wecode-cli/src/**" --tokens 200000 --wall 7200

$W task add cli-board --project migration \
  "render the board from computed plan health" \
  --after cli-commands \
  --accept-cmd "cargo test -p wecode-cli --bin wecode" \
  --write "crates/wecode-cli/src/board.rs" \
  --write "crates/wecode-cli/src/tui.rs" --tokens 90000 --wall 3600

$W task add integration-tests --project migration \
  "cover the new command surface end to end" \
  --after cli-commands \
  --accept-cmd "cargo test -p wecode-cli --test cli" \
  --write "crates/wecode-cli/tests/**" --tokens 80000 --wall 3600

$W task add seed-cws --project migration \
  "recreate the cws workspace in the new format" \
  --after cli-commands \
  --accept-cmd "./target/release/wecode --org cws tree" \
  --write "scripts/**" --tokens 40000 --wall 1800

$W task add docs-refresh --project migration \
  "correct architecture.md to the shipped design" \
  --after cli-board --after seed-cws \
  --accept-cmd "test -f docs/architecture.md" \
  --write "docs/**" --write "README.md" --tokens 70000 --wall 3600

# Assigning is what admits work to the queue: a fresh task is a draft, and
# `wecode ready` deliberately shows nothing until a post owns it.
for t in store-sqlite org-toml cli-commands cli-board integration-tests seed-cws docs-refresh; do
  $W assign "$t" --to impl
done

$W tree
$W ready
