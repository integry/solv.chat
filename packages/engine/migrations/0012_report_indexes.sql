-- Reports filter messages by org, role and time window. Existing indexes on
-- `messages` start with `(org_id, conversation_id)`, `(org_id, answered)` or
-- `(org_id, question_key)`, which caused EXPLAIN QUERY PLAN to scan every
-- message in the org regardless of date range.
CREATE INDEX messages_role_created ON messages(org_id, role, created_at);
