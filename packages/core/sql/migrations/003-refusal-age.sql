-- How long a task has been refused, and how many passes it has been refused for.
--
-- The allocator is the only thing that knows why a ready task did not become an assignment,
-- so staleness is read from what it recorded rather than guessed from a row's updated_at.
-- `since` is when this reason started: a task refused for the same reason all morning is a
-- different thing from one refused for a new reason a minute ago.
ALTER TABLE refusal ADD COLUMN since TEXT NOT NULL DEFAULT '';
ALTER TABLE refusal ADD COLUMN passes INTEGER NOT NULL DEFAULT 1;
