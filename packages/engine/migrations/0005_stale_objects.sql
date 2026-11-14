-- Durable R2 object cleanup tracking when an in-flight push completes after
-- document deletion (F9). No ON DELETE CASCADE from documents so unresolved
-- obligations survive document deletion until R2 removal is confirmed.
CREATE TABLE stale_objects (
  object_key TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  document_id TEXT NOT NULL
);
CREATE INDEX stale_objects_doc ON stale_objects(org_id, document_id);
