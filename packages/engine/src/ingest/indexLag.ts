/**
 * How long the vector index takes to reflect a change, and what the engine
 * does about it. Vectorize applies every write asynchronously:
 *
 * - "Vectorize inserts are asynchronous … It typically takes a few seconds
 *   for inserted vectors to be available for querying"; the same for
 *   upserts, and for deletes "It typically takes a few seconds for vectors
 *   to be removed from the Vectorize index".
 *   Source: https://developers.cloudflare.com/vectorize/reference/client-api/ — checked 2026-11-20
 * - Writes go to a write-ahead log at once; "To make these writes visible
 *   for reads, an asynchronous job needs to read the current index files
 *   from R2", build an updated index and commit it, in batches of up to
 *   200,000 vectors or 1,000 updates. A large batched load "will [be]
 *   visible in queries within minutes"; one-at-a-time writes of the same
 *   load "could take at least an hour".
 *   Source: https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/ — checked 2026-11-20
 * - The index reports `processedUpToMutation`: "All changes before this
 *   mutation will be reflected in the index state", so mutations are
 *   applied in the order they were made.
 *   Source: `VectorizeIndexInfo` in @cloudflare/workers-types 4 — checked 2026-11-20
 *
 * No upper bound is documented, so both windows below are ours.
 */

/**
 * How long after an assistant's last change to its searchable content
 * (chunks committed, documents deleted, a Rebuild queued) the admin says
 * that answers may not show it yet. "A few seconds" is the typical case;
 * a large import is "within minutes". Ten minutes covers the second with
 * room, and an owner who sees the notice a little longer loses nothing.
 */
export const INDEX_SETTLE_MS = 10 * 60 * 1000;

/**
 * How long a replaced chunk's text stays readable for answers after a
 * re-index or update (`retired_chunks`). The new vectors are written
 * before the old ones are deleted, and the index applies them in that
 * order, so a page always has vectors in the index; but the old chunks'
 * D1 rows go at the commit, while their vectors are still what the index
 * returns. Kept this long, a hit on an old vector still finds its text
 * until the delete is applied. An hour is the slowest the documentation
 * describes ("at least an hour" for unbatched writes); a delete applied
 * later still costs nothing but a stale hit, which the answer path
 * replaces by searching again (see `searchPool` in `chat/answer.ts`).
 */
export const RETIRED_CHUNK_KEEP_MS = 60 * 60 * 1000;
