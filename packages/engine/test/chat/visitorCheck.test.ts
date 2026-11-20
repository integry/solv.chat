import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defaultVersionConfig, parseChatEventLine } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppOptions, createApp, type Env } from "../../src/app.js";
import { checkBinding, SITEVERIFY_URL } from "../../src/chat/turnstile.js";
import { forPrincipal } from "../../src/db/tenant.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider } from "../../src/providers/types.js";
import type { Seams } from "../../src/seams/types.js";
import { issueVisitorSession, VISITOR_SESSION_TTL_MS } from "../../src/security/visitorSession.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { type FakeSeamOverrides, fakeSeams, TEST_ORG_ID } from "../helpers/app.js";

// Turnstile's documented test keys and dummy token.
// Source (checked 2026-11-20): https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const PASS_SITE_KEY = "1x00000000000000000000AA";
const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
const SPENT_SECRET = "3x0000000000000000000000000000000AA";
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** A production-shaped secret, answered by `fakeTurnstile` from its token table. */
const REAL_SECRET = "0x4AAAAAAAREALSECRETFORTESTSONLY";
const REAL_SITE_KEY = "0x4AAAAAAAREALSITEKEY";
const SIGNING_SECRET = "a-test-only-signing-secret-of-some-length";

const ORG_B = "org_cccccccccccccccccccc";
const ORIGIN = "https://site.example";
const ENGINE = "https://engine.example";

/**
 * Stands in for Siteverify, answering as the documentation says it does:
 * a test secret accepts only the dummy token and reports hostname
 * example.com with no action; a real secret is answered from `tokens`.
 */
function fakeTurnstile(tokens: Record<string, Record<string, unknown>> = {}) {
  const verifyCalls: Record<string, unknown>[] = [];
  const otherCalls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== SITEVERIFY_URL) {
      otherCalls.push(url);
      throw new Error(`unexpected fetch ${url}`);
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    verifyCalls.push(body);
    if (body.secret === PASS_SECRET) {
      return Response.json(
        body.response === DUMMY_TOKEN
          ? {
              success: true,
              challenge_ts: "2026-11-20T00:00:00Z",
              hostname: "example.com",
              "error-codes": [],
            }
          : { success: false, "error-codes": ["invalid-input-response"] },
      );
    }
    if (body.secret === FAIL_SECRET) {
      return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
    }
    if (body.secret === SPENT_SECRET) {
      return Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] });
    }
    const answer = tokens[String(body.response)];
    return Response.json(answer ?? { success: false, "error-codes": ["invalid-input-response"] });
  });
  return { fetchImpl, verifyCalls, otherCalls };
}

function parseSse(text: string) {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const name =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "";
      const data =
        lines
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? "";
      return parseChatEventLine(name, data);
    });
}

interface Harness {
  app: ReturnType<typeof createApp>;
  env: Env;
  embedSpy: ReturnType<typeof vi.fn>;
  streamSpy: ReturnType<typeof vi.fn>;
  turnstile: ReturnType<typeof fakeTurnstile>;
}

function harness(
  envOverrides: Partial<Env>,
  options: {
    tokens?: Record<string, Record<string, unknown>>;
    seams?: FakeSeamOverrides;
    fetchImpl?: AppOptions["fetch"];
  } = {},
): Harness {
  const embedSpy = vi.fn(fakeEmbedder().embed);
  const streamSpy = vi.fn();
  const provider: LlmProvider = {
    name: "anthropic",
    model: ANTHROPIC_MODELS.balanced.id,
    async *stream() {
      streamSpy();
      yield { kind: "text", text: "Here is the answer." };
      yield { kind: "usage", tokensIn: 1, tokensOut: 1, stopReason: "end" };
    },
  };
  const turnstile = fakeTurnstile(options.tokens);
  const app = createApp(fakeSeams(options.seams), {
    fetch: (options.fetchImpl ?? turnstile.fetchImpl) as typeof fetch,
    chat: {
      embedder: { dimensions: 1536, embed: embedSpy },
      retriever: memoryRetriever(),
      provider,
      reviewer: null,
    },
  });
  return { app, env: { ...env, ...envOverrides } as Env, embedSpy, streamSpy, turnstile };
}

const PASS_ENV: Partial<Env> = {
  SOLV_TURNSTILE_SITE_KEY: PASS_SITE_KEY,
  SOLV_TURNSTILE_SECRET: PASS_SECRET,
  SOLV_SECRET_KEY: SIGNING_SECRET,
};

async function call(h: Harness, path: string, init: RequestInit & { ip?: string } = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", ORIGIN);
  headers.set("content-type", "application/json");
  if (init.ip) headers.set("cf-connecting-ip", init.ip);
  const response = await h.app.fetch(
    new Request(`${ENGINE}${path}`, { ...init, headers }),
    h.env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

async function exchange(
  h: Harness,
  token: string,
  opts: { visitorId?: string; assistant?: string; ip?: string; origin?: string } = {},
) {
  const { response, text } = await call(h, "/v1/session", {
    method: "POST",
    ip: opts.ip ?? "203.0.113.7",
    headers: { origin: opts.origin ?? ORIGIN },
    body: JSON.stringify({
      protocol: 2,
      assistant: opts.assistant ?? "pk_vc_1",
      visitorId: opts.visitorId ?? "vis_1",
      token,
    }),
  });
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, response };
}

async function chat(
  h: Harness,
  body: Record<string, unknown>,
  opts: { ip?: string; origin?: string } = {},
) {
  const { response, text } = await call(h, "/v1/chat", {
    method: "POST",
    ip: opts.ip ?? "203.0.113.7",
    headers: { origin: opts.origin ?? ORIGIN },
    body: JSON.stringify({ protocol: 2, assistant: "pk_vc_1", visitorId: "vis_1", ...body }),
  });
  return { response, events: parseSse(text), text };
}

let tokenSeq = 0;
/**
 * A fresh real-shaped token that `fakeTurnstile` accepts for the engine's
 * hostname, as Turnstile answers for one rendered by `assistantId`'s frame
 * opened for `origin` (its `cdata`).
 */
async function realToken(
  tokens: Record<string, Record<string, unknown>>,
  answer?: Record<string, unknown>,
  boundTo: { assistantId?: string; origin?: string } = {},
) {
  tokenSeq += 1;
  const token = `real-token-${tokenSeq}-${crypto.randomUUID()}`;
  tokens[token] = answer ?? {
    success: true,
    hostname: "engine.example",
    action: "solv-chat",
    cdata: await checkBinding(boundTo.assistantId ?? "ast_vc_1", boundTo.origin ?? ORIGIN),
    "error-codes": [],
  };
  return token;
}

const REAL_ENV: Partial<Env> = {
  SOLV_TURNSTILE_SITE_KEY: REAL_SITE_KEY,
  SOLV_TURNSTILE_SECRET: REAL_SECRET,
  SOLV_SECRET_KEY: SIGNING_SECRET,
};

describe("visitor check", () => {
  const tenantA = forPrincipal(env.DB, { orgId: TEST_ORG_ID, userId: "usr_a", role: "owner" });
  const tenantB = forPrincipal(env.DB, { orgId: ORG_B, userId: "usr_b", role: "owner" });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM visitor_counters"),
      env.DB.prepare("DELETE FROM visitor_check_tokens"),
      env.DB.prepare("DELETE FROM feedback"),
      env.DB.prepare("DELETE FROM message_traces"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM conversations"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id = ?1").bind(ORG_B),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
    const seed = async (
      tenant: typeof tenantA,
      id: string,
      publicKey: string,
      origins: string[],
    ) => {
      await tenant.assistants.create({
        id,
        name: id,
        publicKey,
        allowedOrigins: origins,
        createdAt: 1000,
      });
      const draft = await tenant.versions.createDraft({
        id: `ver_${id}`,
        assistantId: id,
        config: defaultVersionConfig(),
        createdAt: 1000,
      });
      await tenant.versions.publishDraft(id, draft.id, `ver_${id}_p`, 2000);
    };
    await seed(tenantA, "ast_vc_1", "pk_vc_1", [ORIGIN]);
    await seed(tenantA, "ast_vc_2", "pk_vc_2", [ORIGIN]);
    await seed(tenantB, "ast_vc_b", "pk_vc_b", [ORIGIN]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("with the always-pass test keys", () => {
    it("issues a session for the dummy token and answers with it", async () => {
      const h = harness(PASS_ENV);
      const issued = await exchange(h, DUMMY_TOKEN);
      expect(issued.status).toBe(200);
      expect(issued.response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(typeof issued.body.session).toBe("string");
      expect(issued.body.expiresAt).toBeGreaterThan(Date.now());
      // Siteverify got the secret, the token and the visitor's IP.
      expect(h.turnstile.verifyCalls).toEqual([
        { secret: PASS_SECRET, response: DUMMY_TOKEN, remoteip: "203.0.113.7" },
      ]);

      const { events } = await chat(h, { message: "Hello?", session: issued.body.session });
      expect(events.at(-1)?.type).toBe("done");
      expect(h.embedSpy).toHaveBeenCalledTimes(1);
    });

    it("tells the widget to run the check in the public config", async () => {
      const h = harness(PASS_ENV);
      const { text } = await call(h, "/v1/assistants/pk_vc_1", { method: "GET" });
      expect(JSON.parse(text).visitorCheck).toBe(true);
    });
  });

  describe("with the always-fail test secret", () => {
    it("issues no session and makes no model, embedding or tool call", async () => {
      const h = harness({ ...PASS_ENV, SOLV_TURNSTILE_SECRET: FAIL_SECRET });
      const issued = await exchange(h, DUMMY_TOKEN);
      expect(issued.status).toBe(403);
      expect(issued.body).toEqual({
        error: "The security check could not be completed. Please try again.",
        code: "check_failed",
      });
      expect(issued.body.session).toBeUndefined();

      // The visitor's message then has nothing to send but no session.
      const { events } = await chat(h, { message: "Hello?" });
      expect(events).toEqual([
        {
          type: "error",
          message: "The security check has expired. Please send your message again.",
          code: "check_required",
        },
      ]);
      expect(h.embedSpy).not.toHaveBeenCalled();
      expect(h.streamSpy).not.toHaveBeenCalled();
      // The only outbound call was Siteverify: no MCP tool was reached.
      expect(h.turnstile.otherCalls).toEqual([]);
    });

    it("treats the documented spent-token secret as a refusal", async () => {
      const h = harness({ ...PASS_ENV, SOLV_TURNSTILE_SECRET: SPENT_SECRET });
      const issued = await exchange(h, DUMMY_TOKEN);
      expect(issued.status).toBe(403);
      expect(issued.body.code).toBe("check_failed");
    });
  });

  describe("POST /v1/chat refusals cost nothing", () => {
    it("refuses a missing, expired, tampered, other-assistant and other-org session", async () => {
      const h = harness(PASS_ENV);
      const subject = { orgId: TEST_ORG_ID, assistantId: "ast_vc_1", visitorId: "vis_1" };
      const expired = await issueVisitorSession(
        SIGNING_SECRET,
        subject,
        Date.now() - VISITOR_SESSION_TTL_MS - 1000,
      );
      const valid = await issueVisitorSession(SIGNING_SECRET, subject, Date.now());
      const [prefix, expiry, nonce, mac = ""] = valid.session.split(".");
      const tamperedExpiry = [prefix, String(Number(expiry) + 60_000), nonce, mac].join(".");
      const tamperedMac = [prefix, expiry, nonce, `${mac.slice(0, -2)}AA`].join(".");
      const otherAssistant = await issueVisitorSession(
        SIGNING_SECRET,
        { ...subject, assistantId: "ast_vc_2" },
        Date.now(),
      );
      const otherOrg = await issueVisitorSession(
        SIGNING_SECRET,
        { ...subject, orgId: ORG_B, assistantId: "ast_vc_b" },
        Date.now(),
      );
      const otherVisitor = await issueVisitorSession(
        SIGNING_SECRET,
        { ...subject, visitorId: "vis_2" },
        Date.now(),
      );
      const otherKey = await issueVisitorSession("another-signing-secret", subject, Date.now());

      for (const session of [
        undefined,
        expired.session,
        tamperedExpiry,
        tamperedMac,
        otherAssistant.session,
        otherOrg.session,
        otherVisitor.session,
        otherKey.session,
        "not-a-session",
      ]) {
        const { events } = await chat(h, {
          message: "Hello?",
          ...(session === undefined ? {} : { session }),
        });
        expect(events).toEqual([
          {
            type: "error",
            message: "The security check has expired. Please send your message again.",
            code: "check_required",
          },
        ]);
      }
      // The session for org B's assistant works there, and only there.
      const { events } = await chat(h, {
        assistant: "pk_vc_b",
        message: "Hello?",
        session: otherOrg.session,
      });
      expect(events.at(-1)?.type).toBe("done");
      expect(h.embedSpy).toHaveBeenCalledTimes(1);

      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE org_id = ?1")
        .bind(TEST_ORG_ID)
        .first<{ n: number }>();
      expect(count?.n).toBe(0);
    });

    it("checks the session before the Limits seam", async () => {
      const limitsCheck = vi.fn(async () => ({ ok: true as const }));
      const h = harness(PASS_ENV, { seams: { limits: { check: limitsCheck } } });
      await chat(h, { message: "Hello?" });
      expect(limitsCheck).not.toHaveBeenCalled();
    });

    it("needs a session for feedback, which writes a row", async () => {
      const h = harness(PASS_ENV);
      const issued = await exchange(h, DUMMY_TOKEN);
      const { events } = await chat(h, { message: "Hello?", session: issued.body.session });
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("expected done");
      const send = (session?: unknown) =>
        call(h, "/v1/feedback", {
          method: "POST",
          body: JSON.stringify({
            messageId: done.messageId,
            visitorId: "vis_1",
            value: "up",
            ...(session === undefined ? {} : { session }),
          }),
        });
      const refused = await send();
      expect(refused.response.status).toBe(403);
      expect(JSON.parse(refused.text).code).toBe("check_required");
      const accepted = await send(issued.body.session);
      expect(accepted.response.status).toBe(200);
    });

    it("needs a session to continue a paused answer", async () => {
      const h = harness(PASS_ENV);
      const { events } = await chat(h, {
        conversationId: "cnv_x",
        resumeMessageId: "msg_x",
        actionResults: [{ callId: "c1", ok: true, result: "{}" }],
      });
      expect(events[0]).toMatchObject({ type: "error", code: "check_required" });
      expect(h.streamSpy).not.toHaveBeenCalled();
    });
  });

  describe("token exchange", () => {
    it("cannot exchange one token twice, even when Siteverify would accept it again", async () => {
      const tokens: Record<string, Record<string, unknown>> = {};
      const h = harness(REAL_ENV, { tokens });
      const token = await realToken(tokens);
      expect((await exchange(h, token)).status).toBe(200);
      const second = await exchange(h, token, { visitorId: "vis_2" });
      expect(second.status).toBe(403);
      expect(second.body.code).toBe("check_failed");
      // Refused before Siteverify was asked a second time.
      expect(h.turnstile.verifyCalls).toHaveLength(1);
    });

    it("cannot spend one token across organisations", async () => {
      const tokens: Record<string, Record<string, unknown>> = {};
      const h = harness(REAL_ENV, { tokens });
      const token = await realToken(tokens);
      expect((await exchange(h, token)).status).toBe(200);
      expect((await exchange(h, token, { assistant: "pk_vc_b" })).status).toBe(403);
      expect(h.turnstile.verifyCalls).toHaveLength(1);
    });

    it("keeps the always-pass test keys usable for every visitor, assistant and renewal", async () => {
      const h = harness(PASS_ENV);
      const runs = [
        {},
        { visitorId: "vis_2" },
        { assistant: "pk_vc_2" },
        { assistant: "pk_vc_b" },
        // A renewal: the same visitor checks again.
        {},
      ];
      for (const opts of runs) {
        const issued = await exchange(h, DUMMY_TOKEN, opts);
        expect(issued.status).toBe(200);
        expect(typeof issued.body.session).toBe("string");
      }
      // Each exchange still asked Siteverify.
      expect(h.turnstile.verifyCalls).toHaveLength(runs.length);
      const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM visitor_check_tokens").first<{
        n: number;
      }>();
      expect(stored?.n).toBe(0);
    });

    it("still refuses every exchange with the always-fail and spent-token test secrets", async () => {
      for (const secret of [FAIL_SECRET, SPENT_SECRET]) {
        const h = harness({ ...PASS_ENV, SOLV_TURNSTILE_SECRET: secret });
        for (const visitorId of ["vis_1", "vis_2", "vis_1"]) {
          const result = await exchange(h, DUMMY_TOKEN, { visitorId });
          expect(result.status).toBe(403);
          expect(result.body.code).toBe("check_failed");
        }
        expect(h.turnstile.verifyCalls).toHaveLength(3);
      }
    });

    it("drops spent tokens once they have expired, before recording a new one", async () => {
      const tokens: Record<string, Record<string, unknown>> = {};
      const h = harness(REAL_ENV, { tokens });
      await env.DB.prepare(
        "INSERT INTO visitor_check_tokens (token_hash, org_id, expires_at) VALUES ('old', ?1, ?2)",
      )
        .bind(TEST_ORG_ID, Date.now() - 1000)
        .run();
      expect((await exchange(h, await realToken(tokens))).status).toBe(200);
      const rows = await env.DB.prepare("SELECT token_hash FROM visitor_check_tokens").all<{
        token_hash: string;
      }>();
      expect(rows.results.map((r) => r.token_hash)).not.toContain("old");
      expect(rows.results).toHaveLength(1);
    });

    it("binds a token to the assistant and page its challenge ran for", async () => {
      const tokens: Record<string, Record<string, unknown>> = {};
      const h = harness(REAL_ENV, { tokens });
      // A token from assistant 1's frame (same org, same website, shared
      // keys and hostname) is refused for assistant 2 and for org B's.
      for (const assistant of ["pk_vc_2", "pk_vc_b"]) {
        const fromFirst = await realToken(tokens);
        const refused = await exchange(h, fromFirst, { assistant });
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({
          error: "The security check could not be completed. Please try again.",
          code: "check_failed",
        });
        expect(refused.body.session).toBeUndefined();
      }
      // One rendered for another page of the same assistant is refused too.
      const otherPage = await realToken(tokens, undefined, { origin: "https://other.example" });
      expect((await exchange(h, otherPage)).status).toBe(403);
      // So is one with no binding at all.
      const unbound = await realToken(tokens, {
        success: true,
        hostname: "engine.example",
        action: "solv-chat",
      });
      expect((await exchange(h, unbound)).status).toBe(403);
      // The right binding is accepted.
      const own = await realToken(tokens, undefined, { assistantId: "ast_vc_2" });
      expect((await exchange(h, own, { assistant: "pk_vc_2" })).status).toBe(200);
    });

    it("never treats a Siteverify error, bad reply or timeout as success", async () => {
      const replies: Array<() => Promise<Response>> = [
        async () => new Response("upstream down", { status: 500 }),
        async () => new Response("not json", { status: 200 }),
        async () => Response.json(null),
        async () => Response.json({ success: "true" }),
        async () => {
          throw new TypeError("network");
        },
      ];
      for (const reply of replies) {
        const h = harness(PASS_ENV, { fetchImpl: (async () => reply()) as typeof fetch });
        const result = await exchange(h, `token-${crypto.randomUUID()}`);
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.body.session).toBeUndefined();
        expect(result.body.code).toBe("check_failed");
      }

      // A Siteverify that never answers is cut off by the timeout.
      const hanging = harness(PASS_ENV, {
        fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("timed out", "TimeoutError")),
            );
          })) as typeof fetch,
      });
      const started = Date.now();
      const result = await exchange(hanging, `token-${crypto.randomUUID()}`);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe("check_failed");
      expect(Date.now() - started).toBeLessThan(15_000);
    }, 20_000);

    it("checks hostname and action with a real secret", async () => {
      const tokens: Record<string, Record<string, unknown>> = {};
      const env2 = {
        SOLV_TURNSTILE_SITE_KEY: REAL_SITE_KEY,
        SOLV_TURNSTILE_SECRET: REAL_SECRET,
        SOLV_SECRET_KEY: SIGNING_SECRET,
      };
      const h = harness(env2, { tokens });
      expect((await exchange(h, await realToken(tokens))).status).toBe(200);
      const wrongHost = await realToken(tokens, {
        success: true,
        hostname: "attacker.example",
        action: "solv-chat",
      });
      expect((await exchange(h, wrongHost)).status).toBe(403);
      const wrongAction = await realToken(tokens, {
        success: true,
        hostname: "engine.example",
        action: "login",
      });
      expect((await exchange(h, wrongAction)).status).toBe(403);
      // A test secret's fixed answer (example.com, no action) is not enough for a real secret.
      const testShaped = await realToken(tokens, { success: true, hostname: "example.com" });
      expect((await exchange(h, testShaped)).status).toBe(403);
    });

    it("refuses an exchange from a page the assistant is not on", async () => {
      const h = harness(PASS_ENV);
      const result = await exchange(h, DUMMY_TOKEN, { origin: "https://evil.example" });
      expect(result.status).toBe(403);
      expect(h.turnstile.verifyCalls).toHaveLength(0);
    });
  });

  describe("caps", () => {
    const capEnv = (caps: Partial<Env>): Partial<Env> => ({ ...PASS_ENV, ...caps });

    async function sessionFor(h: Harness, visitorId = "vis_1", assistant = "pk_vc_1") {
      const tokens = h.turnstile;
      void tokens;
      const subject = {
        orgId: assistant === "pk_vc_b" ? ORG_B : TEST_ORG_ID,
        assistantId:
          assistant === "pk_vc_1" ? "ast_vc_1" : assistant === "pk_vc_2" ? "ast_vc_2" : "ast_vc_b",
        visitorId,
      };
      return (await issueVisitorSession(SIGNING_SECRET, subject, Date.now())).session;
    }

    it("refuses the message after the visitor's daily cap, per assistant and org", async () => {
      const h = harness(capEnv({ SOLV_VISITOR_DAILY_MESSAGES: "2" }));
      const session = await sessionFor(h);
      for (let i = 0; i < 2; i++) {
        const { events } = await chat(h, { message: `Q${i}`, session });
        expect(events.at(-1)?.type).toBe("done");
      }
      const calls = h.embedSpy.mock.calls.length;
      const { events } = await chat(h, { message: "Q3", session });
      expect(events).toEqual([
        {
          type: "error",
          message: "You have reached today's limit for questions. Please come back tomorrow.",
          code: "visitor_cap",
        },
      ]);
      expect(h.embedSpy.mock.calls.length).toBe(calls);

      // The same visitor id on another assistant, or in another org, starts at zero.
      const other = await chat(h, {
        assistant: "pk_vc_2",
        message: "Q",
        session: await sessionFor(h, "vis_1", "pk_vc_2"),
      });
      expect(other.events.at(-1)?.type).toBe("done");
      const orgB = await chat(h, {
        assistant: "pk_vc_b",
        message: "Q",
        session: await sessionFor(h, "vis_1", "pk_vc_b"),
      });
      expect(orgB.events.at(-1)?.type).toBe("done");
    });

    it("refuses the message after the IP's daily cap", async () => {
      const h = harness(capEnv({ SOLV_IP_DAILY_MESSAGES: "2" }));
      for (const visitorId of ["vis_a", "vis_b"]) {
        const { events } = await chat(h, {
          visitorId,
          message: "Q",
          session: await sessionFor(h, visitorId),
        });
        expect(events.at(-1)?.type).toBe("done");
      }
      const { events } = await chat(h, {
        visitorId: "vis_c",
        message: "Q",
        session: await sessionFor(h, "vis_c"),
      });
      expect(events).toEqual([
        {
          type: "error",
          message:
            "Too many questions have come from your network today. Please come back tomorrow.",
          code: "ip_cap",
        },
      ]);
      // Another network is not affected.
      const elsewhere = await chat(
        h,
        { visitorId: "vis_c", message: "Q", session: await sessionFor(h, "vis_c") },
        { ip: "198.51.100.1" },
      );
      expect(elsewhere.events.at(-1)?.type).toBe("done");
    });

    it("lets no refused message use up a cap shared with other visitors", async () => {
      const h = harness(
        capEnv({
          SOLV_VISITOR_DAILY_MESSAGES: "2",
          SOLV_IP_DAILY_MESSAGES: "4",
        }),
      );
      const sessionA = await sessionFor(h, "vis_a");
      for (let i = 0; i < 2; i++) {
        const { events } = await chat(h, {
          visitorId: "vis_a",
          message: `A${i}`,
          session: sessionA,
        });
        expect(events.at(-1)?.type).toBe("done");
      }
      // Visitor A keeps asking past their own cap from the shared network.
      for (let i = 0; i < 5; i++) {
        const { events } = await chat(h, {
          visitorId: "vis_a",
          message: `More${i}`,
          session: sessionA,
        });
        expect(events).toEqual([expect.objectContaining({ type: "error", code: "visitor_cap" })]);
      }
      // The network still has two messages left, and B's last admitted one counts against it.
      const sessionB = await sessionFor(h, "vis_b");
      for (let i = 0; i < 2; i++) {
        const { events } = await chat(h, {
          visitorId: "vis_b",
          message: `B${i}`,
          session: sessionB,
        });
        expect(events.at(-1)?.type).toBe("done");
      }
      const { events } = await chat(h, {
        visitorId: "vis_c",
        message: "C",
        session: await sessionFor(h, "vis_c"),
      });
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "ip_cap" })]);
      const counts = await env.DB.prepare(
        "SELECT counter, hits FROM visitor_counters ORDER BY counter, hits",
      ).all<{ counter: string; hits: number }>();
      expect(counts.results).toEqual([
        { counter: "ip_day", hits: 4 },
        { counter: "visitor_day", hits: 2 },
        { counter: "visitor_day", hits: 2 },
      ]);

      // Refused by the network's cap, a visitor keeps their own allowance for elsewhere.
      const elsewhere = { ip: "198.51.100.1" };
      const sessionD = await sessionFor(h, "vis_d");
      for (let i = 0; i < 3; i++) {
        const refused = await chat(h, {
          visitorId: "vis_d",
          message: `D${i}`,
          session: sessionD,
        });
        expect(refused.events[0]).toMatchObject({ code: "ip_cap" });
      }
      for (let i = 0; i < 2; i++) {
        const away = await chat(
          h,
          { visitorId: "vis_d", message: `D-away${i}`, session: sessionD },
          elsewhere,
        );
        expect(away.events.at(-1)?.type).toBe("done");
      }
    });

    it("admits only one of two simultaneous requests for a visitor's last daily message", async () => {
      const h = harness(
        capEnv({
          SOLV_VISITOR_DAILY_MESSAGES: "1",
          SOLV_IP_DAILY_MESSAGES: "5",
        }),
      );
      const session = await sessionFor(h);
      const results = await Promise.all([
        chat(h, { message: "Qa", session }),
        chat(h, { message: "Qb", session }),
      ]);
      const last = results.map((r) => r.events.at(-1));
      expect(last.filter((e) => e?.type === "done")).toHaveLength(1);
      expect(last.filter((e) => e?.type === "error" && e.code === "visitor_cap")).toHaveLength(1);
      const ip = await env.DB.prepare(
        "SELECT hits FROM visitor_counters WHERE counter = 'ip_day'",
      ).first<{ hits: number }>();
      expect(ip?.hits).toBe(1);
    });

    it("refuses the message after the conversation's cap", async () => {
      const h = harness(capEnv({ SOLV_CONVERSATION_MESSAGES: "2" }));
      const session = await sessionFor(h);
      const first = await chat(h, { message: "Q1", session });
      const done = first.events.at(-1);
      if (done?.type !== "done") throw new Error("expected done");
      const conversationId = done.conversationId;
      const second = await chat(h, { message: "Q2", session, conversationId });
      expect(second.events.at(-1)?.type).toBe("done");
      const calls = h.embedSpy.mock.calls.length;
      const third = await chat(h, { message: "Q3", session, conversationId });
      expect(third.events).toEqual([
        {
          type: "error",
          message: "This conversation has reached its limit. Your next question starts a new one.",
          code: "conversation_cap",
        },
      ]);
      expect(h.embedSpy.mock.calls.length).toBe(calls);
      // A new conversation is fine.
      const fresh = await chat(h, { message: "Q4", session });
      expect(fresh.events.at(-1)?.type).toBe("done");
    });

    it("admits only one of two simultaneous requests for a conversation's last slot", async () => {
      const h = harness(capEnv({ SOLV_CONVERSATION_MESSAGES: "2" }));
      const session = await sessionFor(h);
      const first = await chat(h, { message: "Q1", session });
      const done = first.events.at(-1);
      if (done?.type !== "done") throw new Error("expected done");
      const conversationId = done.conversationId;
      const calls = h.embedSpy.mock.calls.length;

      const results = await Promise.all([
        chat(h, { message: "Q2a", session, conversationId }),
        chat(h, { message: "Q2b", session, conversationId }),
      ]);
      const last = results.map((r) => r.events.at(-1));
      expect(last.filter((e) => e?.type === "done")).toHaveLength(1);
      expect(last.filter((e) => e?.type === "error" && e.code === "conversation_cap")).toHaveLength(
        1,
      );
      // Only the admitted request did paid work, and the conversation holds the cap.
      expect(h.embedSpy.mock.calls.length).toBe(calls + 1);
      const stored = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND role = 'user'",
      )
        .bind(conversationId)
        .first<{ n: number }>();
      expect(stored?.n).toBe(2);
    });

    it("counts visitor messages stored before any reservation, and gives a slot back when a daily cap refuses", async () => {
      const h = harness(
        capEnv({ SOLV_CONVERSATION_MESSAGES: "3", SOLV_VISITOR_DAILY_MESSAGES: "2" }),
      );
      const session = await sessionFor(h);
      const first = await chat(h, { message: "Q1", session });
      const done = first.events.at(-1);
      if (done?.type !== "done") throw new Error("expected done");
      const conversationId = done.conversationId;
      expect((await chat(h, { message: "Q2", session, conversationId })).events.at(-1)?.type).toBe(
        "done",
      );
      // The day's cap refuses the third: no slot is kept for a message not admitted.
      const refused = await chat(h, { message: "Q3", session, conversationId });
      expect(refused.events[0]).toMatchObject({ code: "visitor_cap" });
      const row = await env.DB.prepare(
        "SELECT visitor_messages_reserved AS n FROM conversations WHERE id = ?1",
      )
        .bind(conversationId)
        .first<{ n: number }>();
      expect(row?.n).toBe(2);

      // A conversation whose messages predate the column is still capped by them.
      await env.DB.prepare("UPDATE conversations SET visitor_messages_reserved = 0 WHERE id = ?1")
        .bind(conversationId)
        .run();
      const fresh = harness(capEnv({ SOLV_CONVERSATION_MESSAGES: "2" }));
      const capped = await chat(fresh, { message: "Q3", session, conversationId });
      expect(capped.events[0]).toMatchObject({ code: "conversation_cap" });
    });

    it("refuses a session after the IP's hourly session cap, per assistant", async () => {
      const tokens: Record<string, Record<string, unknown>> = {};
      const h = harness(
        {
          SOLV_TURNSTILE_SITE_KEY: REAL_SITE_KEY,
          SOLV_TURNSTILE_SECRET: REAL_SECRET,
          SOLV_SECRET_KEY: SIGNING_SECRET,
          SOLV_IP_HOURLY_SESSIONS: "2",
        },
        { tokens },
      );
      expect((await exchange(h, await realToken(tokens))).status).toBe(200);
      expect((await exchange(h, await realToken(tokens))).status).toBe(200);
      const third = await exchange(h, await realToken(tokens));
      expect(third.status).toBe(429);
      expect(third.body).toEqual({
        error: "Too many security checks have come from your network. Please try again in an hour.",
        code: "session_cap",
      });
      const forSecond = await realToken(tokens, undefined, { assistantId: "ast_vc_2" });
      expect((await exchange(h, forSecond, { assistant: "pk_vc_2" })).status).toBe(200);
      const forOrgB = await realToken(tokens, undefined, { assistantId: "ast_vc_b" });
      expect((await exchange(h, forOrgB, { assistant: "pk_vc_b" })).status).toBe(200);
    });

    it("stores no IP or visitor id in the counters", async () => {
      const h = harness(PASS_ENV);
      await chat(h, { message: "Q", session: await sessionFor(h) });
      const rows = await env.DB.prepare("SELECT subject FROM visitor_counters").all<{
        subject: string;
      }>();
      expect(rows.results.length).toBeGreaterThan(0);
      for (const row of rows.results) {
        expect(row.subject).not.toContain("203.0.113.7");
        expect(row.subject).not.toContain("vis_1");
      }
    });

    it("leaves owner surfaces unchallenged and uncounted", async () => {
      const h = harness(capEnv({ SOLV_VISITOR_DAILY_MESSAGES: "1", SOLV_IP_DAILY_MESSAGES: "1" }));
      for (let i = 0; i < 3; i++) {
        const { response, text } = await call(h, "/api/admin/chat", {
          method: "POST",
          headers: { origin: ENGINE },
          body: JSON.stringify({
            protocol: 2,
            assistant: "pk_vc_1",
            visitorId: "vis_1",
            message: `Try ${i}`,
          }),
        });
        expect(response.status).toBe(200);
        expect(parseSse(text).at(-1)?.type).toBe("done");
      }
      const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM visitor_counters").first<{
        n: number;
      }>();
      expect(rows?.n).toBe(0);
    });
  });

  describe("not configured", () => {
    it("answers exactly as before: no session asked for, no config field, no session route", async () => {
      const h = harness({
        SOLV_TURNSTILE_SITE_KEY: undefined,
        SOLV_TURNSTILE_SECRET: undefined,
      });
      const config = await call(h, "/v1/assistants/pk_vc_1", { method: "GET" });
      expect(Object.keys(JSON.parse(config.text)).sort()).toEqual([
        "accentColor",
        "actions",
        "greeting",
        "position",
        "suggestedQuestions",
        "title",
      ]);
      const { events, text } = await chat(h, { message: "Hello?" });
      expect(events.at(-1)?.type).toBe("done");
      expect(text).not.toContain("code");
      expect((await exchange(h, DUMMY_TOKEN)).status).toBe(404);
      expect(
        (await call(h, `/v1/check/frame?assistant=pk_vc_1&parent=${ORIGIN}`)).response.status,
      ).toBe(404);
      expect(h.turnstile.verifyCalls).toHaveLength(0);
    });

    it("shows the admin that visitor chat is unprotected", async () => {
      const h = harness({});
      const { text } = await call(h, "/api/admin/assistants", { method: "GET" });
      expect(JSON.parse(text).visitorCheck).toEqual({ state: "off", missing: [] });
    });
  });

  describe("half configured", () => {
    for (const [name, overrides, missing] of [
      [
        "site key only",
        { SOLV_TURNSTILE_SITE_KEY: PASS_SITE_KEY, SOLV_SECRET_KEY: SIGNING_SECRET },
        ["secret"],
      ],
      [
        "secret only",
        { SOLV_TURNSTILE_SECRET: PASS_SECRET, SOLV_SECRET_KEY: SIGNING_SECRET },
        ["site_key"],
      ],
      [
        "no SOLV_SECRET_KEY",
        {
          SOLV_TURNSTILE_SITE_KEY: PASS_SITE_KEY,
          SOLV_TURNSTILE_SECRET: PASS_SECRET,
          SOLV_SECRET_KEY: "",
        },
        ["secret_key"],
      ],
    ] as const) {
      it(`refuses the public chat and tells the admin what is missing (${name})`, async () => {
        const h = harness(overrides as Partial<Env>);
        const { events } = await chat(h, { message: "Hello?" });
        expect(events).toEqual([
          {
            type: "error",
            message: "This chat is not set up correctly. Please try again later.",
            code: "check_config",
          },
        ]);
        expect(h.embedSpy).not.toHaveBeenCalled();
        expect(h.streamSpy).not.toHaveBeenCalled();
        const admin = await call(h, "/api/admin/assistants", { method: "GET" });
        expect(JSON.parse(admin.text).visitorCheck).toEqual({
          state: "misconfigured",
          missing: [...missing],
        });
      });
    }

    it("lets a host require the check through the seam", async () => {
      const visitorCheck: NonNullable<Seams["visitorCheck"]> = {
        required: true,
        keys: () => ({}),
      };
      const h = harness({}, { seams: { visitorCheck } });
      const { events } = await chat(h, { message: "Hello?" });
      expect(events[0]).toMatchObject({ code: "check_config" });

      const supplied = harness(
        { SOLV_SECRET_KEY: SIGNING_SECRET },
        {
          seams: {
            visitorCheck: {
              required: true,
              keys: () => ({ siteKey: PASS_SITE_KEY, secret: PASS_SECRET }),
            },
          },
        },
      );
      expect((await exchange(supplied, DUMMY_TOKEN)).status).toBe(200);
    });
  });

  describe("check frame", () => {
    it("is framed only by the assistant's own website and carries Turnstile's policy", async () => {
      const h = harness(PASS_ENV);
      const ok = await call(
        h,
        `/v1/check/frame?assistant=pk_vc_1&parent=${encodeURIComponent(ORIGIN)}&theme=dark`,
      );
      expect(ok.response.status).toBe(200);
      const csp = ok.response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain(`frame-ancestors ${ORIGIN}`);
      expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
      expect(csp).toContain("frame-src https://challenges.cloudflare.com");
      expect(ok.text).toContain(`data-site-key="${PASS_SITE_KEY}"`);
      expect(ok.text).toContain('data-theme="dark"');
      // The challenge carries the assistant-and-page binding Siteverify must echo.
      expect(ok.text).toContain(`data-cdata="${await checkBinding("ast_vc_1", ORIGIN)}"`);
      const second = await call(
        h,
        `/v1/check/frame?assistant=pk_vc_2&parent=${encodeURIComponent(ORIGIN)}`,
      );
      expect(second.text).toContain(`data-cdata="${await checkBinding("ast_vc_2", ORIGIN)}"`);
      expect(await checkBinding("ast_vc_1", ORIGIN)).toMatch(/^[0-9a-f]{64}$/);
      expect(ok.text).not.toContain(PASS_SECRET);

      const evil = await call(
        h,
        `/v1/check/frame?assistant=pk_vc_1&parent=${encodeURIComponent("https://evil.example")}`,
      );
      expect(evil.response.status).toBe(404);
      const script = await call(h, "/v1/check/frame.js");
      expect(script.response.headers.get("content-type")).toContain("javascript");
      expect(script.text).toContain("event.origin !== parentOrigin");
      expect(script.text).toContain("cData: data.cdata");
    });
  });

  it("never puts the Turnstile secret or signing secret in a response or a log line", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const bodies: string[] = [];
    const tokens: Record<string, Record<string, unknown>> = {};
    const real = {
      SOLV_TURNSTILE_SITE_KEY: REAL_SITE_KEY,
      SOLV_TURNSTILE_SECRET: REAL_SECRET,
      SOLV_SECRET_KEY: SIGNING_SECRET,
    };
    const h = harness(real, { tokens });
    const good = await exchange(h, await realToken(tokens));
    bodies.push(JSON.stringify(good.body));
    bodies.push(JSON.stringify((await exchange(h, "bad-token")).body));
    bodies.push(
      JSON.stringify(
        (await exchange(h, await realToken(tokens, { success: true, hostname: "x" }))).body,
      ),
    );
    bodies.push((await chat(h, { message: "Q", session: good.body.session })).text);
    bodies.push((await chat(h, { message: "Q" })).text);
    bodies.push((await call(h, "/v1/assistants/pk_vc_1", { method: "GET" })).text);
    bodies.push((await call(h, `/v1/check/frame?assistant=pk_vc_1&parent=${ORIGIN}`)).text);
    bodies.push((await call(h, "/api/admin/assistants", { method: "GET" })).text);
    bodies.push((await call(h, "/api/admin/assistants/ast_vc_1/install", { method: "GET" })).text);
    const half = harness({ SOLV_TURNSTILE_SECRET: REAL_SECRET, SOLV_SECRET_KEY: SIGNING_SECRET });
    bodies.push((await chat(half, { message: "Q" })).text);
    bodies.push((await call(half, "/api/admin/assistants", { method: "GET" })).text);

    expect(lines.length).toBeGreaterThan(0);
    for (const text of [...bodies, ...lines]) {
      expect(text).not.toContain(REAL_SECRET);
      expect(text).not.toContain(SIGNING_SECRET);
    }
  });
});
