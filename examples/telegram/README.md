# Deciding from a phone

A working pair of hooks for `[notify] command` and `[telegram] answer`, and the
account-specific parts that have to be changed.

    cp notify.sh answer.sh ~/.wecode/
    chmod +x ~/.wecode/notify.sh ~/.wecode/answer.sh
    # then edit CHAT= in both, and put the bot token in ~/.wecode/telegram-token (0600)

In `company.toml`:

    [notify]
    command = "~/.wecode/notify.sh"
    timeout = "30s"

    [telegram]
    fetch  = "curl -sS -m 20 \"https://api.telegram.org/bot$(cat ~/.wecode/telegram-token)/getUpdates?offset=$WECODE_TELEGRAM_OFFSET\""
    answer = "~/.wecode/answer.sh"

## What each does

`notify.sh` sends one message when a task starts waiting: the document the task
produced, with **Approve** and **Hold** on it. One message rather than two, because
`sendDocument` takes a caption and a `reply_markup` — the thing being decided and the
way to decide it should not be two notifications.

`answer.sh` stops the spinner, then edits that message into a record: buttons gone,
caption stating what was decided.

## Four traps, each of which cost an evening

**`-F` reads a value beginning with `<` as a filename.** An HTML caption begins with
`<b>`, and curl then reports a missing file — an error a long way from its cause. Use
`--form-string` for text parts.

**`%0A` inside `--data-urlencode` has its percent escaped** and arrives as two literal
characters. Build the text with `printf` instead. This one was fixed twice.

**A send that times out may still have been delivered.** Retrying duplicates the
message, and a duplicated *approval* is two buttons for one decision.

**Nothing polls.** `wecode telegram` reads the channel when run; `wecode loop` reads it
every pass. Without one of them a tap sits in Telegram's queue and the button appears
to do nothing — which no amount of message-editing will fix, because the edit is what
is not happening.

## The part that is a workaround

`answer.sh` needs the message id to edit, and wecode hands the hook only a callback id
and an outcome. So `notify.sh` writes the message id under the task's name in
`~/.wecode/msg/`, and `answer.sh` matches the outcome text back to it.

That is state belonging to wecode kept in a directory of files, and it will race if two
decisions land in the same second. `tap-receipt` passes the message and chat ids the
callback already carries, and deletes all of this.
