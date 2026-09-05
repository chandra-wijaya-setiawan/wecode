# Home as onboarding — the first screen a newcomer sees (proposed)

**Status: proposed, not built.** Drawn up 5 Sep 2026 from the owner's direction:
a new user should be able to look at the home view and understand what wecode is
for, and why it answers the agentic- and vibe-coding pain of 2026 — without
having read a page of documentation first. wecode is pre-MVP; the first screen
is where that mission is stated in the product, not only in the README.

[tui-dashboard.md](tui-dashboard.md) settled the division of labour between the
two front screens of the cockpit architecture: the dashboard answers *what needs
me now*, home answers *what is the shape of the work*. This page proposes a
third thing home does, and it must not become a second copy of either: **teach,
when there is nothing to show.**

## The problem

A newcomer who runs `wecode tui` today meets the portfolio — and a newcomer has
no portfolio. Empty panes teach nothing; a blank home in an empty workspace is
the one moment the product has the newcomer's full attention and says nothing
with it. Meanwhile the README carries the whole explanation alone, and the
people who most need the answer — everyone burned by an agent that said "done"
— are precisely the ones who will not read a manual before forming an opinion.

## What the home view must answer, in order

Five questions, top to bottom. Each is one or two lines, and each line that
makes a claim names where the claim is checked.

1. **What is this?** SDLC and project management for agentic software: agents
   do the work; wecode is the lifecycle they work inside.
2. **Why does it exist?** Because agentic coding produces code faster than
   anyone can check it, and "done" too often means an agent said so. Skipping
   the process should be impossible, not merely discouraged.
3. **What does it enforce?** The gates, stated as facts: executable acceptance
   and a write scope before a task is admitted; worktree confinement and a
   budget while it runs; verification from the diff; a signature where the
   policy asks for one.
4. **Where am I in it?** The portfolio — the section home already owns.
5. **What do I do next?** The ten-minute path from
   [../guides/getting-started.md](../guides/getting-started.md), as commands
   that can be typed straight from the screen.

## The drawing (text only)

    ┌ wecode ─ home ───────────────────────────────────────────────────┐
    │ agents write the code; wecode enforces the process               │
    │ admitted: executable acceptance + write scope, or refused        │
    │ running:   worktree + budget, confined                           │
    │ judged:    the diff and the exit codes, never the agent's word   │
    ├ portfolio ───────────────────────────────────────────────────────┤
    │ (no projects yet — nothing to hide)                              │
    ├ next ────────────────────────────────────────────────────────────┤
    │ wecode init mycompany --template solo     # a workspace          │
    │ wecode login you                          # take a seat          │
    │ wecode project add …                      # plan something       │
    │ wecode run <task>                         # watch it be checked  │
    ├──────────────────────────────────────────────────────────────────┤
    │ home v-h · dashboard v-d · tour reopens this banner              │
    └──────────────────────────────────────────────────────────────────┘

## The rules the drawing states

1. **The banner teaches when empty and recedes when full.** With no projects,
   the teaching block is the top of the screen. Once the workspace carries
   work, it collapses to one line — *agents write the code; wecode enforces the
   process* — and the portfolio takes the space. A `tour` key reopens it.
2. **Every claim on it is checkable from the screen it sits on.** The gates
   named in the banner are the gates in [../features.md](../features.md); a
   line that stops being true is a documentation defect, per
   [living-docs.md](living-docs.md), not a marketing choice.
3. **Nothing here duplicates the dashboard.** Needs-you, moving, blocked and
   roadmap belong to `v-d`; the banner answers *what is this*, the portfolio
   answers *what is the shape of the work*.
4. **Text only, and honest about status.** No colour semantics beyond the
   dashboard's; the word *pre-MVP* belongs on the screen until it is no longer
   true, because a newcomer deserves the same honesty as the README's reader.

## What this deliberately is not

Not a marketing page embedded in the tool, and not a tutorial with state to
keep. The banner is a fixed rendering over facts the store already holds —
whether any project exists is the only input — so it cannot drift from the
system it introduces.
