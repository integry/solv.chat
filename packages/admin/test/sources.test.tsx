import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, DocumentSummary, SourceSummary } from "../src/api/types.js";

function makeAssistant(): Assistant {
  return {
    id: "ast_1",
    orgId: "org_00000000000000000000",
    name: "Docs Bot",
    publicKey: "pk_ast_1",
    allowedOrigins: [],
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

function installSourcesFakeServer() {
  const assistant = makeAssistant();
  const sources: SourceSummary[] = [
    {
      id: "src_push_1",
      orgId: assistant.orgId,
      assistantId: assistant.id,
      kind: "push",
      label: "Push",
      settings: {},
      createdAt: 1_700_000_000_000,
      documentCount: 3,
      lastUpdatedAt: 1_700_000_100_000,
    },
  ];
  const documentsBySource = new Map<string, Array<DocumentSummary & { markdown: string }>>([
    [
      "src_push_1",
      [
        {
          id: "doc_p1",
          sourceId: "src_push_1",
          externalId: "intro",
          url: "https://docs.example.com/intro",
          title: "Intro",
          updatedAt: 1_700_000_100_000,
          markdown: "# Intro\n\nWelcome.",
        },
      ],
    ],
  ]);

  const importedPayloads: Array<{ sitemapUrl?: string; urls: string[] }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/sources` && method === "GET") {
      return Response.json({ sources: [...sources] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/entries` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { question: string; answer: string };
      let entrySource = sources.find((s) => s.kind === "entry");
      if (!entrySource) {
        entrySource = {
          id: "src_entry_1",
          orgId: assistant.orgId,
          assistantId: assistant.id,
          kind: "entry",
          label: "Answers you wrote",
          settings: {},
          createdAt: Date.now(),
          documentCount: 0,
          lastUpdatedAt: null,
        };
        sources.push(entrySource);
        documentsBySource.set(entrySource.id, []);
      }
      const list = documentsBySource.get(entrySource.id) ?? [];
      const doc = {
        id: `doc_e_${list.length + 1}`,
        sourceId: entrySource.id,
        externalId: `entry:h${list.length + 1}`,
        url: `https://example.com/admin/sources#entry:h${list.length + 1}`,
        title: body.question,
        updatedAt: Date.now(),
        markdown: `# ${body.question}\n\n${body.answer}`,
      };
      list.push(doc);
      entrySource.documentCount = list.length;
      entrySource.lastUpdatedAt = doc.updatedAt;
      return Response.json({ documentId: doc.id, sourceId: entrySource.id }, { status: 201 });
    }

    if (path === `/api/admin/assistants/${assistant.id}/sitemap-preview` && method === "POST") {
      return Response.json({
        urls: [
          "https://docs.example.com/getting-started",
          "https://docs.example.com/pricing",
          "https://docs.example.com/changelog",
        ],
      });
    }

    if (path === `/api/admin/assistants/${assistant.id}/sitemap-import` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        sitemapUrl?: string;
        urls: string[];
      };
      importedPayloads.push(body);
      const now = Date.now();
      const sitemapSource: SourceSummary = {
        id: "src_sitemap_1",
        orgId: assistant.orgId,
        assistantId: assistant.id,
        kind: "sitemap",
        label: "docs.example.com",
        settings: { url: body.sitemapUrl ?? body.urls[0] },
        createdAt: now,
        documentCount: body.urls.length,
        lastUpdatedAt: now,
      };
      sources.push(sitemapSource);
      documentsBySource.set(
        sitemapSource.id,
        body.urls.map((u, idx) => ({
          id: `doc_s_${idx + 1}`,
          sourceId: sitemapSource.id,
          externalId: u,
          url: u,
          title: `Page ${idx + 1}`,
          updatedAt: now,
          markdown: `# Page ${idx + 1}`,
        })),
      );
      return Response.json(
        { source: sitemapSource, written: body.urls.length, unchanged: 0, total: body.urls.length },
        { status: 201 },
      );
    }

    const docsMatch = /^\/api\/admin\/sources\/([^/]+)\/documents$/.exec(path);
    if (docsMatch?.[1] && method === "GET") {
      const list = documentsBySource.get(docsMatch[1]) ?? [];
      return Response.json({
        documents: list.map(({ markdown: _m, ...rest }) => rest),
        total: list.length,
        limit: 20,
        offset: 0,
      });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { importedPayloads };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("admin Sources screen", () => {
  it("shows the pushed source as read-only with a CLI hint and accessible controls without crawl/schedule/chunking", async () => {
    installSourcesFakeServer();
    window.history.replaceState(null, "", "/admin/sources");

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: "Sources" })).toBeTruthy();
    expect(screen.getByText("Pushed from your site")).toBeTruthy();
    expect(screen.getByText(/Read-only\./)).toBeTruthy();
    expect(screen.getByText("solv push")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    // Every interactive control has an accessible name.
    const controls = container.querySelectorAll("button, input, textarea, select");
    for (const control of controls) {
      const el = control as HTMLElement;
      const ariaLabel = el.getAttribute("aria-label");
      const id = el.getAttribute("id");
      const hasForLabel = id ? Boolean(container.querySelector(`label[for="${id}"]`)) : false;
      const text = el.textContent?.trim() ?? "";
      expect(Boolean(ariaLabel || hasForLabel || text)).toBe(true);
    }

    // Never offers crawl, schedule, or chunking settings.
    const bodyText = container.textContent?.toLowerCase() ?? "";
    expect(bodyText).not.toContain("schedule");
    expect(bodyText).not.toContain("chunk");
  });

  it("creates an entry and shows the new entry source in the list", async () => {
    installSourcesFakeServer();
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByRole("heading", { name: "Sources" });

    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Do you offer refunds?" },
    });
    fireEvent.change(screen.getByLabelText("Answer"), {
      target: { value: "Yes, within 30 days." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));

    expect(await screen.findByText("Answer saved.")).toBeTruthy();
    expect((await screen.findAllByText("Answers you wrote")).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 document/)).toBeTruthy();
  });

  it("previews sitemap URLs and imports only the selected ones", async () => {
    const server = installSourcesFakeServer();
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByRole("heading", { name: "Sources" });

    fireEvent.change(screen.getByLabelText("Sitemap URL"), {
      target: { value: "https://docs.example.com/sitemap.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch URLs" }));

    const pricingCheckbox = (await screen.findByLabelText(
      "https://docs.example.com/pricing",
    )) as HTMLInputElement;
    expect(pricingCheckbox.checked).toBe(true);

    // Deselect pricing so only 2 of the 3 URLs are imported.
    fireEvent.click(pricingCheckbox);
    expect(pricingCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));

    await waitFor(() => {
      expect(screen.getByText("Imported 2 pages.")).toBeTruthy();
    });
    expect(server.importedPayloads).toEqual([
      {
        sitemapUrl: "https://docs.example.com/sitemap.xml",
        urls: ["https://docs.example.com/getting-started", "https://docs.example.com/changelog"],
      },
    ]);
    expect(await screen.findByText("docs.example.com")).toBeTruthy();
  });
});
