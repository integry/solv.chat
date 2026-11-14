-- Links an unanswered message to the entry document written to answer it.
CREATE TABLE gap_answers (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  message_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, message_id),
  FOREIGN KEY (org_id, message_id) REFERENCES messages(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
);
