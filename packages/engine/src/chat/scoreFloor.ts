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
 * The chunks given to the model, in retrieval order: every chunk at or above
 * the floor, and a chunk up to `SAME_DOCUMENT_MARGIN` under it only when a
 * chunk of the same document is at or above the floor. Nothing is kept when
 * no chunk clears the floor, so off-topic questions still find nothing.
 */
export function selectChunks<T extends { score: number; documentId: string }>(
  chunks: readonly T[],
  floor: number,
): T[] {
  const documents = new Set(chunks.filter((c) => c.score >= floor).map((c) => c.documentId));
  return chunks.filter(
    (c) =>
      c.score >= floor || (documents.has(c.documentId) && c.score >= floor - SAME_DOCUMENT_MARGIN),
  );
}
