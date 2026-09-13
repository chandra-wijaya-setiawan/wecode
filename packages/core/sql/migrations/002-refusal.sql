-- Why a candidate was passed over on the last pass.
--
-- One row per task, replaced each time: the board answers *why is nothing running* from
-- here. A refusal nobody can see is how a task starves silently — it is refused on every
-- pass, forever, and the queue looks healthy.
CREATE TABLE refusal (
  task_id INTEGER PRIMARY KEY REFERENCES task(id),
  why     TEXT NOT NULL,
  at      TEXT NOT NULL
);
