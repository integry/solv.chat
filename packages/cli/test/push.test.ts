import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH_SIZE, push } from "../src/push.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function createMockFetch(handler?: (req: RecordedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const recorded = { url, method, headers, body };
    requests.push(recorded);
    if (handler) return handler(recorded);
    const docs = Array.isArray(body.documents) ? body.documents : [];
    return Response.json({ written: docs.length, unchanged: 0, deleted: 0 });
  };
  return { fetchImpl, requests };
}

describe("solv push", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "solv-cli-push-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("pushes a folder of Markdown files with expected ids, titles, and URLs", async () => {
    await mkdir(join(root, "guides"), { recursive: true });
    await writeFile(
      join(root, "index.md"),
      "---\ntitle: Home Page\n---\n\n# Ignored Heading\n\nWelcome.\n",
      "utf8",
    );
    await writeFile(join(root, "guides", "intro.md"), "# Getting Started\n\nStep one.\n", "utf8");
    await writeFile(join(root, "guides", "plain.markdown"), "No heading here.\n", "utf8");

    const { fetchImpl, requests } = createMockFetch();
    const logs: string[] = [];

    await push(
      {
        dir: root,
        endpoint: "https://chat.example.com/",
        assistant: "ast_123",
        baseUrl: "https://docs.example.com/docs",
        ingestKey: "ing_secret_key_value",
      },
      { fetchImpl, log: (line) => logs.push(line) },
    );

    expect(requests).toHaveLength(1);
    const req = requests[0];
    if (!req) throw new Error("Expected request");
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("https://chat.example.com/v1/ingest/ast_123/documents");
    expect(req.headers.authorization).toBe("Bearer ing_secret_key_value");

    const docs = req.body.documents as Array<{
      externalId: string;
      title: string;
      url: string;
      markdown: string;
    }>;
    expect(docs).toEqual([
      {
        externalId: "guides/intro",
        title: "Getting Started",
        url: "https://docs.example.com/docs/guides/intro",
        markdown: "# Getting Started\n\nStep one.\n",
      },
      {
        externalId: "guides/plain",
        title: "guides/plain",
        url: "https://docs.example.com/docs/guides/plain",
        markdown: "No heading here.\n",
      },
      {
        externalId: "index",
        title: "Home Page",
        url: "https://docs.example.com/docs/index",
        markdown: "\n# Ignored Heading\n\nWelcome.\n",
      },
    ]);
  });

  it("sends nothing and prints every document on --dry-run", async () => {
    await writeFile(join(root, "a.md"), "# Doc A\n\nHello\n", "utf8");
    await writeFile(join(root, "b.md"), "# Doc B\n\nWorld\n", "utf8");

    const { fetchImpl, requests } = createMockFetch();
    const logs: string[] = [];

    await push(
      {
        dir: root,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        baseUrl: "https://docs.example.com",
        dryRun: true,
      },
      { fetchImpl, log: (line) => logs.push(line) },
    );

    expect(requests).toHaveLength(0);
    const output = logs.join("\n");
    expect(output).toContain("2 documents would be pushed");
    expect(output).toContain("a -> https://docs.example.com/a");
    expect(output).toContain("b -> https://docs.example.com/b");
  });

  it("splits batches larger than BATCH_SIZE and sends --prune once after the last batch", async () => {
    const total = BATCH_SIZE + 5;
    for (let i = 0; i < total; i++) {
      const name = String(i).padStart(3, "0");
      await writeFile(join(root, `doc-${name}.md`), `# Doc ${name}\n\nBody ${name}\n`, "utf8");
    }

    const { fetchImpl, requests } = createMockFetch((req) => {
      if (req.method === "DELETE") {
        return Response.json({ written: 0, unchanged: 0, deleted: 3 });
      }
      const docs = req.body.documents as unknown[];
      return Response.json({ written: docs.length, unchanged: 0, deleted: 0 });
    });
    const logs: string[] = [];

    await push(
      {
        dir: root,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        baseUrl: "https://docs.example.com",
        ingestKey: "ing_secret",
        prune: true,
      },
      { fetchImpl, log: (line) => logs.push(line) },
    );

    expect(requests).toHaveLength(3);
    const [first, second, third] = requests;
    expect(first?.method).toBe("PUT");
    expect(first?.body.documents).toHaveLength(BATCH_SIZE);
    expect(second?.method).toBe("PUT");
    expect(second?.body.documents).toHaveLength(5);
    expect(third?.method).toBe("DELETE");
    expect(third?.body.prune).toBe(true);
    expect(third?.body.keep).toHaveLength(total);
  });

  it("pushes a prepared JSON batch with --json", async () => {
    const jsonPath = join(root, "batch.json");
    await writeFile(
      jsonPath,
      JSON.stringify({
        documents: [
          {
            externalId: "faq",
            title: "FAQ",
            url: "https://docs.example.com/faq",
            markdown: "# FAQ\n\nAnswers.",
          },
        ],
      }),
      "utf8",
    );

    const { fetchImpl, requests } = createMockFetch();
    await push(
      {
        json: jsonPath,
        endpoint: "https://chat.example.com",
        assistant: "ast_123",
        ingestKey: "ing_secret",
      },
      { fetchImpl, log: () => {} },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.documents).toHaveLength(1);
  });
});
