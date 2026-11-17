import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, AssistantOverview, AssistantReport } from "../src/api/types.js";
import { monitorOverview } from "./support/monitorFixtures.js";
import { findAssistantButton, pickAssistant, selectedAssistantId } from "./support/switcher.js";

/**
 * Links from one assistant's Overview, Reports and Gaps to its other screens.
 * A link opened in a new tab starts a fresh shell from the address alone, so
 * the address has to name the assistant; otherwise the new tab shows the
 * first assistant's screen instead.
 */

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

const FIRST: Assistant = {
  id: "ast_1",
  orgId: "org_00000000000000000000",
  name: "Docs Bot",
  publicKey: "pk_ast_1",
  allowedOrigins: ["https://docs.example.com"],
  hasIngestKey: true,
  createdAt: 1_700_000_000_000,
};

const SECOND: Assistant = { ...FIRST, id: "ast_2", name: "Sales Bot", publicKey: "pk_ast_2" };

function overview(): AssistantOverview {
  return { ...monitorOverview(NOW), configError: "The OpenAI key must be entered again." };
}

const REPORT: AssistantReport = {
  days: 30,
  from: "2026-10-18",
  to: "2026-11-16",
  questions: 10,
  replies: 10,
  answeredShare: 0.9,
  thumbsDownShare: 0.1,
  costMicros: 30_000,
  topQuestions: [],
  topGaps: [{ question: "can i pay by invoice?", count: 2 }],
  topSources: [],
  uncitedSources: [],
  uncitedTotal: 0,
};

/** Every request's path, so a test can see which assistant a screen loaded. */
function installServer() {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "https://example.com");
      paths.push(url.pathname);
      if (url.pathname === "/api/admin/assistants") {
        return Response.json({ assistants: [FIRST, SECOND] });
      }
      const resource = /^\/api\/admin\/assistants\/ast_[12]\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (resource === "overview") return Response.json(overview());
      if (resource === "report") return Response.json(REPORT);
      if (resource === "gaps") return Response.json({ gaps: [], total: 0, limit: 25, offset: 0 });
      if (resource === "conversations") {
        return Response.json({ conversations: [], total: 0, limit: 25, offset: 0 });
      }
      if (resource === "versions") return Response.json({ versions: [] });
      // The destination screens' own data is not needed: what matters is
      // which assistant they ask for.
      return Response.json({ error: "Not found." }, { status: 404 });
    }),
  );
  return { paths };
}

/** Opens `screenPath`, switches to the second assistant, and finds the link. */
async function linkOnSecondAssistant(screenPath: string, region: string, name: string) {
  window.history.pushState(null, "", screenPath);
  render(<App />);
  await findAssistantButton();
  expect(selectedAssistantId()).toBe(FIRST.id);
  pickAssistant(SECOND.id);
  await waitFor(() => expect(selectedAssistantId()).toBe(SECOND.id));
  const container = await screen.findByRole("region", { name: region });
  return within(container).findByRole("link", { name });
}

const LINKS = [
  {
    from: "/admin/overview",
    region: "Getting started",
    name: "Add content",
    to: "/admin/sources",
    loads: "sources",
  },
  {
    from: "/admin/overview",
    region: "Getting started",
    name: "Publish",
    to: "/admin/behaviour",
    loads: "draft",
  },
  {
    from: "/admin/overview",
    region: "Getting started",
    name: "Install on your site",
    to: "/admin/install",
    loads: "install",
  },
  {
    from: "/admin/overview",
    region: "Getting started",
    name: "First visitor question",
    to: "/admin/conversations",
    loads: "conversations",
  },
  {
    from: "/admin/overview",
    region: "Needs attention",
    name: "5 unanswered questions are waiting for an answer",
    to: "/admin/gaps",
    loads: "gaps",
  },
  {
    from: "/admin/overview",
    region: "Needs attention",
    name: "1 test failed in the last run",
    to: "/admin/tests",
    loads: "tests",
  },
  {
    from: "/admin/overview",
    region: "Needs attention",
    name: "Help centre: 3 pages were not indexed",
    to: "/admin/sources",
    loads: "sources",
  },
  {
    from: "/admin/overview",
    region: "Most asked questions",
    name: "See Reports",
    to: "/admin/reports",
    loads: "report",
  },
  {
    from: "/admin/reports",
    region: "Most often unanswered",
    name: "can i pay by invoice?",
    to: "/admin/gaps",
    loads: "gaps",
  },
] as const;

describe("links to an assistant's own screens", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it.each(LINKS)(
    "$name ($from) opens the second assistant's screen in a new tab",
    async ({ from, region, name, to, loads }) => {
      const { paths } = installServer();
      const link = await linkOnSecondAssistant(from, region, name);
      const href = link.getAttribute("href") ?? "";
      const address = new URL(href, "https://example.com");
      expect(address.pathname).toBe(to);
      expect(address.searchParams.get("assistant")).toBe(SECOND.id);

      // What a new tab does: a fresh shell started from the address alone.
      cleanup();
      paths.length = 0;
      window.history.pushState(null, "", href);
      render(<App />);

      await waitFor(() => expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/${loads}`));
      expect(selectedAssistantId()).toBe(SECOND.id);
      expect(paths.filter((p) => p.startsWith(`/api/admin/assistants/${FIRST.id}/`))).toEqual([]);
    },
  );

  it("Read conversations on an empty Gaps opens the second assistant's conversations", async () => {
    const { paths } = installServer();
    window.history.pushState(null, "", "/admin/gaps");
    render(<App />);
    await findAssistantButton();
    pickAssistant(SECOND.id);
    await waitFor(() => expect(selectedAssistantId()).toBe(SECOND.id));
    await waitFor(() => expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/gaps`));
    const link = await screen.findByRole("link", { name: "Read conversations" });
    const href = link.getAttribute("href") ?? "";
    expect(href).toBe(`/admin/conversations?assistant=${SECOND.id}`);

    cleanup();
    paths.length = 0;
    window.history.pushState(null, "", href);
    render(<App />);
    await waitFor(() =>
      expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/conversations`),
    );
    expect(selectedAssistantId()).toBe(SECOND.id);
    expect(paths.filter((p) => p.startsWith(`/api/admin/assistants/${FIRST.id}/`))).toEqual([]);
  });

  it("keeps the second assistant in the Gaps address, so a reload shows it again", async () => {
    const { paths } = installServer();
    // The address a question link leaves behind, with no handed-over answer.
    window.history.pushState(null, "", `/admin/gaps?assistant=${SECOND.id}`);
    render(<App />);
    await waitFor(() => expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/gaps`));
    expect(await screen.findByRole("heading", { name: "No unanswered questions" })).toBeTruthy();
    // Gaps takes consumed parameters out of the address but leaves the assistant.
    expect(window.location.pathname).toBe("/admin/gaps");
    expect(window.location.search).toBe(`?assistant=${SECOND.id}`);

    // A reload: a fresh shell started from the address Gaps left behind.
    cleanup();
    paths.length = 0;
    render(<App />);
    await waitFor(() => expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/gaps`));
    expect(selectedAssistantId()).toBe(SECOND.id);
    expect(paths.filter((p) => p.startsWith(`/api/admin/assistants/${FIRST.id}/`))).toEqual([]);
  });

  it("drops a handed-over answer from the Gaps address but keeps its assistant", async () => {
    const { paths } = installServer();
    const handedOver = new URLSearchParams({
      answer: "msg_1",
      question: "Do you ship to Spain?",
      assistant: SECOND.id,
    });
    window.history.pushState(null, "", `/admin/gaps?${handedOver.toString()}`);
    render(<App />);
    await waitFor(() => expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/gaps`));
    expect(((await screen.findByLabelText("Question")) as HTMLInputElement).value).toBe(
      "Do you ship to Spain?",
    );
    expect(window.location.search).toBe(`?assistant=${SECOND.id}`);

    cleanup();
    paths.length = 0;
    render(<App />);
    await waitFor(() => expect(paths).toContain(`/api/admin/assistants/${SECOND.id}/gaps`));
    expect(selectedAssistantId()).toBe(SECOND.id);
    // The editor does not reopen on a reload.
    expect(screen.queryByLabelText("Question")).toBeNull();
  });

  it("leaves Providers, which is for the whole organisation, without an assistant", async () => {
    installServer();
    const link = await linkOnSecondAssistant(
      "/admin/overview",
      "Needs attention",
      "Check providers",
    );
    expect(link.getAttribute("href")).toBe("/admin/providers");
  });
});
