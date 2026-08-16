# The envelope

`templates.task_envelope` is the prompt a worker receives. It is a key in
[`company.toml`](company.md), and it is on its own page because what it configures is
what an *agent* is told, where the rest of that file configures what a **person** may do.
Placeholders:

`{{task_id}}` `{{project_id}}` `{{objective}}` `{{title}}` `{{acceptance}}`
`{{write_scope}}` `{{context}}` `{{repo_map}}`

`{{context}}` carries the handoff — what predecessors produced: a capped diff per
predecessor, or the whole document when the predecessor was a `design`. If the template
omits it, the handoff is **appended** rather than dropped: losing it silently would be
worse than putting it somewhere unexpected.

`{{repo_map}}` carries the shape of the repository the task will work in — the
directories git is tracking, the files inside the ones this task may write to, and the
line each of those files uses to describe itself. Same rule when the template omits it:
appended under a `REPO MAP` heading. The shipped template has no slot for it, so most
workspaces get it appended and need change nothing.

Previous attempts are appended after the template, always.

Both are rendered from A2A artifacts, so `wecode start <task> --json` shows exactly what
a worker is being given — including the structured part it never sees in the prose.

## The guidance is not one of them

There is no `{{guidance}}`. The playbook is not copied into the envelope, because it is
already in the tree the worker lands in: it is committed at
[`.wecode/playbook.toml`](playbook.md) in the project's own repository, which is what
makes it a description of that code rather than of the workspace.

What the shipped envelope does is **name it**, under a `GUIDANCE` heading. Everything
else the worker is told — the objective, the title, the acceptance, the scope — says
what the work is; the playbook is the only place that says how work of this kind is done
here, and a worker never told the file exists is working to guidance it has not read.

Read, not written. `.wecode/playbook.toml` sits outside every write scope on purpose —
only `.wecode/run/**` is the worker-writable area — so a task cannot rewrite the
guidance it was handed, and verification reports it as a scope violation if it tries. A
worker with something to say about the guidance says it in its result, and a seat that
may `define project` records it with `wecode playbook gap`.

A workspace that predates this heading loses nothing: `company.toml` is hand-edited and
wecode never rewrites it. Copy the section out of `wecode init --template solo` into
your own `task_envelope`, or leave it out and point the worker at the file however you
prefer.
