#!/usr/bin/env bash
# Fails when a source file grows past the limit in `.max-lines`.
#
# A ratchet rather than a cliff. Eighteen of fifty-six files were over five hundred
# lines when this was written, so a limit anyone would call correct would have failed
# every task on the day it landed — and a gate that blocks all work gets deleted rather
# than satisfied. The number starts where it fails only the worst offenders, and each
# refactor lowers it.
#
# Why it is a check and not a convention: a line in a playbook is read by whoever
# happens to read it, and a file grows one commit at a time. See docs/design/method.md
# on what belongs in the machinery.
#
# It became a check late, and on purpose: it landed wired to nothing, because enforcing
# it that day would have failed every queued task for a debt none of them created. The
# splits it was written to argue for have since landed — render, org, plan — and
# `.wecode/playbook.toml` now runs this in `accept` on every kind that changes code.
#
# Being an acceptance command is what fixes which way the numbers may move. Acceptance
# runs against the whole worktree, while a task may only write inside its declared
# scope — so a limit under the tallest file fails tasks that are not allowed to fix it,
# and the limit tracks the tree from above: down in the commit that lands a split, never
# in the one before it.
#
# Tests are counted separately. One integration suite covering a whole CLI is a
# different shape from a module, and pretending otherwise would only mean exempting it.
#
# On the way past it prints the tallest file in each half and what the rule would allow,
# because "each refactor lowers it" does not happen on its own. `tests=6500` was right
# for a 6179-line `cli.rs`; that suite is now seven files and the largest is 1270, and
# the number sat where it was through all of it — a limit five thousand lines clear of
# anything could not have failed for any input the tree could offer.
set -euo pipefail
cd "$(dirname "$0")/.."

# A missing or non-numeric limit would otherwise arrive as a bash error in the middle
# of somebody's acceptance log, which is the wrong place to read it — and, since the
# comparison would be against an empty string, it would arrive on a passing task.
limit_of() {
  local v
  v=$(grep -E "^$1=" .max-lines | head -1 | cut -d= -f2 | tr -d '[:space:]') || true
  case $v in
    '' | *[!0-9]*)
      echo "max-lines: .max-lines needs a line \`$1=<number>\`" >&2
      exit 2
      ;;
  esac
  printf '%s' "$v"
}

# `limit_of` exits from a command substitution, which is a subshell — the `|| exit`
# is what carries that out here rather than leaving the limit empty.
LIMIT=$(limit_of src) || exit $?
TEST_LIMIT=$(limit_of tests) || exit $?

fail=0
summary=()

# One half of the tree: every file matching $2, against the limit $1, named $3 in what
# is printed. The tallest file is recorded whether or not anything failed — it is the
# number the limit may come down to, and knowing it is the difference between lowering
# the ratchet in one edit and auditing the tree to find out whether it can move.
check() {
  local limit="$1" path="$2" half="$3"
  local n f tallest=0 tallest_f='(no files)'
  while read -r n f; do
    [ "$f" = total ] && continue
    if [ "$n" -gt "$tallest" ]; then
      tallest=$n
      tallest_f=$f
    fi
    if [ "$n" -gt "$limit" ]; then
      printf '  %5d  %-50s over %s (%s)\n' "$n" "$f" "$limit" "$half"
      fail=1
    fi
  done < <(find crates -path "$path" -print0 | xargs -0 wc -l | sort -rn)
  summary+=("$(printf '  %-5s limit %5s   tallest %5s  %s   rule allows %s' \
    "$half" "$limit" "$tallest" "$tallest_f" "$(( (tallest + 99) / 100 * 100 ))")")
}

check "$LIMIT" '*/src/*.rs' src
check "$TEST_LIMIT" '*/tests/*.rs' tests

if [ "$fail" -ne 0 ]; then
  echo
  echo "  Split by capability, not by line count: move what belongs to a concept next to"
  echo "  the code that owns it. Lower the number in .max-lines when the tree allows."
  echo
  echo "  A file you did not touch broke this? Then the limit was lowered in front of a"
  echo "  split instead of behind one. Raising it back is the fix; it is not this task's."
  exit 1
fi

# Printed on the way past, because a ratchet nobody can see is a ratchet nobody turns.
printf '%s\n' "${summary[@]}"
