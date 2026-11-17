-- Why a document could not be indexed, so the admin can say "Failed: reason"
-- instead of "Indexing…" forever. `index_error` is a short code written by
-- the ingest consumer (never a provider message, which could echo a secret);
-- `index_error_hash` is the content hash it belongs to, so pushing or saving
-- new content makes the old error stale without another write.
ALTER TABLE documents ADD COLUMN index_error TEXT;
ALTER TABLE documents ADD COLUMN index_error_hash TEXT;
