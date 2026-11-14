import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type {
  Assistant,
  AssistantOverview,
  ConversationDetail,
  ConversationSummary,
  GapSummary,
  InstallInfo,
} from "../src/api/types.js";

function makeAssistant(allowedOrigins: string[] = []): Assistant {
  return {
    id: "ast_1",
    orgId: "org_00000000000000000000",
    name: "Docs Bot",
    publicKey: "pk_ast_1",
    allowedOrigins,
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

function installFakeServer(options?: {
  allowedOrigins?: string[];
  overview?: AssistantOverview;
  conversations?: ConversationSummary[];
  conversationDetails?: Record<string, ConversationDetail>;
  gaps?: GapSummary[];
}) {
  const assistant = makeAssistant(options?.allowedOrigins ?? []);
  const gaps: GapSummary[] = options?.gaps
    ? options.gaps.map((g) => ({ ...g }))
    : [
        {
          question: "do you ship to spain?",
          displayQuestion: "Do you ship to Spain?",
          times: 3,
          lastAsked: 1_700_000_500_000,
          exampleMessageId: "msg_gap_1",
          handled: false,
          documentId: null,
        },
      ];

  const answerPosts: Array<{ question: string; answer: string; fromMessageId: string }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/overview` && method === "GET") {
      return Response.json(
        options?.overview ?? {
          messages: 24,
          answeredShare: 0.75,
          topQuestions: [{ question: "pricing?", count: 5 }],
          todayCostMicros: 15_000,
        },
      );
    }

    if (path === `/api/admin/assistants/${assistant.id}/conversations` && method === "GET") {
      const list = options?.conversations ?? [
        {
          id: "cnv_1",
          assistantId: assistant.id,
          visitorId: "vis_1",
          startedAt: 1_700_000_100_000,
          pageUrl: "https://docs.example.com/pricing",
          firstQuestion: "How do I start?",
          turnCount: 2,
          hasUnanswered: false,
        },
      ];
      return Response.json({
        conversations: list,
        total: list.length,
        limit: 25,
        offset: 0,
      });
    }

    const convMatch = /^\/api\/admin\/conversations\/([^/]+)$/.exec(path);
    if (convMatch?.[1] && method === "GET") {
      const detail = options?.conversationDetails?.[convMatch[1]] ?? {
        conversation: {
          id: convMatch[1],
          assistantId: assistant.id,
          visitorId: "vis_1",
          startedAt: 1_700_000_100_000,
          pageUrl: "https://docs.example.com/pricing",
        },
        turns: [
          {
            id: "msg_u1",
            role: "user",
            content: "How do I start?",
            citations: [],
            answered: true,
            createdAt: 1_700_000_101_000,
            feedback: [],
            answerDocumentId: null,
          },
          {
            id: "msg_a1",
            role: "assistant",
            content: "Read the quickstart guide.",
            citations: [{ url: "https://docs.example.com/quickstart", title: "Quickstart" }],
            answered: true,
            createdAt: 1_700_000_102_000,
            feedback: [
              { id: "fbk_1", value: "up", note: "Helpful!", createdAt: 1_700_000_103_000 },
            ],
            answerDocumentId: null,
          },
        ],
      };
      return Response.json(detail);
    }

    if (path === `/api/admin/assistants/${assistant.id}/gaps` && method === "GET") {
      return Response.json({ gaps });
    }

    if (path === `/api/admin/assistants/${assistant.id}/answers` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        question: string;
        answer: string;
        fromMessageId: string;
      };
      answerPosts.push(body);
      for (const gap of gaps) {
        if (gap.exampleMessageId === body.fromMessageId) {
          gap.handled = true;
          gap.documentId = "doc_saved_1";
        }
      }
      return Response.json(
        {
          documentId: "doc_saved_1",
          sourceId: "src_entry_1",
          url: "https://example.com/admin/sources#entry:1",
          counts: { written: 1, unchanged: 0, deleted: 0 },
        },
        { status: 201 },
      );
    }

    if (path === `/api/admin/assistants/${assistant.id}/install` && method === "GET") {
      const info: InstallInfo = {
        assistantId: assistant.id,
        publicKey: assistant.publicKey,
        allowedOrigins: assistant.allowedOrigins,
        snippet: `<script src="https://example.com/widget.js" defer></script>\n<solv-chat assistant="${assistant.publicKey}"></solv-chat>`,
      };
      return Response.json(info);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { answerPosts };
}

describe("admin phase 1 screens", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it("renders Overview with each number and its plain explanation", async () => {
    installFakeServer({
      overview: {
        messages: 42,
        answeredShare: 0.75,
        topQuestions: [{ question: "how much does it cost?", count: 7 }],
        todayCostMicros: 20_000,
      },
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("Total questions and replies across all conversations.")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(
      screen.getByText("Share of questions your assistant could answer from your content."),
    ).toBeTruthy();
    expect(screen.getByText("$0.02")).toBeTruthy();
    expect(screen.getByText("Estimated model cost so far today.")).toBeTruthy();
    expect(screen.getByText("how much does it cost?")).toBeTruthy();
    expect(screen.getByText("7 times")).toBeTruthy();
  });

  it("opens Gaps, pre-fills Write the right answer, saves, and marks the gap as handled", async () => {
    const server = installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Gaps" }));
    expect(await screen.findByText("Do you ship to Spain?")).toBeTruthy();
    expect(screen.getByText("Asked 3 times")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Write the right answer" }));

    const questionInput = (await screen.findByLabelText("Question")) as HTMLInputElement;
    expect(questionInput.value).toBe("Do you ship to Spain?");

    const answerInput = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    fireEvent.change(answerInput, { target: { value: "Yes, we ship to Spain in 3 days." } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));

    await waitFor(() => expect(server.answerPosts).toHaveLength(1));
    expect(server.answerPosts[0]).toEqual({
      question: "Do you ship to Spain?",
      answer: "Yes, we ship to Spain in 3 days.",
      fromMessageId: "msg_gap_1",
    });

    expect(await screen.findByText("Handled")).toBeTruthy();
  });

  it("renders Conversations, opens a conversation, and renders citations as links", async () => {
    installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    expect(await screen.findByText("How do I start?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Read the quickstart guide.")).toBeTruthy();

    const link = screen.getByRole("link", { name: "Quickstart" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://docs.example.com/quickstart");
    expect(screen.getByText("Helpful: Helpful!")).toBeTruthy();
  });

  it("allows Write the right answer from an unanswered turn in a conversation", async () => {
    const server = installFakeServer({
      conversations: [
        {
          id: "cnv_unans",
          assistantId: "ast_1",
          visitorId: "vis_1",
          startedAt: 1_700_000_100_000,
          pageUrl: "https://docs.example.com",
          firstQuestion: "Do you have an SLA?",
          turnCount: 2,
          hasUnanswered: true,
        },
      ],
      conversationDetails: {
        cnv_unans: {
          conversation: {
            id: "cnv_unans",
            assistantId: "ast_1",
            visitorId: "vis_1",
            startedAt: 1_700_000_100_000,
            pageUrl: "https://docs.example.com",
          },
          turns: [
            {
              id: "msg_q_sla",
              role: "user",
              content: "Do you have an SLA?",
              citations: [],
              answered: true,
              createdAt: 1_700_000_101_000,
              feedback: [],
              answerDocumentId: null,
            },
            {
              id: "msg_a_sla",
              role: "assistant",
              content: "I could not find an answer.",
              citations: [],
              answered: false,
              createdAt: 1_700_000_102_000,
              feedback: [],
              answerDocumentId: null,
            },
          ],
        },
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Write the right answer" }));

    const questionInput = (await screen.findByLabelText("Question")) as HTMLInputElement;
    expect(questionInput.value).toBe("Do you have an SLA?");

    fireEvent.change(screen.getByLabelText("Answer"), {
      target: { value: "99.9% uptime SLA on Business plans." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));

    await waitFor(() => expect(server.answerPosts).toHaveLength(1));
    expect(server.answerPosts[0]).toEqual({
      question: "Do you have an SLA?",
      answer: "99.9% uptime SLA on Business plans.",
      fromMessageId: "msg_a_sla",
    });
  });

  it("renders Install with the empty-origins warning and copies the snippet", async () => {
    installFakeServer({ allowedOrigins: [] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Install" }));

    expect(
      await screen.findByText(
        "Add your website address on the Widget screen first. Until you do, the chat will not answer anyone.",
      ),
    ).toBeTruthy();

    const snippetBox = screen.getByLabelText("Paste this into your site") as HTMLTextAreaElement;
    expect(snippetBox.value).toContain("pk_ast_1");
    expect(snippetBox.value).toContain("https://example.com/widget.js");

    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(snippetBox.value));
    expect(await screen.findByText("Copied.")).toBeTruthy();
  });

  it("keeps Tools and Tests out of navigation and exposes keyboard-reachable links", async () => {
    installFakeServer();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Conversations",
      "Gaps",
      "Sources",
      "Behaviour",
      "Widget",
      "Install",
    ]);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/admin\//);
    }
  });
});
