#!/usr/bin/env bash
# wecode telegram answer hook: tell the chat a decision was recorded.
#
# Two things, and no more. The callback answer stops the spinner. The edit turns the
# original message from an offer into a record — buttons gone, caption stating what was
# decided. A third message repeating the outcome was noise: the message you tapped is
# the one you look at.
#
# printf builds the text: %0A inside --data-urlencode has its percent escaped and
# arrives as two literal characters. That bug has now been fixed twice.
set -uo pipefail

TOKEN=$(cat ~/.wecode/telegram-token)
CHAT=6249211484
API="https://api.telegram.org/bot$TOKEN"
SAID=${WECODE_TELEGRAM_ANSWER:-decided}

curl -sS -m 10 -d callback_query_id="$WECODE_TELEGRAM_CALLBACK" \
  --data-urlencode "text=recorded" "$API/answerCallbackQuery" >/dev/null 2>&1

task=""; mid=""
for f in ~/.wecode/msg/*; do
  [ -f "$f" ] || continue
  name=$(basename "$f")
  case "$SAID" in *"$name"*) task="$name"; mid=$(cat "$f"); break ;; esac
done
[ -n "$mid" ] || exit 0

BODY=$(printf '<b>%s</b>\n\nrecorded: %s' "$task" "$SAID")
# No reply_markup on the edit: omitting it removes the keyboard, so the message stops
# offering a decision already made.
curl -sS -m 15 -X POST "$API/editMessageCaption" \
  -d chat_id="$CHAT" -d message_id="$mid" -d parse_mode=HTML \
  --data-urlencode "caption=$BODY" >/dev/null 2>&1
curl -sS -m 15 -X POST "$API/editMessageText" \
  -d chat_id="$CHAT" -d message_id="$mid" -d parse_mode=HTML \
  --data-urlencode "text=$BODY" >/dev/null 2>&1
rm -f "$HOME/.wecode/msg/$task"
