-- Pages still owed a rebuild after a change to their source's repeated
-- blocks (issue #127; see "Repeated blocks" in docs/architecture.md).
--
-- sources.repeated_pending: the hashes whose status changed and whose pages
-- are not yet known to be queued (a sorted JSON array). Written in the same
-- statement that stores a changed repeated_blocks, so a failed queue send
-- after that store cannot lose the pages: every later reconciliation queues
-- the pages holding these hashes again, and removes the hashes only once
-- all of its sends succeeded.
ALTER TABLE sources ADD COLUMN repeated_pending TEXT NOT NULL DEFAULT '[]';

-- sources.repeated_rev: counts the stores of repeated_blocks. Pending hashes
-- are removed only if no store happened since they were read, so a removal
-- never takes hashes a later store added for pages it has not queued.
ALTER TABLE sources ADD COLUMN repeated_rev INTEGER NOT NULL DEFAULT 0;
