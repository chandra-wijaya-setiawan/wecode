-- When the test was last seen to fail against the base it was written from.
--
-- `red_at_base_sha` is the commit the test failed at; `red_at_base_at` is when that was
-- observed. A test that has never been red proves nothing — it may be asserting what the
-- code already did, or nothing at all — so `test_has_been_red` refuses `pass` while the
-- sha is null.
--
-- Both nullable, and null for every existing row: nobody watched the older tests fail, so
-- they are unproven until someone records a red run. It is a record of an observation, not
-- a reading of the tree: the guard that reads it has no worktree and no clock, and never
-- re-derives it by running anything.
ALTER TABLE acceptance_test ADD COLUMN red_at_base_sha TEXT;
ALTER TABLE acceptance_test ADD COLUMN red_at_base_at TEXT;
