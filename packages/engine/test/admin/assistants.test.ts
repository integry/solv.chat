import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import type { AssistantRow } from "../../src/db/assistants.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ORG_A = TEST_ORG_ID;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb";

function appForOrg(orgId: string | null) {
  return createTestApp({
    auth: {
      async authenticate() {
        return orgId === null ? null : { orgId, userId: "owner", role: "owner" };
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

describe("admin assistants API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("creates an assistant with a pk_ key, initial draft, and one-time ingest key", async () => {
    const app = appForOrg(ORG_A);
    const res = await call(app, "POST", "/api/admin/assistants", {
      name: "Docs Bot",
      allowedOrigins: ["https://docs.example.com"],
    });
    expect(res.status).toBe(201);

    const created = (await res.json()) as { assistant: AssistantRow; ingestKey: string };
    expect(created.assistant.id).toMatch(/^ast_[0-9a-z]{20}$/);
    expect(created.assistant.publicKey).toMatch(/^pk_[0-9a-z]{20}$/);
    expect(created.assistant.name).toBe("Docs Bot");
    expect(created.assistant.allowedOrigins).toEqual(["https://docs.example.com"]);
    expect(created.assistant.hasIngestKey).toBe(true);
    expect(created.ingestKey).toMatch(/^ik_[0-9a-z]{40}$/);

    const expectedHash = await sha256Hex(created.ingestKey);
    const row = await env.DB.prepare("SELECT ingest_key_hash FROM assistants WHERE id = ?1")
      .bind(created.assistant.id)
      .first<{ ingest_key_hash: string }>();
    expect(row?.ingest_key_hash).toBe(expectedHash);

    // Subsequent GETs never return the ingest key or its hash.
    const getRes = await call(app, "GET", `/api/admin/assistants/${created.assistant.id}`);
    expect(getRes.status).toBe(200);
    const getText = await getRes.text();
    expect(getText).not.toContain(created.ingestKey);
    expect(getText).not.toContain(expectedHash);

    const listRes = await call(app, "GET", "/api/admin/assistants");
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    expect(listText).not.toContain(created.ingestKey);
    expect(listText).not.toContain(expectedHash);
  });

  it("rotates the ingest key, invalidates the old hash, and never exposes it on GET", async () => {
    const app = appForOrg(ORG_A);
    const createRes = await call(app, "POST", "/api/admin/assistants", {
      name: "Docs Bot",
      allowedOrigins: [],
    });
    const { assistant, ingestKey: oldKey } = (await createRes.json()) as {
      assistant: AssistantRow;
      ingestKey: string;
    };
    const oldHash = await sha256Hex(oldKey);

    const rotateRes = await call(app, "POST", `/api/admin/assistants/${assistant.id}/ingest-key`);
    expect(rotateRes.status).toBe(200);
    const { ingestKey: newKey } = (await rotateRes.json()) as { ingestKey: string };
    expect(newKey).toMatch(/^ik_[0-9a-z]{40}$/);
    expect(newKey).not.toBe(oldKey);

    const newHash = await sha256Hex(newKey);
    const row = await env.DB.prepare("SELECT ingest_key_hash FROM assistants WHERE id = ?1")
      .bind(assistant.id)
      .first<{ ingest_key_hash: string }>();
    expect(row?.ingest_key_hash).toBe(newHash);
    expect(row?.ingest_key_hash).not.toBe(oldHash);

    const getText = await (await call(app, "GET", `/api/admin/assistants/${assistant.id}`)).text();
    expect(getText).not.toContain(newKey);
    expect(getText).not.toContain(newHash);
    expect(getText).not.toContain(oldKey);
    expect(getText).not.toContain(oldHash);
  });

  it("lists only the principal's org assistants and updates name/allowedOrigins", async () => {
    const appA = appForOrg(ORG_A);
    const appB = appForOrg(ORG_B);

    const aRes = await call(appA, "POST", "/api/admin/assistants", {
      name: "Org A Bot",
      allowedOrigins: ["https://a.example"],
    });
    const { assistant: a } = (await aRes.json()) as { assistant: AssistantRow };
    await call(appB, "POST", "/api/admin/assistants", {
      name: "Org B Bot",
      allowedOrigins: ["https://b.example"],
    });

    const listA = (await (await call(appA, "GET", "/api/admin/assistants")).json()) as {
      assistants: AssistantRow[];
    };
    expect(listA.assistants.map((x) => x.id)).toEqual([a.id]);

    const patchRes = await call(appA, "PATCH", `/api/admin/assistants/${a.id}`, {
      name: "Org A Renamed",
      allowedOrigins: ["https://a2.example"],
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { assistant: AssistantRow };
    expect(patched.assistant.name).toBe("Org A Renamed");
    expect(patched.assistant.allowedOrigins).toEqual(["https://a2.example"]);
  });

  it("returns 400 with core field messages on validation failures", async () => {
    const app = appForOrg(ORG_A);
    const badCreate = await call(app, "POST", "/api/admin/assistants", {
      name: "",
      allowedOrigins: ["not-a-url"],
    });
    expect(badCreate.status).toBe(400);
    const body = (await badCreate.json()) as { error: string; fields: string[] };
    expect(body.fields.some((f) => f.includes("name"))).toBe(true);
    expect(body.fields.some((f) => f.includes("allowedOrigins[0]"))).toBe(true);
  });

  describe("unauthenticated requests return 401", () => {
    const unauth = appForOrg(null);

    it("rejects GET /api/admin/assistants", async () => {
      const res = await call(unauth, "GET", "/api/admin/assistants");
      expect(res.status).toBe(401);
    });

    it("rejects POST /api/admin/assistants", async () => {
      const res = await call(unauth, "POST", "/api/admin/assistants", {
        name: "Bot",
        allowedOrigins: [],
      });
      expect(res.status).toBe(401);
    });

    it("rejects GET /api/admin/assistants/:id/draft", async () => {
      const res = await call(unauth, "GET", "/api/admin/assistants/ast_123/draft");
      expect(res.status).toBe(401);
    });

    it("rejects POST /api/admin/assistants/:id/publish", async () => {
      const res = await call(unauth, "POST", "/api/admin/assistants/ast_123/publish");
      expect(res.status).toBe(401);
    });
  });

  describe("org isolation returns 404 and leaves org A unchanged", () => {
    let assistantA: AssistantRow;
    let archivedVersionAId: string;

    beforeEach(async () => {
      const appA = appForOrg(ORG_A);
      const created = (await (
        await call(appA, "POST", "/api/admin/assistants", {
          name: "Org A Bot",
          allowedOrigins: ["https://a.example"],
        })
      ).json()) as { assistant: AssistantRow };
      assistantA = created.assistant;

      // Publish twice so org A has an archived version to target with rollback.
      const pub1 = (await (
        await call(appA, "POST", `/api/admin/assistants/${assistantA.id}/publish`)
      ).json()) as { version: { id: string } };
      archivedVersionAId = pub1.version.id;
      await call(appA, "POST", `/api/admin/assistants/${assistantA.id}/publish`);
    });

    it("GET /api/admin/assistants/:id returns 404 for another org", async () => {
      const res = await call(appForOrg(ORG_B), "GET", `/api/admin/assistants/${assistantA.id}`);
      expect(res.status).toBe(404);
    });

    it("PATCH /api/admin/assistants/:id returns 404 and leaves row unchanged", async () => {
      const res = await call(appForOrg(ORG_B), "PATCH", `/api/admin/assistants/${assistantA.id}`, {
        name: "Hijacked",
        allowedOrigins: ["https://evil.example"],
      });
      expect(res.status).toBe(404);

      const after = (await (
        await call(appForOrg(ORG_A), "GET", `/api/admin/assistants/${assistantA.id}`)
      ).json()) as { assistant: AssistantRow };
      expect(after.assistant.name).toBe("Org A Bot");
      expect(after.assistant.allowedOrigins).toEqual(["https://a.example"]);
    });

    it("GET /api/admin/assistants/:id/draft returns 404 for another org", async () => {
      const res = await call(
        appForOrg(ORG_B),
        "GET",
        `/api/admin/assistants/${assistantA.id}/draft`,
      );
      expect(res.status).toBe(404);
    });

    it("PUT /api/admin/assistants/:id/draft returns 404 and leaves draft unchanged", async () => {
      const before = (await (
        await call(appForOrg(ORG_A), "GET", `/api/admin/assistants/${assistantA.id}/draft`)
      ).json()) as { draft: { config: { behaviour: { greeting: string } } } };

      const res = await call(
        appForOrg(ORG_B),
        "PUT",
        `/api/admin/assistants/${assistantA.id}/draft`,
        { behaviour: { greeting: "Hijacked greeting" } },
      );
      expect(res.status).toBe(404);

      const after = (await (
        await call(appForOrg(ORG_A), "GET", `/api/admin/assistants/${assistantA.id}/draft`)
      ).json()) as { draft: { config: { behaviour: { greeting: string } } } };
      expect(after.draft.config.behaviour.greeting).toBe(before.draft.config.behaviour.greeting);
    });

    it("POST /api/admin/assistants/:id/publish returns 404 and leaves versions unchanged", async () => {
      const before = await env.DB.prepare(
        "SELECT id, state FROM assistant_versions WHERE assistant_id = ?1 ORDER BY rowid ASC",
      )
        .bind(assistantA.id)
        .all();

      const res = await call(
        appForOrg(ORG_B),
        "POST",
        `/api/admin/assistants/${assistantA.id}/publish`,
      );
      expect(res.status).toBe(404);

      const after = await env.DB.prepare(
        "SELECT id, state FROM assistant_versions WHERE assistant_id = ?1 ORDER BY rowid ASC",
      )
        .bind(assistantA.id)
        .all();
      expect(after.results).toEqual(before.results);
    });

    it("POST /api/admin/assistants/:id/versions/:versionId/rollback returns 404 and leaves versions unchanged", async () => {
      const before = await env.DB.prepare(
        "SELECT id, state FROM assistant_versions WHERE assistant_id = ?1 ORDER BY rowid ASC",
      )
        .bind(assistantA.id)
        .all();

      const res = await call(
        appForOrg(ORG_B),
        "POST",
        `/api/admin/assistants/${assistantA.id}/versions/${archivedVersionAId}/rollback`,
      );
      expect(res.status).toBe(404);

      const after = await env.DB.prepare(
        "SELECT id, state FROM assistant_versions WHERE assistant_id = ?1 ORDER BY rowid ASC",
      )
        .bind(assistantA.id)
        .all();
      expect(after.results).toEqual(before.results);
    });

    it("GET /api/admin/assistants/:id/versions returns 404 for another org", async () => {
      const res = await call(
        appForOrg(ORG_B),
        "GET",
        `/api/admin/assistants/${assistantA.id}/versions`,
      );
      expect(res.status).toBe(404);
    });

    it("POST /api/admin/assistants/:id/ingest-key returns 404 and leaves hash unchanged", async () => {
      const before = await env.DB.prepare("SELECT ingest_key_hash FROM assistants WHERE id = ?1")
        .bind(assistantA.id)
        .first<{ ingest_key_hash: string }>();

      const res = await call(
        appForOrg(ORG_B),
        "POST",
        `/api/admin/assistants/${assistantA.id}/ingest-key`,
      );
      expect(res.status).toBe(404);

      const after = await env.DB.prepare("SELECT ingest_key_hash FROM assistants WHERE id = ?1")
        .bind(assistantA.id)
        .first<{ ingest_key_hash: string }>();
      expect(after?.ingest_key_hash).toBe(before?.ingest_key_hash);
    });
  });
});
