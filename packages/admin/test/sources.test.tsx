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

function installSourcesFakeServer(options?: {
  extraSources?: SourceSummary[];
  extraDocuments?: Array<[string, Array<DocumentSummary & { markdown: string }>]>;
  onDocsRequest?: (sourceId: string, url: URL) => Promise<Response> | null;
  onSitemapImport?: (body: {
    sitemapUrl?: string;
    urls: string[];
    sourceId?: string;
  }) => Promise<Response> | Response | null;
}) {
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
    ...(options?.extraSources ?? []),
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
    ...(options?.extraDocuments ?? []),
  ]);

  const importedPayloads: Array<{ sitemapUrl?: string; urls: string[]; sourceId?: string }> = [];
  let createdSitemapSources = 0;

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

    if (path === `/api/admin/assistants/${assistant.id}/sources` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        kind: "sitemap" | "entry";
        label: string;
        settings: Record<string, unknown>;
      };
      createdSitemapSources++;
      const created: SourceSummary = {
        id: `src_sitemap_${createdSitemapSources}`,
        orgId: assistant.orgId,
        assistantId: assistant.id,
        kind: body.kind,
        label: body.label,
        settings: body.settings,
        createdAt: Date.now(),
        documentCount: 0,
        lastUpdatedAt: null,
      };
      sources.push(created);
      documentsBySource.set(created.id, []);
      return Response.json({ source: created }, { status: 201 });
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
        sourceId?: string;
      };
      importedPayloads.push(body);
      const intercepted = await options?.onSitemapImport?.(body);
      if (intercepted) {
        return intercepted;
      }
      const now = Date.now();
      let sitemapSource = body.sourceId ? sources.find((s) => s.id === body.sourceId) : undefined;
      if (!sitemapSource) {
        sitemapSource = {
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
      } else {
        sitemapSource.documentCount = body.urls.length;
        sitemapSource.lastUpdatedAt = now;
      }
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
      const parsedUrl = new URL(url, "https://example.com");
      const intercepted = options?.onDocsRequest?.(docsMatch[1], parsedUrl);
      if (intercepted) {
        return intercepted;
      }
      const list = documentsBySource.get(docsMatch[1]) ?? [];
      const limit = Math.max(1, Number(parsedUrl.searchParams.get("limit") ?? "20"));
      const offset = Math.max(0, Number(parsedUrl.searchParams.get("offset") ?? "0"));
      const page = list.slice(offset, offset + limit);
      return Response.json({
        documents: page.map(({ markdown: _m, ...rest }) => rest),
        total: list.length,
        limit,
        offset,
      });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    importedPayloads,
    get createdSitemapSourceCount() {
      return createdSitemapSources;
    },
  };
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
        sourceId: "src_sitemap_1",
      },
    ]);
    expect(await screen.findByText("docs.example.com")).toBeTruthy();
  });

  it("retains and reuses sourceId when retrying a failed sitemap import", async () => {
    let attempts = 0;
    const server = installSourcesFakeServer({
      onSitemapImport() {
        attempts++;
        if (attempts === 1) {
          return Response.json({ error: "Queue send failed." }, { status: 500 });
        }
        return null;
      },
    });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByRole("heading", { name: "Sources" });

    fireEvent.change(screen.getByLabelText("Sitemap URL"), {
      target: { value: "https://docs.example.com/sitemap.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch URLs" }));
    await screen.findByLabelText("https://docs.example.com/pricing");

    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    expect(await screen.findByText("Queue send failed.")).toBeTruthy();
    expect(server.createdSitemapSourceCount).toBe(1);

    // Retry without re-fetching: must reuse the same sourceId and not create a second source.
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => {
      expect(screen.getByText("Imported 3 pages.")).toBeTruthy();
    });
    expect(server.createdSitemapSourceCount).toBe(1);
    expect(server.importedPayloads).toHaveLength(2);
    expect(server.importedPayloads[0]?.sourceId).toBe("src_sitemap_1");
    expect(server.importedPayloads[1]?.sourceId).toBe("src_sitemap_1");
  });

  it("paginates documents beyond the first 20 so the 21st entry is reachable and editable", async () => {
    const entries = Array.from({ length: 21 }, (_, idx) => ({
      id: `doc_e_${idx + 1}`,
      sourceId: "src_entry_1",
      externalId: `entry:h${idx + 1}`,
      url: `https://example.com/admin/sources#entry:h${idx + 1}`,
      title: `Question ${idx + 1}`,
      updatedAt: 1_700_000_200_000 - idx * 1000,
      markdown: `# Question ${idx + 1}\n\nAnswer ${idx + 1}`,
    }));

    installSourcesFakeServer({
      extraSources: [
        {
          id: "src_entry_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          kind: "entry",
          label: "Answers you wrote",
          settings: {},
          createdAt: 1_700_000_000_000,
          documentCount: 21,
          lastUpdatedAt: 1_700_000_200_000,
        },
      ],
      extraDocuments: [["src_entry_1", entries]],
    });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findAllByText("Answers you wrote");

    const [, entryViewButton] = screen.getAllByRole("button", { name: "View documents" });
    if (!entryViewButton) throw new Error("Expected entry View documents button");
    fireEvent.click(entryViewButton);

    expect(await screen.findByText("Question 1")).toBeTruthy();
    expect(screen.getByText("Showing 1–20 of 21")).toBeTruthy();
    expect(screen.queryByText("Question 21")).toBeNull();

    const prevButton = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const nextButton = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(prevButton.disabled).toBe(true);
    expect(nextButton.disabled).toBe(false);

    fireEvent.click(nextButton);

    expect(await screen.findByText("Question 21")).toBeTruthy();
    expect(screen.getByText("Showing 21–21 of 21")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Question 1")).toBeTruthy();
    expect(screen.queryByText("Question 21")).toBeNull();
  });

  it("ignores stale document responses and errors when switching to another source", async () => {
    let resolveStaleA!: (value: Response) => void;
    let rejectStaleA2!: (reason?: unknown) => void;
    let aCallCount = 0;

    installSourcesFakeServer({
      extraSources: [
        {
          id: "src_entry_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          kind: "entry",
          label: "Answers you wrote",
          settings: {},
          createdAt: 1_700_000_000_000,
          documentCount: 1,
          lastUpdatedAt: 1_700_000_200_000,
        },
      ],
      extraDocuments: [
        [
          "src_entry_1",
          [
            {
              id: "doc_e_1",
              sourceId: "src_entry_1",
              externalId: "entry:h1",
              url: "https://example.com/admin/sources#entry:h1",
              title: "Entry B Question",
              updatedAt: 1_700_000_200_000,
              markdown: "# Entry B Question\n\nAnswer B",
            },
          ],
        ],
      ],
      onDocsRequest(sourceId) {
        if (sourceId === "src_push_1") {
          aCallCount++;
          if (aCallCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveStaleA = resolve;
            });
          }
          return new Promise<Response>((_resolve, reject) => {
            rejectStaleA2 = reject;
          });
        }
        return null;
      },
    });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findAllByText("Answers you wrote");

    const [pushViewButton, entryViewButton] = screen.getAllByRole("button", {
      name: "View documents",
    });
    if (!pushViewButton || !entryViewButton)
      throw new Error("Expected both View documents buttons");
    // Expand source A (src_push_1) whose response stays pending.
    fireEvent.click(pushViewButton);
    // Switch to source B (src_entry_1) whose response resolves immediately.
    fireEvent.click(entryViewButton);

    expect(await screen.findByText("Entry B Question")).toBeTruthy();

    // Now resolve the stale response for source A.
    resolveStaleA(
      Response.json({
        documents: [
          {
            id: "doc_p1",
            sourceId: "src_push_1",
            externalId: "intro",
            url: "https://docs.example.com/intro",
            title: "Stale Source A Doc",
            updatedAt: 1_700_000_100_000,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Entry B Question")).toBeTruthy();
      expect(screen.queryByText("Stale Source A Doc")).toBeNull();
    });

    // Also verify a late error from a superseded request does not overwrite source B.
    fireEvent.click(screen.getByRole("button", { name: "View documents" })); // expand A again (2nd call)
    fireEvent.click(screen.getByRole("button", { name: "View documents" })); // switch back to B
    expect(await screen.findByText("Entry B Question")).toBeTruthy();

    rejectStaleA2(new Error("Network error from A"));
    await waitFor(() => {
      expect(screen.getByText("Entry B Question")).toBeTruthy();
      expect(screen.queryByText("Could not load documents.")).toBeNull();
    });
  });
});
