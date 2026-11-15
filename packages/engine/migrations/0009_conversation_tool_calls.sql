-- Track per-conversation tool call expenditure atomically on the conversation row
-- so failed answers and concurrent requests cannot exceed the per-conversation cap.
ALTER TABLE conversations ADD COLUMN tool_calls_used INTEGER NOT NULL DEFAULT 0;
