import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, DocumentSummary, SourceSummary } from "../src/api/types.js";
import { INDEXING_POLL_MS } from "../src/screens/Sources.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

/** Opens a source's row menu and chooses an item. */
async function chooseRowAction(sourceName: string, item: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${sourceName}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

/** Opens "Add content" and picks one of its three choices. */
async function openAddContent(choice?: "Import from a sitemap" | "Push from your build") {
  const [headerButton] = await screen.findAllByRole("button", { name: "Add content" });
  if (!headerButton) throw new Error("Expected an Add content button");
  fireEvent.click(headerButton);
  if (choice) fireEvent.click(await screen.findByRole("radio", { name: new RegExp(choice) }));
}

/** The table row that names `sourceName`. */
function sourceRow(sourceName: string): HTMLElement {
  const row = screen.getByText(sourceName, { selector: ".source-label" }).closest("tr");
  if (!row) throw new Error(`No row for ${sourceName}`);
  return row as HTMLElement;
}

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
  onDocRequest?: (sourceId: string, docId: string) => Promise<Response> | null;
  onEntrySave?: (
    sourceId: string,
    docId: string,
    body: { question: string; answer: string },
  ) => Promise<Response> | Response | null;
  onSitemapImport?: (body: {
    sitemapUrl?: string;
    urls: string[];
    sourceId?: string;
  }) => Promise<Response> | Response | null;
  onSitemapPreview?: (body: { url: string }) => Promise<Response> | Response | null;
  onSourcesGet?: (count: number) => Promise<Response | null> | Response | null;
  previewUrls?: string[];
  noPush?: boolean;
}) {
  const assistant = makeAssistant();
  const sources: SourceSummary[] = [
    ...(options?.noPush
      ? []
      : [
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
          } satisfies SourceSummary,
        ]),
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
  let sourcesGets = 0;
  const previewBodies: Array<{ url: string }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/sources` && method === "GET") {
      sourcesGets++;
      const intercepted = await options?.onSourcesGet?.(sourcesGets);
      if (intercepted) return intercepted;
      return Response.json({ sources: sources.map((source) => ({ ...source })) });
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
      const body = JSON.parse(String(init?.body ?? "{}")) as { url: string };
      previewBodies.push(body);
      const intercepted = await options?.onSitemapPreview?.(body);
      if (intercepted) return intercepted;
      return Response.json({
        urls: options?.previewUrls ?? [
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

    const entryPutMatch = /^\/api\/admin\/sources\/([^/]+)\/entries\/([^/]+)$/.exec(path);
    if (entryPutMatch?.[1] && entryPutMatch[2] && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { question: string; answer: string };
      const intercepted = await options?.onEntrySave?.(entryPutMatch[1], entryPutMatch[2], body);
      if (intercepted) {
        return intercepted;
      }
      const list = documentsBySource.get(entryPutMatch[1]) ?? [];
      const found = list.find((d) => d.id === entryPutMatch[2]);
      if (!found) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      found.title = body.question;
      found.updatedAt = Date.now();
      found.markdown = `# ${body.question}\n\n${body.answer}`;
      return Response.json({ documentId: found.id, sourceId: entryPutMatch[1] });
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

    const docMatch = /^\/api\/admin\/sources\/([^/]+)\/documents\/([^/]+)$/.exec(path);
    if (docMatch?.[1] && docMatch[2] && method === "GET") {
      const intercepted = options?.onDocRequest?.(docMatch[1], docMatch[2]);
      if (intercepted) {
        return intercepted;
      }
      const list = documentsBySource.get(docMatch[1]) ?? [];
      const found = list.find((d) => d.id === docMatch[2]);
      if (!found) {
        return Response.json({ error: "Not found." }, { status: 404 });
      }
      const { markdown, ...document } = found;
      return Response.json({ document, markdown });
    }

    const deleteSourceMatch = /^\/api\/admin\/sources\/([^/]+)$/.exec(path);
    if (deleteSourceMatch?.[1] && method === "DELETE") {
      const idx = sources.findIndex((s) => s.id === deleteSourceMatch[1]);
      if (idx !== -1) {
        sources.splice(idx, 1);
      }
      documentsBySource.delete(deleteSourceMatch[1]);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    sources,
    importedPayloads,
    previewBodies,
    get sourcesGets() {
      return sourcesGets;
    },
    get createdSitemapSourceCount() {
      return createdSitemapSources;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
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
    expect(await screen.findByText("Your site")).toBeTruthy();
    expect(screen.getByText("Pushed with the CLI")).toBeTruthy();
    expect(screen.getByText(/read-only here/)).toBeTruthy();
    expect(screen.getByText("solv push")).toBeTruthy();

    // A pushed source can be viewed but not deleted by hand.
    fireEvent.click(screen.getByRole("button", { name: "Actions for Your site" }));
    expect(await screen.findByRole("menuitem", { name: "View documents" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Re-import" })).toBeNull();

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
    await screen.findByText("Your site");
    await openAddContent();
    // Writing an answer is the default choice.
    expect(
      (screen.getByRole("radio", { name: /Write an answer/ }) as HTMLInputElement).checked,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Do you offer refunds?" },
    });
    fireEvent.change(screen.getByLabelText("Answer"), {
      target: { value: "Yes, within 30 days." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));

    expect(
      await screen.findByText("Answer saved. Your assistant can use it in a minute or two."),
    ).toBeTruthy();
    expect(await screen.findByText("Answers you wrote")).toBeTruthy();
    const docsCell = sourceRow("Answers you wrote").querySelector('td[data-label="Documents"]');
    expect(docsCell?.textContent).toBe("1");
  });

  it("previews sitemap URLs and imports only the selected ones", async () => {
    const server = installSourcesFakeServer();
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByText("Your site");
    await openAddContent("Import from a sitemap");

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
      expect(screen.getByText(/^Imported 2 pages\./)).toBeTruthy();
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

  it("imports a large selection in batches the engine accepts and reports the total", async () => {
    const previewUrls = Array.from({ length: 12 }, (_, i) => `https://docs.example.com/p${i}`);
    const server = installSourcesFakeServer({ previewUrls });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByText("Your site");
    await openAddContent("Import from a sitemap");
    fireEvent.change(screen.getByLabelText("Sitemap URL"), {
      target: { value: "https://docs.example.com/sitemap.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch URLs" }));
    await screen.findByLabelText("https://docs.example.com/p11");

    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    expect(await screen.findByText(/^Imported 12 pages\./)).toBeTruthy();
    expect(server.importedPayloads.map((p) => p.urls.length)).toEqual([5, 5, 2]);
    expect(server.importedPayloads.flatMap((p) => p.urls)).toEqual(previewUrls);
    expect(new Set(server.importedPayloads.map((p) => p.sourceId)).size).toBe(1);
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
    await screen.findByText("Your site");
    await openAddContent("Import from a sitemap");

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
      expect(screen.getByText(/^Imported 3 pages\./)).toBeTruthy();
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
    await chooseRowAction("Answers you wrote", "View documents");

    expect(
      await screen.findByRole("heading", { name: "Documents in Answers you wrote" }),
    ).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Edit Question 21" })).toBeTruthy();
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
    // Expand source A (src_push_1) whose response stays pending.
    await chooseRowAction("Your site", "View documents");
    // Switch to source B (src_entry_1) whose response resolves immediately.
    await chooseRowAction("Answers you wrote", "View documents");

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
    await chooseRowAction("Your site", "View documents"); // expand A again (2nd call)
    await chooseRowAction("Answers you wrote", "View documents"); // switch back to B
    expect(await screen.findByText("Entry B Question")).toBeTruthy();

    rejectStaleA2(new Error("Network error from A"));
    await waitFor(() => {
      expect(screen.getByText("Entry B Question")).toBeTruthy();
      expect(screen.queryByText("Could not load documents.")).toBeNull();
    });
  });

  it("clears preview and selections when editing the sitemap URL", async () => {
    const server = installSourcesFakeServer();
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByText("Your site");
    await openAddContent("Import from a sitemap");

    const urlInput = screen.getByLabelText("Sitemap URL");
    fireEvent.change(urlInput, {
      target: { value: "https://docs.example.com/sitemap-a.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch URLs" }));

    expect(await screen.findByText("https://docs.example.com/getting-started")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import selected" })).toBeTruthy();

    // Editing the sitemap URL must invalidate the previous preview and selections.
    fireEvent.change(urlInput, {
      target: { value: "https://docs.example.com/sitemap-b.xml" },
    });

    await waitFor(() => {
      expect(screen.queryByText("https://docs.example.com/getting-started")).toBeNull();
      expect(screen.queryByRole("button", { name: "Import selected" })).toBeNull();
    });
    expect(server.importedPayloads).toHaveLength(0);
  });

  it("ignores stale entry-body loads so they cannot overwrite active edits or reopen after cancel/delete", async () => {
    let resolveA!: (res: Response) => void;
    let resolveA2!: (res: Response) => void;
    let aCalls = 0;

    installSourcesFakeServer({
      extraSources: [
        {
          id: "src_entry_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          kind: "entry",
          label: "Answers you wrote",
          settings: {},
          createdAt: 1_700_000_200_000,
          documentCount: 2,
          lastUpdatedAt: 1_700_000_200_000,
        },
      ],
      extraDocuments: [
        [
          "src_entry_1",
          [
            {
              id: "doc_a",
              sourceId: "src_entry_1",
              externalId: "entry:a",
              url: "https://example.com/admin/sources#entry:a",
              title: "Question A",
              updatedAt: 1_700_000_200_000,
              markdown: "# Question A\n\nAnswer A",
            },
            {
              id: "doc_b",
              sourceId: "src_entry_1",
              externalId: "entry:b",
              url: "https://example.com/admin/sources#entry:b",
              title: "Question B",
              updatedAt: 1_700_000_200_000,
              markdown: "# Question B\n\nAnswer B",
            },
          ],
        ],
      ],
      onDocRequest: (_sourceId, docId) => {
        if (docId === "doc_a") {
          aCalls++;
          return new Promise<Response>((resolve) => {
            if (aCalls === 1) {
              resolveA = resolve;
            } else {
              resolveA2 = resolve;
            }
          });
        }
        return null;
      },
    });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    // Expand the entry source.
    await chooseRowAction("Answers you wrote", "View documents");

    expect(await screen.findByText("Question A")).toBeTruthy();
    expect(screen.getByText("Question B")).toBeTruthy();

    const editA = screen.getByRole("button", { name: "Edit Question A" });
    const editB = screen.getByRole("button", { name: "Edit Question B" });

    // 1. Click Edit for entry A (remains pending), then click Edit for entry B (resolves first).
    fireEvent.click(editA);
    fireEvent.click(editB);

    const questionInput = (await screen.findByLabelText("Question")) as HTMLInputElement;
    const answerInput = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(questionInput.value).toBe("Question B");
      expect(answerInput.value).toBe("Answer B");
    });

    // 2. User modifies B's question and answer.
    fireEvent.change(questionInput, { target: { value: "Edited B Question" } });
    fireEvent.change(answerInput, { target: { value: "Edited B Answer" } });

    // 3. Stale A response now resolves; B's unsaved edits must remain intact.
    resolveA(
      Response.json({
        document: {
          id: "doc_a",
          sourceId: "src_entry_1",
          externalId: "entry:a",
          url: "https://example.com/admin/sources#entry:a",
          title: "Question A",
          updatedAt: 1_700_000_200_000,
        },
        markdown: "# Question A\n\nAnswer A",
      }),
    );

    await waitFor(() => {
      expect(questionInput.value).toBe("Edited B Question");
      expect(answerInput.value).toBe("Edited B Answer");
    });

    // 4. Cancel editing, start loading A again, then delete the source before A resolves.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(editA);
    await chooseRowAction("Answers you wrote", "Delete");
    const dialog = await screen.findByRole("dialog", { name: "Delete Answers you wrote?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete source" }));

    await waitFor(() => {
      expect(screen.queryByText("Answers you wrote")).toBeNull();
    });

    resolveA2(
      Response.json({
        document: {
          id: "doc_a",
          sourceId: "src_entry_1",
          externalId: "entry:a",
          url: "https://example.com/admin/sources#entry:a",
          title: "Question A",
          updatedAt: 1_700_000_200_000,
        },
        markdown: "# Question A\n\nAnswer A",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Edit answer" })).toBeNull();
      expect(screen.queryByLabelText("Question")).toBeNull();
    });
  });

  it("keeps entry B loaded and editable when a delayed save for entry A completes", async () => {
    let resolveSaveA!: (res: Response) => void;
    const entryDocs = [
      {
        id: "doc_a",
        sourceId: "src_entry_1",
        externalId: "entry:a",
        url: "https://example.com/admin/sources#entry:a",
        title: "Question A",
        updatedAt: 1_700_000_200_000,
        markdown: "# Question A\n\nAnswer A",
      },
      {
        id: "doc_b",
        sourceId: "src_entry_1",
        externalId: "entry:b",
        url: "https://example.com/admin/sources#entry:b",
        title: "Question B",
        updatedAt: 1_700_000_200_000,
        markdown: "# Question B\n\nAnswer B",
      },
    ];

    installSourcesFakeServer({
      extraSources: [
        {
          id: "src_entry_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          kind: "entry",
          label: "Answers you wrote",
          settings: {},
          createdAt: 1_700_000_200_000,
          documentCount: 2,
          lastUpdatedAt: 1_700_000_200_000,
        },
      ],
      extraDocuments: [["src_entry_1", entryDocs]],
      onEntrySave: (_sourceId, docId, body) => {
        if (docId === "doc_a") {
          return new Promise<Response>((resolve) => {
            resolveSaveA = (res) => {
              const currentDoc = entryDocs[0];
              if (currentDoc) {
                entryDocs[0] = { ...currentDoc, title: body.question };
              }
              resolve(res);
            };
          });
        }
        return null;
      },
    });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    // Expand the entry source.
    await chooseRowAction("Answers you wrote", "View documents");
    expect(await screen.findByText("Question A")).toBeTruthy();

    const editA = screen.getByRole("button", { name: "Edit Question A" });
    const editB = screen.getByRole("button", { name: "Edit Question B" });

    // 1. Load entry A, modify it, and click Save (PUT remains pending).
    fireEvent.click(editA);
    const questionInput = (await screen.findByLabelText("Question")) as HTMLInputElement;
    const answerInput = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(questionInput.value).toBe("Question A");
    });
    fireEvent.change(questionInput, { target: { value: "Updated Question A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();

    // 2. Switch to entry B while A's save is still pending.
    fireEvent.click(editB);
    await waitFor(() => {
      expect(questionInput.value).toBe("Question B");
      expect(answerInput.value).toBe("Answer B");
    });
    expect(questionInput.disabled).toBe(false);
    fireEvent.change(answerInput, { target: { value: "Draft Answer B" } });

    // 3. Delayed save for A now completes; B's editor session must stay intact.
    resolveSaveA(Response.json({ documentId: "doc_a", sourceId: "src_entry_1" }));

    expect(await screen.findByText("Updated Question A")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Edit answer" })).toBeTruthy();
    expect(questionInput.value).toBe("Question B");
    expect(answerInput.value).toBe("Draft Answer B");
    expect(screen.queryByText(/Answer saved/)).toBeNull();
  });

  it("selects at most 100 URLs by default and shows the 100-page import limit", async () => {
    const previewUrls = Array.from(
      { length: 150 },
      (_, i) => `https://docs.example.com/page-${i + 1}`,
    );
    installSourcesFakeServer({ previewUrls });
    window.history.replaceState(null, "", "/admin/sources");

    render(<App />);
    await screen.findByText("Your site");
    await openAddContent("Import from a sitemap");

    fireEvent.change(screen.getByLabelText("Sitemap URL"), {
      target: { value: "https://docs.example.com/sitemap.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch URLs" }));

    expect(
      await screen.findByText("100 of 150 selected · Up to 100 pages per import"),
    ).toBeTruthy();

    const firstCheckbox = screen.getByLabelText(
      "https://docs.example.com/page-1",
    ) as HTMLInputElement;
    const hundredthCheckbox = screen.getByLabelText(
      "https://docs.example.com/page-100",
    ) as HTMLInputElement;
    const hundredFirstCheckbox = screen.getByLabelText(
      "https://docs.example.com/page-101",
    ) as HTMLInputElement;
    expect(firstCheckbox.checked).toBe(true);
    expect(hundredthCheckbox.checked).toBe(true);
    expect(hundredFirstCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("0 of 150 selected · Up to 100 pages per import")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("100 of 150 selected · Up to 100 pages per import")).toBeTruthy();
  });

  function source(overrides: Partial<SourceSummary> & { id: string }): SourceSummary {
    return {
      orgId: "org_00000000000000000000",
      assistantId: "ast_1",
      kind: "entry",
      label: "Answers you wrote",
      settings: {},
      createdAt: 1_700_000_000_000,
      documentCount: 2,
      lastUpdatedAt: 1_700_000_200_000,
      indexingCount: 0,
      failedCount: 0,
      indexError: null,
      ...overrides,
    };
  }

  it("shows Indexing…, Ready and Failed with the reason, and passes axe", async () => {
    installSourcesFakeServer({
      extraSources: [
        source({ id: "src_entry_1", indexingCount: 1 }),
        source({
          id: "src_map_1",
          kind: "sitemap",
          label: "blog.example.com",
          settings: { url: "https://blog.example.com/sitemap.xml" },
          documentCount: 24,
          failedCount: 2,
          indexError: "too_long",
        }),
        source({
          id: "src_map_2",
          kind: "sitemap",
          label: "help.example.com",
          settings: { url: "https://help.example.com/sitemap.xml" },
          documentCount: 0,
        }),
      ],
    });
    window.history.replaceState(null, "", "/admin/sources");
    const { container } = render(<App />);
    await screen.findByText("blog.example.com");

    expect(within(sourceRow("Your site")).getByText("Ready")).toBeTruthy();
    const indexing = sourceRow("Answers you wrote");
    expect(within(indexing).getByText("Indexing…")).toBeTruthy();
    expect(within(indexing).getByText(/1 page not searchable yet/)).toBeTruthy();
    const failed = sourceRow("blog.example.com");
    expect(within(failed).getByText("Failed")).toBeTruthy();
    expect(
      within(failed).getByText(/2 pages could not be indexed: a page is too long to index/),
    ).toBeTruthy();
    expect(within(sourceRow("help.example.com")).getByText("Empty")).toBeTruthy();

    await expectNoSeriousA11yViolations(container);
  });

  it("checks again while something is indexing and stops once it is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = installSourcesFakeServer({
      extraSources: [source({ id: "src_entry_1", indexingCount: 1 })],
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);
    expect(await screen.findByText("Indexing…")).toBeTruthy();
    const before = server.sourcesGets;

    // Indexing finishes on the server; the next check shows it.
    const entry = server.sources.find((s) => s.id === "src_entry_1");
    if (entry) entry.indexingCount = 0;
    await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS + 50);
    await waitFor(() => expect(server.sourcesGets).toBe(before + 1));
    expect(await within(sourceRow("Answers you wrote")).findByText("Ready")).toBeTruthy();

    // Nothing is indexing any more, so no further checks.
    await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS * 3);
    expect(server.sourcesGets).toBe(before + 1);
  });

  it("keeps checking a failure the Queue retries, and shows Ready once a retry succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = installSourcesFakeServer({
      extraSources: [
        source({
          id: "src_entry_1",
          failedCount: 1,
          retryingCount: 1,
          indexError: "embedding_failed",
        }),
      ],
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);
    await screen.findByText("Answers you wrote");
    expect(within(sourceRow("Answers you wrote")).getByText("Failed")).toBeTruthy();
    const before = server.sourcesGets;

    // Nothing changes yet: still failed, still checking.
    await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS + 50);
    await waitFor(() => expect(server.sourcesGets).toBe(before + 1));
    expect(within(sourceRow("Answers you wrote")).getByText("Failed")).toBeTruthy();

    // The Queue's retry succeeds on the server; the next check shows it.
    const entry = server.sources.find((s) => s.id === "src_entry_1");
    if (entry) Object.assign(entry, { failedCount: 0, retryingCount: 0, indexError: null });
    // The next check is scheduled once the last one has answered, so step the clock.
    for (let step = 0; step < 20 && server.sourcesGets < before + 2; step++) {
      await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS / 5);
    }
    expect(server.sourcesGets).toBe(before + 2);
    expect(await within(sourceRow("Answers you wrote")).findByText("Ready")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS * 3);
    expect(server.sourcesGets).toBe(before + 2);
  });

  it("does not keep checking a failure that only the owner can fix", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = installSourcesFakeServer({
      extraSources: [
        source({ id: "src_entry_1", failedCount: 1, retryingCount: 0, indexError: "too_long" }),
      ],
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);
    await screen.findByText("Answers you wrote");
    expect(within(sourceRow("Answers you wrote")).getByText("Failed")).toBeTruthy();
    const before = server.sourcesGets;
    await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS * 3);
    expect(server.sourcesGets).toBe(before);
  });

  it("asks before deleting a source, and Cancel deletes nothing", async () => {
    const server = installSourcesFakeServer({ extraSources: [source({ id: "src_entry_1" })] });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);

    await chooseRowAction("Answers you wrote", "Delete");
    let dialog = await screen.findByRole("dialog", { name: "Delete Answers you wrote?" });
    expect(within(dialog).getByText(/2 documents stop being used in answers/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const deletes = () =>
      server.fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "DELETE");
    expect(deletes()).toHaveLength(0);
    expect(screen.getByText("Answers you wrote")).toBeTruthy();

    await chooseRowAction("Answers you wrote", "Delete");
    dialog = await screen.findByRole("dialog", { name: "Delete Answers you wrote?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete source" }));
    expect(await screen.findByText("Deleted Answers you wrote.")).toBeTruthy();
    expect(deletes()).toHaveLength(1);
    await waitFor(() => expect(screen.queryByText("Answers you wrote")).toBeNull());
  });

  it("re-imports a sitemap source from its saved address, in batches, into the same source", async () => {
    const previewUrls = Array.from({ length: 7 }, (_, i) => `https://blog.example.com/p${i}`);
    const server = installSourcesFakeServer({
      previewUrls,
      extraSources: [
        source({
          id: "src_map_1",
          kind: "sitemap",
          label: "blog.example.com",
          settings: { url: "https://blog.example.com/sitemap.xml" },
        }),
      ],
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);

    await chooseRowAction("blog.example.com", "Re-import");
    expect(await screen.findByText(/^blog\.example\.com: Imported 7 pages\./)).toBeTruthy();
    expect(server.previewBodies).toEqual([{ url: "https://blog.example.com/sitemap.xml" }]);
    expect(server.importedPayloads.map((p) => p.urls.length)).toEqual([5, 2]);
    expect(server.importedPayloads.every((p) => p.sourceId === "src_map_1")).toBe(true);
    expect(server.createdSitemapSourceCount).toBe(0);
  });

  it("shows import progress, then a summary with the unchanged pages", async () => {
    const previewUrls = Array.from({ length: 8 }, (_, i) => `https://docs.example.com/p${i}`);
    let release!: () => void;
    let calls = 0;
    installSourcesFakeServer({
      previewUrls,
      async onSitemapImport(body) {
        calls++;
        if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
        return Response.json(
          { written: 1, unchanged: body.urls.length - 1, total: body.urls.length },
          { status: 201 },
        );
      },
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);
    await screen.findByText("Your site");
    await openAddContent("Import from a sitemap");
    fireEvent.change(screen.getByLabelText("Sitemap URL"), {
      target: { value: "https://docs.example.com/sitemap.xml" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch URLs" }));
    await screen.findByLabelText("https://docs.example.com/p7");
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));

    expect(await screen.findByText("Importing 5 of 8 pages…")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Importing" }) as HTMLProgressElement;
    expect(bar.value).toBe(5);
    expect(bar.max).toBe(8);
    release();
    expect(
      await screen.findByText(/^Imported 8 pages\. 2 new or changed, 6 unchanged\./),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows a placeholder while loading, then an error with Try again that reloads", async () => {
    let releaseFirst!: () => void;
    const server = installSourcesFakeServer({
      async onSourcesGet(count) {
        if (count === 1) {
          await new Promise<void>((resolve) => (releaseFirst = resolve));
          return Response.json({ error: "The database is busy." }, { status: 503 });
        }
        return null;
      },
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);

    expect(await screen.findByText("Loading sources…")).toBeTruthy();
    releaseFirst();
    expect(await screen.findByText("Could not load your sources.")).toBeTruthy();
    expect(screen.getByText("The database is busy.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your site")).toBeTruthy();
    expect(server.sourcesGets).toBe(2);
    expect(screen.queryByText("Could not load your sources.")).toBeNull();
  });

  it("offers Add content from the empty state, with the three ways to add", async () => {
    installSourcesFakeServer({ noPush: true });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);

    expect(await screen.findByText("No sources yet")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Add content" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1] as HTMLElement);

    const group = await screen.findByRole("group", { name: "What would you like to add?" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(
      radios.map((r) => r.closest("label")?.querySelector(".choice-card-title")?.textContent),
    ).toEqual(["Write an answer", "Import from a sitemap", "Push from your build"]);
    expect(radios[0]?.checked).toBe(true);
    expect(screen.getByLabelText("Question")).toBeTruthy();

    fireEvent.click(within(group).getByRole("radio", { name: /Push from your build/ }));
    expect(
      await screen.findByText(/npx @solvchat\/cli push \.\/docs --endpoint .* --assistant ast_1/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Question")).toBeNull();
  });
});
