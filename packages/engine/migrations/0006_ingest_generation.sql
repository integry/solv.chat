-- Monotonic chunk replacement generation per document (F15) so duplicate
-- revisionless deliveries cannot restore chunk IDs retired by a later attempt.
ALTER TABLE documents ADD COLUMN chunk_generation INTEGER NOT NULL DEFAULT 0;
