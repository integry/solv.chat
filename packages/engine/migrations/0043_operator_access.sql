CREATE TABLE operator_grants (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'full')),
  resource TEXT NOT NULL,
  client_id TEXT,
  redirect_uri TEXT,
  challenge TEXT,
  code_hash TEXT,
  access_hash TEXT,
  refresh_hash TEXT,
  expires_at INTEGER,
  access_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  call_window INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  PRIMARY KEY (org_id, id),
  FOREIGN KEY (org_id, parent_id) REFERENCES operator_grants(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX operator_access_hash ON operator_grants(org_id, access_hash) WHERE access_hash IS NOT NULL;
CREATE UNIQUE INDEX operator_code_hash ON operator_grants(org_id, code_hash) WHERE code_hash IS NOT NULL;
CREATE UNIQUE INDEX operator_refresh_hash ON operator_grants(org_id, refresh_hash) WHERE refresh_hash IS NOT NULL;
CREATE INDEX operator_grants_user ON operator_grants(org_id, user_id, resource);
CREATE INDEX operator_grants_expiry ON operator_grants(org_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX operator_grants_parent ON operator_grants(org_id, parent_id);

CREATE TABLE operator_spent_refresh (
  org_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (org_id, hash),
  FOREIGN KEY (org_id, grant_id) REFERENCES operator_grants(org_id, id) ON DELETE CASCADE
);
CREATE INDEX operator_spent_grant ON operator_spent_refresh(org_id, grant_id);

CREATE TRIGGER operator_save_spent_refresh AFTER UPDATE OF refresh_hash ON operator_grants
WHEN OLD.refresh_hash IS NOT NULL AND NEW.refresh_hash <> OLD.refresh_hash
BEGIN
  INSERT INTO operator_spent_refresh (org_id, grant_id, hash)
  VALUES (OLD.org_id, OLD.id, OLD.refresh_hash);
END;
