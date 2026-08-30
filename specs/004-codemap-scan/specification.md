# 004 codemap-scan — a design step names files from a parsed map, not from a guess

**Task:** #004 `codemap-scan` · **Branch:** `wecode/codemap-scan` · **Target:** `master`
· **Design record:** [docs/wecode/codemap-scan/design.md](../../docs/wecode/codemap-scan/design.md)

Execution state is tracked in `report_as_finished.md`. This document is the contract.

## 1. Requirement summary

A new `wecode-map` crate parses tracked source files with tree-sitter, extracts definitions
and references by name from each grammar's upstream `tags.scm`, and ranks the files nearest
a seed path set. The result reaches an agent two ways: a ranked section in the dispatch
envelope, and `wecode map` for the operator. A store table caches tags by content hash.
Permanent; no scaffolding.

Out of this slice, and each named with its owner: the components table itself and
scope-by-component (`components`); any admission or verify gate consuming the map (nobody —
declined in the design record); name resolution via a language server (nobody — see §7 A3).

## 2. Architecture

| C4 | Placement |
|---|---|
| L2 container | `wecode` CLI — no new container |
| L3 component | new `wecode-map` crate (parse + rank, pure over bytes); cache in `wecode-store`; file reading, envelope and command in `wecode-cli` |
| L4 | `map::tags(lang, bytes) -> Vec<Tag>`, `map::rank(index, seeds, budget) -> Vec<Ranked>` |

`wecode-map` depends on `wecode-core` and tree-sitter and nothing else; it opens no files.
That is the `wecode_core::docs` division — the caller reads, the crate decides — and it is
what keeps the C dependency and the I/O in separate crates. It sits beside `store` in the
crate order: nothing below `cli` depends on it.

## 3. Requirement details

**Functional**

| ID | Component | Requirement |
|---|---|---|
| FR-04-01 | map | Detect a file's language from its extension; the set is Rust, Python, TypeScript, TSX, JavaScript, Go |
| FR-04-02 | map | Extract `(kind, name, line)` tags from a file's bytes using that grammar's vendored `tags.scm`, separating definitions from references |
| FR-04-03 | map | A file whose language is unknown, or whose parse errors, yields no tags and is counted — never silently dropped |
| FR-04-04 | map | Build a name index over definitions; a name defined in more than the frequency threshold of files carries zero weight |
| FR-04-05 | map | Rank files by inverse-frequency-weighted degree, one hop from a seed path set, bounded by a row count |
| FR-04-06 | store | Cache tags keyed by content hash (git blob oid); an entry is never invalidated, only collected |
| FR-04-07 | cli | Scan at dispatch, incrementally — only blobs absent from the cache are parsed |
| FR-04-08 | cli | The envelope carries a ranked neighbours section beneath the existing repo map, seeded from the write scope, or from the whole tree when the task declares none |
| FR-04-09 | cli | `wecode map <project> [--seed <glob>…]` prints the same ranking the envelope carries |
| FR-04-10 | cli | Every derived row is rendered as *references* / *referenced by*; the words *depends on* appear nowhere in the output |
| FR-04-11 | cli | `wecode doctor` reports a project whose playbook `language` has no compiled grammar |

**Non-functional**

| ID | Component | Requirement (ISO 25010) |
|---|---|---|
| NFR-04-PER-01 | cli | *Performance efficiency*: a warm scan does no parsing — one cache lookup per tracked blob |
| NFR-04-REL-01 | map | *Reliability*: no network, no build, no subprocess; a file that does not compile still yields its tags |
| NFR-04-MNT-01 | map | *Maintainability*: queries are vendored `tags.scm` data, not Rust — a grammar bump is a data update |
| NFR-04-MNT-02 | build | `.max-lines` src=1600 stays green; the new crate is new files, and `map.rs` (461) does not absorb this |
| NFR-04-CPT-01 | build | *Compatibility*: the C toolchain requirement is unchanged in kind — `rusqlite` is already `bundled` |
| NFR-04-SEC-01 | map | *Security*: parsing only; no file the scan reads is ever executed |

## 4. Acceptance criteria

| AC | Criterion | Evidences | How it is proven |
|---|---|---|---|
| AC-1 | A Rust fixture yields its `fn`/`struct` definitions and its call references with line numbers | FR-04-01, 02 | `cargo test --workspace` |
| AC-2 | Each of the six languages yields at least one definition from a fixture | FR-04-01, 02 | `cargo test --workspace` |
| AC-3 | An unknown extension and a syntactically broken file both scan without error, and are counted | FR-04-03, NFR-04-REL-01 | `cargo test --workspace` |
| AC-4 | A name defined in more files than the threshold contributes no edge | FR-04-04 | `cargo test --workspace` |
| AC-5 | Given a seed, the ranking puts the file defining the seed's references above an unrelated file of equal size | FR-04-05 | `cargo test --workspace` |
| AC-6 | A second scan of an unchanged tree parses zero files | FR-04-06, 07, NFR-04-PER-01 | `cargo test --workspace` — counter assertion |
| AC-7 | `wecode map` on this repository prints a non-empty ranking, and no line contains "depends on" | FR-04-09, 10 | `cargo test --workspace` — CLI test running the binary |
| AC-8 | The envelope for a task with a write scope contains the ranked section | FR-04-08 | `cargo test --workspace` — handoff test |
| AC-9 | `wecode doctor` names a project whose language has no grammar | FR-04-11 | `cargo test --workspace` |
| AC-10 | Tree under the ratchet, lint clean | NFR-04-MNT-02 | `bash scripts/max-lines.sh`; `cargo clippy --all-targets -- -D warnings` |

## 4b. Interfaces — user and agent parity

| Action | User via | Agent via | Same gate? |
|---|---|---|---|
| See what a path is coupled to | `wecode map <project> --seed <glob>` | the ranked envelope section, same ranking | yes — one ranker |
| Learn a language is unmapped | `wecode doctor` | the scan's counted-skips line in the envelope | yes |
| Declare a write scope | `wecode task add --write` | same command | yes — admission, unchanged |
| Have the map refuse a scope | *(none — by design)* | *(none)* | n/a |

## 5. Technical component details

**Cache key.** Git's blob oid for a clean file, the same hash computed over content for a
dirty one. A hash names its content, so an entry can never be wrong; the table grows and is
collected, never invalidated. This is what makes a dispatch-time scan affordable and is why
there is no `wecode scan` an operator must remember to run.

**Ranking.** Weight of a name is inverse to the number of files defining it, zero above the
threshold. A file's score is the summed weight of names it shares with the seed set, one hop
only. Not PageRank: global centrality returns `main.rs`, which answers a question nobody
asked. The argument is in the design record and is not re-run here.

**Bounds.** Counts, not bytes, and what is left out is counted — the rule `map.rs` already
follows, for the reason stated there: a map that stops quietly reads as a tree that ends.

**Vocabulary.** Name matching cannot support *depends on*. FR-04-10 makes that a testable
property of the render rather than a note in a doc comment.

## 6. Out of scope

| Not doing | Owner |
|---|---|
| Scope declared by component name; the `docs/architecture.md` table | `components` |
| Admission or verify refusing anything from the map | nobody — declined in the design record; a frozen scope makes such a finding unrepairable |
| Generating component *names* from clusters | nobody — a responsibility has a human author (`docs/design/living-docs.md` mechanism 1, narrowed) |
| Resolved symbols via a language server | nobody — costs a build in a cold worktree |
| Grammars loaded from disk at runtime; a cargo feature gating tree-sitter | nobody — one binary, runtime degradation per file |

## 7. Assumptions

| # | Assumption | If wrong |
|---|---|---|
| A1 | Upstream `tags.scm` exists and is usable for all six grammars | wecode vendors a minimal query for the gap and the spec records which language it wrote by hand |
| A2 | Inverse-frequency weighting suppresses common-name noise well enough to rank usefully | the falsifier in the design record fires; drop to definitions-only and rank by directory adjacency |
| A3 | A one-hop neighbourhood is the right radius | widen to two hops with decay; the ranker is the only thing that changes |
| A4 | Six grammars is order-of-megabytes of binary, not tens | ship fewer, chosen by the languages `company.toml` actually names |
| A5 | Adding `wecode map` moves `docs/reference/commands.md` and `schema.md`, which are generated | it does — the build task's write scope must include `docs/**` or the scope check refuses the work after it is done |

## 8. Decisions

| Decision | Justification | Reference |
|---|---|---|
| tree-sitter, not LSP/ctags/regex | per-file, no toolchain, no build, error-tolerant, uniform across languages | design record §"Why tree-sitter" |
| The map ranks; it never refuses | a scope refused on a matched spelling is unrepairable — the frozen-scope shape | design record §"Names, not symbols" |
| Names are matched, weighted by inverse frequency | resolution is unavailable at this cost; rarity is the evidence that survives | design record §"Names, not symbols" |
| Component names stay authored; the scan supplies edges and reconciliation | a cluster label nobody reviews is inherited, not known | `docs/design/sdlc.md` §"the exposed gap"; `components` brief |
| Directory is the fallback component | readable on day one; the table is not a precondition | design record §"Three layers" |
| A fixed compiled grammar set, no runtime loading, no cargo feature | one binary; a path CI does not build is a second product | design record §"Grammars" |
| Cache keyed by content hash, in the store | content addresses content, so an entry is never stale | §5 |
| New `wecode-map` crate, not `core`, not `map.rs` | core is dependency-free by rule; `map.rs` is 461 lines under a 1600 ceiling | NFR-04-MNT-02 |

## 9. References

Project: `docs/wecode/codemap-scan/design.md`, `docs/design/method.md` (partitioning by
coupling; the three places a rule can live), `docs/design/sdlc.md` (ISO 42010 / C4 gap),
`docs/design/living-docs.md` (mechanism 1, narrowed here), `docs/wecode/components/brief.md`,
`crates/wecode-cli/src/map.rs` (the file layer this extends), `.max-lines`.

Published: tree-sitter tag queries (the `tags.scm` convention behind GitHub code
navigation); Aider's repo map (PageRank over a tags graph — the ranking this rejects and the
extraction it borrows); ISO/IEC/IEEE 29148 (this document's shape); ISO/IEC 25010 (NFR names).
