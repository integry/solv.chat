import { MAX_CONVERSATION_SEARCH_LENGTH } from "@solvchat/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type {
  Assistant,
  AssistantOverview,
  AssistantReport,
  ConversationSummary,
} from "../src/api/types.js";
import { monitorOverview } from "./support/monitorFixtures.js";
import { findAssistantButton, pickAssistant, selectedAssistantId } from "./support/switcher.js";

/**
 * A most-asked question in Overview or Reports leads to the conversations that
 * asked it. The link has to work when opened in a new tab (where the shell
 * starts from the address alone), for any assistant, and for a question
 * longer than the conversation search accepts.
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

const SHORT_QUESTION = "do you offer volume discounts?";
// Longer than the search limit, with a character made of two code units
// sitting on the cut, so a careless cut would break the address.
const LONG_QUESTION = `${"a".repeat(MAX_CONVERSATION_SEARCH_LENGTH - 1)}😀 ${"and then some more words ".repeat(4)}`;

function report(question: string): AssistantReport {
  return {
    days: 30,
    from: "2026-10-18",
    to: "2026-11-16",
    questions: 10,
    replies: 10,
    answeredShare: 0.9,
    thumbsDownShare: 0.1,
    costMicros: 30_000,
    topQuestions: [{ question, count: 3 }],
    topGaps: [],
    topSources: [],
    uncitedSources: [],
    uncitedTotal: 0,
  };
}

function overview(question: string): AssistantOverview {
  return { ...monitorOverview(NOW), topQuestions: [{ question, count: 6 }] };
}

function conversationOf(assistantId: string): ConversationSummary {
  return {
    id: `cnv_${assistantId}`,
    assistantId,
    visitorId: "vis_1",
    startedAt: NOW - 3_600_000,
    pageUrl: "https://docs.example.com/pricing",
    firstQuestion: `A question asked of ${assistantId}`,
    turnCount: 2,
    hasUnanswered: false,
    hasNotHelpful: false,
    usedTool: false,
    lastMessageAt: NOW - 3_600_000,
  };
}

/**
 * Two assistants. Only the second has the question under test; the first's
 * figures name a different one. The conversation list refuses an over-long
 * search the way the engine does.
 */
function installServer(question: string) {
  const conversationRequests: Array<{ assistantId: string; q: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "https://example.com");
      if (url.pathname === "/api/admin/assistants") {
        return Response.json({ assistants: [FIRST, SECOND] });
      }
      const match = /^\/api\/admin\/assistants\/(ast_[12])\/(overview|report|conversations)$/.exec(
        url.pathname,
      );
      if (!match) return Response.json({ error: "Not found." }, { status: 404 });
      const assistantId = match[1] ?? "";
      const resource = match[2];
      const asked = assistantId === SECOND.id ? question : "what are your opening hours?";
      if (resource === "overview") return Response.json(overview(asked));
      if (resource === "report") return Response.json(report(asked));
      const q = url.searchParams.get("q");
      conversationRequests.push({ assistantId, q });
      if (q !== null && q.length > MAX_CONVERSATION_SEARCH_LENGTH) {
        return Response.json(
          { error: `q: must be at most ${MAX_CONVERSATION_SEARCH_LENGTH} characters` },
          { status: 400 },
        );
      }
      return Response.json({
        conversations: [conversationOf(assistantId)],
        total: 1,
        limit: 25,
        offset: 0,
      });
    }),
  );
  return { conversationRequests };
}

/** Opens `screenPath` and switches to the second assistant through the switcher. */
async function openOnSecondAssistant(screenPath: string, question: string) {
  window.history.pushState(null, "", screenPath);
  render(<App />);
  await findAssistantButton();
  expect(selectedAssistantId()).toBe(FIRST.id);
  pickAssistant(SECOND.id);
  await waitFor(() => expect(selectedAssistantId()).toBe(SECOND.id));
  return screen.findByRole("link", { name: question.trim() });
}

/** What a new tab does with the link: a fresh shell started from the address alone. */
async function openInNewTab(href: string) {
  cleanup();
  window.history.pushState(null, "", href);
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Conversations", level: 1 })).toBeTruthy();
}

describe("question links from Overview and Reports", () => {
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

  describe.each([
    { screenName: "Overview", path: "/admin/overview" },
    { screenName: "Reports", path: "/admin/reports" },
  ])("from $screenName", ({ path }) => {
    it.each([
      { kind: "a short question", question: SHORT_QUESTION },
      { kind: "a question longer than the search limit", question: LONG_QUESTION },
    ])(
      "opens the second assistant's conversations for $kind in a new tab",
      async ({ question }) => {
        const { conversationRequests } = installServer(question);
        const link = await openOnSecondAssistant(path, question);
        const href = link.getAttribute("href") ?? "";
        const params = new URL(href, "https://example.com").searchParams;
        expect(params.get("assistant")).toBe(SECOND.id);
        const q = params.get("q") ?? "";
        expect(q.length).toBeGreaterThan(0);
        expect(q.length).toBeLessThanOrEqual(MAX_CONVERSATION_SEARCH_LENGTH);
        // The search keeps the start of the question, so it still finds it.
        expect(question.startsWith(q)).toBe(true);

        conversationRequests.length = 0;
        await openInNewTab(href);

        expect(await screen.findByText(`A question asked of ${SECOND.id}`)).toBeTruthy();
        expect(selectedAssistantId()).toBe(SECOND.id);
        expect((screen.getByLabelText("Search conversations") as HTMLInputElement).value).toBe(q);
        expect(screen.queryByText("Could not load conversations.")).toBeNull();
        expect(conversationRequests).toContainEqual({ assistantId: SECOND.id, q });
        expect(conversationRequests.some((r) => r.assistantId === FIRST.id)).toBe(false);
      },
    );
  });

  it("bounds an over-long search already in a shared address", async () => {
    const { conversationRequests } = installServer(SHORT_QUESTION);
    const params = new URLSearchParams({ q: LONG_QUESTION, assistant: SECOND.id });
    await openInNewTab(`/admin/conversations?${params.toString()}`);

    expect(await screen.findByText(`A question asked of ${SECOND.id}`)).toBeTruthy();
    expect(screen.queryByText("Could not load conversations.")).toBeNull();
    const sent = conversationRequests.filter((r) => r.assistantId === SECOND.id);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.q?.length ?? 0).toBeLessThanOrEqual(MAX_CONVERSATION_SEARCH_LENGTH);
      expect(LONG_QUESTION.startsWith(request.q ?? "")).toBe(true);
    }
  });
});
