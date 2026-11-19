import { isReviewFailure, type ReviewFailure } from "@solvchat/core";
import type { KeyProvider, LlmProviderName } from "../seams/types.js";

/**
 * How one assistant answer was made: what retrieval considered, which version
 * and model answered, how long it took and why it stopped. It holds
 * references, never copies: chunk and document ids with scores, a version id,
 * a model id. No prompt, chunk text or tool output is ever put in it, and no
 * key material: only where the key came from.
 */

export const TRACE_VERSION = 1;
/** Candidates kept per request. The retriever is asked for `TOP_K` today; this is the ceiling. */
export const MAX_TRACE_CANDIDATES = 20;
/**
 * Requests kept per message: the first answer and up to seven page-action
 * resumes of it. The per-conversation tool-call cap ends a longer chain first.
 */
export const MAX_TRACE_PARTS = 8;
/**
 * The stored JSON for one message never exceeds this many UTF-8 bytes. The
 * fullest trace the engine can write (8 parts of 20 candidates) is about
 * 20 KiB, and a typical one (one part, `TOP_K` candidates) under 1 KiB;
 * anything larger is cut down by `boundTrace` before it is written, and
 * migration 0026 refuses a longer row as a backstop.
 */
export const MAX_TRACE_BYTES = 32 * 1024;
/**
 * Bytes `boundTrace` leaves free for the answer review's note (`review`),
 * which is written later, into the stored JSON, without re-bounding it. The
 * largest note is under 70 bytes.
 */
export const TRACE_REVIEW_RESERVE_BYTES = 128;
/** Scores are kept to four decimal places: enough to rank, and a third of the bytes. */
const SCORE_PLACES = 10_000;
const MAX_ID_CHARS = 256;

/** Why a retrieved chunk was not given to the model. */
export type TraceDropReason =
  /** Its similarity score was under the floor. */
  | "below_floor"
  /** The vector matched, but its chunk is no longer in D1 (content changed or was removed). */
  | "not_found";

export interface TraceCandidate {
  chunkId: string;
  /** Null when the chunk could not be resolved at answer time. */
  documentId: string | null;
  score: number;
  /** True when the chunk was passed to the model. */
  used: boolean;
  dropped?: TraceDropReason;
}

/**
 * Where the model key came from. `stored`: Settings → Providers. `environment`:
 * a Worker secret. `managed`: the host supplies it (`KeyProvider.managed`).
 */
export type KeySource = "stored" | "environment" | "managed";

/**
 * Where the model key for `provider` comes from, for an answer's trace. Reads
 * which providers have a stored key (names only, never the sealed value) and
 * the seam's own flags: a host that manages keys and allows no own key
 * always supplies it. Called after the reply is sent, from the trace write,
 * so the visitor never waits on it.
 */
export async function modelKeySource(
  storedKeys: { listKeys(): Promise<readonly { provider: string }[]> },
  keys: Pick<KeyProvider, "managed" | "ownKeysAllowed">,
  provider: LlmProviderName,
): Promise<KeySource> {
  if (keys.managed === true && keys.ownKeysAllowed !== true) return "managed";
  const stored = await storedKeys.listKeys();
  if (stored.some((key) => key.provider === provider)) return "stored";
  return keys.managed === true ? "managed" : "environment";
}

/**
 * Where an answer that stores no message came from. `try_it`: the admin's
 * "Try it" pane. `test_run`: an answer test. Both answer from the draft and
 * are kept apart from visitor replies (`preview_traces`), so no report counts
 * them.
 */
export type PreviewTraceSource = "try_it" | "test_run";

/**
 * Why the answer stopped. `paused` means it is waiting for page actions and a
 * later request continues it. `spend_cap` is kept for hosts whose limits stop
 * an answer part-way; the open engine refuses an over-cap request before it
 * answers, so no stored answer of its own carries it.
 */
export type TraceStop = "complete" | "length" | "spend_cap" | "error" | "paused";

export interface TracePart {
  /** `answer` for the request that wrote the message, `resume` for a page-action continuation. */
  kind: "answer" | "resume";
  version: { id: string; state: "published" | "draft" };
  /**
   * Null when no model was asked (nothing relevant was found). `reasoningOff`:
   * the answer was sent with `reasoning: "off"` (the fast tier). Absent in
   * traces written before it was recorded.
   */
  model: {
    provider: LlmProviderName;
    id: string;
    keySource: KeySource;
    reasoningOff?: boolean;
  } | null;
  retrieval: { floor: number; ms: number; candidates: TraceCandidate[] };
  /** Milliseconds from the start of the request. */
  timing: { firstTokenMs: number | null; totalMs: number };
  tools: { rounds: number; ms: number };
  stop: TraceStop;
}

/**
 * What the answer review left on the trace. `failed`: why its last attempt
 * gave no usable result (a fixed code, never provider or visitor text).
 * `catchUp`: the scheduled catch-up has taken this answer (each answer once).
 * `claimedAt`: when it did, kept until its run ends without a failure (a
 * failure replaces the whole note), so a run cut off after the claim still
 * leaves evidence (`reviewFailureOf`). Absent when the review stored its
 * outcome, or has not run.
 */
export interface TraceReviewNote {
  failed?: ReviewFailure;
  catchUp?: true;
  claimedAt?: number;
}

export interface StoredTrace {
  v: typeof TRACE_VERSION;
  /** Empty when only the review's note was recorded (the answer's own trace write failed). */
  parts: TracePart[];
  /** Set when something had to be left out to stay within `MAX_TRACE_BYTES`. */
  truncated?: true;
  review?: TraceReviewNote;
}

/** The note as stored, keeping only what this engine writes. */
export function readReviewNote(value: unknown): TraceReviewNote | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const note: TraceReviewNote = {
    ...(isReviewFailure(obj.failed) ? { failed: obj.failed } : {}),
    ...(obj.catchUp === true ? { catchUp: true as const } : {}),
    ...(Number.isSafeInteger(obj.claimedAt) && (obj.claimedAt as number) >= 0
      ? { claimedAt: obj.claimedAt as number }
      : {}),
  };
  return note.failed === undefined && note.catchUp === undefined && note.claimedAt === undefined
    ? undefined
    : note;
}

/**
 * How long a catch-up claim may stay open before it counts as cut off. Ours:
 * a claimed review is a few reads, two calls of `REVIEW_TIMEOUT_MS` (10
 * seconds) at most, and a few writes, so one still open after 5 minutes has
 * stopped, and nothing will finish it.
 */
export const REVIEW_CLAIM_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Why an answer has no review result, as the admin reports it: the recorded
 * reason, or `review_error` for an answer the catch-up claimed and never
 * finished (its run was cut off before it could record anything, and no
 * later tick takes it again). Null when the review stored an outcome, is
 * still running, or has not run.
 */
export function reviewFailureOf(
  note: TraceReviewNote | undefined,
  outcome: string | null,
  now: number,
): ReviewFailure | null {
  if (note === undefined) return null;
  if (note.failed !== undefined) return note.failed;
  if (note.claimedAt !== undefined && outcome === null) {
    return now - note.claimedAt >= REVIEW_CLAIM_EXPIRY_MS ? "review_error" : null;
  }
  return null;
}

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function clip(value: string): string {
  return value.length > MAX_ID_CHARS ? value.slice(0, MAX_ID_CHARS) : value;
}

function boundPart(part: TracePart): TracePart {
  return {
    ...part,
    version: { ...part.version, id: clip(part.version.id) },
    model: part.model === null ? null : { ...part.model, id: clip(part.model.id) },
    retrieval: {
      ...part.retrieval,
      candidates: part.retrieval.candidates.slice(0, MAX_TRACE_CANDIDATES).map((c) => ({
        ...c,
        chunkId: clip(c.chunkId),
        documentId: c.documentId === null ? null : clip(c.documentId),
      })),
    },
  };
}

/**
 * Keeps a trace within `MAX_TRACE_BYTES`. Ids are clipped and candidates
 * capped first; if it is still too large, the oldest resumes go (the first
 * answer and the latest request are what explain it), then candidates from
 * the end of each list. Whatever is left out sets `truncated`.
 */
export function boundTrace(trace: StoredTrace): StoredTrace {
  let parts = trace.parts.map(boundPart);
  let truncated =
    trace.truncated === true ||
    trace.parts.some((p) => p.retrieval.candidates.length > MAX_TRACE_CANDIDATES);
  if (parts.length > MAX_TRACE_PARTS) {
    // The first answer, then the newest resumes.
    parts = [parts[0] as TracePart, ...parts.slice(-(MAX_TRACE_PARTS - 1))];
    truncated = true;
  }
  const review = readReviewNote(trace.review);
  const build = (): StoredTrace => ({
    v: TRACE_VERSION,
    parts,
    ...(truncated ? { truncated: true as const } : {}),
    ...(review !== undefined ? { review } : {}),
  });
  // Room is left for a review note written later, straight into the JSON.
  const limit = MAX_TRACE_BYTES - TRACE_REVIEW_RESERVE_BYTES;
  let out = build();
  while (byteLength(out) > limit && parts.length > 2) {
    parts = [parts[0] as TracePart, ...parts.slice(2)];
    truncated = true;
    out = build();
  }
  while (byteLength(out) > limit) {
    const longest = parts.reduce(
      (best, p, i) =>
        p.retrieval.candidates.length > (parts[best]?.retrieval.candidates.length ?? 0) ? i : best,
      0,
    );
    const target = parts[longest];
    if (!target || target.retrieval.candidates.length === 0) {
      // Nothing left to drop: a trace this large cannot come from the engine.
      return { v: TRACE_VERSION, parts: [], truncated: true, ...(review ? { review } : {}) };
    }
    parts = parts.map((p, i) =>
      i === longest
        ? { ...p, retrieval: { ...p.retrieval, candidates: p.retrieval.candidates.slice(0, -1) } }
        : p,
    );
    truncated = true;
    out = build();
  }
  return out;
}

/** Reads a stored trace, or null when the JSON is not one this engine wrote. */
export function parseStoredTrace(raw: string): StoredTrace | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.v !== TRACE_VERSION || !Array.isArray(obj.parts)) return null;
  const review = readReviewNote(obj.review);
  return {
    v: TRACE_VERSION,
    parts: obj.parts as TracePart[],
    ...(obj.truncated === true ? { truncated: true as const } : {}),
    ...(review !== undefined ? { review } : {}),
  };
}

/**
 * Times one request through the answer path. One clock, read here and
 * nowhere else in the pipeline, so the numbers in a trace are measured the
 * same way every time.
 */
export interface AnswerRecorder {
  /** Runs `work` and adds its duration to the retrieval time. */
  retrieval<T>(work: () => Promise<T>): Promise<T>;
  /** Marks the first token sent to the visitor; later calls are ignored. */
  firstToken(): void;
  /** Counts one round of tool calls and its duration. */
  toolRound(ms: number): void;
  /** What has been measured so far, with the total up to now. */
  snapshot(): {
    retrievalMs: number;
    firstTokenMs: number | null;
    totalMs: number;
    toolRounds: number;
    toolMs: number;
  };
}

export function answerRecorder(clock: () => number = Date.now): AnswerRecorder {
  const startedAt = clock();
  let retrievalMs = 0;
  let firstTokenMs: number | null = null;
  let toolRounds = 0;
  let toolMs = 0;
  const since = () => Math.max(0, clock() - startedAt);
  return {
    async retrieval(work) {
      const from = clock();
      try {
        return await work();
      } finally {
        retrievalMs += Math.max(0, clock() - from);
      }
    },
    firstToken() {
      if (firstTokenMs === null) firstTokenMs = since();
    },
    toolRound(ms) {
      toolRounds += 1;
      toolMs += Math.max(0, ms);
    },
    snapshot() {
      return { retrievalMs, firstTokenMs, totalMs: since(), toolRounds, toolMs };
    },
  };
}

/**
 * The candidates retrieval considered, best first: every hit the retriever
 * returned, marked used when it reached the model, or with the reason it did
 * not. `kept` names chunks under the floor that were still given to the
 * model (within the same-document margin); they are marked used.
 */
export function traceCandidates(
  hits: readonly { chunkId: string; score: number }[],
  floor: number,
  resolved: readonly { chunkId: string; documentId: string }[],
  kept: ReadonlySet<string> = new Set(),
): TraceCandidate[] {
  const byId = new Map(resolved.map((c) => [c.chunkId, c.documentId]));
  return [...hits]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TRACE_CANDIDATES)
    .map((hit): TraceCandidate => {
      const score = Number.isFinite(hit.score)
        ? Math.round(hit.score * SCORE_PLACES) / SCORE_PLACES
        : 0;
      if (hit.score < floor && !kept.has(hit.chunkId)) {
        return {
          chunkId: hit.chunkId,
          documentId: byId.get(hit.chunkId) ?? null,
          score,
          used: false,
          dropped: "below_floor",
        };
      }
      const documentId = byId.get(hit.chunkId);
      if (documentId === undefined) {
        return { chunkId: hit.chunkId, documentId: null, score, used: false, dropped: "not_found" };
      }
      return { chunkId: hit.chunkId, documentId, score, used: true };
    });
}
