-- How a "Try it" preview or an answer test was made (see "Answer traces" in
-- docs/architecture.md). Neither stores a message, so neither can keep its
-- trace in `message_traces`; they get this table instead, which no report
-- reads: Overview, Reports, Gaps and Conversations count visitor replies
-- only, and a preview never becomes one.
--
-- `id` is the reply id the preview's `done` event carried, the one the admin
-- pane holds. `source` marks where it came from; a test run's trace also
-- names the run and the test (`run_id`, `test_id`, no foreign key: the run's
-- row is written once every test has answered, after these). Tokens and cost
-- are kept here because there is no message row to read them from. Deleting
-- the assistant deletes them. Each write keeps only the newest
-- `MAX_PREVIEW_TRACES` (src/db/traces.ts) per assistant, so a long Try it
-- session cannot grow this without bound. Same 32 KiB backstop as
-- `message_traces`.
CREATE TABLE preview_traces (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('try_it', 'test_run')),
  run_id TEXT,
  test_id TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER,
  detail TEXT NOT NULL CHECK (length(CAST(detail AS BLOB)) <= 32768),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id) ON DELETE CASCADE
);
-- The pruning on each write reads an assistant's newest rows.
CREATE INDEX preview_traces_assistant ON preview_traces(org_id, assistant_id, created_at);

-- `messages.topic_id` references `topics(id)` (0028), and deleting a topic
-- (directly, by merge, or by deleting its assistant) makes SQLite find every
-- message that names it. `messages_org_topic` leads with `org_id`, so it
-- cannot serve that lookup, and each delete scanned the whole table across
-- every org. Partial, like `messages_org_topic`: most messages have no topic,
-- and `topic_id = ?` lets SQLite use it.
CREATE INDEX messages_topic ON messages(topic_id) WHERE topic_id IS NOT NULL;

-- 0027 created `messages_org_outcome` for Gaps and the outcome filters. With
-- table statistics SQLite plans none of them through it (Gaps starts from the
-- assistant's conversations, the filters from `messages_conversation`, the
-- reports from the role and time index), and without statistics it picked it
-- for the Conversations outcome filter, a worse plan that reads every
-- declined reply in the org per conversation. Fresh databases no longer
-- create it; this removes it where 0027 already did.
DROP INDEX IF EXISTS messages_org_outcome;
