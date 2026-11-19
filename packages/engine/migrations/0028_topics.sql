-- Topics for visitor questions (see "Topics" in docs/architecture.md). The
-- answer review names one for each reviewed question: one of the assistant's
-- existing topics, or a new short label it proposes. Owners rename, merge and
-- delete them in Reports.
--
-- Per assistant and per org. `name_key` is the name folded for comparison
-- (Unicode NFKC, lowercase, whitespace runs collapsed; `topicKey` in
-- @solvchat/core, src/schemas/topic.ts), unique per assistant: two reviews
-- proposing the same new topic at once both insert with ON CONFLICT DO
-- NOTHING and both read back the one row that won. Deleting the assistant deletes its topics.
CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  -- Folding can lengthen a name (a dotted capital I lowercases to two code
  -- points), so the key gets room for that.
  name_key TEXT NOT NULL CHECK (length(name_key) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  UNIQUE (org_id, assistant_id, name_key),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id) ON DELETE CASCADE
);

-- The topic is stored on the visitor's question (the `user` message), not on
-- the reply: a topic describes what was asked, the Topics list counts
-- questions asked (as "Questions asked" does), and the Conversations filter
-- finds the conversations where a visitor asked about it, as `question=`
-- does. The reply is reached through its `reply_to` link for the share that
-- could not be answered. NULL: not reviewed (older rows, "Review answers" off,
-- the spend cap reached, a failed review) or its topic was deleted.
ALTER TABLE messages ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL;

-- The Topics report and the Conversations filter read a period's questions
-- by topic; merge and delete move or clear every question of one topic.
CREATE INDEX messages_org_topic ON messages(org_id, topic_id, created_at)
  WHERE topic_id IS NOT NULL;
