-- Scheduled re-sync of sitemap sources. The schedule itself (`sync`:
-- off | daily | weekly, and `maxRemovePercent`) lives in `sources.settings`;
-- these tables hold what a run needs and what it found.

-- One row per source that has ever started a sync: the current or latest run.
-- `lease_until` is set while a run is in progress, so a second run for the
-- same source (a cron firing twice, a host cron beside the open one) cannot
-- start until the first finishes or its lease runs out.
CREATE TABLE source_syncs (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lease_until INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- running | succeeded | partial | failed
  outcome TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  -- Pages left for a later run by the per-run page cap or the source's document cap.
  deferred INTEGER NOT NULL DEFAULT 0,
  -- A short code, never a remote server's or provider's message.
  error TEXT,
  PRIMARY KEY (org_id, source_id),
  FOREIGN KEY (org_id, source_id) REFERENCES sources(org_id, id) ON DELETE CASCADE
);

-- The pages one run handed to the ingest queue, one message each. A page
-- leaves `pending` exactly once, so a retried message is not counted twice;
-- the run finishes when none is pending. Rows of earlier runs are deleted
-- when the next run starts.
CREATE TABLE source_sync_pages (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- The sitemap's <lastmod> for the page, stored on the document when it is checked.
  lastmod TEXT,
  -- pending | added | updated | unchanged | failed
  state TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (org_id, run_id, url),
  FOREIGN KEY (org_id, source_id) REFERENCES sources(org_id, id) ON DELETE CASCADE
);

CREATE INDEX source_sync_pages_source ON source_sync_pages(org_id, source_id);

-- Validators from the last time a sync checked the page, so the next run can
-- skip it on an unchanged sitemap <lastmod> or ask with If-None-Match /
-- If-Modified-Since. `sync_checked_at` orders pages so a capped run starts
-- with the ones checked longest ago.
ALTER TABLE documents ADD COLUMN etag TEXT;
ALTER TABLE documents ADD COLUMN last_modified TEXT;
ALTER TABLE documents ADD COLUMN sitemap_lastmod TEXT;
ALTER TABLE documents ADD COLUMN sync_checked_at INTEGER;
