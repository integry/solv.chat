-- Text blocks that repeat across a source's pages (issue #127; see
-- "Repeated blocks" in docs/architecture.md). A block of text found on a
-- large share of one source's pages is page chrome however it is marked up,
-- and is left out when the source's pages are chunked. Only hashes are
-- stored here, never the text: the text stays in each document's R2 body.
--
-- document_blocks: the distinct block hashes of each indexed page, written
-- by the queue consumer in the batch that commits the page's chunks. A hash
-- is "b" + 16 hex (a paragraph, list or code block) or "h" + 16 hex (a
-- heading with its immediate body). Deleted with the document.
CREATE TABLE document_blocks (
  org_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  PRIMARY KEY (org_id, document_id, block_hash),
  FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id) ON DELETE CASCADE
);
CREATE INDEX document_blocks_source ON document_blocks(org_id, source_id, block_hash);

-- source_blocks: on how many of the source's pages each hash is, kept by the
-- triggers below so no write path (a commit, a prune, a sync's removals, a
-- deleted source) can leave it wrong, and so finding the repeated blocks
-- reads only the few rows over the threshold.
CREATE TABLE source_blocks (
  org_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  pages INTEGER NOT NULL,
  PRIMARY KEY (org_id, source_id, block_hash),
  FOREIGN KEY (org_id, source_id) REFERENCES sources(org_id, id) ON DELETE CASCADE
);
CREATE INDEX source_blocks_pages ON source_blocks(org_id, source_id, pages);

CREATE TRIGGER document_blocks_count_insert AFTER INSERT ON document_blocks
BEGIN
  INSERT OR IGNORE INTO source_blocks (org_id, source_id, block_hash, pages)
  VALUES (NEW.org_id, NEW.source_id, NEW.block_hash, 0);
  UPDATE source_blocks SET pages = pages + 1
   WHERE org_id = NEW.org_id AND source_id = NEW.source_id AND block_hash = NEW.block_hash;
END;

CREATE TRIGGER document_blocks_count_delete AFTER DELETE ON document_blocks
BEGIN
  UPDATE source_blocks SET pages = pages - 1
   WHERE org_id = OLD.org_id AND source_id = OLD.source_id AND block_hash = OLD.block_hash;
  DELETE FROM source_blocks
   WHERE org_id = OLD.org_id AND source_id = OLD.source_id AND block_hash = OLD.block_hash
     AND pages <= 0;
END;

-- sources.repeated_blocks: the source's repeated block hashes as last
-- worked out (a sorted JSON array). Compared with the counts after every
-- commit; when it changes, the pages holding a hash that changed are queued
-- to be cleaned (or given the block back).
ALTER TABLE sources ADD COLUMN repeated_blocks TEXT NOT NULL DEFAULT '[]';

-- documents.repeated_key: which of the page's own blocks were repeated when
-- its chunks were built ('' for none; a hash of their sorted hashes
-- otherwise); NULL until a page's blocks are recorded (and always for
-- written answers, which this never touches). A page whose key no longer
-- matches the source's repeated blocks is built again from its stored text.
ALTER TABLE documents ADD COLUMN repeated_key TEXT;
