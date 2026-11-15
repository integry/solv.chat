-- Each assistant reply names the visitor message it answers. Two requests in
-- one conversation can interleave (both append a question, then both reply),
-- so "the latest question before this reply" can be the wrong one; Gaps,
-- "Write the right answer" and the conversation view read this link instead.
ALTER TABLE messages ADD COLUMN reply_to TEXT;

-- The visitor's question, normalised (trimmed, lowercased, whitespace runs
-- collapsed) when the engine writes it, so Gaps and Overview group in SQL
-- instead of loading every row into the Worker.
ALTER TABLE messages ADD COLUMN question_key TEXT;

-- Rows written before this migration: the nearest preceding question, by
-- time and then by insertion order, is the best evidence there is.
UPDATE messages SET reply_to = (
  SELECT q.id FROM messages AS q
   WHERE q.org_id = messages.org_id
     AND q.conversation_id = messages.conversation_id
     AND q.role = 'user'
     AND (q.created_at < messages.created_at
          OR (q.created_at = messages.created_at AND q.rowid < messages.rowid))
   ORDER BY q.created_at DESC, q.rowid DESC
   LIMIT 1
)
WHERE role = 'assistant';

-- SQLite has no regular expressions: tabs, newlines, vertical tab and form
-- feed become spaces, then each pass halves every run of spaces (eight passes
-- collapse runs of up to 256). The engine computes the key for new rows.
UPDATE messages SET question_key = lower(trim(
  replace(replace(replace(replace(replace(content,
    char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' ')
))
WHERE role = 'user';
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;
UPDATE messages SET question_key = replace(question_key, '  ', ' ') WHERE instr(question_key, '  ') > 0;

CREATE INDEX messages_reply_to ON messages(org_id, reply_to);
CREATE INDEX messages_question_key ON messages(org_id, question_key);
