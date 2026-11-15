import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { forIngestScope, forPrincipal } from "../../src/db/tenant.js";
import { runIngestBatch } from "../../src/ingest/consumer.js";
import { pushDocuments } from "../../src/ingest/documents.js";
import { fakeEmbedder } from "../fakes/fakeEmbedder.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { acceptQueuedOrg, createTestApp, TEST_ORG_ID } from "../helpers/app.js";

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
    { ...env, INGEST_QUEUE: { async send() {}, async sendBatch() {} } as unknown as Queue },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function createAssistant(app: ReturnType<typeof createTestApp>, name = "Docs Bot") {
  const res = await call(app, "POST", "/api/admin/assistants", {
    name,
    allowedOrigins: [],
  });
  const data = (await res.json()) as { assistant: { id: string } };
  return data.assistant.id;
}

describe("admin sources API", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM chunks"),
      env.DB.prepare("DELETE FROM documents"),
      env.DB.prepare("DELETE FROM sources"),
      env.DB.prepare("DELETE FROM assistant_versions"),
      env.DB.prepare("DELETE FROM assistants"),
      env.DB.prepare("DELETE FROM orgs WHERE id != ?1").bind(ORG_A),
      env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2)").bind(ORG_B, "Org B"),
    ]);
  });

  it("creates an entry source, edits it, deletes it, and lists sources with document counts", async () => {
    const app = appForOrg(ORG_A);
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/sources`, {
      kind: "entry",
      label: "FAQ answers",
      settings: {},
    });
    expect(createRes.status).toBe(201);
    const { source } = (await createRes.json()) as {
      source: { id: string; kind: string; label: string };
    };
    expect(source.kind).toBe("entry");
    expect(source.label).toBe("FAQ answers");

    // Add a document via entries endpoint so counts and newest updated_at are populated.
    const entryRes = await call(app, "POST", `/api/admin/sources/${source.id}/entries`, {
      question: "How do I reset?",
      answer: "Click Reset in settings.",
    });
    expect(entryRes.status).toBe(201);
    const { documentId } = (await entryRes.json()) as { documentId: string };

    // Edit source label.
    const patchRes = await call(app, "PATCH", `/api/admin/sources/${source.id}`, {
      label: "Custom answers",
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { source: { label: string } };
    expect(patched.source.label).toBe("Custom answers");

    // List sources with counts and newest updated_at.
    const listRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/sources`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      sources: Array<{
        id: string;
        label: string;
        documentCount: number;
        lastUpdatedAt: number | null;
      }>;
    };
    expect(listed.sources).toHaveLength(1);
    expect(listed.sources[0]).toMatchObject({
      id: source.id,
      label: "Custom answers",
      documentCount: 1,
    });
    expect(typeof listed.sources[0]?.lastUpdatedAt).toBe("number");

    // Paged documents list has metadata only (no bodies).
    const docsRes = await call(
      app,
      "GET",
      `/api/admin/sources/${source.id}/documents?limit=10&offset=0`,
    );
    expect(docsRes.status).toBe(200);
    const docsBody = (await docsRes.json()) as {
      documents: Array<{
        id: string;
        title: string;
        url: string;
        updatedAt: number;
        markdown?: string;
      }>;
      total: number;
    };
    expect(docsBody.total).toBe(1);
    expect(docsBody.documents[0]).toMatchObject({
      id: documentId,
      title: "How do I reset?",
    });
    expect(docsBody.documents[0]?.markdown).toBeUndefined();

    // Single document fetch reads Markdown from R2.
    const singleDocRes = await call(
      app,
      "GET",
      `/api/admin/sources/${source.id}/documents/${documentId}`,
    );
    expect(singleDocRes.status).toBe(200);
    const singleDoc = (await singleDocRes.json()) as { markdown: string };
    expect(singleDoc.markdown).toContain("Click Reset in settings.");

    // Delete entry source.
    const delRes = await call(app, "DELETE", `/api/admin/sources/${source.id}`);
    expect(delRes.status).toBe(200);
    const afterDel = await call(app, "GET", `/api/admin/assistants/${assistantId}/sources`);
    const afterList = (await afterDel.json()) as { sources: unknown[] };
    expect(afterList.sources).toHaveLength(0);
  });

  it("refuses creating, editing, or deleting a push source by hand", async () => {
    const app = appForOrg(ORG_A);
    const assistantId = await createAssistant(app);

    // Creating a push source via admin API is rejected.
    const createPush = await call(app, "POST", `/api/admin/assistants/${assistantId}/sources`, {
      kind: "push",
      label: "Manual push",
      settings: {},
    });
    expect(createPush.status).toBe(400);

    // Create a real push source via ingest.
    const scope = { orgId: ORG_A, assistantId };
    await pushDocuments(
      {
        tenant: forIngestScope(env.DB, scope),
        docs: env.DOCS,
        queue: { async send() {}, async sendBatch() {} } as unknown as Queue,
      },
      scope,
      {
        documents: [
          {
            externalId: "readme",
            url: "https://docs.example.com/readme",
            title: "README",
            markdown: "# README\n\nPushed content.",
          },
        ],
      },
    );

    const listRes = await call(app, "GET", `/api/admin/assistants/${assistantId}/sources`);
    const { sources } = (await listRes.json()) as { sources: Array<{ id: string; kind: string }> };
    const pushSource = sources.find((s) => s.kind === "push");
    expect(pushSource).toBeDefined();
    if (!pushSource) throw new Error("expected push source");

    const patchRes = await call(app, "PATCH", `/api/admin/sources/${pushSource.id}`, {
      label: "Renamed",
    });
    expect(patchRes.status).toBe(400);

    const deleteRes = await call(app, "DELETE", `/api/admin/sources/${pushSource.id}`);
    expect(deleteRes.status).toBe(400);
  });

  it("returns 404 on every verb for another org's assistant or source id", async () => {
    const appA = appForOrg(ORG_A);
    const appB = appForOrg(ORG_B);

    const assistantA = await createAssistant(appA, "Org A Bot");
    const createRes = await call(appA, "POST", `/api/admin/assistants/${assistantA}/sources`, {
      kind: "entry",
      label: "Org A Entries",
      settings: {},
    });
    const { source: sourceA } = (await createRes.json()) as { source: { id: string } };
    const entryRes = await call(appA, "POST", `/api/admin/sources/${sourceA.id}/entries`, {
      question: "Q",
      answer: "A",
    });
    const { documentId: docA } = (await entryRes.json()) as { documentId: string };

    expect((await call(appB, "GET", `/api/admin/assistants/${assistantA}/sources`)).status).toBe(
      404,
    );
    expect(
      (
        await call(appB, "POST", `/api/admin/assistants/${assistantA}/sources`, {
          kind: "entry",
          label: "Cross",
          settings: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(appB, "PATCH", `/api/admin/sources/${sourceA.id}`, { label: "X" })).status,
    ).toBe(404);
    expect((await call(appB, "DELETE", `/api/admin/sources/${sourceA.id}`)).status).toBe(404);
    expect((await call(appB, "GET", `/api/admin/sources/${sourceA.id}/documents`)).status).toBe(
      404,
    );
    expect(
      (await call(appB, "GET", `/api/admin/sources/${sourceA.id}/documents/${docA}`)).status,
    ).toBe(404);
    expect(
      (
        await call(appB, "POST", `/api/admin/sources/${sourceA.id}/entries`, {
          question: "Q2",
          answer: "A2",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(appB, "PUT", `/api/admin/sources/${sourceA.id}/entries/${docA}`, {
          question: "Q",
          answer: "A2",
        })
      ).status,
    ).toBe(404);

    // Ensure Org A's source and document were untouched.
    const checkA = await call(appA, "GET", `/api/admin/sources/${sourceA.id}/documents/${docA}`);
    expect(checkA.status).toBe(200);
    const docBody = (await checkA.json()) as { markdown: string };
    expect(docBody.markdown).toContain("A");
    void newId;
  });

  it("cleans up R2 bodies and retriever vectors when deleting an indexed source", async () => {
    const app = appForOrg(ORG_A);
    const assistantId = await createAssistant(app);

    const createRes = await call(app, "POST", `/api/admin/assistants/${assistantId}/sources`, {
      kind: "entry",
      label: "Indexed entries",
      settings: {},
    });
    expect(createRes.status).toBe(201);
    const { source } = (await createRes.json()) as { source: { id: string } };

    const entryRes = await call(app, "POST", `/api/admin/sources/${source.id}/entries`, {
      question: "How do I delete a source?",
      answer: "Click Delete and clean up bodies and vectors.",
    });
    expect(entryRes.status).toBe(201);
    const { documentId } = (await entryRes.json()) as { documentId: string };

    const tenant = forPrincipal(env.DB, { orgId: ORG_A, userId: "owner", role: "owner" });
    const docBefore = await tenant.documents.get(documentId);
    expect(docBefore).not.toBeNull();
    expect(docBefore?.bodyKey).not.toBeNull();
    const bodyKey = docBefore?.bodyKey ?? "";
    expect(await env.DOCS.head(bodyKey)).not.toBeNull();

    // Index the document so D1 chunks and retriever vectors are populated.
    const retriever = memoryRetriever();
    await runIngestBatch(
      {
        messages: [
          {
            id: newId("msg"),
            timestamp: new Date(),
            attempts: 1,
            body: {
              orgId: ORG_A,
              documentId,
              contentHash: docBefore?.contentHash ?? "",
            },
            ack() {},
            retry() {},
          },
        ],
      },
      {
        db: env.DB,
        resolveOrg: acceptQueuedOrg,
        docs: env.DOCS,
        embedder: fakeEmbedder(),
        retriever,
      },
    );

    const chunksBefore = await tenant.documents.listChunks(documentId);
    expect(chunksBefore.length).toBeGreaterThan(0);
    expect(retriever.all()).toHaveLength(chunksBefore.length);

    // Delete the source through deleteSource / admin router and verify R2 + vectors + D1 cleanup.
    const { deleteSource } = await import("../../src/admin/sources.js");
    await deleteSource({ tenant, docs: env.DOCS, retriever }, source.id);

    expect(await tenant.sources.get(source.id)).toBeNull();
    expect(await tenant.documents.get(documentId)).toBeNull();
    expect(await tenant.documents.listChunks(documentId)).toHaveLength(0);
    expect(await env.DOCS.head(bodyKey)).toBeNull();
    expect(retriever.all()).toHaveLength(0);
  });
});
