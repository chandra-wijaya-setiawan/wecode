# tui-nav — what the owner asked for

The owner's words: "board → task view, kind of call each other, like SPA webpage in a
web app but TUI style. Dashboard cockpit is the board; second is the by-project task
view like up. Also board/up is not intuitive — it's all TUI anyway."

## One application, screens that call each other

    HOME     the cockpit: NEEDS YOU / MOVING / NEXT / LANDED (board-brief's groups)
      ↓ enter on any row
    PROJECT  that project's tree — today's up view, scoped to one project
      ↓ enter on a task
    TASK     detail: attempts with spend vs budget, the agent's latest stream line
             while running, the report once merged, incidents from the ledger

    esc / backspace  up one screen · from HOME, q quits
    j/k, space fold  survive unchanged on every screen

k9s and lazygit are the precedent: state lives in the app, screens are navigation.
No screen is reachable only by restarting with a different command.

## Naming

One live entry point: `wecode tui`, with `up` kept as an alias — renames that break
muscle memory are a tax with no revenue. Screens are keystrokes, never flags: a
`--main`/`--board` flag freezes navigation into the invocation. `wecode tui #205`
may open focused on a project, as a starting screen, not a different mode.

`wecode board` stays, unchanged in purpose: the print-once snapshot for pipes, logs
and no-tty contexts. That is a different consumer, not a second UI — the help text
should say exactly that.

## What this is not

- Not new data. Every screen renders what the plan, ledger and streams already hold.
- Not a rewrite of board-brief's groups — HOME *is* that view, navigable.
- Not mouse support, panes, or theming. Keys the hands already know.
