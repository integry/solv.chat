-- Removals the wipe guard held back. A run that would remove more than the
-- source's `maxRemovePercent` still adds and updates the pages its sitemap
-- lists, keeps the documents it no longer lists, records their number here
-- and ends as `failed` with `too_many_removals`, so the owner can see how
-- many a "Sync anyway" would remove. Zero for every other run.
ALTER TABLE source_syncs ADD COLUMN withheld INTEGER NOT NULL DEFAULT 0;
