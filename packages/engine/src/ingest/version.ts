/**
 * The ingest pipeline's version, stored with each document (migration 0033).
 *
 * `INGEST_VERSION` covers what turns a document's stored text into
 * searchable chunks: the chunker and the text each chunk is embedded as.
 * A document indexed by an older version is rebuilt from its stored text
 * once: by the admin's "Rebuild" on Sources, or by the next scheduled sync
 * of its source, even when the page is unchanged. Version 1 is everything
 * before issue #123; 2 added the minimum chunk size, the bounded heading
 * context and a written answer's question vector; 3 leaves out the blocks
 * that repeat across most of a source's pages and records each page's
 * block hashes (issue #127), so every page is read once to count them.
 *
 * `PAGE_TEXT_VERSION` covers how a fetched HTML page becomes text
 * (`extractHtml`). A page's stored text cannot be re-read without the page,
 * so only a sync (which fetches it) brings a page from an older version up
 * to date. Version 1 is everything before issue #123; 2 leaves out page
 * chrome and link lists; 3 (issue #128) applies the end tags HTML lets a page
 * leave out, so an unclosed `<li>` or `<p>` no longer runs on to the end of
 * the page.
 *
 * Bump one when a change to its part would make existing documents worse
 * than new ones.
 */
export const INGEST_VERSION = 3;
export const PAGE_TEXT_VERSION = 3;

/**
 * The oldest ingest version that embeds a chunk exactly as the current one
 * does (the same `embeddingInput` for the same text and heading path). A
 * document of at least this version that is rebuilt into the very chunks it
 * has keeps their vectors instead of being embedded again. Version 3 only
 * added the repeated-block check before chunking (issue #127), so a version 2
 * page with no repeated blocks costs a D1 write, not an embedding.
 */
export const EMBEDDINGS_REUSABLE_FROM = 2;
