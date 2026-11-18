-- When a conversation's newest message was written (`started_at` while it has
-- none), stored so the Conversations list can order by it from an index
-- instead of reading every conversation's messages for each page.
ALTER TABLE conversations ADD COLUMN last_message_at INTEGER;

UPDATE conversations SET last_message_at = COALESCE(
  (SELECT MAX(m.created_at) FROM messages m
    WHERE m.org_id = conversations.org_id AND m.conversation_id = conversations.id),
  started_at);

CREATE INDEX conversations_last_message
  ON conversations(org_id, assistant_id, last_message_at, id);

-- Kept by triggers rather than by the engine's writes, so an older Worker
-- still serving while this deploys keeps it right too.
CREATE TRIGGER conversations_last_message_at_start AFTER INSERT ON conversations
WHEN NEW.last_message_at IS NULL
BEGIN
  UPDATE conversations SET last_message_at = NEW.started_at
   WHERE org_id = NEW.org_id AND id = NEW.id;
END;

CREATE TRIGGER messages_last_message_at_insert AFTER INSERT ON messages
BEGIN
  UPDATE conversations SET last_message_at = (
    SELECT MAX(m.created_at) FROM messages m
     WHERE m.org_id = NEW.org_id AND m.conversation_id = NEW.conversation_id)
   WHERE org_id = NEW.org_id AND id = NEW.conversation_id;
END;

CREATE TRIGGER messages_last_message_at_delete AFTER DELETE ON messages
BEGIN
  UPDATE conversations SET last_message_at = COALESCE(
    (SELECT MAX(m.created_at) FROM messages m
      WHERE m.org_id = OLD.org_id AND m.conversation_id = OLD.conversation_id),
    started_at)
   WHERE org_id = OLD.org_id AND id = OLD.conversation_id;
END;
