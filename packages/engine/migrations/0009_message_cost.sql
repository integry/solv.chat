-- Distinguish unknown cost (NULL) from known zero cost (0) on messages,
-- and track whether any response today had unknown cost so the admin can warn
-- that the daily spend cap cannot protect the instance.
ALTER TABLE messages ADD COLUMN cost_micros INTEGER;
ALTER TABLE usage_daily ADD COLUMN cost_unknown INTEGER NOT NULL DEFAULT 0;
