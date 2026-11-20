import { env } from "cloudflare:test";
import { type ChatEvent, defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { saveEntry } from "../../src/admin/entries.js";
import { reindexAssistant } from "../../src/admin/reindex.js";
import { deleteSource } from "../../src/admin/sources.js";
import { answerMessage, CANDIDATE_POOL, REFILL_TOP_K } from "../../src/chat/answer.js";
import type { TracePart } from "../../src/chat/trace.js";
import { deleteDocuments, pushDocuments } from "../../src/ingest/documents.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { Embedder, Retriever, VectorRecord } from "../../src/providers/retrieval.js";
import type { LlmProvider, LlmRequest } from "../../src/providers/types.js";
import { laggingRetriever } from "../fakes/laggingRetriever.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";
import { TEST_ORG_ID } from "../helpers/app.js";
import { capturingQueue, runConsumer, seedSite } from "../helpers/pipeline.js";

/**
 * Issue #131: the vector index applies changes some time after they are
 * made, so for a while after an import, re-index or deletion a search
 * returns vectors whose chunks are gone and not yet the new ones.
 */

const FALLBACK = "Sorry, I could not find that.";

/** Every question embeds as the first axis; vectors are placed by hand. */
const axisEmbedder: Embedder = {
  dimensions: 3,
  async embed(texts, onBilled) {
    await onBilled(texts.length);
    return { vectors: texts.map(() => [1, 0, 0]) };
  },
};

/** A vector at cosine `score` from the question's. */
function at(score: number): number[] {
  return [score, Math.sqrt(1 - score * score), 0];
}

interface Asked {
  prompt: string;
  answer: string;
  trace: TracePart | undefined;
}

async function ask(
  site: Awaited<ReturnType<typeof seedSite>>,
  embedder: Embedder,
  retriever: Retriever,
  question: string,
): Promise<Asked> {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    name: "anthropic",
    model: ANTHROPIC_MODELS.fast.id,
    async *stream(request) {
      requests.push(request);
      yield { kind: "text", text: "Answered." };
      yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
    },
  };
  const behaviour = { ...defaultVersionConfig().behaviour, fallbackText: FALLBACK };
  const events: ChatEvent[] = [];
  for await (const event of answerMessage(
    {
      tenant: site.tenant,
      embedder,
      retriever,
      provider,
      model: ANTHROPIC_MODELS.fast,
      usage: { record: async () => {} },
      trace: { version: { id: "ver_1", state: "published" }, keySource: "environment" },
    },
    {
      orgId: TEST_ORG_ID,
      assistantId: site.assistantId,
      visitorId: "vis_1",
      message: question,
      behaviour,
    },
  )) {
    events.push(event);
  }
  const done = events.find((e) => e.type === "done");
  if (done?.type !== "done") throw new Error("no done event");
  const answer = events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
  const trace = await site.tenant.traces.get(done.messageId);
  return { prompt: JSON.stringify(requests), answer, trace: trace?.parts[0] };
}

/** Seeds `texts` as live chunks of one document of the site's sitemap source, at the given scores. */
async function seedLive(
  site: Awaited<ReturnType<typeof seedSite>>,
  retriever: Retriever,
  documentId: string,
  chunks: Array<{ id: string; text: string; score: number }>,
  scope: { orgId: string; assistantId: string } = {
    orgId: TEST_ORG_ID,
    assistantId: site.assistantId,
  },
  tenant = site.tenant,
  sourceId = site.sitemapSourceId,
) {
  await tenant.documents.upsert({
    id: documentId,
    sourceId,
    externalId: documentId,
    url: `https://docs.example.com/${documentId}`,
    title: `Page ${documentId}`,
    contentHash: `hash_${documentId}`,
    updatedAt: 1000,
  });
  await tenant.documents.replaceChunks(
    documentId,
    chunks.map((c, ordinal) => ({ id: c.id, ordinal, text: c.text, headingPath: "" })),
  );
  await retriever.upsert(chunks.map((c) => ({ chunkId: c.id, vector: at(c.score), ...scope })));
}

function staleVectors(count: number, score: number, assistantId: string): VectorRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `chk_gone_${i}`,
    vector: at(score),
    orgId: TEST_ORG_ID,
    assistantId,
  }));
}

describe("issue #131: stale vectors do not use up the candidate pool", () => {
  let site: Awaited<ReturnType<typeof seedSite>>;

  beforeEach(async () => {
    site = await seedSite();
  });

  it("asks once more and answers from the live chunks the stale ones pushed out", async () => {
    const retriever = laggingRetriever();
    await seedLive(site, retriever, "doc_sqlite", [
      { id: "chk_a", text: "Avoid SQLite for many concurrent writers.", score: 0.6 },
      { id: "chk_b", text: "Avoid SQLite over a network file system.", score: 0.59 },
      { id: "chk_c", text: "Avoid SQLite for very large datasets.", score: 0.58 },
    ]);
    // Vectors of a re-imported page whose chunks were replaced: they score higher.
    await retriever.upsert(staleVectors(25, 0.63, site.assistantId));
    await retriever.catchUp();

    const asked = await ask(site, axisEmbedder, retriever, "When should I not use SQLite?");

    expect(asked.answer).toBe("Answered.");
    for (const text of ["concurrent writers", "network file system", "very large datasets"]) {
      expect(asked.prompt).toContain(text);
    }
    // One further query, at most, with the first one's filters.
    expect(retriever.queries).toEqual([
      { orgId: TEST_ORG_ID, assistantId: site.assistantId, topK: CANDIDATE_POOL },
      { orgId: TEST_ORG_ID, assistantId: site.assistantId, topK: REFILL_TOP_K },
    ]);
    expect(asked.trace?.retrieval.stale).toBe(25);
    expect(asked.trace?.retrieval.searchedAgain).toBe(true);
    const used = asked.trace?.retrieval.candidates.filter((c) => c.used).map((c) => c.chunkId);
    expect(used?.sort()).toEqual(["chk_a", "chk_b", "chk_c"]);
    // The stale rows stay, each marked.
    expect(asked.trace?.retrieval.candidates.filter((c) => c.dropped === "not_found")).toHaveLength(
      25,
    );
  });

  it("never asks more than twice, even when the second answer is all stale too", async () => {
    const retriever = laggingRetriever();
    await seedLive(site, retriever, "doc_low", [
      { id: "chk_low", text: "A live chunk below every stale one.", score: 0.5 },
    ]);
    await retriever.upsert(staleVectors(150, 0.7, site.assistantId));
    await retriever.catchUp();

    const asked = await ask(site, axisEmbedder, retriever, "Anything?");

    expect(retriever.queries.map((q) => q.topK)).toEqual([CANDIDATE_POOL, REFILL_TOP_K]);
    expect(asked.answer).toBe(FALLBACK);
    expect(asked.trace?.retrieval.stale).toBe(REFILL_TOP_K);
    expect(asked.trace?.retrieval.searchedAgain).toBe(true);
  });

  it("asks once when nothing is stale", async () => {
    const retriever = laggingRetriever();
    await seedLive(
      site,
      retriever,
      "doc_many",
      Array.from({ length: 25 }, (_, i) => ({
        id: `chk_live_${i}`,
        text: `Live chunk number ${i} with enough words.`,
        score: 0.6 - i * 0.001,
      })),
    );
    await retriever.catchUp();

    const asked = await ask(site, axisEmbedder, retriever, "Anything?");

    expect(retriever.queries.map((q) => q.topK)).toEqual([CANDIDATE_POOL]);
    expect(asked.trace?.retrieval.stale).toBe(0);
    expect(asked.trace?.retrieval.searchedAgain).toBe(false);
  });

  it("asks once when the index has nothing more: a short answer, or one that reached under the floor", async () => {
    const retriever = laggingRetriever();
    await seedLive(site, retriever, "doc_one", [
      { id: "chk_one", text: "The only live chunk.", score: 0.6 },
    ]);
    await retriever.upsert(staleVectors(5, 0.7, site.assistantId));
    await retriever.catchUp();

    // Six hits in all: the index returned everything it holds.
    const short = await ask(site, axisEmbedder, retriever, "Anything?");
    expect(retriever.queries).toHaveLength(1);
    expect(short.answer).toBe("Answered.");
    expect(short.trace?.retrieval.stale).toBe(5);
    expect(short.trace?.retrieval.searchedAgain).toBe(false);

    // Full, but its last hit is under the floor: nothing further is above it.
    await retriever.upsert(
      Array.from({ length: 20 }, (_, i) => ({
        chunkId: `chk_unrelated_${i}`,
        vector: at(0.01),
        orgId: TEST_ORG_ID,
        assistantId: site.assistantId,
      })),
    );
    await retriever.catchUp();
    retriever.queries.length = 0;
    await ask(site, axisEmbedder, retriever, "Anything?");
    expect(retriever.queries).toHaveLength(1);
  });

  it("keeps the further query to the org and assistant: another's content is never found", async () => {
    const retriever = laggingRetriever();
    await seedLive(site, retriever, "doc_ours", [
      { id: "chk_ours", text: "Our own answer text.", score: 0.55 },
    ]);
    await retriever.upsert(staleVectors(30, 0.7, site.assistantId));
    // Another assistant of the same org, scoring higher than anything of ours.
    const otherAssistant = "ast_other_131";
    await site.tenant.assistants.create({
      id: otherAssistant,
      name: "Other",
      publicKey: "pk_other_131",
      allowedOrigins: [],
      createdAt: 1000,
    });
    await site.tenant.sources.create({
      id: "src_other_131",
      assistantId: otherAssistant,
      kind: "push",
      label: "Other",
      settings: {},
      createdAt: 1000,
    });
    await seedLive(
      site,
      retriever,
      "doc_other_assistant",
      [{ id: "chk_other_assistant", text: "Another assistant's secret text.", score: 0.99 }],
      { orgId: TEST_ORG_ID, assistantId: otherAssistant },
      site.tenant,
      "src_other_131",
    );
    // Another org's vector carrying our assistant id (the filter is on both).
    await retriever.upsert([
      {
        chunkId: "chk_other_org",
        vector: at(0.99),
        orgId: "org_elsewhere",
        assistantId: site.assistantId,
      },
    ]);
    await retriever.catchUp();

    const asked = await ask(site, axisEmbedder, retriever, "Anything?");

    expect(retriever.queries).toHaveLength(2);
    for (const query of retriever.queries) {
      expect(query).toMatchObject({ orgId: TEST_ORG_ID, assistantId: site.assistantId });
    }
    expect(asked.prompt).toContain("Our own answer text.");
    expect(asked.prompt).not.toContain("Another assistant's secret text.");
    const ids = asked.trace?.retrieval.candidates.map((c) => c.chunkId) ?? [];
    expect(ids).not.toContain("chk_other_assistant");
    expect(ids).not.toContain("chk_other_org");
  });
});

const PAGE_V1 = `# Backups

Backups run every night at two and keep thirty days of snapshots for restore.`;
const PAGE_V2 = `# Backups

Backups run every hour and keep seven days of snapshots for restore.`;

/** Every vector the index shows that has no chunk: leftovers once it has caught up. */
describe("issue #131: a replaced chunk is left out whichever query returned it", () => {
  let site: Awaited<ReturnType<typeof seedSite>>;

  beforeEach(async () => {
    site = await seedSite();
  });

  /**
   * Mid-update: page A's current chunk is committed and its vector shown,
   * and the replaced chunk's vector is not yet deleted. 19 stale vectors
   * fill the first query with whichever of A's two chunks scores higher;
   * the other comes back only from the further query.
   */
  async function midUpdate(scores: { retired: number; current: number }) {
    const retriever = laggingRetriever();
    await seedLive(site, retriever, "doc_backups", [
      { id: "chk_new", text: "Backups are kept for seven days.", score: scores.current },
    ]);
    await env.DB.prepare(
      `INSERT INTO retired_chunks (id, org_id, document_id, text, heading_path, retired_at)
       VALUES ('chk_old', ?1, 'doc_backups', 'Backups are kept for thirty days.', '', ?2)`,
    )
      .bind(TEST_ORG_ID, Date.now())
      .run();
    await retriever.upsert([
      {
        chunkId: "chk_old",
        vector: at(scores.retired),
        orgId: TEST_ORG_ID,
        assistantId: site.assistantId,
      },
      ...staleVectors(CANDIDATE_POOL - 1, 0.65, site.assistantId),
    ]);
    await retriever.catchUp();
    return ask(site, axisEmbedder, retriever, "How long are backups kept?");
  }

  it("leaves out the replaced chunk from the first query when the current one comes only from the second", async () => {
    const asked = await midUpdate({ retired: 0.7, current: 0.6 });

    expect(asked.trace?.retrieval.searchedAgain).toBe(true);
    expect(asked.prompt).toContain("seven days");
    expect(asked.prompt).not.toContain("thirty days");
    const used = asked.trace?.retrieval.candidates.filter((c) => c.used).map((c) => c.chunkId);
    expect(used).toEqual(["chk_new"]);
  });

  it("leaves out the replaced chunk from the second query when the current one came in the first", async () => {
    const asked = await midUpdate({ retired: 0.6, current: 0.7 });

    expect(asked.trace?.retrieval.searchedAgain).toBe(true);
    expect(asked.prompt).toContain("seven days");
    expect(asked.prompt).not.toContain("thirty days");
    const used = asked.trace?.retrieval.candidates.filter((c) => c.used).map((c) => c.chunkId);
    expect(used).toEqual(["chk_new"]);
  });
});

async function vectorsWithoutChunk(retriever: { all(): VectorRecord[] }): Promise<string[]> {
  const ids = retriever.all().map((v) => v.chunkId);
  if (ids.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT id FROM chunks WHERE id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  const live = new Set(rows.results.map((r) => r.id));
  return ids.filter((id) => !live.has(id));
}

describe("issue #131: a page stays answerable while the index catches up", () => {
  let site: Awaited<ReturnType<typeof seedSite>>;
  const embedder = tokenEmbedder();
  let retriever: ReturnType<typeof laggingRetriever>;
  const scope = () => ({ orgId: TEST_ORG_ID, assistantId: site.assistantId });

  async function push(markdown: string) {
    const queue = capturingQueue();
    await pushDocuments({ tenant: site.tenant, docs: env.DOCS, queue }, scope(), {
      sourceId: site.sitemapSourceId,
      documents: [
        {
          externalId: "backups",
          url: "https://docs.example.com/backups",
          title: "Backups",
          markdown,
        },
      ],
    });
    expect(await runConsumer(queue.messages, { embedder, retriever })).toMatchObject({
      retried: 0,
    });
  }

  beforeEach(async () => {
    site = await seedSite();
    retriever = laggingRetriever();
    await push(PAGE_V1);
    await retriever.catchUp();
  });

  it("answers from the old text after an update until the index shows the new, then from the new", async () => {
    await push(PAGE_V2);
    expect(retriever.pending()).toBeGreaterThan(0);

    // The index still returns the old vectors, whose chunks the commit replaced.
    const during = await ask(site, embedder, retriever, "How long are backups kept?");
    expect(during.answer).toBe("Answered.");
    expect(during.prompt).toContain("thirty days");
    expect(during.trace?.retrieval.stale).toBe(0);

    await retriever.catchUp();
    const after = await ask(site, embedder, retriever, "How long are backups kept?");
    expect(after.prompt).toContain("seven days");
    expect(after.prompt).not.toContain("thirty days");
    expect(await vectorsWithoutChunk(retriever)).toEqual([]);
  });

  it("keeps a page answerable through a Rebuild, and leaves no vector without a chunk", async () => {
    // Indexed by an old ingest version: a Rebuild embeds it again.
    await env.DB.prepare("UPDATE documents SET ingest_version = 1").run();
    const queue = capturingQueue();
    await reindexAssistant(
      {
        tenant: site.tenant,
        orgId: TEST_ORG_ID,
        queue,
        limits: { check: async () => ({ ok: true }) },
      },
      site.assistantId,
    );
    expect(await runConsumer(queue.messages, { embedder, retriever })).toMatchObject({
      retried: 0,
    });
    expect(retriever.pending()).toBeGreaterThan(0);

    const during = await ask(site, embedder, retriever, "How long are backups kept?");
    expect(during.answer).toBe("Answered.");
    expect(during.prompt).toContain("thirty days");

    await retriever.catchUp();
    const after = await ask(site, embedder, retriever, "How long are backups kept?");
    expect(after.prompt).toContain("thirty days");
    expect(await vectorsWithoutChunk(retriever)).toEqual([]);
  });

  it("does not answer from a deleted page while its vectors linger, and none are left once applied", async () => {
    await deleteDocuments({ tenant: site.tenant, docs: env.DOCS, retriever }, scope(), {
      sourceId: site.sitemapSourceId,
      externalIds: ["backups"],
    });
    expect(retriever.pending()).toBeGreaterThan(0);

    const during = await ask(site, embedder, retriever, "How long are backups kept?");
    expect(during.answer).toBe(FALLBACK);
    expect(during.prompt).not.toContain("thirty days");
    expect(during.trace?.retrieval.stale).toBeGreaterThan(0);

    await retriever.catchUp();
    expect(retriever.all()).toEqual([]);
    expect(await vectorsWithoutChunk(retriever)).toEqual([]);
  });

  it("leaves no vector without a chunk after a source is deleted", async () => {
    const queue = capturingQueue();
    await saveEntry(
      { tenant: site.tenant, docs: env.DOCS, queue, publicBaseUrl: "https://solv.example" },
      { orgId: TEST_ORG_ID },
      { assistantId: site.assistantId, question: "Where are backups?", answer: "In the vault." },
    );
    expect(await runConsumer(queue.messages, { embedder, retriever })).toMatchObject({
      retried: 0,
    });
    await retriever.catchUp();
    const before = retriever.all().length;

    await deleteSource({ tenant: site.tenant, docs: env.DOCS, retriever }, site.sitemapSourceId);
    await retriever.catchUp();

    expect(retriever.all().length).toBeLessThan(before);
    expect(retriever.all().length).toBeGreaterThan(0);
    expect(await vectorsWithoutChunk(retriever)).toEqual([]);
  });

  it("stops reading a replaced chunk once its window has passed", async () => {
    await push(PAGE_V2);
    // An hour and more ago: the old vectors outlived every window the
    // documentation describes, and are treated as stale.
    await env.DB.prepare("UPDATE retired_chunks SET retired_at = retired_at - ?1")
      .bind(2 * 60 * 60 * 1000)
      .run();
    const asked = await ask(site, embedder, retriever, "How long are backups kept?");
    expect(asked.prompt).not.toContain("thirty days");
    expect(asked.trace?.retrieval.stale).toBeGreaterThan(0);
  });
});
