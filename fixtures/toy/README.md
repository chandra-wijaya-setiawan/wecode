# toy — the repository the tests drive

A deliberately tiny project, committed rather than generated, so an end-to-end run is
reproducible and an edge case can be reproduced by hand a week later.

This is **not** a git repository as committed — it cannot be, nested inside one.
`Toy::plant()` copies it somewhere temporary and runs `git init`, so every test gets a
private repo with this exact content.

## What is here

    src/app.txt          the file work is done to
    .wecode/playbook.toml  guidance, exactly as a real project carries it

## The agent

Tests stand a shell script in for a coding CLI. The script reads its instruction from
the envelope on stdin the way a real harness would, so the supervision, the timeouts
and the scope checks are all exercised against a real process — only the binary
differs.
