import { env } from "cloudflare:test";
import { type ChatEvent, defaultVersionConfig } from "@solvchat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { getAnswerTrace } from "../../src/admin/conversations.js";
import { saveEntry } from "../../src/admin/entries.js";
import { answerMessage, TOP_K } from "../../src/chat/answer.js";
import { pushDocuments } from "../../src/ingest/documents.js";
import { extractHtml } from "../../src/ingest/htmlToMarkdown.js";
import { ANTHROPIC_MODELS } from "../../src/models.js";
import type { LlmProvider, LlmRequest } from "../../src/providers/types.js";
import { memoryRetriever } from "../fakes/memoryRetriever.js";
import { tokenEmbedder } from "../fakes/tokenEmbedder.js";
import { TEST_ORG_ID } from "../helpers/app.js";
import { capturingQueue, runConsumer, seedSite } from "../helpers/pipeline.js";

/**
 * Issue #123: a documentation site imported from its sitemap, where every
 * page carries the same header, footer link columns and "Related guides"
 * list. Asked "How do I test a remote MCP server?", retrieval returned six
 * chunks of that chrome and the assistant said it did not have the steps.
 */

const CHROME_TOP = `<header><a href="/">mcptest</a><nav><ul>
  <li><a href="/test">Test a server</a></li><li><a href="/guides">Guides</a></li><li><a href="/pricing">Pricing</a></li>
</ul></nav></header>`;

const CHROME_FOOTER = `<footer>
  <h2>Guides</h2><ul><li><a href="/what-is-mcp">What is MCP?</a></li><li><a href="/remote-vs-local">Remote vs Local</a></li><li><a href="/glossary">MCP Glossary</a></li></ul>
  <h2>Testing &amp; Specs</h2><ul><li><a href="/testing">Testing Guide</a></li><li><a href="/oauth">OAuth 2.1</a></li><li><a href="/troubleshooting">Troubleshooting</a></li></ul>
  <h2>Compare</h2><ul><li><a href="/vs-glama">mcptest.io vs Glama</a></li><li><a href="/inspector">MCP Inspector Alternatives</a></li><li><a href="/roundup">Testing Tools Roundup</a></li></ul>
</footer>`;

const RELATED = `<h2>Related guides</h2><ul>
  <li><a href="/test-remote">Test a remote MCP server: connect over Streamable HTTP and call its tools</a></li>
  <li><a href="/public-servers">Public MCP test servers you can point a client at</a></li>
  <li><a href="/before-deploy">How to test an MCP server before you deploy it</a></li>
</ul>`;

function pageHtml(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${CHROME_TOP}
<main><article><h1>${title}</h1>${body}${RELATED}</article></main>${CHROME_FOOTER}</body></html>`;
}

const PAGES: Array<{ path: string; title: string; body: string }> = [
  {
    path: "online",
    title: "Test your MCP server online",
    body: `<p>mcptest runs in your browser and talks to your server directly. It shows the server's tools, prompts and resources, and the raw messages exchanged.</p>
<p>Nothing is installed and nothing is kept after you close the tab. Servers that need a token can be given one in the connection settings.</p>`,
  },
  {
    path: "before-deploy",
    title: "How to test an MCP server before you deploy it",
    body: `<p>Run the server on your machine first and point the tester at it, so a broken tool never reaches your users.</p>
<h2>Steps for a remote server</h2>
<ol>
  <li>Open the tester and paste the remote server's address, ending in /mcp.</li>
  <li>Choose Streamable HTTP as the transport and press Connect.</li>
  <li>Pick a tool from the list, fill in its arguments and press Run; the reply shows below.</li>
</ol>`,
  },
  {
    path: "public-servers",
    title: "Public MCP test servers",
    body: `<p>These servers are run for testing clients. They have a few harmless tools and reset every hour.</p>
<p>Each takes requests without a token, so they suit a first try of a new client before you point it at your own server.</p>`,
  },
];

const QUESTION = "How do I test a remote MCP server?";
const WRITTEN_ANSWER =
  "Paste the server's address into mcptest, choose Streamable HTTP and press Connect. Then run any tool to see its reply.";

describe("issue #123: page chrome does not crowd out the answer", () => {
  let site: Awaited<ReturnType<typeof seedSite>>;
  const embedder = tokenEmbedder();
  const retriever = memoryRetriever();

  beforeEach(async () => {
    site = await seedSite();
    const queue = capturingQueue();
    await pushDocuments(
      { tenant: site.tenant, docs: env.DOCS, queue },
      { orgId: TEST_ORG_ID, assistantId: site.assistantId },
      {
        sourceId: site.sitemapSourceId,
        documents: PAGES.map((p) => {
          const url = `https://docs.example.com/${p.path}`;
          const { title, markdown } = extractHtml(pageHtml(p.title, p.body), url);
          return { externalId: p.path, url, title, markdown };
        }),
      },
    );
    await saveEntry(
      { tenant: site.tenant, docs: env.DOCS, queue, publicBaseUrl: "https://solv.example" },
      { orgId: TEST_ORG_ID },
      { assistantId: site.assistantId, question: QUESTION, answer: WRITTEN_ANSWER },
    );
    expect(await runConsumer(queue.messages, { embedder, retriever })).toMatchObject({
      retried: 0,
    });
  });

  async function ask(question: string) {
    const requests: LlmRequest[] = [];
    const provider: LlmProvider = {
      name: "anthropic",
      model: ANTHROPIC_MODELS.fast.id,
      async *stream(request) {
        requests.push(request);
        yield { kind: "text", text: "Here is how." };
        yield { kind: "usage", tokensIn: 10, tokensOut: 5 };
      },
    };
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
        behaviour: defaultVersionConfig().behaviour,
      },
    )) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("no done event");
    const message = await site.tenant.messages.get(done.messageId);
    return { requests, message, prompt: JSON.stringify(requests) };
  }

  it("never indexes the header, footer or related-links lists", async () => {
    const rows = await env.DB.prepare("SELECT text FROM chunks").all<{ text: string }>();
    const all = rows.results.map((r) => r.text).join("\n");
    for (const chrome of [
      "MCP Glossary",
      "Testing Tools Roundup",
      "Pricing",
      "Related guides\n\n-",
    ]) {
      expect(all).not.toContain(chrome);
    }
    for (const row of rows.results) {
      // No chunk of a page is a few words long.
      if (!row.text.startsWith("Paste the server's address"))
        expect(row.text.length).toBeGreaterThan(150);
    }
  });

  it("answers the how-to question from the steps and the owner's written answer", async () => {
    const { requests, message, prompt } = await ask(QUESTION);
    expect(requests).toHaveLength(1);
    expect(message?.answered).toBe(true);
    expect(prompt).toContain("Choose Streamable HTTP as the transport and press Connect.");
    expect(prompt).toContain(WRITTEN_ANSWER);
    expect(prompt).not.toContain("MCP Glossary");

    // The trace names, per candidate, its heading path and why it was not used.
    const trace = await getAnswerTrace(
      site.tenant,
      message?.conversationId as string,
      message?.id as string,
    );
    const candidates = trace.trace?.parts[0]?.retrieval.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    const used = candidates.filter((c) => c.used);
    expect(used.length).toBeLessThanOrEqual(TOP_K);
    // The written answer is used once; its other vector is the same text.
    const entryRows = candidates.filter((c) => c.content?.sourceKind === "entry");
    expect(entryRows.filter((c) => c.used)).toHaveLength(1);
    expect(entryRows.filter((c) => c.dropped === "duplicate")).toHaveLength(1);
    const steps = candidates.find((c) =>
      c.content?.excerpt.includes("Streamable HTTP as the transport"),
    );
    expect(steps?.used).toBe(true);
    // The page's short intro was merged into its steps, so the path is the
    // heading both share, and the steps' own heading is in the text.
    expect(steps?.content?.headingPath).toBe("How to test an MCP server before you deploy it");
    expect(steps?.content?.excerpt).toContain("## Steps for a remote server");
    // References only in the stored trace: no chunk text, no heading.
    const stored = JSON.stringify(await site.tenant.traces.get(message?.id as string));
    expect(stored).not.toContain("Streamable");
    expect(stored).not.toContain("Steps for a remote server");
  });

  it("still finds nothing for an off-topic question", async () => {
    const { requests, message } = await ask("Who painted the Mona Lisa?");
    expect(requests).toHaveLength(0);
    expect(message?.answered).toBe(false);
  });
});
