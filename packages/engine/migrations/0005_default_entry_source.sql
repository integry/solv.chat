-- Default entry source uniqueness: at most one default entry source per
-- assistant, while allowing additional explicitly created entry sources.
CREATE UNIQUE INDEX sources_default_entry
  ON sources(org_id, assistant_id)
  WHERE kind = 'entry' AND is_default = 1;
