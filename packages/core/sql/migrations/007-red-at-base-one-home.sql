-- One home for the red-at-base verdict: the columns on acceptance_test that
-- `test_has_been_red` reads.
--
-- The runner had been recording its observation in a side table of its own, `red_at_base`,
-- while the guard read the column. Nothing reconciled the two, so a test could be proven
-- red and still be refused a pass for ever — live, acceptance_test 157 and 160 held a
-- recorded sha and stayed ready while the log claimed a pass on every tick.
--
-- `red_at_base_reason` is the third field the side table carried: why a run at base proved
-- nothing. It belongs beside the sha it explains the absence of.
ALTER TABLE acceptance_test ADD COLUMN red_at_base_reason TEXT;

-- A database that never ran the old runner has no side table; create it empty so the copy
-- below is a no-op there rather than an error.
CREATE TABLE IF NOT EXISTS red_at_base (
  test_id         INTEGER PRIMARY KEY,
  red_at_base_sha TEXT,
  red_at_base_at  TEXT,
  reason          TEXT
);

-- Anything already in the side table moves to the column. `coalesce` so a column that was
-- filled by hand wins: the side table is the older, less trusted record of the two.
UPDATE acceptance_test SET
  red_at_base_sha    = coalesce(red_at_base_sha,
                         (SELECT b.red_at_base_sha FROM red_at_base b WHERE b.test_id = acceptance_test.id)),
  red_at_base_at     = coalesce(red_at_base_at,
                         (SELECT b.red_at_base_at FROM red_at_base b WHERE b.test_id = acceptance_test.id)),
  red_at_base_reason = coalesce(red_at_base_reason,
                         (SELECT b.reason FROM red_at_base b WHERE b.test_id = acceptance_test.id))
WHERE EXISTS (SELECT 1 FROM red_at_base b WHERE b.test_id = acceptance_test.id);

DROP TABLE red_at_base;

-- The old name, kept as a read-only lens on the one home rather than a second copy of it.
-- Nothing can write here, so nothing can disagree with the column the guard reads.
CREATE VIEW red_at_base AS
  SELECT id AS test_id, red_at_base_sha, red_at_base_at, red_at_base_reason AS reason
    FROM acceptance_test;
