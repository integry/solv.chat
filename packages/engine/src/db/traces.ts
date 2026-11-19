import {
  boundTrace,
  type PreviewTraceSource,
  parseStoredTrace,
  type StoredTrace,
  type TracePart,
} from "../chat/trace.js";
import { prepare, prepareInsert } from "./sql.js";

/**
 * Preview traces kept per assistant: enough for a long Try it session and
 * several full test runs (at most 25 tests each). Each write drops the older
 * ones, so the table cannot grow without bound.
 */
export const MAX_PREVIEW_TRACES = 200;

export interface PreviewTraceInput {
  /** The reply id the preview's `done` event carried. */
  id: string;
  assistantId: string;
  source: PreviewTraceSource;
  /** A test run's trace: the run and the test it answered. */
  runId?: string | undefined;
  testId?: string | undefined;
  tokensIn: number;
  tokensOut: number;
  costMicros: number | null;
  part: TracePart;
  createdAt: number;
}

export interface PreviewTraceRow {
  id: string;
  assistantId: string;
  source: PreviewTraceSource;
  runId: string | null;
  testId: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicros: number | null;
  trace: StoredTrace | null;
  createdAt: number;
}

interface PreviewRow {
  id: string;
  assistant_id: string;
  source: string;
  run_id: string | null;
  test_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_micros: number | null;
  detail: string;
  created_at: number;
}

/**
 * Tenant-scoped data access for `preview_traces`: how a "Try it" answer or
 * an answer test was made. Kept apart from `message_traces` so that nothing
 * reading visitor replies can count one.
 */
export function previewTracesFor(db: D1Database, orgId: string) {
  return {
    /**
     * Writes one preview's trace and, in the same batch, drops the
     * assistant's oldest beyond `MAX_PREVIEW_TRACES`. The assistant must be
     * in this org: the foreign key refuses anything else.
     */
    async put(input: PreviewTraceInput): Promise<void> {
      const detail = JSON.stringify(boundTrace({ v: 1, parts: [input.part] }));
      await db.batch([
        prepareInsert(
          db,
          `INSERT INTO preview_traces
             (org_id, id, assistant_id, source, run_id, test_id, tokens_in, tokens_out, cost_micros, detail, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT(org_id, id) DO NOTHING`,
        ).bind(
          orgId,
          input.id,
          input.assistantId,
          input.source,
          input.runId ?? null,
          input.testId ?? null,
          input.tokensIn,
          input.tokensOut,
          input.costMicros,
          detail,
          input.createdAt,
        ),
        prepare(
          db,
          `DELETE FROM preview_traces
            WHERE org_id = ?1 AND assistant_id = ?2
              AND id NOT IN (
                SELECT id FROM preview_traces
                 WHERE org_id = ?1 AND assistant_id = ?2
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?3
              )`,
        ).bind(orgId, input.assistantId, MAX_PREVIEW_TRACES),
      ]);
    },

    /** One preview's trace, when it is this assistant's (and, through the tenant, this org's). */
    async get(assistantId: string, id: string): Promise<PreviewTraceRow | null> {
      const row = await prepare(
        db,
        `SELECT id, assistant_id, source, run_id, test_id, tokens_in, tokens_out, cost_micros, detail, created_at
           FROM preview_traces WHERE org_id = ?1 AND assistant_id = ?2 AND id = ?3`,
      )
        .bind(orgId, assistantId, id)
        .first<PreviewRow>();
      if (!row) return null;
      return {
        id: row.id,
        assistantId: row.assistant_id,
        source: row.source === "test_run" ? "test_run" : "try_it",
        runId: row.run_id,
        testId: row.test_id,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        costMicros: row.cost_micros,
        trace: parseStoredTrace(row.detail),
        createdAt: row.created_at,
      };
    },
  };
}

/** Tenant-scoped data access for `message_traces`. */
export function tracesFor(db: D1Database, orgId: string) {
  const write = async (messageId: string, trace: StoredTrace, now: number): Promise<void> => {
    await prepareInsert(
      db,
      `INSERT INTO message_traces (org_id, message_id, detail, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(org_id, message_id) DO UPDATE SET
           detail = excluded.detail,
           updated_at = excluded.updated_at`,
    )
      .bind(orgId, messageId, JSON.stringify(trace), now)
      .run();
  };
  const get = async (messageId: string): Promise<StoredTrace | null> => {
    const row = await prepare(
      db,
      "SELECT detail FROM message_traces WHERE org_id = ?1 AND message_id = ?2",
    )
      .bind(orgId, messageId)
      .first<{ detail: string }>();
    return row ? parseStoredTrace(row.detail) : null;
  };
  return {
    get,

    /**
     * Writes the trace for a message's first request, replacing any there
     * was. The message must exist in this org: the foreign key refuses a
     * trace for anything else.
     */
    async put(messageId: string, part: TracePart, now: number): Promise<void> {
      await write(messageId, boundTrace({ v: 1, parts: [part] }), now);
    },

    /**
     * Adds a later request (a page-action resume) to a message's trace. A
     * message whose first trace write failed gets one with this part alone.
     */
    async append(messageId: string, part: TracePart, now: number): Promise<void> {
      const existing = await get(messageId);
      const trace = boundTrace(
        existing === null
          ? { v: 1, parts: [part], truncated: true }
          : { ...existing, parts: [...existing.parts, part] },
      );
      await write(messageId, trace, now);
    },
  };
}
