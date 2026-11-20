-- Which version of the ingest pipeline a document was made with (see
-- "Re-indexing" in docs/architecture.md). Issue #123 changed how pages are
-- read (page chrome and link lists left out), how they are cut into chunks
-- (no chunk under a minimum size) and what each chunk is embedded as, so
-- chunks stored before it are rebuilt once, without the owner adding the
-- content again.
--
-- ingest_version: the version the document's searchable chunks were built
-- with. Written by the queue consumer in the batch that commits the chunks.
-- Every row stored before this was built by version 1.
--
-- page_version: for a page fetched from a sitemap, the version of the
-- HTML-to-text extraction its stored text came from; NULL for pushed and
-- written content and for pages fetched before this. A scheduled sync
-- fetches a page whose page_version is older than the engine's again, in
-- full (no conditional request, no skip on an unchanged <lastmod>), once.
ALTER TABLE documents ADD COLUMN ingest_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN page_version INTEGER;
