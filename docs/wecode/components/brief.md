# components — paths get their meaning back

Grounding: docs/design/sdlc.md (ISO 42010, C4 L2-L3). The owner: "software is broken
down by architecture, by component, by layer — this is part of wecode."

## The shape

1. Each repo may carry a components table in `docs/architecture.md`:

       | component | layer | paths | responsibility |
       |---|---|---|---|
       | store | container | crates/wecode-store/** | SQLite; the database is the bus |

   Machine-readable (a fenced table with fixed columns), human-first prose around it.
2. wecode reads it like a playbook. Then:
   - `--write @store` declares a scope by component; expands to its paths at admission
     and is RECORDED as the component name
   - collisions name components, not globs: "both tasks touch *store*"
   - `wecode show <project>` and the board can group by component
3. A path no component claims is fine (not everything is architecture); a component
   claiming paths that do not exist draws an advisory (the map rotted).

## Not doing
- No diagrams, no enforcement that code respects boundaries (that is clippy/import
  lints per language, another day). This is naming, reading, and reporting.
