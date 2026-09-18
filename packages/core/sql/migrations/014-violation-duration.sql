-- The doctor's report, as the record rather than as the runner's scratch space.
--
-- `doctor_violation` existed before this migration, but only as a `CREATE TABLE IF NOT
-- EXISTS` in the runner's Doctor constructor, and it held one thing: what the last pass
-- found. That is a report with no memory. A drift that has stood for nine days and one
-- found ten seconds ago read exactly alike, and a drift that a pass stopped finding
-- vanished with no record that it had ever been there or that anything had cleared it.
--
-- So the table moves here and grows five columns. Every one of them is nullable, because
-- the runner's own insert names six columns and is out of this slice's reach: a pass that
-- has not been taught the new columns still writes a row, and a NULL says nobody said
-- rather than saying no.
--
-- | column | what it holds |
-- |---|---|
-- | `kind` | `safe` or `major` — docs/design/19's two columns, whether a machine may make this fix |
-- | `heal` | the chore that discharges it, or NULL when only a person can settle it |
-- | `first_seen` | the pass that found it first |
-- | `last_seen` | the most recent pass that still found it |
-- | `cleared_at` | the pass that looked and did not find it, NULL while it stands |
--
-- `first_seen` to `last_seen` is the duration the title asks for: a violation carries how
-- long it has been standing, which is the one thing that tells drift from an accident.
--
-- Dropped and recreated rather than altered. The old shape is the runner's, created outside
-- the migrations, so a database in the field may have it with any history of its own; and
-- the report is rewritten whole on every tick by design, so the rows lost here are one
-- tick's worth. Losing them is cheaper than an ALTER that has to guess whether the table it
-- is altering is the one this file means.
DROP TABLE IF EXISTS doctor_violation;

CREATE TABLE doctor_violation (
  invariant  TEXT    NOT NULL,
  entity     TEXT    NOT NULL,
  entity_id  INTEGER,
  slug       TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  found_at   TEXT    NOT NULL,
  kind       TEXT,
  heal       TEXT,
  first_seen TEXT,
  last_seen  TEXT,
  cleared_at TEXT
);

-- One open row per violation, enforced by the schema and not only by the code that writes
-- it. `invariant`, `entity`, `entity_id` and `slug` are the identity of a finding — the same
-- sentence about the same entity — and a second open row claiming it is the duplicate that
-- `last_seen` exists to avoid.
--
-- Partial on `cleared_at IS NULL`, so history is not the thing being constrained: a drift
-- that was cleared and came back opens a second row, and that is two spells of drift rather
-- than one, which is what a person reading the table wants to see.
--
-- `COALESCE(entity_id, -1)` because SQLite counts NULLs as distinct in a unique index, and a
-- role-level or schema-level finding has no id at all — without it every one of those could
-- open a second row unchecked.
CREATE UNIQUE INDEX doctor_violation_open
  ON doctor_violation (invariant, entity, COALESCE(entity_id, -1), slug)
  WHERE cleared_at IS NULL;

-- One row per doctor pass, whatever the pass found.
--
-- `doctor_violation` answers "what is broken"; nothing answered "did anybody look, and how
-- hard". An empty report after a pass that ran every check is a healthy record; an empty
-- report after a pass that ran nothing is a record nobody has examined, and until this table
-- existed the two were the same zero rows.
--
-- | column | what it holds |
-- |---|---|
-- | `at` | when the pass started |
-- | `duration_ms` | how long it took, measured by the caller — nothing here reads a clock |
-- | `checks_run` | how many checks actually ran; a check that could not run is not counted |
-- | `checks_failed` | how many of those found at least one violation |
--
-- Named `doctor_run`, not `doctor_pass`. `doctor_pass` is already taken, by the runner, for
-- one row per *check* within a pass (doctor.ts) — creating it here would silence that
-- `CREATE TABLE IF NOT EXISTS` and break every insert it makes. Two grains in one table
-- would be worse than the collision.
--
-- Appended, never rewritten: the last pass is the newest row, and the ones before it are how
-- long the doctor has been keeping up.
CREATE TABLE doctor_run (
  at            TEXT    NOT NULL,
  duration_ms   INTEGER NOT NULL,
  checks_run    INTEGER NOT NULL,
  checks_failed INTEGER NOT NULL
);
