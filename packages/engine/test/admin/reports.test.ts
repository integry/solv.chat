import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { rangeFor, reportFor, responseTimeFigures } from "../../src/admin/reports.js";
import { REPORT_TOP_LIMIT } from "../../src/db/reports.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { utcDay } from "../../src/util/time.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";
const FIXED_NOW = Date.UTC(2026, 10, 15, 12, 0, 0); // 2026-11-15T12:00:00Z
const DAY_MS = 86_400_000;

function appForOrg(orgId: string) {
  return createTestApp({
    auth: {
      async authenticate() {
        return { orgId, userId: "owner", role: "owner" };
      },
      async login() {
        return Response.json({ ok: true });
      },
      async logout() {
        return Response.json({ ok: true });
      },
    },
  });
}

function tenantFor(orgId: string) {
  return forPrincipal(env.DB, { orgId, userId: "owner", role: "owner" });
}

async function call(app: ReturnType<typeof createTestApp>, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://example.com${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedAssistant(orgId: string, name = "Docs Bot"): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5)`,
  )
    .bind(id, orgId, name, `pk_${newId("ast").slice(4)}`, FIXED_NOW)
    .run();
  return id;
}

async function seedSource(orgId: string, assistantId: string): Promise<string> {
  const id = newId("src");
  await env.DB.prepare(
    `INSERT INTO sources (id, org_id, assistant_id, kind, label, settings, created_at)
     VALUES (?1, ?2, ?3, 'push', 'Docs', '{}', ?4)`,
  )
    .bind(id, orgId, assistantId, FIXED_NOW)
    .run();
  return id;
}

async function seedConversation(
  orgId: string,
  assistantId: string,
  visitorId = "vis_1",
): Promise<string> {
  const id = newId("cnv");
  await env.DB.prepare(
    `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
     VALUES (?1, ?2, ?3, ?4, ?5, '')`,
  )
    .bind(id, orgId, assistantId, visitorId, FIXED_NOW)
    .run();
  return id;
}

describe("admin reports API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("returns zeros and empty lists on an empty assistant", async () => {
    const astA = await seedAssistant(ORG_A);
    const app = appForOrg(ORG_A);

    const res = await call(app, `/api/admin/assistants/${astA}/report`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      days: 30,
      from: expect.any(String),
      to: expect.any(String),
      questions: 0,
      replies: 0,
      answeredShare: 0,
      thumbsDownShare: 0,
      costMicros: 0,
      topQuestions: [],
      topGaps: [],
      topics: { reviewAnswers: true, rows: [] },
      topSources: [],
      uncitedSources: [],
      uncitedTotal: 0,
      responseTime: {
        days: 30,
        from: body.from,
        to: body.to,
        status: "no_answers",
        answers: 0,
        pageActionAnswers: 0,
        noContentAnswers: 0,
        timed: 0,
        firstTokenMedianMs: null,
        firstTokenP90Ms: null,
        totalMedianMs: null,
        previous: {
          from: expect.any(String),
          to: expect.any(String),
          status: "no_answers",
          answers: 0,
          pageActionAnswers: 0,
          noContentAnswers: 0,
          timed: 0,
          firstTokenMedianMs: null,
          firstTokenP90Ms: null,
          totalMedianMs: null,
        },
      },
    });
  });

  it("validates days query parameter and rejects cross-org assistants", async () => {
    const astA = await seedAssistant(ORG_A);
    const astB = await seedAssistant(ORG_B);
    const app = appForOrg(ORG_A);

    for (const bad of ["31", "0", "-7", "abc", ""]) {
      const res = await call(app, `/api/admin/assistants/${astA}/report?days=${bad}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { fields?: string[] };
      expect(body.fields?.some((e) => e.includes("days"))).toBe(true);
    }

    for (const good of ["7", "30", "90"]) {
      const res = await call(app, `/api/admin/assistants/${astA}/report?days=${good}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { days: number };
      expect(body.days).toBe(Number(good));
    }

    const crossRes = await call(app, `/api/admin/assistants/${astB}/report?days=7`);
    expect(crossRes.status).toBe(404);
  });

  it("computes all figures and excludes out-of-range, other-assistant, and other-org rows", async () => {
    const astA = await seedAssistant(ORG_A, "Bot A");
    const astA2 = await seedAssistant(ORG_A, "Bot A2");
    const astB = await seedAssistant(ORG_B, "Bot B");

    const srcA = await seedSource(ORG_A, astA);
    const srcA2 = await seedSource(ORG_A, astA2);
    const srcB = await seedSource(ORG_B, astB);

    const convA = await seedConversation(ORG_A, astA);
    const convA2 = await seedConversation(ORG_A, astA2);
    const convB = await seedConversation(ORG_B, astB);

    // 7-day range ending on FIXED_NOW (2026-11-15) starts at 2026-11-09T00:00:00Z.
    const startOf7Days = Date.UTC(2026, 10, 9, 0, 0, 0);
    const beforeRange = startOf7Days - 1;
    const inRange1 = startOf7Days;
    const inRange2 = FIXED_NOW - DAY_MS;
    const inRange3 = FIXED_NOW;

    const q1 = newId("msg");
    const q2 = newId("msg");
    const q3 = newId("msg");
    const r1 = newId("msg");
    const r2 = newId("msg");
    const r3 = newId("msg");
    const qOut = newId("msg");
    const rOut = newId("msg");

    await env.DB.batch([
      // Documents for A (2 cited, 1 uncited)
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'd1', 'https://docs.example.com/pricing', 'Pricing', 'h1', 100)",
      ).bind(newId("doc"), ORG_A, srcA),
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'd2', 'https://docs.example.com/sso', 'SSO', 'h2', 200)",
      ).bind(newId("doc"), ORG_A, srcA),
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'd3', 'https://docs.example.com/unused', 'Unused', 'h3', 300)",
      ).bind(newId("doc"), ORG_A, srcA),
      // Document for A2 and B (must not appear in A's uncited)
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'd4', 'https://other-bot.example.com/x', 'Other Bot', 'h4', 400)",
      ).bind(newId("doc"), ORG_A, srcA2),
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'd5', 'https://other-org.example.com/y', 'Other Org', 'h5', 500)",
      ).bind(newId("doc"), ORG_B, srcB),

      // In-range for A: 3 questions (2 answered, 1 unanswered)
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'Pricing?', '[]', 1, 'pricing?', ?4)",
      ).bind(q1, ORG_A, convA, inRange1),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, reply_to, created_at) VALUES (?1, ?2, ?3, 'assistant', 'See pricing.', ?4, 1, ?5, ?6)",
      ).bind(
        r1,
        ORG_A,
        convA,
        JSON.stringify([{ url: "https://docs.example.com/pricing", title: "Pricing" }]),
        q1,
        inRange1 + 10,
      ),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'pricing?', '[]', 1, 'pricing?', ?4)",
      ).bind(q2, ORG_A, convA, inRange2),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, reply_to, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Pricing + SSO.', ?4, 1, ?5, ?6)",
      ).bind(
        r2,
        ORG_A,
        convA,
        JSON.stringify([
          { url: "https://docs.example.com/pricing", title: "Pricing" },
          { url: "https://docs.example.com/sso", title: "SSO" },
        ]),
        q2,
        inRange2 + 10,
      ),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'Refunds?', '[]', 1, 'refunds?', ?4)",
      ).bind(q3, ORG_A, convA, inRange3),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, reply_to, created_at) VALUES (?1, ?2, ?3, 'assistant', 'No info.', '[]', 0, ?4, ?5)",
      ).bind(r3, ORG_A, convA, q3, inRange3 + 10),

      // Feedback: r3 has a thumbs down; r1 has a thumbs up (ignored in thumbsDownShare)
      env.DB.prepare(
        "INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at) VALUES (?1, ?2, ?3, 'vis_1', 'down', '', ?4)",
      ).bind(newId("fbk"), ORG_A, r3, inRange3 + 20),
      env.DB.prepare(
        "INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at) VALUES (?1, ?2, ?3, 'vis_1', 'up', '', ?4)",
      ).bind(newId("fbk"), ORG_A, r1, inRange1 + 20),

      // Out-of-range for A (day before 7-day window)
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'Old question', '[]', 1, 'old question', ?4)",
      ).bind(qOut, ORG_A, convA, beforeRange),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, reply_to, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Old.', ?4, 0, ?5, ?6)",
      ).bind(
        rOut,
        ORG_A,
        convA,
        JSON.stringify([{ url: "https://docs.example.com/unused", title: "Unused" }]),
        qOut,
        beforeRange,
      ),

      // Other assistant in Org A (in range)
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'A2 question', '[]', 1, 'a2 question', ?4)",
      ).bind(newId("msg"), ORG_A, convA2, inRange3),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'A2 reply', '[]', 1, ?4)",
      ).bind(newId("msg"), ORG_A, convA2, inRange3),

      // Other org B (in range)
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'B question', '[]', 1, 'b question', ?4)",
      ).bind(newId("msg"), ORG_B, convB, inRange3),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'B reply', '[]', 1, ?4)",
      ).bind(newId("msg"), ORG_B, convB, inRange3),

      // Usage daily: 2 days in range for A, 1 day before range for A, 1 day in range for A2 and B
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 2, 100, 50, 1500)",
      ).bind(ORG_A, astA, utcDay(inRange1)),
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 4, 200, 100, 2700)",
      ).bind(ORG_A, astA, utcDay(inRange3)),
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 1, 50, 25, 8888)",
      ).bind(ORG_A, astA, utcDay(beforeRange)),
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 1, 50, 25, 7777)",
      ).bind(ORG_A, astA2, utcDay(inRange3)),
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 1, 50, 25, 9999)",
      ).bind(ORG_B, astB, utcDay(inRange3)),
    ]);

    const report = await reportFor(tenantFor(ORG_A), astA, 7, FIXED_NOW);
    expect(report.days).toBe(7);
    expect(report.from).toBe("2026-11-09");
    expect(report.to).toBe("2026-11-15");
    expect(report.questions).toBe(3);
    expect(report.replies).toBe(3);
    expect(report.answeredShare).toBeCloseTo(2 / 3);
    expect(report.thumbsDownShare).toBeCloseTo(1 / 3);
    expect(report.costMicros).toBe(4200);
    expect(report.topQuestions).toEqual([
      { question: "pricing?", count: 2 },
      { question: "refunds?", count: 1 },
    ]);
    expect(report.topGaps).toEqual([{ question: "refunds?", count: 1, topic: null }]);
    const page = { documentId: expect.any(String), kind: "page" };
    expect(report.topSources).toEqual([
      { ...page, url: "https://docs.example.com/pricing", title: "Pricing", count: 2 },
      { ...page, url: "https://docs.example.com/sso", title: "SSO", count: 1 },
    ]);
    // Out-of-range citation of /unused does not hide it from uncitedSources in this range.
    expect(report.uncitedSources).toEqual([
      { ...page, url: "https://docs.example.com/unused", title: "Unused" },
    ]);
    expect(report.uncitedTotal).toBe(1);
  });

  it("de-duplicates multiple thumbs-down rows per reply and duplicate URL citations per reply", async () => {
    const astA = await seedAssistant(ORG_A);
    const srcA = await seedSource(ORG_A, astA);
    const convA = await seedConversation(ORG_A, astA);
    const r1 = newId("msg");
    const r2 = newId("msg");
    const docA = newId("doc");

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, 'a', 'https://docs.example.com/a', 'Page A', 'h', 1)",
      ).bind(docA, ORG_A, srcA),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Reply 1', ?4, 1, ?5)",
      ).bind(
        r1,
        ORG_A,
        convA,
        JSON.stringify([
          { url: "https://docs.example.com/a", title: "Page A" },
          { url: "https://docs.example.com/a", title: "Page A" },
        ]),
        FIXED_NOW,
      ),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Reply 2', '[]', 1, ?4)",
      ).bind(r2, ORG_A, convA, FIXED_NOW + 1),
      // Two visitors both give thumbs down to r1; one gives thumbs up to r2.
      env.DB.prepare(
        "INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at) VALUES (?1, ?2, ?3, 'vis_1', 'down', '', ?4)",
      ).bind(newId("fbk"), ORG_A, r1, FIXED_NOW + 2),
      env.DB.prepare(
        "INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at) VALUES (?1, ?2, ?3, 'vis_2', 'down', '', ?4)",
      ).bind(newId("fbk"), ORG_A, r1, FIXED_NOW + 3),
      env.DB.prepare(
        "INSERT INTO feedback (id, org_id, message_id, visitor_id, value, note, created_at) VALUES (?1, ?2, ?3, 'vis_1', 'up', '', ?4)",
      ).bind(newId("fbk"), ORG_A, r2, FIXED_NOW + 4),
    ]);

    const report = await reportFor(tenantFor(ORG_A), astA, 7, FIXED_NOW);
    expect(report.replies).toBe(2);
    expect(report.thumbsDownShare).toBeCloseTo(0.5);
    expect(report.topSources).toEqual([
      {
        documentId: docA,
        kind: "page",
        url: "https://docs.example.com/a",
        title: "Page A",
        count: 1,
      },
    ]);
  });

  it("caps uncitedSources at 20 and reports the full uncitedTotal", async () => {
    const astA = await seedAssistant(ORG_A);
    const srcA = await seedSource(ORG_A, astA);
    const convA = await seedConversation(ORG_A, astA);

    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 25; i++) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO documents (id, org_id, source_id, external_id, url, title, content_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        ).bind(
          newId("doc"),
          ORG_A,
          srcA,
          `ext_${i}`,
          `https://docs.example.com/p${i}`,
          `Page ${i}`,
          `hash_${i}`,
          1000 + i,
        ),
      );
    }
    stmts.push(
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Cited two', ?4, 1, ?5)",
      ).bind(
        newId("msg"),
        ORG_A,
        convA,
        JSON.stringify([
          { url: "https://docs.example.com/p0", title: "Page 0" },
          { url: "https://docs.example.com/p1", title: "Page 1" },
        ]),
        FIXED_NOW,
      ),
    );
    await env.DB.batch(stmts);

    const report = await reportFor(tenantFor(ORG_A), astA, 30, FIXED_NOW);
    expect(report.uncitedSources).toHaveLength(REPORT_TOP_LIMIT);
    expect(report.uncitedTotal).toBe(23);
  });

  it("stays bounded with 5,000 messages", async () => {
    const astA = await seedAssistant(ORG_A);
    const convA = await seedConversation(ORG_A, astA);

    // 5000 user messages across 50 batches of 100 statements (D1's batch limit).
    // Each statement inserts 1 row (7 bound parameters, well within D1's 100-param limit).
    // Actually 10 rows per statement * 10 statements per batch = 100 rows per batch -> 50 batches,
    // or 100 statements * 1 row = 100 rows per batch -> 50 batches.
    // Using 10 rows per statement (60 params < 100) * 100 statements = 1000 rows per batch -> 5 batches!
    const rowsPerStmt = 10;
    const stmtsPerBatch = 100;
    let inserted = 0;
    for (let b = 0; b < 5; b++) {
      const batch: D1PreparedStatement[] = [];
      for (let s = 0; s < stmtsPerBatch; s++) {
        const placeholders: string[] = [];
        const params: Array<string | number> = [];
        for (let r = 0; r < rowsPerStmt; r++) {
          const base = r * 5;
          placeholders.push(
            `(?${base + 1}, ?${base + 2}, ?${base + 3}, 'user', 'q', '[]', 1, ?${base + 4}, ?${base + 5})`,
          );
          params.push(
            newId("msg"),
            ORG_A,
            convA,
            `question_${inserted % 50}`,
            FIXED_NOW - (inserted % 10) * 1000,
          );
          inserted += 1;
        }
        batch.push(
          env.DB.prepare(
            `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, question_key, created_at) VALUES ${placeholders.join(", ")}`,
          ).bind(...params),
        );
      }
      await env.DB.batch(batch);
    }

    const report = await reportFor(tenantFor(ORG_A), astA, 90, FIXED_NOW);
    expect(report.questions).toBe(5000);
    expect(report.topQuestions).toHaveLength(REPORT_TOP_LIMIT);
    expect(report.topSources.length).toBeLessThanOrEqual(REPORT_TOP_LIMIT);
  });

  describe("response time", () => {
    /** An assistant reply with its two timings; `null` is a reply from before they existed. */
    function reply(
      orgId: string,
      conversationId: string,
      createdAt: number,
      firstTokenMs: number | null,
      totalMs: number | null = firstTokenMs === null ? null : firstTokenMs * 3,
    ): D1PreparedStatement {
      return env.DB.prepare(
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at, first_token_ms, total_ms)
         VALUES (?1, ?2, ?3, 'assistant', 'An answer.', '[]', 1, ?4, ?5, ?6)`,
      ).bind(newId("msg"), orgId, conversationId, createdAt, firstTokenMs, totalMs);
    }

    const range7 = rangeFor(7, FIXED_NOW);

    it("computes the median and 90th percentile in SQL, interpolating between ranks", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      // Inserted out of order: the query sorts, not the insert.
      const firsts = [700, 100, 1000, 300, 500, 200, 900, 400, 800, 600];
      await env.DB.batch(firsts.map((ms, i) => reply(ORG_A, conv, FIXED_NOW - i * 1000, ms)));

      const figures = await responseTimeFigures(tenantFor(ORG_A), ast, range7);
      expect(figures).toEqual({
        from: "2026-11-09",
        to: "2026-11-15",
        status: "measured",
        answers: 10,
        pageActionAnswers: 0,
        noContentAnswers: 0,
        timed: 10,
        // Even count: the mean of the 5th and 6th (500 and 600).
        firstTokenMedianMs: 550,
        // Rank 9 × 0.9 = 8.1: 900 + 0.1 × (1000 − 900).
        firstTokenP90Ms: 910,
        // Totals are three times the firsts: (1500 + 1800) / 2.
        totalMedianMs: 1650,
      });
    });

    it("leaves out replies that found nothing to answer from, and counts them apart", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      const fallback = (createdAt: number) =>
        env.DB.prepare(
          `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at, first_token_ms, total_ms)
           VALUES (?1, ?2, ?3, 'assistant', 'Sorry, I could not find that.', '[]', 0, ?4, 1, 2)`,
        ).bind(newId("msg"), ORG_A, conv, createdAt);
      // Two real answers, and three near-instant fallbacks that would pull the median down.
      await env.DB.batch([
        reply(ORG_A, conv, FIXED_NOW, 800, 2000),
        reply(ORG_A, conv, FIXED_NOW - 1, 1200, 3000),
        fallback(FIXED_NOW - 2),
        fallback(FIXED_NOW - 3),
        fallback(FIXED_NOW - 4),
      ]);
      expect(await responseTimeFigures(tenantFor(ORG_A), ast, range7)).toMatchObject({
        status: "measured",
        answers: 2,
        noContentAnswers: 3,
        timed: 2,
        firstTokenMedianMs: 1000,
        totalMedianMs: 2500,
      });

      // Only fallbacks: nothing to time.
      const missOnly = await seedAssistant(ORG_A, "Misses");
      const missConv = await seedConversation(ORG_A, missOnly);
      await env.DB.prepare(
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at, first_token_ms, total_ms)
         VALUES (?1, ?2, ?3, 'assistant', 'Sorry.', '[]', 0, ?4, 1, 2)`,
      )
        .bind(newId("msg"), ORG_A, missConv, FIXED_NOW)
        .run();
      expect(await responseTimeFigures(tenantFor(ORG_A), missOnly, range7)).toMatchObject({
        status: "no_answers",
        answers: 0,
        noContentAnswers: 1,
        firstTokenMedianMs: null,
      });
    });

    it("gives the middle value of an odd count and rounds to whole milliseconds", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      await env.DB.batch([
        reply(ORG_A, conv, FIXED_NOW, 5, 41),
        reply(ORG_A, conv, FIXED_NOW - 1, 1, 13),
        reply(ORG_A, conv, FIXED_NOW - 2, 3, 20),
      ]);
      const figures = await responseTimeFigures(tenantFor(ORG_A), ast, range7);
      expect(figures.firstTokenMedianMs).toBe(3);
      // 2 × 0.9 = 1.8: 3 + 0.8 × (5 − 3) = 4.6.
      expect(figures.firstTokenP90Ms).toBe(5);
      expect(figures.totalMedianMs).toBe(20);

      // One answer is its own median and 90th percentile.
      const single = await seedAssistant(ORG_A, "Single");
      const singleConv = await seedConversation(ORG_A, single);
      await reply(ORG_A, singleConv, FIXED_NOW, 1234, 4321).run();
      expect(await responseTimeFigures(tenantFor(ORG_A), single, range7)).toMatchObject({
        firstTokenMedianMs: 1234,
        firstTokenP90Ms: 1234,
        totalMedianMs: 4321,
      });
    });

    it("leaves out answers without timings, and says so when they are most of the period", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      // Two timed, two from before timings: half timed is enough, from the timed two only.
      await env.DB.batch([
        reply(ORG_A, conv, FIXED_NOW, 200),
        reply(ORG_A, conv, FIXED_NOW - 1, 400),
        reply(ORG_A, conv, FIXED_NOW - 2, null),
        reply(ORG_A, conv, FIXED_NOW - 3, null),
      ]);
      expect(await responseTimeFigures(tenantFor(ORG_A), ast, range7)).toMatchObject({
        status: "measured",
        answers: 4,
        timed: 2,
        firstTokenMedianMs: 300,
        firstTokenP90Ms: 380,
        totalMedianMs: 900,
      });

      // One more legacy answer and the untimed are the majority: no number.
      await reply(ORG_A, conv, FIXED_NOW - 4, null).run();
      expect(await responseTimeFigures(tenantFor(ORG_A), ast, range7)).toEqual({
        from: "2026-11-09",
        to: "2026-11-15",
        status: "mostly_untimed",
        answers: 5,
        pageActionAnswers: 0,
        noContentAnswers: 0,
        timed: 2,
        firstTokenMedianMs: null,
        firstTokenP90Ms: null,
        totalMedianMs: null,
      });

      // Only legacy answers.
      const legacy = await seedAssistant(ORG_A, "Legacy");
      const legacyConv = await seedConversation(ORG_A, legacy);
      await reply(ORG_A, legacyConv, FIXED_NOW, null).run();
      expect(await responseTimeFigures(tenantFor(ORG_A), legacy, range7)).toMatchObject({
        status: "mostly_untimed",
        answers: 1,
        timed: 0,
        firstTokenMedianMs: null,
      });
    });

    it("compares with the period of the same length before, meeting at midnight", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      const start = Date.UTC(2026, 10, 9); // First millisecond of the 7-day range.
      await env.DB.batch([
        reply(ORG_A, conv, start, 1000),
        reply(ORG_A, conv, FIXED_NOW, 2000),
        // The 7 days before: 2026-11-02 to 2026-11-08, to its last millisecond.
        reply(ORG_A, conv, start - 1, 500),
        reply(ORG_A, conv, start - 7 * DAY_MS, 700),
        // Before both periods.
        reply(ORG_A, conv, start - 7 * DAY_MS - 1, 99_999),
      ]);

      const report = await reportFor(tenantFor(ORG_A), ast, 7, FIXED_NOW);
      expect(report.responseTime).toMatchObject({
        days: 7,
        from: "2026-11-09",
        to: "2026-11-15",
        status: "measured",
        answers: 2,
        firstTokenMedianMs: 1500,
        previous: {
          from: "2026-11-02",
          to: "2026-11-08",
          status: "measured",
          answers: 2,
          firstTokenMedianMs: 600,
          firstTokenP90Ms: 680,
          totalMedianMs: 1800,
        },
      });

      // A 30-day report compares with the 30 days before it.
      const month = await reportFor(tenantFor(ORG_A), ast, 30, FIXED_NOW);
      expect(month.responseTime).toMatchObject({
        days: 30,
        from: "2026-10-17",
        answers: 5,
        previous: { from: "2026-09-17", to: "2026-10-16", status: "no_answers", answers: 0 },
      });
    });

    it("counts only the org's own assistant, and visitor messages are not answers", async () => {
      const astA = await seedAssistant(ORG_A, "Bot A");
      const astA2 = await seedAssistant(ORG_A, "Bot A2");
      const astB = await seedAssistant(ORG_B, "Bot B");
      const convA = await seedConversation(ORG_A, astA);
      const convA2 = await seedConversation(ORG_A, astA2);
      const convB = await seedConversation(ORG_B, astB);
      await env.DB.batch([
        reply(ORG_A, convA, FIXED_NOW, 100),
        reply(ORG_A, convA2, FIXED_NOW, 50_000),
        reply(ORG_B, convB, FIXED_NOW, 90_000),
        env.DB.prepare(
          `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, answered, created_at)
           VALUES (?1, ?2, ?3, 'user', 'Pricing?', '[]', 1, ?4)`,
        ).bind(newId("msg"), ORG_A, convA, FIXED_NOW),
      ]);

      const res = await call(appForOrg(ORG_A), `/api/admin/assistants/${astA}/report?days=7`);
      const body = (await res.json()) as { responseTime: Record<string, unknown> };
      expect(body.responseTime).toMatchObject({
        status: "measured",
        answers: 1,
        timed: 1,
        firstTokenMedianMs: 100,
        firstTokenP90Ms: 100,
        totalMedianMs: 300,
      });

      // Org B asking for org A's assistant gets nothing, and its own figure is its own.
      const cross = await call(appForOrg(ORG_B), `/api/admin/assistants/${astA}/report?days=7`);
      expect(cross.status).toBe(404);
      expect(await responseTimeFigures(tenantFor(ORG_B), astA, range7)).toMatchObject({
        status: "no_answers",
        answers: 0,
      });
      expect(await responseTimeFigures(tenantFor(ORG_B), astB, range7)).toMatchObject({
        answers: 1,
        firstTokenMedianMs: 90_000,
      });
    });

    /**
     * A reply that used a page action, as `answer.ts` stores it: written when
     * it paused, with the first request's timings, which a resume keeps.
     * `resumed` is a reply whose continuation has completed (the call is no
     * longer pending and `resume_revision` has moved on).
     */
    function pageActionReply(
      conversationId: string,
      createdAt: number,
      firstTokenMs: number | null,
      totalMs: number,
      resumed: boolean,
    ): D1PreparedStatement {
      const call = {
        callId: `call_${createdAt}`,
        name: "navigate",
        kind: "action",
        ok: resumed,
        ...(resumed ? {} : { pending: true }),
        ms: 0,
        input: { path: "/billing" },
        resultBytes: 0,
        resultPreview: "",
      };
      return env.DB.prepare(
        `INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, answered, created_at, first_token_ms, total_ms, resume_context, resume_revision)
         VALUES (?1, ?2, ?3, 'assistant', 'Opening that page.', '[]', ?4, 1, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        newId("msg"),
        ORG_A,
        conversationId,
        JSON.stringify([call]),
        createdAt,
        firstTokenMs,
        totalMs,
        resumed ? null : "{}",
        resumed ? 1 : 0,
      );
    }

    it("leaves out answers that used a page action, paused or completed, and counts them apart", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      await env.DB.batch([
        // Ordinary answers: the figures are theirs alone.
        reply(ORG_A, conv, FIXED_NOW, 200, 2000),
        reply(ORG_A, conv, FIXED_NOW - 1, 400, 4000),
        // Action only before the pause (no first token), still waiting and completed.
        pageActionReply(conv, FIXED_NOW - 2, null, 30, false),
        pageActionReply(conv, FIXED_NOW - 3, null, 40, true),
        // Text before the pause, still waiting and completed. Their short
        // totals would pull "Full answer" down if counted.
        pageActionReply(conv, FIXED_NOW - 4, 10, 50, false),
        pageActionReply(conv, FIXED_NOW - 5, 20, 60, true),
      ]);
      expect(await responseTimeFigures(tenantFor(ORG_A), ast, range7)).toEqual({
        from: "2026-11-09",
        to: "2026-11-15",
        status: "measured",
        answers: 2,
        pageActionAnswers: 4,
        noContentAnswers: 0,
        timed: 2,
        firstTokenMedianMs: 300,
        firstTokenP90Ms: 380,
        totalMedianMs: 3000,
      });

      // A legacy answer is still untimed; page-action answers are not.
      await reply(ORG_A, conv, FIXED_NOW - 6, null).run();
      expect(await responseTimeFigures(tenantFor(ORG_A), ast, range7)).toMatchObject({
        status: "measured",
        answers: 3,
        pageActionAnswers: 4,
        noContentAnswers: 0,
        timed: 2,
      });
    });

    it("says only page actions, not old answers, when every answer used one", async () => {
      const ast = await seedAssistant(ORG_A);
      const conv = await seedConversation(ORG_A, ast);
      await env.DB.batch([
        pageActionReply(conv, FIXED_NOW, null, 30, false),
        pageActionReply(conv, FIXED_NOW - 1, null, 40, true),
      ]);
      expect(await responseTimeFigures(tenantFor(ORG_A), ast, range7)).toEqual({
        from: "2026-11-09",
        to: "2026-11-15",
        status: "page_actions_only",
        answers: 0,
        pageActionAnswers: 2,
        noContentAnswers: 0,
        timed: 0,
        firstTokenMedianMs: null,
        firstTokenP90Ms: null,
        totalMedianMs: null,
      });
    });

    it("reads the period's replies through the org, role and time index", async () => {
      const ast = await seedAssistant(ORG_A);
      const statements: string[] = [];
      const recording = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              statements.push(sql);
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await forPrincipal(recording, {
        orgId: ORG_A,
        userId: "owner",
        role: "owner",
      }).reports.replyTiming(ast, range7);
      const sql = statements.find((s) => s.includes("first_ranked"));
      if (sql === undefined) throw new Error("no timing statement");

      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(ORG_A, ast, range7.fromMs, range7.toMs)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail);
      expect(details).toContainEqual(
        "SEARCH m USING INDEX messages_role_created (org_id=? AND role=? AND created_at>? AND created_at<?)",
      );
      expect(details).toContainEqual(
        expect.stringMatching(/^SEARCH c USING INDEX \S+ \(org_id=\? AND id=\?\)$/),
      );
      // No full scan of a stored table: only the period's rows, then the ranked CTEs.
      for (const detail of details) {
        expect(detail).not.toMatch(/^SCAN (m|c|messages|conversations)\b/);
      }
    });
  });
});
