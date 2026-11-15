import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { ingestScopeFor } from "../../src/ingest/auth.js";
import { createTestApp, directoryResolveOrg, TEST_ORG_ID } from "../helpers/app.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function createAssistant(orgId: string, name: string): Promise<{ id: string; key: string }> {
  const id = newId("ast");
  const key = `ik_${newId("src").slice(4)}`;
  const hash = await sha256Hex(key);
  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(orgId, orgId)
    .run();
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)`,
  )
    .bind(id, orgId, name, `pk_${newId("ast").slice(4)}`, hash, Date.now())
    .run();
  return { id, key };
}

describe("ingest auth", () => {
  it("rejects missing, malformed, wrong, or other assistant keys with 401 and writes nothing", async () => {
    const app = createTestApp();
    const a = await createAssistant(TEST_ORG_ID, "Assistant A");
    const otherOrg = newId("org");
    const b = await createAssistant(otherOrg, "Assistant B");

    const body = JSON.stringify({
      documents: [
        {
          externalId: "doc-1",
          url: "https://example.com/1",
          title: "Doc 1",
          markdown: "Hello",
        },
      ],
    });

    const badHeaders: Array<Record<string, string>> = [
      {},
      { authorization: "" },
      { authorization: "Basic abc123" },
      { authorization: "Bearer" },
      { authorization: "Bearer   " },
      { authorization: "Bearer wrong-key" },
      { authorization: `Bearer ${b.key}` },
    ];

    for (const headers of badHeaders) {
      const res = await app.fetch(
        new Request(`https://example.com/v1/ingest/${a.id}/documents`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain(a.key);
      expect(text).not.toContain(b.key);
    }

    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM documents WHERE org_id = ?1")
      .bind(TEST_ORG_ID)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("stops accepting the old key after rotation", async () => {
    const app = createTestApp();
    const a = await createAssistant(TEST_ORG_ID, "Rotatable");
    const newKey = `ik_${newId("src").slice(4)}`;
    await env.DB.prepare("UPDATE assistants SET ingest_key_hash = ?1 WHERE id = ?2")
      .bind(await sha256Hex(newKey), a.id)
      .run();

    const oldRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${a.id}/documents`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${a.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ documents: [] }),
      }),
      env,
      ctx,
    );
    expect(oldRes.status).toBe(401);

    const newRes = await app.fetch(
      new Request(`https://example.com/v1/ingest/${a.id}/documents`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${newKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ documents: [] }),
      }),
      env,
      ctx,
    );
    expect(newRes.status).toBe(200);
  });

  it("compares against the SHA-256 hash, never plaintext, and takes orgId from the auth seam", async () => {
    const orgId = newId("org");
    const a = await createAssistant(orgId, "Hashed Only");
    const storedHash = await sha256Hex(a.key);

    // Presenting the stored hash itself as a bearer token must fail.
    const hashAsToken = await ingestScopeFor(
      env.DB,
      { resolveOrg: directoryResolveOrg },
      new Request(`https://example.com/v1/ingest/${a.id}/documents`, {
        headers: { authorization: `Bearer ${storedHash}` },
      }),
      a.id,
    );
    expect(hashAsToken).toBeNull();

    // Presenting the real key returns the seam's org.
    const scope = await ingestScopeFor(
      env.DB,
      { resolveOrg: directoryResolveOrg },
      new Request(`https://example.com/v1/ingest/${a.id}/documents`, {
        headers: { authorization: `Bearer ${a.key}` },
      }),
      a.id,
    );
    expect(scope).toEqual({ orgId, assistantId: a.id });
  });

  it("looks the key up only inside the org the auth seam returns", async () => {
    const otherOrg = newId("org");
    const a = await createAssistant(otherOrg, "Other org");
    const request = () =>
      new Request(`https://example.com/v1/ingest/${a.id}/documents`, {
        headers: { authorization: `Bearer ${a.key}` },
      });

    // A valid key, but the seam says this request belongs to another org:
    // the row is not found there, so the key is refused.
    const claims: unknown[] = [];
    const elsewhere = await ingestScopeFor(
      env.DB,
      {
        async resolveOrg(claim) {
          claims.push(claim);
          return TEST_ORG_ID;
        },
      },
      request(),
      a.id,
    );
    expect(elsewhere).toBeNull();
    expect(claims).toEqual([{ kind: "ingest_key", assistantId: a.id }]);

    // The seam refusing the request is a 401 before any lookup.
    expect(await ingestScopeFor(env.DB, { resolveOrg: async () => null }, request(), a.id)).toBe(
      null,
    );
    expect(
      await ingestScopeFor(env.DB, { resolveOrg: async () => otherOrg }, request(), a.id),
    ).toEqual({ orgId: otherOrg, assistantId: a.id });
  });
});
