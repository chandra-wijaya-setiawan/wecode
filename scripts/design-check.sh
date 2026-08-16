#!/usr/bin/env bash
# Fails when a design document is a file rather than a decision.
#
# The design gate's acceptance command is `test -f docs/wecode/<task>/design.md`, and
# that is the whole of it: `: > design.md` passes it. This project's own playbook says
# acceptance must be able to fail if the task did nothing, and the design gate is the
# one place in it where a task satisfies acceptance by touching the filesystem.
#
# What a script can check here is form. Whether a decision is a *good* one is what the
# signature on `approve design` is for, and nothing here takes that over. The narrower
# thing this does is make sure the signature is being asked about a document rather
# than about a filename — a person approving an empty file has approved nothing and
# has left a ledger row saying they did.
#
# So, no rubric. A rubric — a Decision heading, an Alternatives heading — is satisfied
# by adding headings, and the designs in this tree are shaped differently from each
# other anyway. What is checked instead is the short list of properties a stub lacks
# and a document does not: it says what it is about, it has parts, it argues in prose,
# and it is not the document next door with a new title.
#
# The floors follow the tree rather than leading it, the same way `.max-lines` does and
# for the reason turned around. Acceptance reads what is committed rather than the
# diff, so a floor above the thinnest document already in the tree fails tasks that are
# not allowed to thicken it. They come up in the commit that thickens the thinnest
# document, never in the one before it — and the thinnest is printed on the way past,
# because a ratchet nobody can see is a ratchet nobody turns.
#
# Two forms, and the difference between them is which work can fail:
#
#   design-check.sh <path>...   one document — the design gate, run by the task that
#                               wrote it, so only its own work can fail it
#   design-check.sh             every design in the tree — the sweep, and the form
#                               that may only ever ratchet
#
# It is wired to nothing yet, which by docs/design/method.md's own account means it is
# not a check yet either — the ratchet shipped that way too and sat idle until a line
# in `accept` made it real. The line here is
#
#   [feature.design]
#   accept = ["bash scripts/design-check.sh docs/wecode/{{task}}/design.md"]
#
# in `.wecode/playbook.toml`, in place of the `test -f`. This task could write only
# this file, so somebody with the playbook in scope has to add it.
set -euo pipefail

# Paths are repo-relative, arguments included, so that the line above means the same
# thing from whichever directory acceptance happens to run in.
cd "$(dirname "$0")/.."

# The thinnest design committed today is 144 words across 3 sections — a drill, and
# complete at that length. The floors sit under it.
#
# Words are prose: headings and fenced blocks do not count toward them. The schema a
# design is about is not the argument for it, and a design that is a pasted TOML block
# under a one-line preamble is the failure this is looking for rather than a pass.
#
# The numbers live here rather than in a sibling config because there are two of them
# and the argument for them is the paragraph they are sitting under. `.max-lines` earns
# its own file by being read by something other than its script.
MIN_WORDS=100
MIN_SECTIONS=2

# Body text, normalised: runs of whitespace flattened, blank lines dropped. Two designs
# with the same checksum are the same document however they are wrapped.
#
# This catches a copy and nothing subtler — changing one word defeats it. It is here
# because pasting the design next door is the cheapest way past a word floor, not
# because it is a general check for saying nothing new.
body_sum() {
  sed -e 's/[[:space:]][[:space:]]*/ /g' -e 's/^ //' -e 's/ $//' -e '/^$/d' "$1" |
    cksum | cut -d' ' -f1
}

# words, sections, has-title, has-stub-line — one pass, so the fence state is tracked
# once. `next` on every heading is what keeps section titles out of the word count.
measure() {
  awk '
    /^```/                { fence = !fence; next }
    fence                 { next }
    /^[[:space:]]*$/      { next }
    !seen                 { seen = 1; if ($0 ~ /^# [^[:space:]]/) title = 1 }
    /^## /                { sections++; next }
    /^#/                  { next }
    /^[[:space:]]*(TODO|TBD|FIXME|XXX|\?\?\?|\.\.\.)[[:space:].:!-]*$/ { stub = 1 }
                          { words += NF }
    END { printf "%d %d %d %d\n", words, sections, title + 0, stub + 0 }
  ' "$1"
}

# Every design in the tree, with its checksum, whichever form we were called in: the
# duplicate check needs the neighbours even when only one document was named.
all_paths=()
all_sums=()
if [ -d docs/wecode ]; then
  while IFS= read -r p; do
    all_paths+=("$p")
    all_sums+=("$(body_sum "$p")")
  done < <(find docs/wecode -name design.md | sort)
fi

if [ "$#" -gt 0 ]; then
  targets=("$@")
elif [ "${#all_paths[@]}" -eq 0 ]; then
  echo "design-check: no design documents under docs/wecode/"
  exit 0
else
  targets=("${all_paths[@]}")
fi

fail=0
thinnest=-1
thinnest_f='(none)'
fewest=-1
fewest_f='(none)'

report() {
  printf '  %-46s %s\n' "$1" "$2"
  fail=1
}

for f in "${targets[@]}"; do
  # `./docs/…` and `docs/…` are the same document, and the duplicate check below
  # compares paths to decide what counts as a neighbour.
  f=${f#./}

  # The old gate, kept: it was never wrong, only alone.
  if [ ! -f "$f" ]; then
    report "$f" "does not exist"
    continue
  fi

  read -r words sections title stub < <(measure "$f")

  # Said on its own rather than as three complaints, because it is the case the whole
  # script is here for: `test -f` passed on exactly this file.
  if [ "$words" -eq 0 ]; then
    report "$f" "has no prose in it at all"
    continue
  fi

  [ "$title" -eq 1 ] ||
    report "$f" "no title — the first line should be \`# what is being decided\`"
  [ "$sections" -ge "$MIN_SECTIONS" ] ||
    report "$f" "$sections of $MIN_SECTIONS sections — an argument has parts"
  [ "$words" -ge "$MIN_WORDS" ] ||
    report "$f" "$words of $MIN_WORDS words of prose"
  [ "$stub" -eq 0 ] ||
    report "$f" "a line that is a placeholder — decide it or drop the section"

  sum=$(body_sum "$f")
  for i in "${!all_paths[@]}"; do
    if [ "${all_paths[$i]}" != "$f" ] && [ "${all_sums[$i]}" = "$sum" ]; then
      report "$f" "is a copy of ${all_paths[$i]}"
    fi
  done

  # Recorded whether or not anything failed: these are the numbers the floors may come
  # up to, and knowing them is the difference between raising the floor in one edit and
  # reading seventeen documents to find out whether it can move.
  if [ "$thinnest" -lt 0 ] || [ "$words" -lt "$thinnest" ]; then
    thinnest=$words
    thinnest_f=$f
  fi
  if [ "$fewest" -lt 0 ] || [ "$sections" -lt "$fewest" ]; then
    fewest=$sections
    fewest_f=$f
  fi
done

if [ "$fail" -ne 0 ]; then
  echo
  echo "  A design is the whole handoff. What the next task knows about this decision it"
  echo "  knows from this file — there is no other channel, which is the argument in"
  echo "  docs/design/method.md for writing it down at all. Say what is being decided,"
  echo "  what it was decided against, and what would show it was decided wrong."
  echo
  echo "  A document you did not write broke this? Then the floor was raised in front of"
  echo "  a thin design rather than behind one. Putting it back is the fix, and it is not"
  echo "  this task's."
  exit 1
fi

printf '  %-4s documents   thinnest %5s words  %s   floor allows %s\n' \
  "${#targets[@]}" "$thinnest" "$thinnest_f" "$((thinnest / 100 * 100))"
printf '  %-4s             fewest   %5s sects  %s   floor allows %s\n' \
  "" "$fewest" "$fewest_f" "$((fewest - 1))"
