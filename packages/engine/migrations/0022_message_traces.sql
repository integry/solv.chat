-- How an assistant answer was made ("How this answer was made" in
-- Conversations).
--
-- The two timings the visitor feels live on the message itself: they are
-- written in the same insert as the reply, are never missing for a row
-- written after this, and can be summed or ranked later (Reports) without
-- reading JSON. NULL means the reply was written before this existed.
ALTER TABLE messages ADD COLUMN first_token_ms INTEGER;
ALTER TABLE messages ADD COLUMN total_ms INTEGER;

-- The rest of the trace is one JSON document per assistant message: what
-- retrieval considered (chunk and document ids with scores, never text), the
-- version that answered, the provider, model and key source (never a key),
-- the timings and the stop reason. It is written after the reply, in a write
-- of its own that may fail without failing the answer, so it is a separate
-- table rather than more columns on `messages`. Keyed and cascaded like
-- `feedback`: deleting the message (or its conversation, or its assistant)
-- deletes the trace. The length check is a backstop for the engine's own
-- 32 KiB cap (`MAX_TRACE_BYTES` in src/chat/trace.ts).
CREATE TABLE message_traces (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  message_id TEXT NOT NULL,
  detail TEXT NOT NULL CHECK (length(CAST(detail AS BLOB)) <= 32768),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, message_id),
  FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE
);
