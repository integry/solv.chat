/**
 * Which retrieved chunks reach the model: the score floor and the one rule
 * that bends it.
 *
 * The floor only has to keep out content unrelated to the question. The
 * answering model already declines when it is given content that does not
 * hold the answer, so a floor set inside the range of answerable questions
 * refuses questions the content plainly answers.
 *
 * The provider documents no threshold to copy: OpenAI's embeddings are
 * normalized to length 1, cosine similarity is the recommended measure, and
 * the guide only compares scores with each other ("small distances suggest
 * high relatedness"), giving no absolute cut-off for `text-embedding-3-small`.
 * Source (checked 2026-11-19):
 * https://developers.openai.com/api/docs/guides/embeddings#which-distance-function-should-i-use
 * So the default is measured, not documented. On a deployed instance with
 * `text-embedding-3-small` and two short owner-written answers, answerable
 * questions scored 0.25 to 0.43, an on-topic question the content did not
 * answer 0.33 (the model said it did not know), and unrelated questions about
 * 0.00. The gap is between about 0.05 and 0.25; 0.2 sits in it, below the
 * lowest answerable score with room for slightly worse phrasing, and well
 * above unrelated content.
 */
export const DEFAULT_SCORE_FLOOR = 0.2;

/**
 * How far under the floor a chunk may score and still be kept, only when a
 * chunk of the same document is already kept on its own score. A document's
 * second chunk (the rest of a list of opening hours, say) often scores a
 * little lower than its first; it is never an unrelated page, because its
 * document already cleared the floor.
 */
export const SAME_DOCUMENT_MARGIN = 0.05;

/** The range `SOLV_SCORE_FLOOR` may take; anything else falls back to the default. */
export const MIN_SCORE_FLOOR = 0;
export const MAX_SCORE_FLOOR = 0.9;

export interface ScoreFloorEnv {
  /** Optional override of the retrieval score floor, a number from 0 to 0.9. */
  SOLV_SCORE_FLOOR?: string | undefined;
}

let warnedInvalidFloor = false;

/**
 * The floor this instance uses: `SOLV_SCORE_FLOOR` when it is a number from
 * 0 to 0.9, the default otherwise (unset, empty, not a number, out of range).
 * An invalid value is warned about once, without its content.
 */
export function scoreFloorFrom(env: ScoreFloorEnv): number {
  const raw = env.SOLV_SCORE_FLOOR;
  if (raw === undefined || raw.trim() === "") return DEFAULT_SCORE_FLOOR;
  const trimmed = raw.trim();
  // Number("") and Number(" ") are 0, and Number("0x1") is 1: only a plain
  // decimal is accepted.
  const value = /^\d+(\.\d+)?$|^\.\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isFinite(value) && value >= MIN_SCORE_FLOOR && value <= MAX_SCORE_FLOOR) {
    return value;
  }
  if (!warnedInvalidFloor) {
    warnedInvalidFloor = true;
    console.warn(
      `Unrecognised SOLV_SCORE_FLOOR configuration (expected a number from ${MIN_SCORE_FLOOR} to ${MAX_SCORE_FLOOR}); falling back to default (${DEFAULT_SCORE_FLOOR}).`,
    );
  }
  return DEFAULT_SCORE_FLOOR;
}

/**
 * The most chunks one document gives the model while chunks of other
 * documents clear the floor and are left over. Two of `TOP_K`'s six means
 * at least three documents when there are three to give, and still about
 * 2,400 characters of a page that holds the answer. It is lifted when there
 * are not enough other chunks to fill the set (see `selectCandidates`). Ours;
 * issue #123 saw three of six chunks come from one page's chrome.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 2;

/** Why a chunk that cleared the floor was still not given to the model. */
export type SelectionDropReason =
  /** Its text, title and heading path are the same as a better-scored chunk's. */
  | "duplicate"
  /** Its document already gave `MAX_CHUNKS_PER_DOCUMENT`, and others filled the set. */
  | "document_cap"
  /** `TOP_K` better chunks filled the set. */
  | "rank";

export interface SelectableChunk {
  chunkId: string;
  score: number;
  documentId: string;
  /** Compared for duplicates; left out, a chunk is never a duplicate. */
  text?: string | undefined;
  /**
   * The chunk's subject: its document's title and heading path. Two chunks
   * are duplicates only when these match as well as the text, so the same
   * answer ("30 days.") to two different questions is kept twice.
   */
  title?: string | undefined;
  headingPath?: string | undefined;
  /** `entry` marks an owner-written answer, which has a reserved place. */
  sourceKind?: "push" | "sitemap" | "entry" | undefined;
}

export interface SelectionOptions {
  /** How many chunks the model is given at most; the answer path passes `TOP_K`. */
  topK?: number | undefined;
  /** Defaults to `MAX_CHUNKS_PER_DOCUMENT`. */
  maxPerDocument?: number | undefined;
}

export interface Selection<T> {
  /** The chunks given to the model, best first. */
  chunks: T[];
  /** Why each chunk that was eligible (on or near the floor) was not given. */
  dropped: Map<string, SelectionDropReason>;
}

/**
 * What makes two chunks interchangeable: the same subject (title and heading
 * path) and the same text, with only runs of whitespace told apart. Nothing
 * looser: a word set ignores order and punctuation, so it calls a sentence
 * and its negation the same, and the same body under another title answers
 * another question. A written answer's question vector, which holds its
 * first chunk's text under the same headings, matches that chunk exactly.
 */
function duplicateKey(chunk: SelectableChunk): string | null {
  if (chunk.text === undefined) return null;
  const squash = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify([squash(chunk.title), squash(chunk.headingPath), squash(chunk.text)]);
}

/**
 * Which retrieved chunks reach the model, and why the others that cleared
 * the floor did not. In order:
 *
 * 1. The floor: every chunk at or above it, and one up to
 *    `SAME_DOCUMENT_MARGIN` under it only when a chunk of the same document
 *    is at or above it. Nothing is eligible when no chunk clears the floor,
 *    so off-topic questions still find nothing.
 * 2. Duplicates: of chunks with the same text, title and heading path
 *    (`duplicateKey`) only the best-scored is kept, except that a written
 *    answer is kept over a page chunk it duplicates. Text that differs in
 *    any word, or the same text about another subject, is kept.
 * 3. The written-answer reservation: the best-scoring written answer
 *    (`sourceKind: "entry"`) at or above the floor itself is always given,
 *    in place of the lowest-scored chunk if the set is full. An owner's
 *    written answer is the most deliberate content there is; page chunks
 *    must not crowd it out.
 * 4. The rest by score, at most `maxPerDocument` from one document; when
 *    that leaves the set short of `topK`, the capped chunks fill it, best
 *    first, so a site with one relevant page still gets its chunks.
 */
export function selectCandidates<T extends SelectableChunk>(
  chunks: readonly T[],
  floor: number,
  options: SelectionOptions = {},
): Selection<T> {
  const topK = options.topK ?? Number.POSITIVE_INFINITY;
  const maxPerDocument = options.maxPerDocument ?? MAX_CHUNKS_PER_DOCUMENT;
  const dropped = new Map<string, SelectionDropReason>();
  const ordered = [...chunks].sort((a, b) => b.score - a.score);

  const cleared = new Set(ordered.filter((c) => c.score >= floor).map((c) => c.documentId));
  const eligible = ordered.filter(
    (c) =>
      c.score >= floor || (cleared.has(c.documentId) && c.score >= floor - SAME_DOCUMENT_MARGIN),
  );

  // 2. Duplicates, best first; a written answer takes its duplicate's place.
  const unique: Array<{ chunk: T }> = [];
  const byKey = new Map<string, { chunk: T }>();
  for (const chunk of eligible) {
    const key = duplicateKey(chunk);
    const twin = key === null ? undefined : byKey.get(key);
    if (twin === undefined) {
      const kept = { chunk };
      unique.push(kept);
      if (key !== null) byKey.set(key, kept);
    } else if (chunk.sourceKind === "entry" && twin.chunk.sourceKind !== "entry") {
      dropped.set(twin.chunk.chunkId, "duplicate");
      twin.chunk = chunk;
    } else {
      dropped.set(chunk.chunkId, "duplicate");
    }
  }
  const candidates = unique.map((u) => u.chunk).sort((a, b) => b.score - a.score);

  // 3. The reserved written answer.
  const reserved = candidates.find((c) => c.sourceKind === "entry" && c.score >= floor);

  // 4. The rest, with the per-document cap and its exception.
  const picked = new Set<T>(reserved !== undefined && topK > 0 ? [reserved] : []);
  const perDocument = new Map<string, number>();
  if (reserved !== undefined) perDocument.set(reserved.documentId, 1);
  const capped: T[] = [];
  for (const chunk of candidates) {
    if (picked.has(chunk)) continue;
    if (picked.size >= topK) break;
    const count = perDocument.get(chunk.documentId) ?? 0;
    if (count >= maxPerDocument) {
      capped.push(chunk);
      continue;
    }
    perDocument.set(chunk.documentId, count + 1);
    picked.add(chunk);
  }
  for (const chunk of capped) {
    if (picked.size >= topK) break;
    picked.add(chunk);
  }
  const cappedLeft = new Set(capped.filter((c) => !picked.has(c)));
  for (const chunk of candidates) {
    if (picked.has(chunk)) continue;
    dropped.set(chunk.chunkId, cappedLeft.has(chunk) ? "document_cap" : "rank");
  }
  return { chunks: candidates.filter((c) => picked.has(c)), dropped };
}

/** The chunks `selectCandidates` gives the model, best first. */
export function selectChunks<T extends SelectableChunk>(
  chunks: readonly T[],
  floor: number,
  options: SelectionOptions = {},
): T[] {
  return selectCandidates(chunks, floor, options).chunks;
}
