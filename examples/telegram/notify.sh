#!/usr/bin/env bash
# wecode notify hook: tell a person a task is waiting, with enough to decide, in one
# message they can answer.
#
# A script rather than a line in company.toml because it outgrew one — a hook that
# sends a document, checks a response and branches on what a task produced is code,
# and belongs in a file that can be read.
#
# The document carries the buttons rather than trailing after them. Telegram's
# sendDocument takes a caption and a reply_markup, so the thing being decided and the
# way to decide it are the same message: no scrolling up to check which of two
# notifications the buttons belonged to.
#
# wecode passes everything in the environment; nothing is interpolated into a command
# line, so a title full of quotes is just a title.
#
# --form-string rather than -F for the text parts: -F reads a value beginning with `<`
# or `@` as a filename, and an HTML caption begins with `<b>`. curl then reports a
# missing file rather than a bad option, which is a long way from the cause.
set -uo pipefail

TOKEN=$(cat ~/.wecode/telegram-token)
CHAT=6249211484
API="https://api.telegram.org/bot$TOKEN"

CAPTION=$(printf '<b>#%s %s</b> — %s\n%s\n\n%s file(s) changed' \
  "$WECODE_TASK_NUMBER" "$WECODE_TASK" "$WECODE_WAITING_FOR" \
  "$WECODE_TASK_TITLE" "${WECODE_CHANGED_COUNT:-0}")

# callback_data carries the short number: Telegram caps it at 64 bytes and a long task
# id would fail at the tap rather than at the send.
KEYS="{\"inline_keyboard\":[[
  {\"text\":\"Approve\",\"callback_data\":\"approve #$WECODE_TASK_NUMBER\"},
  {\"text\":\"Hold\",\"callback_data\":\"no #$WECODE_TASK_NUMBER\"}]]}"

# What the task produced, so the decision can be made from the phone rather than from a
# terminal. A design is the case that matters: approving one you have not read is the
# rubber-stamp the gate exists to prevent.
doc=""
if [ -n "${WECODE_WORKTREE:-}" ] && [ -n "${WECODE_CHANGED_FILES:-}" ]; then
  while IFS= read -r f; do
    case "$f" in
      *.md) [ -f "$WECODE_WORKTREE/$f" ] && { doc="$WECODE_WORKTREE/$f"; break; } ;;
    esac
  done <<< "$WECODE_CHANGED_FILES"
fi

if [ -n "$doc" ]; then
  resp=$(curl -sS -m 60 -X POST "$API/sendDocument" \
    -F chat_id="$CHAT" -F parse_mode=HTML \
    -F document=@"$doc" \
    --form-string caption="$CAPTION" \
    --form-string reply_markup="$KEYS")
else
  resp=$(curl -sS -m 10 -X POST "$API/sendMessage" \
    -d chat_id="$CHAT" -d parse_mode=HTML \
    --data-urlencode "text=$CAPTION" \
    --data-urlencode "reply_markup=$KEYS")
fi

case "$resp" in
  *'"ok":true'*) ;;
  *) echo "telegram refused the notification: $resp" >&2; exit 1 ;;
esac

# Remember which message carried this decision, so answering it can edit the message
# rather than leaving a live-looking button on a question already settled. wecode hands
# the answer hook a callback id and the outcome, not the message it came from — this is
# how the two are joined until it does.
mkdir -p ~/.wecode/msg
mid=$(printf '%s' "$resp" | sed -n 's/.*"message_id":\([0-9]*\).*/\1/p' | head -1)
printf '%s %s' "$mid" "$WECODE_TASK_NUMBER" > ~/.wecode/msg/"$WECODE_TASK"
