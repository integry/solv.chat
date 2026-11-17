-- Message text folded for the Conversations search: Unicode lowercase, in NFC,
-- computed by the engine when it writes or rewrites `content`. SQLite's
-- `lower()` only folds ASCII, so folding both sides in SQL would miss
-- "École" for a search of "école".
--
-- Rows written before this migration stay NULL: SQL cannot produce the same
-- folding. The search falls back to `lower(content)` and to the exact text
-- for them, so a search still finds them by what the visitor typed.
ALTER TABLE messages ADD COLUMN search_text TEXT;
