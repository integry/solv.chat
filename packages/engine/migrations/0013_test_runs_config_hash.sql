-- Binds each test run to the exact draft configuration revision it tested,
-- so a "Publish anyway" override cannot promote a draft that was edited after
-- the failing run.
ALTER TABLE test_runs ADD COLUMN config_hash TEXT;
