-- "Send conversation context": when 1, requests the engine makes to this MCP
-- server carry the Solv-Conversation-Id, Solv-Visitor-Id and Solv-Assistant-Id
-- headers. Off for every server, existing and new, until the owner turns it on.
-- Numbered 0025 so it cannot collide with 0022 to 0024 on the content-sync epic.
ALTER TABLE mcp_servers ADD COLUMN send_conversation_context INTEGER NOT NULL DEFAULT 0
  CHECK (send_conversation_context IN (0, 1));
