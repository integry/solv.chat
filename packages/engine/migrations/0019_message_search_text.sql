-- Message text folded for the Conversations search: Unicode lowercase, in NFC,
-- each run of whitespace collapsed to one space the way the question key
-- collapses it, so a most-asked question finds the messages it groups. The
-- engine computes it when it writes or rewrites `content`. SQLite's `lower()`
-- only folds ASCII, so folding both sides in SQL would miss "École" for a
-- search of "école".
ALTER TABLE messages ADD COLUMN search_text TEXT;

-- Rows written before this migration, when the text is all ASCII (as many
-- characters as bytes): there `lower()` and the replacements below give
-- exactly what the engine computes. Tabs, newlines, vertical tab, form feed
-- and carriage return become spaces, then each pass halves every run of
-- spaces (eight passes collapse runs of up to 256).
UPDATE messages SET search_text = lower(
  replace(replace(replace(replace(replace(content,
    char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' ')
)
WHERE length(content) = length(CAST(content AS BLOB));
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
UPDATE messages SET search_text = replace(search_text, '  ', ' ') WHERE instr(search_text, '  ') > 0;
-- A longer run is not fully collapsed: the engine folds that row instead.
UPDATE messages SET search_text = NULL WHERE instr(search_text, '  ') > 0;

-- The engine folds every row still NULL (any non-ASCII text) before it runs a
-- search, and finds them through this index, which empties as it goes.
CREATE INDEX messages_search_text_pending ON messages(org_id) WHERE search_text IS NULL;

-- An older Worker still serving while this deploys rewrites `content` (a
-- paused reply completed, say) without `search_text`, which would keep the
-- text folded from the old content for good. A rewrite that leaves
-- `search_text` as it was drops it instead, so the engine folds the row again
-- before the next search. The engine writes both together, so this does not
-- fire for its own rewrites unless the folded text happens to be unchanged,
-- and then the row is only folded once more.
CREATE TRIGGER messages_search_text_stale AFTER UPDATE OF content ON messages
WHEN NEW.content IS NOT OLD.content
  AND NEW.search_text IS NOT NULL
  AND NEW.search_text IS OLD.search_text
BEGIN
  UPDATE messages SET search_text = NULL WHERE org_id = NEW.org_id AND id = NEW.id;
END;
