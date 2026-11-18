import type { SourceSyncStatus } from "@solvchat/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, SourceSummary } from "../src/api/types.js";
import { mountAdmin } from "../src/mount.js";
import { syncCountsText, syncErrorText } from "../src/screens/SourceSync.js";
import { INDEXING_POLL_MS } from "../src/screens/Sources.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const ASSISTANT: Assistant = {
  id: "ast_1",
  orgId: "org_00000000000000000000",
  name: "Docs Bot",
  publicKey: "pk_ast_1",
  allowedOrigins: [],
  hasIngestKey: true,
  createdAt: NOW - 100 * HOUR,
};

const ZERO = { added: 0, updated: 0, unchanged: 0, removed: 0, failed: 0, deferred: 0 };

function source(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    id: "src_site",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    kind: "sitemap",
    label: "Help site",
    settings: { url: "https://docs.example.com/sitemap.xml" },
    createdAt: NOW - 50 * HOUR,
    documentCount: 40,
    lastUpdatedAt: NOW - 3 * HOUR,
    indexingCount: 0,
    failedCount: 0,
    retryingCount: 0,
    indexError: null,
    ...overrides,
  };
}

const SYNCED: SourceSyncStatus = {
  schedule: "daily",
  last: {
    startedAt: NOW - 3 * HOUR - 60_000,
    finishedAt: NOW - 3 * HOUR,
    outcome: "succeeded",
    counts: { ...ZERO, added: 2, updated: 1, unchanged: 37 },
    error: null,
    progress: null,
  },
  nextSyncAt: NOW + 21 * HOUR,
};

const ENTRY = source({
  id: "src_entry",
  kind: "entry",
  label: "Written answers",
  settings: {},
  documentCount: 2,
});

interface ServerOptions {
  sources: SourceSummary[];
  /** Answers `POST /api/admin/sources/:id/sync`; default: a run that starts. */
  onSync?: (sourceId: string) => Response | Promise<Response>;
  onPatch?: (sourceId: string, body: unknown) => Response | Promise<Response>;
}

function installServer(options: ServerOptions) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = { sources: options.sources };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://example.com");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body });

    if (url.pathname === "/api/admin/assistants") return Response.json({ assistants: [ASSISTANT] });
    if (url.pathname === `/api/admin/assistants/${ASSISTANT.id}/sources` && method === "GET") {
      return Response.json({ sources: server.sources.map((s) => ({ ...s })) });
    }
    if (url.pathname === `/api/admin/assistants/${ASSISTANT.id}/versions`) {
      return Response.json({ versions: [] });
    }
    const sync = /^\/api\/admin\/sources\/([^/]+)\/sync$/.exec(url.pathname);
    if (sync?.[1] && method === "POST") {
      const id = sync[1];
      if (options.onSync) return options.onSync(id);
      return Response.json(
        {
          sync: {
            schedule: "daily",
            nextSyncAt: null,
            last: {
              startedAt: NOW,
              finishedAt: null,
              outcome: "running",
              counts: ZERO,
              error: null,
              progress: { done: 0, total: 4 },
            },
          },
        },
        { status: 202 },
      );
    }
    const patch = /^\/api\/admin\/sources\/([^/]+)$/.exec(url.pathname);
    if (patch?.[1] && method === "PATCH") {
      if (options.onPatch) return options.onPatch(patch[1], body);
      return Response.json({ source: server.sources.find((s) => s.id === patch[1]) });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, server };
}

async function openSources() {
  window.history.pushState(null, "", `/admin/sources?assistant=${ASSISTANT.id}`);
  const view = render(<App />);
  await screen.findByText("Help site", { selector: ".source-label" });
  return view;
}

function sourceRow(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: ".source-label" }).closest("tr");
  if (!row) throw new Error(`No row for ${name}`);
  return row as HTMLElement;
}

function cell(row: HTMLElement, label: string): HTMLElement {
  const td = row.querySelector(`td[data-label="${label}"]`);
  if (!td) throw new Error(`No ${label} cell`);
  return td as HTMLElement;
}

describe("Sources screen: sitemap sync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it("shows a sitemap source's schedule, last sync with counts and next sync; other kinds unchanged", async () => {
    installServer({ sources: [source({ sync: SYNCED }), ENTRY] });
    const { container } = await openSources();

    const row = sourceRow("Help site");
    const sync = cell(row, "Sync");
    const schedule = within(sync).getByRole("combobox", { name: "How often Help site syncs" });
    expect((schedule as HTMLSelectElement).value).toBe("daily");
    expect(
      within(schedule)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Off", "Every day", "Every week"]);
    expect(sync.textContent).toContain(
      "Last synced 3 hours ago: 2 added, 1 updated, 37 unchanged.",
    );
    expect(sync.textContent).toContain("Next sync in 21 hours.");
    expect(within(sync).getByRole("button", { name: "Sync Help site now" })).toBeTruthy();

    // An entry source has no sync controls, and its Sync cell is empty.
    const entry = sourceRow("Written answers");
    expect(cell(entry, "Sync").textContent).toBe("");
    expect(within(entry).queryByRole("combobox")).toBeNull();

    // Nothing promises to follow links.
    const text = container.textContent?.toLowerCase() ?? "";
    expect(text).not.toContain("crawl");
    await expectNoSeriousA11yViolations(container);
  });

  it("leaves out the Sync column when no source syncs", async () => {
    installServer({ sources: [source({ id: "src_e2", label: "Help site", kind: "entry" })] });
    await openSources();
    expect(screen.queryByRole("columnheader", { name: "Sync" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sync .* now/ })).toBeNull();
  });

  it("saves a schedule change on a source that already synced, without asking", async () => {
    const { calls } = installServer({ sources: [source({ sync: SYNCED })] });
    await openSources();

    fireEvent.change(screen.getByRole("combobox", { name: "How often Help site syncs" }), {
      target: { value: "weekly" },
    });
    await screen.findByText("Help site now syncs with its sitemap every week.");
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: "/api/admin/sources/src_site",
        body: { settings: { sync: "weekly" } },
      },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before the first sync, explaining that every listed page comes in, and can be cancelled", async () => {
    const never: SourceSyncStatus = { schedule: "off", last: null, nextSyncAt: null };
    const { calls } = installServer({ sources: [source({ sync: never })] });
    await openSources();

    const sync = cell(sourceRow("Help site"), "Sync");
    expect(sync.textContent).toContain("Never synced.");
    expect(sync.textContent).toContain("Syncs only when you choose Sync now.");

    fireEvent.change(within(sync).getByRole("combobox"), { target: { value: "daily" } });
    const dialog = await screen.findByRole("dialog", { name: "Sync Help site every day?" });
    expect(dialog.textContent).toContain("not only the ones you chose when importing");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect((within(sync).getByRole("combobox") as HTMLSelectElement).value).toBe("off");

    fireEvent.click(within(sync).getByRole("button", { name: "Sync Help site now" }));
    const now = await screen.findByRole("dialog", { name: "Sync Help site now?" });
    fireEvent.click(within(now).getByRole("button", { name: "Sync now" }));
    await screen.findByText("Syncing Help site…");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/api/admin/sources/src_site/sync",
    ]);
  });

  it("starts a sync on Sync now, shows its progress in Status like indexing, and the outcome once done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const { server, calls } = installServer({ sources: [source({ sync: SYNCED })] });
    await openSources();

    server.sources = [
      source({
        sync: {
          schedule: "daily",
          nextSyncAt: null,
          last: {
            startedAt: NOW,
            finishedAt: null,
            outcome: "running",
            counts: { ...ZERO, added: 1 },
            error: null,
            progress: { done: 1, total: 4 },
          },
        },
      }),
    ];
    fireEvent.click(screen.getByRole("button", { name: "Sync Help site now" }));
    await screen.findByText("Syncing Help site…");

    const row = sourceRow("Help site");
    await waitFor(() => expect(cell(row, "Status").textContent).toContain("Syncing 1 of 4 pages…"));
    const bar = within(cell(row, "Status")).getByRole("progressbar", { name: "Syncing" });
    expect(bar.getAttribute("value")).toBe("1");
    expect(
      within(cell(row, "Sync")).getByRole("button", { name: "Sync Help site now" }),
    ).toHaveProperty("disabled", true);
    // Re-import waits for the sync.
    fireEvent.click(within(row).getByRole("button", { name: "Actions for Help site" }));
    expect(screen.getByRole("menuitem", { name: "Re-import" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // The list is checked again while the sync runs, until it finishes.
    server.sources = [
      source({
        sync: {
          schedule: "daily",
          nextSyncAt: NOW + 23 * HOUR,
          last: {
            startedAt: NOW,
            finishedAt: NOW + 60_000,
            outcome: "partial",
            counts: { ...ZERO, added: 3, failed: 1 },
            error: "pages_failed",
            progress: null,
          },
        },
      }),
    ];
    const gets = () =>
      calls.filter((c) => c.path.endsWith("/sources") && c.method === "GET").length;
    const before = gets();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS);
    });
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() =>
      expect(cell(row, "Sync").textContent).toContain("3 added, 1 could not be fetched."),
    );
    expect(cell(row, "Sync").textContent).toContain(
      "Some pages could not be fetched. They are tried again on a later sync.",
    );
    expect(cell(row, "Status").textContent).toContain("Ready");
  });

  it("shows the last error in plain words, using the source's own removal limit", async () => {
    installServer({
      sources: [
        source({
          settings: { url: "https://docs.example.com/sitemap.xml", maxRemovePercent: 20 },
          sync: {
            schedule: "weekly",
            nextSyncAt: NOW - 60_000,
            last: {
              startedAt: NOW - 2 * HOUR,
              finishedAt: NOW - 2 * HOUR,
              outcome: "failed",
              counts: ZERO,
              error: "too_many_removals",
              progress: null,
            },
          },
        }),
      ],
    });
    await openSources();
    const sync = cell(sourceRow("Help site"), "Sync");
    expect(sync.textContent).toContain("Last sync failed 2 hours ago.");
    expect(sync.textContent).toContain(
      "It would have removed more than 20% of this source's pages, so nothing was changed.",
    );
    expect(sync.textContent).toContain("Next sync: soon.");
  });

  it("says why a Sync now failed straight away, and why it was refused", async () => {
    let answer: "failed" | "busy" = "failed";
    installServer({
      sources: [source({ sync: SYNCED })],
      onSync: () =>
        answer === "failed"
          ? Response.json(
              {
                sync: {
                  ...SYNCED,
                  last: {
                    ...SYNCED.last,
                    startedAt: NOW,
                    finishedAt: NOW,
                    outcome: "failed",
                    error: "sitemap_unavailable",
                    counts: ZERO,
                  },
                },
              },
              { status: 202 },
            )
          : Response.json({ error: "This source is already syncing." }, { status: 409 }),
    });
    await openSources();

    fireEvent.click(screen.getByRole("button", { name: "Sync Help site now" }));
    await screen.findByText(
      "Help site did not sync: The sitemap could not be read. Check that its address still works.",
    );

    answer = "busy";
    fireEvent.click(screen.getByRole("button", { name: "Sync Help site now" }));
    await screen.findByText("Could not sync Help site: This source is already syncing.");
  });

  it("reports a schedule that could not be saved", async () => {
    installServer({
      sources: [source({ sync: SYNCED })],
      onPatch: () =>
        Response.json(
          { error: "That is not valid.", fields: ["settings.sync: must be one of the choices"] },
          { status: 400 },
        ),
    });
    await openSources();
    fireEvent.change(screen.getByRole("combobox", { name: "How often Help site syncs" }), {
      target: { value: "off" },
    });
    await screen.findByText(/Could not change how often Help site syncs/);
  });

  it("works mounted by a host through mountAdmin", async () => {
    const { calls } = installServer({ sources: [source({ sync: SYNCED })] });
    window.history.pushState(null, "", `/admin/sources?assistant=${ASSISTANT.id}`);
    const root = document.createElement("div");
    document.body.append(root);
    let mounted: ReturnType<typeof mountAdmin> | undefined;
    act(() => {
      mounted = mountAdmin(root, {
        extraNavItems: [{ id: "billing", label: "Billing", path: "/admin/billing" }],
        extraScreens: { billing: () => <p>Billing</p> },
        hideScreens: ["providers"],
      });
    });
    const button = await within(root).findByRole("button", { name: "Sync Help site now" });
    fireEvent.click(button);
    await within(document.body).findByText("Syncing Help site…");
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/api/admin/sources/src_site/sync"),
    ).toBe(true);
    act(() => mounted?.unmount());
    root.remove();
  });
});

describe("sync wording", () => {
  it("leaves out counts that are zero and says when nothing changed", () => {
    expect(syncCountsText(ZERO)).toBe("nothing changed");
    expect(syncCountsText({ ...ZERO, removed: 2, deferred: 5 })).toBe(
      "2 removed, 5 left for the next sync",
    );
  });

  it("words every error code without the server's own text", () => {
    for (const code of [
      "sitemap_unavailable",
      "sitemap_invalid",
      "sitemap_empty",
      "too_many_removals",
      "limit_refused",
      "pages_failed",
      "interrupted",
      null,
    ] as const) {
      const text = syncErrorText(code);
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text.toLowerCase()).not.toContain("crawl");
    }
    expect(syncErrorText("too_many_removals")).not.toMatch(/\d/);
  });
});
