import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import type { AssistantRow } from "../../src/db/assistants.js";
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

async function call(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = "https://example.com";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("admin install API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("returns a snippet with the public key and deployed origin, and never exposes an ingest key", async () => {
    const appA = appForOrg(ORG_A);
    const createRes = await call(appA, "POST", "/api/admin/assistants", {
      name: "Docs Bot",
      allowedOrigins: ["https://docs.example.com"],
    });
    expect(createRes.status).toBe(201);
    const { assistant, ingestKey } = (await createRes.json()) as {
      assistant: AssistantRow;
      ingestKey: string;
    };
    const keyHash = await sha256Hex(ingestKey);

    const installRes = await call(appA, "GET", `/api/admin/assistants/${assistant.id}/install`);
    expect(installRes.status).toBe(200);
    const raw = await installRes.text();
    expect(raw).not.toContain(ingestKey);
    expect(raw).not.toContain(keyHash);
    expect(raw).not.toContain("ik_");

    const body = JSON.parse(raw) as {
      assistantId: string;
      publicKey: string;
      allowedOrigins: string[];
      snippet: string;
      hostPolicy: { directive: string; value: string }[];
    };
    expect(body.assistantId).toBe(assistant.id);
    expect(body.publicKey).toBe(assistant.publicKey);
    expect(body.allowedOrigins).toEqual(["https://docs.example.com"]);
    const boot = await (await call(appA, "GET", "/boot.js")).text();
    expect(boot.length).toBeLessThan(1024);
    expect(body.snippet).toContain(
      `<script data-key="${assistant.publicKey}">${boot}</script>\n<script src="https://example.com/widget.js" defer>`,
    );
    expect(body.snippet).toContain(`<solv-chat assistant="${assistant.publicKey}">`);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(boot));
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(body.hostPolicy).toContainEqual({
      directive: "script-src",
      value: `https://example.com 'sha256-${hash}'`,
    });
  });

  it("reports the page of the newest conversation as where the widget was last seen, per org", async () => {
    const appA = appForOrg(ORG_A);
    const createRes = await call(appA, "POST", "/api/admin/assistants", {
      name: "Seen Bot",
      allowedOrigins: ["https://docs.example.com"],
    });
    const { assistant } = (await createRes.json()) as { assistant: AssistantRow };

    const before = (await (
      await call(appA, "GET", `/api/admin/assistants/${assistant.id}/install`)
    ).json()) as { lastSeen: unknown };
    expect(before.lastSeen).toBeNull();

    const insert = (id: string, orgId: string, at: number, pageUrl: string) =>
      env.DB.prepare(
        `INSERT INTO conversations (id, org_id, assistant_id, visitor_id, started_at, page_url)
         VALUES (?1, ?2, ?3, 'v_1', ?4, ?5)`,
      ).bind(id, orgId, assistant.id, at, pageUrl);
    await env.DB.batch([
      insert("cnv_old", ORG_A, 1000, "https://docs.example.com/old"),
      insert("cnv_new", ORG_A, 3000, "https://docs.example.com/pricing"),
      insert("cnv_blank", ORG_A, 4000, ""),
    ]);

    const after = (await (
      await call(appA, "GET", `/api/admin/assistants/${assistant.id}/install`)
    ).json()) as { lastSeen: { pageUrl: string; at: number } | null };
    expect(after.lastSeen).toEqual({ pageUrl: "https://docs.example.com/pricing", at: 3000 });
    await env.DB.prepare("DELETE FROM conversations").run();
  });

  it("returns 404 for another org's assistant", async () => {
    const appB = appForOrg(ORG_B);
    const createRes = await call(appB, "POST", "/api/admin/assistants", {
      name: "Org B Bot",
      allowedOrigins: [],
    });
    const { assistant } = (await createRes.json()) as { assistant: AssistantRow };

    const appA = appForOrg(ORG_A);
    const res = await call(appA, "GET", `/api/admin/assistants/${assistant.id}/install`);
    expect(res.status).toBe(404);
  });
});
