import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { utcDay } from "../../src/util/time.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

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

async function call(app: ReturnType<typeof createTestApp>, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://example.com${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function seedAssistant(orgId: string): Promise<string> {
  const id = newId("ast");
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, created_at)
     VALUES (?1, ?2, 'Docs Bot', ?3, '[]', ?4)`,
  )
    .bind(id, orgId, `pk_${newId("ast").slice(4)}`, Date.now())
    .run();
  return id;
}

describe("admin overview API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("returns zeros on a day with no messages instead of failing", async () => {
    const astA = await seedAssistant(ORG_A);
    const app = appForOrg(ORG_A);

    const res = await call(app, `/api/admin/assistants/${astA}/overview`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      messages: 0,
      answeredShare: 0,
      topQuestions: [],
      todayCostMicros: 0,
    });
  });

  it("computes messages, answered share, top questions, and today's cost for the principal's org only", async () => {
    const astA = await seedAssistant(ORG_A);
    const astB = await seedAssistant(ORG_B);
    const convA = newId("cnv");
    const convB = newId("cnv");
    const today = utcDay(Date.now());

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES (?1, ?2, ?3, 'vis_1', 1000, '')",
      ).bind(convA, ORG_A, astA),
      env.DB.prepare(
        "INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url) VALUES (?1, ?2, ?3, 'vis_2', 1000, '')",
      ).bind(convB, ORG_B, astB),

      // 3 user messages + 3 assistant messages in Org A (2 answered, 1 unanswered -> 2/3)
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'Pricing?', '[]', NULL, 0, 0, 1, 'pricing?', 1001)",
      ).bind(newId("msg"), ORG_A, convA),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Free tier.', '[]', NULL, 10, 5, 1, 1002)",
      ).bind(newId("msg"), ORG_A, convA),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', '  pricing? ', '[]', NULL, 0, 0, 1, 'pricing?', 1003)",
      ).bind(newId("msg"), ORG_A, convA),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'Free tier.', '[]', NULL, 10, 5, 1, 1004)",
      ).bind(newId("msg"), ORG_A, convA),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'Refunds?', '[]', NULL, 0, 0, 1, 'refunds?', 1005)",
      ).bind(newId("msg"), ORG_A, convA),
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, created_at) VALUES (?1, ?2, ?3, 'assistant', 'No info.', '[]', NULL, 0, 0, 0, 1006)",
      ).bind(newId("msg"), ORG_A, convA),

      // Org B messages must not be counted.
      env.DB.prepare(
        "INSERT INTO messages (id, org_id, conversation_id, role, content, citations, tool_calls, tokens_in, tokens_out, answered, question_key, created_at) VALUES (?1, ?2, ?3, 'user', 'Other org', '[]', NULL, 0, 0, 1, 'other org', 1007)",
      ).bind(newId("msg"), ORG_B, convB),

      // Today's cost for Org A vs Org B
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 3, 20, 10, 4200)",
      ).bind(ORG_A, astA, today),
      env.DB.prepare(
        "INSERT INTO usage_daily (org_id, assistant_id, day, messages, tokens_in, tokens_out, cost_micros) VALUES (?1, ?2, ?3, 9, 90, 90, 99999)",
      ).bind(ORG_B, astB, today),
    ]);

    const app = appForOrg(ORG_A);
    const res = await call(app, `/api/admin/assistants/${astA}/overview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: number;
      answeredShare: number;
      topQuestions: Array<{ question: string; count: number }>;
      todayCostMicros: number;
    };

    expect(body.messages).toBe(6);
    expect(body.answeredShare).toBeCloseTo(2 / 3);
    expect(body.topQuestions).toEqual([
      { question: "pricing?", count: 2 },
      { question: "refunds?", count: 1 },
    ]);
    expect(body.todayCostMicros).toBe(4200);

    // Cross-org assistant is 404.
    const crossRes = await call(app, `/api/admin/assistants/${astB}/overview`);
    expect(crossRes.status).toBe(404);
  });
});
