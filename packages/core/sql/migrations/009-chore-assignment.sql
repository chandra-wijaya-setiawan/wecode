-- A chore may be assigned, and a chore nobody can take may say so.
--
-- assignment.objective_type is unconstrained text, so 'chore' needs no column change: the
-- set of objective types is the interpreter's, for the same reason `state` is not a CHECK.
-- The index on (objective_type, objective_id) already serves the chore lookups.
--
-- What a chore did need is somewhere to put the reason it was passed over. `refusal` keys
-- on task_id and carries a foreign key into task(id), so a chore's refusal cannot go there
-- — chore ids and task ids are two id spaces, and one row per (space, id) is the only way
-- the board can name the right thing. Columns are refusal's, meaning the same things:
-- `since` is when this reason started, `passes` how many passes it has held.
CREATE TABLE chore_refusal (
  chore_id INTEGER PRIMARY KEY REFERENCES chore(id),
  why      TEXT NOT NULL,
  at       TEXT NOT NULL,
  since    TEXT NOT NULL,
  passes   INTEGER NOT NULL DEFAULT 1
);
