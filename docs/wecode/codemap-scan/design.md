# The codemap — what each file defines, what it names, and which component owns it

A design step today names the files its build will touch by reading the tree and guessing.
The guess is what the write scope is made of, and a wrong one is not recoverable: scope is
frozen at creation, so a task that declared too little dies holding work it may not commit,
and one that declared too much collides at admission and serialises against every neighbour
in the crate. `map.rs` already puts the shape of the tree in the envelope, but it stops at
the directory and the first line of a file. This decides what a deeper scan reads, how, and
— the harder half — what the answer is then allowed to be used for.

## Three layers, and only the middle one is new

| layer | unit | source | can it rot? |
|---|---|---|---|
| file | path, length, its own first line | git index + the four conventions in `map.rs` | no — read at dispatch |
| **symbol** | **a definition or a reference, by name and line** | **tree-sitter tags, cached by content hash** | **no — content addresses content** |
| component | a named responsibility owning a set of paths | the table in `docs/architecture.md` | yes — reconciled, not generated |

The component layer keeps its author. `docs/design/living-docs.md` lists "codemap →
component docs" under *generate more*, and this narrows that: the scan generates the
**edges** and the **membership check**, never the names. A responsibility is a claim about
intent, its source of truth is a person, and a cluster label a machine invented is a label
nobody reviews and everybody inherits. What the scan can do to that table is refuse it —
a component whose paths hold symbols nothing outside it ever names is not a boundary, and
a file no component claims that half the tree references is a hub that was never declared.

Where no table exists, the directory is the component. Most repositories already shelve by
responsibility, `map.rs` groups that way today, and a fallback that produces something
readable on day one is what keeps the table from being a precondition.

## Why tree-sitter, when a compiler would actually be right

A language server resolves names. Tree-sitter does not — it gives a concrete syntax tree
per file and no idea what any identifier refers to. Resolution is strictly better data, and
it is rejected on where it has to run: `rust-analyzer` needs a resolved dependency graph,
which needs a fetch and often a build, in a worktree that was created ninety seconds ago
and whose whole point is that nothing has been built in it yet. The measured cost of a cold
worktree is already 890 MB and a full rebuild (`docs/design/method.md`); paying it again
before the agent has read anything is not a map, it is a second build.

| option | rejected because |
|---|---|
| LSP / `rust-analyzer` | needs a resolved, buildable project; wrong side of the cold-worktree cost |
| `ctags` | a second binary an operator must install — the exact failure `playbook-gap` exists for |
| regex over the source | comments and strings defeat it, and `docs/design/living-docs.md` already names grep as the thing that has been fooled |

Tree-sitter's properties are the ones this position needs: per-file, no toolchain, no
network, error-tolerant on a file that does not compile, and one uniform interface across
languages so a second language is a grammar rather than an integration.

## Names, not symbols — and what that forbids

Each file yields a list of `(kind, name, line)` from that grammar's upstream `tags.scm`
query, vendored as data rather than hand-written per language: the tags convention is
maintained beside the grammar and is what GitHub's code navigation and Aider's repo map
both read, so a hand-rolled query would be a per-language maintenance debt that silently
decays on the next grammar bump. An edge is then drawn by **name matching** — file A
references `foo`, file B defines `foo`, so A is near B.

That is a heuristic and the design turns on admitting it. `new`, `run`, `id` and `main`
are defined everywhere and mean nothing, so a name's weight is inverse to how many files
define it: defined once, strong evidence; defined thirty times, dropped before it is
counted. Ranking is inverse-frequency-weighted degree over one hop from the task's scope —
not PageRank. PageRank finds the globally central file, which is `main.rs`, which the agent
can already see; the question here is local — *what sits next to what I am about to change*.

The heuristic sets the rule for the whole feature: **the codemap ranks, it never refuses.**
It does not gate admission. `docs/design/method.md` lists "declare scopes as files, not
crates" as advice waiting to become a check, and this declines to be that check. A scope
refused because a machine matched two identifiers that happened to share a spelling is
unrepairable for exactly the reason the freshness gate refused history-based staleness: the
run cannot answer the finding. So the output is an ordering in an envelope and a table in
`wecode map`, read by whoever declares the scope, and admission goes on comparing globs.
For the same reason the rendering may say *references* and *is referenced by*; it may not
say *depends on*, which is a claim this data cannot support.

## Grammars, the C dependency, and where the parse lands

A fixed set compiled in — Rust, Python, TypeScript/TSX, JavaScript, Go — not grammars
loaded from disk at runtime. Dynamic loading buys a language an operator can add and costs
a C compiler on the machine running the agent plus a grammar path to configure; wecode
ships one binary and the set it supports must be checkable at `project add` time against
`playbook.toml`'s `language` field, so a project naming a language with no grammar is a
`doctor` finding rather than a map that comes back empty. No cargo feature gating it
either: an optional path CI does not build is a second product, and the degradation that
matters is at runtime — an unknown extension falls back to the file layer, per file.

The C dependency is not new in kind. `rusqlite` is already `bundled`, so this workspace
already requires a C toolchain and already links C. What widens is the FFI surface, from
one vendored library to six, and `unsafe_code = "forbid"` in the workspace lints is worth
reading honestly for the first time: it binds the Rust in these crates and never bound
what they link.

Parsing lands in a new `wecode-map` crate depending on core alone — core is dependency-free
by rule and a parser is a dependency. The cache is a store table keyed by content hash
(git's blob oid, which the index already carries for a clean file), and an entry is never
invalidated because a hash names its own content; it is only collected. So the scan runs at
dispatch, incrementally, rather than behind a command someone must remember — a map is
stale exactly when nobody re-ran it. Files are read by the CLI and handed in as bytes, the
same division `wecode_core::docs` already uses, which also keeps `map.rs` at 461 lines from
growing toward the 1600 in `.max-lines`.

## What it costs, and what it makes harder

Order of a megabyte of compiled parser per grammar, a build that now compiles five more C
libraries, a store table that grows with every blob ever seen, and milliseconds per file on
a cold cache. Harder: cross-compiling to a target without those grammars, and — the real
one — a map that is plausible and wrong. `docs/features.md` says the repo map "is a
photograph, and it only knows four conventions", which is a limitation a reader can see;
a ranked list of coupled files looks like knowledge. Every derived row carries the word
that says it was derived, and the file layer stays exactly as it is: tree-sitter answers
what is *in* a file, and the first line still answers what the file is *for*.

## What would show this was decided wrong

The ground truth is already committed. Every merge writes `docs/wecode/<task>/report.md`
with the files the change actually touched, so for the next ten features the design's named
file list can be scored against it. Recall below roughly 0.7 means the map is not grounding
the guess it replaced; precision below roughly 0.5 means designs are padding scopes, and
padding is measurable a second way — as admission collisions, which cost parallelism the
same papers priced at 45–52%.

The sharper test is the baseline: the ranked codemap has to beat *the directory map already
in the envelope*. If a design step given ranked neighbours names the same files as one given
`map.rs` output, the parse bought nothing and should be deleted rather than tuned. And if
the reconciliation against `docs/architecture.md` fires constantly, the failure is more
likely in the name matching than in the architecture — that is the point at which
resolution, with its build cost, becomes worth re-arguing.
