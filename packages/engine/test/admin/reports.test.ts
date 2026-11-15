import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { reportFor } from "../../src/admin/reports.js";
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
      topSources: [],
      uncitedSources: [],
      uncitedTotal: 0,
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
    expect(report.topGaps).toEqual([{ question: "refunds?", count: 1 }]);
    expect(report.topSources).toEqual([
      { url: "https://docs.example.com/pricing", title: "Pricing", count: 2 },
      { url: "https://docs.example.com/sso", title: "SSO", count: 1 },
    ]);
    // Out-of-range citation of /unused does not hide it from uncitedSources in this range.
    expect(report.uncitedSources).toEqual([
      { url: "https://docs.example.com/unused", title: "Unused" },
    ]);
    expect(report.uncitedTotal).toBe(1);
  });

  it("de-duplicates multiple thumbs-down rows per reply and duplicate URL citations per reply", async () => {
    const astA = await seedAssistant(ORG_A);
    const convA = await seedConversation(ORG_A, astA);
    const r1 = newId("msg");
    const r2 = newId("msg");

    await env.DB.batch([
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
      { url: "https://docs.example.com/a", title: "Page A", count: 1 },
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
});
