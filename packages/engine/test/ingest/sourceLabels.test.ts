import { env } from "cloudflare:test";
import { newId } from "@solvchat/core";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/admin/ingestKeys.js";
import { forIngestScope } from "../../src/db/tenant.js";
import {
  deleteDocuments,
  type IngestQueueMessage,
  pushDocuments,
} from "../../src/ingest/documents.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { createTestApp, TEST_ORG_ID } from "../helpers/app.js";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function createAssistantWithKey() {
  const id = newId("ast");
  const key = `ik_${newId("src").slice(4)}`;
  await env.DB.prepare("INSERT INTO orgs (id, name) VALUES (?1, ?2) ON CONFLICT(id) DO NOTHING")
    .bind(TEST_ORG_ID, "Test Org")
    .run();
  await env.DB.prepare(
    `INSERT INTO assistants (id, org_id, name, public_key, allowed_origins, ingest_key_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6)`,
  )
    .bind(
      id,
      TEST_ORG_ID,
      "Docs Bot",
      `pk_${newId("ast").slice(4)}`,
      await sha256Hex(key),
      Date.now(),
    )
    .run();
  return { id, key };
}

function queue() {
  const sent: IngestQueueMessage[] = [];
  return {
    sent,
    async send(message: IngestQueueMessage) {
      sent.push(message);
    },
  };
}

const doc = (externalId: string) => ({
  externalId,
  url: `https://example.com/${externalId}`,
  title: externalId,
  markdown: `# ${externalId}`,
});

describe("ingest source labels", () => {
  it("gives each source label its own push source, and prunes only within it", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    const deps = { tenant, docs: env.DOCS, queue: queue() };
    const deleteDeps = { tenant, docs: env.DOCS, retriever: memoryRetriever() };

    // An existing single-source user: no label, the default push source.
    await pushDocuments(deps, scope, { documents: [doc("legacy-a"), doc("legacy-b")] });
    // Two repositories pushing into the same assistant, first pushes racing.
    await Promise.all([
      pushDocuments(deps, scope, { source: "docs", documents: [doc("intro"), doc("setup")] }),
      pushDocuments(deps, scope, { source: "docs", documents: [doc("faq")] }),
      pushDocuments(deps, scope, { source: "sdk", documents: [doc("intro"), doc("api")] }),
    ]);

    const sources = await tenant.sources.list(assistantId);
    expect(sources.map((s) => [s.kind, s.label]).sort()).toEqual([
      ["push", "Push"],
      ["push", "docs"],
      ["push", "sdk"],
    ]);
    const byLabel = new Map(sources.map((s) => [s.label, s.id]));
    const docsId = byLabel.get("docs") ?? "";
    const sdkId = byLabel.get("sdk") ?? "";
    const defaultId = byLabel.get("Push") ?? "";
    const ids = async (sourceId: string) =>
      (await tenant.documents.listBySource(sourceId)).map((d) => d.externalId).sort();
    expect(await ids(docsId)).toEqual(["faq", "intro", "setup"]);
    // The same external id in two sources is two documents.
    expect(await ids(sdkId)).toEqual(["api", "intro"]);

    // "docs" prunes everything it did not push this time; nothing else moves.
    const pruned = await deleteDocuments(deleteDeps, scope, {
      source: "docs",
      prune: true,
      keep: ["intro"],
    });
    expect(pruned.deleted).toBe(2);
    expect(await ids(docsId)).toEqual(["intro"]);
    expect(await ids(sdkId)).toEqual(["api", "intro"]);
    expect(await ids(defaultId)).toEqual(["legacy-a", "legacy-b"]);

    // An unlabelled prune still reaches the default source only.
    const legacyPrune = await deleteDocuments(deleteDeps, scope, { prune: true, keep: [] });
    expect(legacyPrune.deleted).toBe(2);
    expect(await ids(docsId)).toEqual(["intro"]);
    expect(await ids(sdkId)).toEqual(["api", "intro"]);

    // Deleting by external id is scoped to the label too.
    const removed = await deleteDocuments(deleteDeps, scope, {
      source: "sdk",
      externalIds: ["intro"],
    });
    expect(removed.deleted).toBe(1);
    expect(await ids(docsId)).toEqual(["intro"]);
    expect(await ids(sdkId)).toEqual(["api"]);
  });

  it("deletes nothing and creates nothing when pruning a label that never pushed", async () => {
    const { id: assistantId } = await createAssistantWithKey();
    const scope = { orgId: TEST_ORG_ID, assistantId };
    const tenant = forIngestScope(env.DB, scope);
    await pushDocuments({ tenant, docs: env.DOCS, queue: queue() }, scope, {
      documents: [doc("kept")],
    });

    const res = await deleteDocuments(
      { tenant, docs: env.DOCS, retriever: memoryRetriever() },
      scope,
      { source: "never-pushed", prune: true, keep: [] },
    );
    expect(res).toEqual({ written: 0, unchanged: 0, deleted: 0 });
    expect((await tenant.sources.list(assistantId)).map((s) => s.label)).toEqual(["Push"]);
  });

  it("keeps labels per assistant", async () => {
    const first = await createAssistantWithKey();
    const second = await createAssistantWithKey();
    for (const { id } of [first, second]) {
      const scope = { orgId: TEST_ORG_ID, assistantId: id };
      await pushDocuments(
        { tenant: forIngestScope(env.DB, scope), docs: env.DOCS, queue: queue() },
        scope,
        { source: "docs", documents: [doc(`only-${id}`)] },
      );
    }
    const scope = { orgId: TEST_ORG_ID, assistantId: first.id };
    const tenant = forIngestScope(env.DB, scope);
    const source = await tenant.sources.getPushByLabel(first.id, "docs");
    expect(source?.assistantId).toBe(first.id);
    const docs = await tenant.documents.listBySource(source?.id ?? "");
    expect(docs.map((d) => d.externalId)).toEqual([`only-${first.id}`]);
  });

  it("refuses a bad source label over the ingest API without writing anything", async () => {
    const app = createTestApp();
    const { id: assistantId, key } = await createAssistantWithKey();
    // A fake queue: a message on the real one is consumed after this test's
    // isolated storage is gone, and breaks the storage of later tests.
    const ingestQueue = queue();
    const call = (method: "PUT" | "DELETE", body: unknown) =>
      app.fetch(
        new Request(`https://example.com/v1/ingest/${assistantId}/documents`, {
          method,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { ...env, INGEST_QUEUE: ingestQueue as unknown as Queue },
        ctx,
      );

    const cases: Array<[unknown, string]> = [
      [{ source: "", documents: [doc("a")] }, "source: must be 1 to 80 characters"],
      [{ source: "x".repeat(81), documents: [doc("a")] }, "source: must be 1 to 80 characters"],
      [{ source: 7, documents: [doc("a")] }, "source: must be 1 to 80 characters"],
      [
        { source: "push", documents: [doc("a")] },
        'source: "push" is the default source\'s name; leave source out to use it',
      ],
      [
        { source: "docs", sourceId: "src_x", documents: [doc("a")] },
        "source: give sourceId or source, not both",
      ],
    ];
    for (const [body, error] of cases) {
      const res = await call("PUT", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ errors: [error] });
    }
    const prune = await call("DELETE", { source: "docs", sourceId: "src_x", prune: true });
    expect(prune.status).toBe(400);

    const ok = await call("PUT", { source: " docs ", documents: [doc("a")] });
    expect(ok.status).toBe(200);
    expect(ingestQueue.sent).toHaveLength(1);
    const tenant = forIngestScope(env.DB, { orgId: TEST_ORG_ID, assistantId });
    // Only the valid push created a source, under the trimmed label.
    expect((await tenant.sources.list(assistantId)).map((s) => s.label)).toEqual(["docs"]);
  });
});
