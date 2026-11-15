-- The owner published a draft whose tests failed. The specification requires
-- the choice to be recorded on the run, so History and Reports can show that
-- what went live was known to fail.
ALTER TABLE test_runs ADD COLUMN published_anyway INTEGER NOT NULL DEFAULT 0;
