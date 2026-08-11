#!/usr/bin/env bash
# wecode planning its own next steps, in wecode.
#
# Run once the project/task CLI exists. It doubles as a smoke test of the whole
# command surface: if this script runs clean, admission, the plan grammar, the
# dependency graph and scope-overlap checking all work end to end.
#
#   ./scripts/seed-cws.sh
#
# The dependency graph below is real, not illustrative:
#
#   store-sqlite ──┐
#                  ├──> cli-commands ──┬──> cli-board ──> docs-refresh
#   org-toml ──────┘                   ├──> integration-tests
#                                      └──> seed-cws
#
# store-sqlite and org-toml touch different crates, so they may run in parallel —
# and the scope-overlap check should permit exactly that. cli-commands and
# cli-board both write crates/wecode-cli/**, which would normally collide; the
# dependency between them is what makes it legal.
set -euo pipefail

W="${WECODE:-./wecode}"
ORG="${ORG:-cws}"
run() { echo "+ $*" >&2; "$W" --org "$ORG" "$@"; }

# ---------------------------------------------------------------- project ------

run project add migration \
    --repo wecode \
    "finish the two-level migration so the cws workspace works again" \
    --measure-cmd "cargo test --workspace" \
    --measure-cmd "cargo clippy --all-targets" \
    --tokens 600000 --wall 21600

# ------------------------------------------------------------------- tasks -----
# Two independent crates first. Disjoint scopes, so they may run at once.

run task add store-sqlite --project migration \
    "port the store to SQLite using the table names in docs/ERD.md" \
    --kind chore \
    --accept-cmd "cargo test -p wecode-store" \
    --write "crates/wecode-store/**" \
    --tokens 150000 --wall 5400 \
    --to impl

run task add org-toml --project migration \
    "replace the hand-rolled TOML subset with serde and the toml crate" \
    --kind chore \
    --accept-cmd "cargo test -p wecode-org" \
    --write "crates/wecode-org/**" \
    --tokens 120000 --wall 5400 \
    --to impl

# The CLI cannot compile until both of those land.

run task add cli-commands --project migration \
    "add project add, task add, tree, show and check commands" \
    --kind feature \
    --after store-sqlite --after org-toml \
    --accept-cmd "cargo build --workspace" \
    --write "crates/wecode-cli/src/main.rs" \
    --write "crates/wecode-cli/src/render.rs" \
    --tokens 150000 --wall 5400 \
    --to impl

# Shares crates/wecode-cli with cli-commands, which is legal only because it
# waits on it. Without the dependency this would be refused as a scope overlap.

run task add cli-board --project migration \
    "port the board and the cockpit onto Plan" \
    --kind feature \
    --after cli-commands \
    --accept-cmd "cargo test -p wecode-cli" \
    --write "crates/wecode-cli/src/board.rs" \
    --write "crates/wecode-cli/src/tui.rs" \
    --tokens 120000 --wall 5400 \
    --to impl

# Tests live in their own directory, so this runs alongside cli-board.

run task add integration-tests --project migration \
    "rewrite the end-to-end suite for the project and task commands" \
    --kind chore \
    --after cli-commands \
    --accept-cmd "cargo test --test cli" \
    --write "crates/wecode-cli/tests/**" \
    --tokens 100000 --wall 3600 \
    --to test

run task add seed-cws --project migration \
    "recreate the cws company profile and run this seed script" \
    --kind chore \
    --after cli-commands \
    --accept-cmd "test -f scripts/seed-cws.sh" \
    --write "scripts/**" \
    --tokens 30000 --wall 1800 \
    --to impl

# Docs last: three sections are now wrong — the four-level tree, tokio, and the
# event bus. Fixing them before the code settles would mean doing it twice.

run task add docs-refresh --project migration \
    "correct architecture.md for two levels, threads over async, and no event bus" \
    --kind docs \
    --after cli-board \
    --accept-cmd "test -f docs/ERD.md" \
    --write "docs/**" \
    --tokens 80000 --wall 3600 \
    --to impl

# ------------------------------------------------------------------ review -----

echo >&2
run tree
echo >&2
run ready
