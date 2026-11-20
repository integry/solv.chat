/**
 * The ingest pipeline's version, stored with each document (migration 0033).
 *
 * `INGEST_VERSION` covers what turns a document's stored text into
 * searchable chunks: the chunker and the text each chunk is embedded as.
 * A document indexed by an older version is rebuilt from its stored text
 * once: by the admin's "Rebuild" on Sources, or by the next scheduled sync
 * of its source, even when the page is unchanged. Version 1 is everything
 * before issue #123; 2 added the minimum chunk size, the bounded heading
 * context and a written answer's question vector.
 *
 * `PAGE_TEXT_VERSION` covers how a fetched HTML page becomes text
 * (`extractHtml`). A page's stored text cannot be re-read without the page,
 * so only a sync (which fetches it) brings a page from an older version up
 * to date. Version 1 is everything before issue #123; 2 leaves out page
 * chrome and link lists.
 *
 * Bump one when a change to its part would make existing documents worse
 * than new ones.
 */
export const INGEST_VERSION = 2;
export const PAGE_TEXT_VERSION = 2;
