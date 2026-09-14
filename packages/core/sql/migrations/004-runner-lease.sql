-- Which runner is allowed to run this workspace.
--
-- Two runners on one workspace mark each other's sessions lost: one starts a session, the
-- other polls, finds nothing in its own memory and calls it lost. Nothing in the record
-- said whose workspace it was, so both were right. One row says it.
--
-- The row is the lease, not a log: `id` is pinned to 1 so a second runner cannot simply
-- insert its own. `heartbeat` is renewed every tick, and `interval_ms` is the tick that
-- holder promised, so a reader can tell a dead holder from a slow one without sharing a
-- clock or a config file. A holder that has missed three intervals is stale and may be
-- taken over: one missed tick is a slow disk, three is a runner that is gone.
CREATE TABLE runner_lease (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  holder      TEXT    NOT NULL,
  interval_ms INTEGER NOT NULL,
  taken_at    TEXT    NOT NULL,
  heartbeat   TEXT    NOT NULL
);
