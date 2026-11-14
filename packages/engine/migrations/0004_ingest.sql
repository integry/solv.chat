-- Default push source uniqueness: at most one default push source per
-- assistant, while allowing additional explicitly selected push sources.
ALTER TABLE sources ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
CREATE UNIQUE INDEX sources_default_push
  ON sources(org_id, assistant_id)
  WHERE kind = 'push' AND is_default = 1;

-- Last content_hash successfully indexed into chunks; null until first indexed.
ALTER TABLE documents ADD COLUMN indexed_hash TEXT;
