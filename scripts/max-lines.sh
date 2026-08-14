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
# Tests are counted separately. One integration suite covering a whole CLI is a
# different shape from a module, and pretending otherwise would only mean exempting it.
set -euo pipefail
cd "$(dirname "$0")/.."

LIMIT=$(grep -E '^src=' .max-lines | cut -d= -f2)
TEST_LIMIT=$(grep -E '^tests=' .max-lines | cut -d= -f2)
fail=0

while read -r n f; do
  [ "$f" = total ] && continue
  if [ "$n" -gt "$LIMIT" ]; then
    printf '  %5d  %-50s over %s\n' "$n" "$f" "$LIMIT"
    fail=1
  fi
done < <(find crates -path '*/src/*.rs' -print0 | xargs -0 wc -l | sort -rn)

while read -r n f; do
  [ "$f" = total ] && continue
  if [ "$n" -gt "$TEST_LIMIT" ]; then
    printf '  %5d  %-50s over %s (tests)\n' "$n" "$f" "$TEST_LIMIT"
    fail=1
  fi
done < <(find crates -path '*/tests/*.rs' -print0 | xargs -0 wc -l | sort -rn)

if [ "$fail" -ne 0 ]; then
  echo
  echo "  Split by capability, not by line count: move what belongs to a concept next to"
  echo "  the code that owns it. Lower the number in .max-lines when the tree allows."
  exit 1
fi
