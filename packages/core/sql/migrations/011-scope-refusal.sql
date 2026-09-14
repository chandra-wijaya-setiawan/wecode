-- What an attempt was refused permission to write, kept against the task.
--
-- The write scope is the operator's decision, and a task that keeps asking for a path it
-- may not have is asking for that decision to be revisited. Seven tasks on 15 Sep burned
-- every attempt on exactly that and the board said only 'out of attempts': the refusal was
-- in the attempt's own output and nowhere a person looks.
--
-- One row per task, like `refusal`: the paths are the current standing ask, not a history.
-- `paths` is a JSON array because the set is what matters and SQLite can read it with
-- json_each; it is emptied a path at a time as the scope grows to cover them, and the row
-- goes when nothing is left to say.
CREATE TABLE scope_refusal (
  task_id INTEGER PRIMARY KEY REFERENCES task(id),
  paths   TEXT NOT NULL,
  at      TEXT NOT NULL
);
