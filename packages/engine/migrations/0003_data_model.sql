CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  -- The widget sends this in the clear, so it identifies and never authorises.
  public_key TEXT NOT NULL UNIQUE,
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  -- Hash only: an ingest key is shown once at creation and never returned.
  ingest_key_hash TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id)
);
CREATE INDEX assistants_org ON assistants(org_id);
CREATE INDEX assistants_ingest_key ON assistants(ingest_key_hash) WHERE ingest_key_hash IS NOT NULL;

CREATE TABLE assistant_versions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'published', 'archived')),
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id)
);
-- The spec's invariant, enforced by the database rather than handler
-- discipline, so a publish bug fails loudly instead of leaving two drafts.
CREATE UNIQUE INDEX versions_one_draft ON assistant_versions(assistant_id) WHERE state = 'draft';
CREATE UNIQUE INDEX versions_one_published ON assistant_versions(assistant_id) WHERE state = 'published';
CREATE INDEX versions_assistant ON assistant_versions(org_id, assistant_id, created_at);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('push', 'sitemap', 'entry')),
  label TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id)
);
CREATE INDEX sources_assistant ON sources(org_id, assistant_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES sources(org_id, id)
);
-- Unique on the pushed identity: what makes a repeat push an update rather
-- than a duplicate, and what `prune` deletes against.
CREATE UNIQUE INDEX documents_identity ON documents(org_id, source_id, external_id);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id)
);
CREATE INDEX chunks_document ON chunks(org_id, document_id, ordinal);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  page_url TEXT NOT NULL DEFAULT '',
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id)
);
CREATE INDEX conversations_assistant ON conversations(org_id, assistant_id, started_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  tool_calls TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  -- answered is 0/1: D1 has no boolean. The accessor surfaces it as one so no
  -- screen has to remember the encoding. This index is what Gaps reads.
  answered INTEGER NOT NULL DEFAULT 1 CHECK (answered IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES conversations(org_id, id)
);
CREATE INDEX messages_conversation ON messages(org_id, conversation_id, created_at);
CREATE INDEX messages_unanswered ON messages(org_id, answered, created_at);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  message_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('up', 'down')),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id)
);
CREATE UNIQUE INDEX feedback_unique ON feedback(org_id, message_id, visitor_id);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none', 'static_header')),
  secret_ciphertext TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id)
);
CREATE INDEX mcp_servers_assistant ON mcp_servers(org_id, assistant_id);

CREATE TABLE mcp_tools (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  input_schema TEXT NOT NULL DEFAULT '{}',
  allowed INTEGER NOT NULL DEFAULT 0 CHECK (allowed IN (0, 1)),
  FOREIGN KEY (org_id, server_id) REFERENCES mcp_servers(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX mcp_tools_server_name ON mcp_tools(org_id, server_id, name);

CREATE TABLE tests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  assistant_id TEXT NOT NULL,
  question TEXT NOT NULL,
  expectation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (org_id, assistant_id) REFERENCES assistants(org_id, id)
);
CREATE INDEX tests_assistant ON tests(org_id, assistant_id);

CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  version_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  results TEXT NOT NULL DEFAULT '[]',
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  FOREIGN KEY (org_id, version_id) REFERENCES assistant_versions(org_id, id)
);
CREATE INDEX test_runs_version ON test_runs(org_id, version_id, started_at);
