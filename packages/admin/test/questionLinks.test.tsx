import {
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CONVERSATION_SEARCH_LENGTH,
  QUESTION_LINK_LENGTH,
} from "@solvchat/core";
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
 * asked it, by the grouped question its count is for. The link has to work
 * when opened in a new tab (where the shell starts from the address alone),
 * for any assistant, and for a question longer than the search box accepts.
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
// A grouped question as long as a key gets, in letters that percent-encode
// to several characters each: whole, its link would be far too long to load.
const LONGEST_QUESTION = "ё".repeat(MAX_CHAT_MESSAGE_LENGTH * 3);

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
  const conversationRequests: Array<{
    assistantId: string;
    q: string | null;
    question?: string | null;
    days?: string;
    askedFrom?: string;
    askedTo?: string;
  }> = [];
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
      const askedQuestion = url.searchParams.get("question");
      const days = url.searchParams.get("days");
      const askedFrom = url.searchParams.get("askedFrom");
      const askedTo = url.searchParams.get("askedTo");
      conversationRequests.push({
        assistantId,
        q,
        ...(askedQuestion === null ? {} : { question: askedQuestion }),
        ...(days === null ? {} : { days }),
        ...(askedFrom === null ? {} : { askedFrom }),
        ...(askedTo === null ? {} : { askedTo }),
      });
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
    // Overview's list is for all time; Reports' is for the UTC days of its
    // period, bounding when the question was asked. Neither sets "Started".
    { screenName: "Overview", path: "/admin/overview", asked: null, period: "" },
    {
      screenName: "Reports",
      path: "/admin/reports",
      asked: { askedFrom: "2026-10-18", askedTo: "2026-11-16" },
      period: " from 18 Oct 2026 to 16 Nov 2026",
    },
  ])("from $screenName", ({ path, asked, period }) => {
    it.each([
      {
        kind: "a short question",
        question: SHORT_QUESTION,
        sent: SHORT_QUESTION.trim(),
        shown: SHORT_QUESTION.trim(),
      },
      {
        kind: "a question longer than the search limit",
        question: LONG_QUESTION,
        // Only its start: the conversation list matches every group starting with it.
        sent: "a".repeat(QUESTION_LINK_LENGTH),
        shown: `${"a".repeat(QUESTION_LINK_LENGTH)}…`,
      },
      {
        kind: "the longest question, in letters that encode long",
        question: LONGEST_QUESTION,
        sent: "ё".repeat(QUESTION_LINK_LENGTH),
        shown: `${"ё".repeat(QUESTION_LINK_LENGTH)}…`,
      },
    ])(
      "opens the second assistant's conversations for $kind in a new tab",
      async ({ question, sent, shown }) => {
        const { conversationRequests } = installServer(question);
        const link = await openOnSecondAssistant(path, question);
        const href = link.getAttribute("href") ?? "";
        // Short enough for any server or proxy on the way to load.
        expect(href.length).toBeLessThan(2_000);
        const params = new URL(href, "https://example.com").searchParams;
        expect(params.get("assistant")).toBe(SECOND.id);
        // The grouped question itself (or its start): not a search for its words.
        expect(params.get("question")).toBe(sent);
        expect(params.has("q")).toBe(false);
        expect(params.has("days")).toBe(false);
        expect(params.get("askedFrom")).toBe(asked?.askedFrom ?? null);
        expect(params.get("askedTo")).toBe(asked?.askedTo ?? null);

        conversationRequests.length = 0;
        await openInNewTab(href);

        expect(await screen.findByText(`A question asked of ${SECOND.id}`)).toBeTruthy();
        expect(selectedAssistantId()).toBe(SECOND.id);
        expect((screen.getByLabelText("Search conversations") as HTMLInputElement).value).toBe("");
        expect(screen.getByText(`Asked: “${shown}”${period}`)).toBeTruthy();
        expect(screen.queryByText("Could not load conversations.")).toBeNull();
        expect(conversationRequests).toContainEqual({
          assistantId: SECOND.id,
          q: null,
          question: sent,
          ...(asked ?? {}),
        });
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
