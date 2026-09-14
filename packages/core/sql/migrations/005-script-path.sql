-- Where the test's script is meant to live.
--
-- `artefact` is the command that runs the test; `script_path` is the file that command is
-- expected to invoke. Naming it separately is what lets a plan say "this test will be a
-- script at scripts/mail.sh" before the file exists, and lets a scope be written against
-- that path rather than guessed from a command line.
--
-- Nullable, and null for every existing row: a judged test has no script, and a script test
-- written before this migration never said where its file was. It is spec — what the test
-- should be — and never a record of what is on disk. There is deliberately no companion
-- flag saying whether the file exists: that answer is different on every branch and stale
-- the moment one moves, so it is read from the filesystem when it is needed, not stored.
ALTER TABLE acceptance_test ADD COLUMN script_path TEXT;
ALTER TABLE task_test ADD COLUMN script_path TEXT;
