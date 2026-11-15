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
  onAnswerPost?: (body: {
    question: string;
    answer: string;
    fromMessageId: string;
  }) => Promise<Response> | Response;
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
            replyTo: null,
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
            replyTo: "msg_u1",
          },
        ],
      };
      return Response.json(detail);
    }

    if (path === `/api/admin/assistants/${assistant.id}/gaps` && method === "GET") {
      const parsed = new URL(url, "https://example.com");
      const rawLimit = Number(parsed.searchParams.get("limit") ?? 50);
      const rawOffset = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(1, Math.trunc(rawLimit)), 100)
        : 50;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
      return Response.json({
        gaps: gaps.slice(offset, offset + limit),
        total: gaps.length,
        limit,
        offset,
      });
    }

    if (path === `/api/admin/assistants/${assistant.id}/answers` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        question: string;
        answer: string;
        fromMessageId: string;
      };
      answerPosts.push(body);
      const response = options?.onAnswerPost
        ? await options.onAnswerPost(body)
        : Response.json(
            {
              documentId: "doc_saved_1",
              sourceId: "src_entry_1",
              url: "https://example.com/admin/sources#entry:1",
              counts: { written: 1, unchanged: 0, deleted: 0 },
            },
            { status: 201 },
          );
      if (response.ok) {
        for (const gap of gaps) {
          if (gap.exampleMessageId === body.fromMessageId) {
            gap.handled = true;
            gap.documentId = "doc_saved_1";
          }
        }
      }
      return response;
    }

    if (path === "/api/admin/assistants" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        name: string;
        allowedOrigins?: string[];
      };
      const created: Assistant = {
        id: "ast_created",
        orgId: assistant.orgId,
        name: body.name,
        publicKey: "pk_created",
        allowedOrigins: body.allowedOrigins ?? [],
        hasIngestKey: true,
        createdAt: 1_700_000_000_001,
      };
      return Response.json({ assistant: created, ingestKey: "ik_created_once" }, { status: 201 });
    }

    if (path === `/api/admin/assistants/${assistant.id}/ingest-key` && method === "POST") {
      return Response.json({ ingestKey: "ik_rotated_once" });
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
    expect(screen.getByText("Estimated cost so far today.")).toBeTruthy();
    expect(screen.getByText("how much does it cost?")).toBeTruthy();
    expect(screen.getByText("7 times")).toBeTruthy();
  });

  it("renders configuration error and unknown-cost spend cap warning on Overview", async () => {
    installFakeServer({
      overview: {
        messages: 5,
        answeredShare: 0.8,
        topQuestions: [],
        todayCostMicros: 0,
        todayCostUnknown: true,
        dailyCostCapMicros: 2_000_000,
        configError: "OpenRouter is selected, but SOLV_LLM_MODEL is not set.",
      },
    });
    render(<App />);

    expect(
      await screen.findByText("OpenRouter is selected, but SOLV_LLM_MODEL is not set."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Estimated cost so far today\. Daily spend cap: \$2\.00\./),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Cost is not being reported for this model, so the daily spend cap cannot protect this instance.",
      ),
    ).toBeTruthy();
  });

  it("formats cost and daily spend cap in credits when costUnit is credits", async () => {
    installFakeServer({
      overview: {
        messages: 10,
        answeredShare: 0.9,
        topQuestions: [],
        todayCostMicros: 20_000,
        dailyCostCapMicros: 2_000_000,
        costUnit: "credits",
      },
    });
    render(<App />);

    expect(await screen.findByText("0.02 credits")).toBeTruthy();
    expect(
      screen.getByText("Estimated cost so far today. Daily spend cap: 2.00 credits."),
    ).toBeTruthy();
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
              replyTo: null,
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
              replyTo: "msg_q_sla",
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
      // The reply's id: the engine links through the question it records.
      fromMessageId: "msg_a_sla",
    });
  });

  it("links Write the right answer to the question the reply answered when two requests interleave", async () => {
    // Both questions were stored before the first reply arrived, so the
    // nearest preceding question of the unanswered reply is the other one.
    const server = installFakeServer({
      conversations: [
        {
          id: "cnv_interleaved",
          assistantId: "ast_1",
          visitorId: "vis_1",
          startedAt: 1_700_000_200_000,
          pageUrl: "https://docs.example.com",
          firstQuestion: "Do you ship to Spain?",
          turnCount: 4,
          hasUnanswered: true,
        },
      ],
      conversationDetails: {
        cnv_interleaved: {
          conversation: {
            id: "cnv_interleaved",
            assistantId: "ast_1",
            visitorId: "vis_1",
            startedAt: 1_700_000_200_000,
            pageUrl: "https://docs.example.com",
          },
          turns: [
            {
              id: "msg_q_ship",
              role: "user",
              content: "Do you ship to Spain?",
              citations: [],
              answered: true,
              createdAt: 1_700_000_201_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: null,
            },
            {
              id: "msg_q_sso",
              role: "user",
              content: "Do you support SSO?",
              citations: [],
              answered: true,
              createdAt: 1_700_000_202_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: null,
            },
            {
              id: "msg_a_ship",
              role: "assistant",
              content: "I could not find an answer.",
              citations: [],
              answered: false,
              createdAt: 1_700_000_203_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: "msg_q_ship",
            },
            {
              id: "msg_a_sso",
              role: "assistant",
              content: "Yes, on Business plans.",
              citations: [],
              answered: true,
              createdAt: 1_700_000_204_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: "msg_q_sso",
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
    expect(questionInput.value).toBe("Do you ship to Spain?");

    fireEvent.change(screen.getByLabelText("Answer"), {
      target: { value: "Yes, within five working days." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));

    await waitFor(() => expect(server.answerPosts).toHaveLength(1));
    expect(server.answerPosts[0]).toEqual({
      question: "Do you ship to Spain?",
      answer: "Yes, within five working days.",
      fromMessageId: "msg_a_ship",
    });
  });

  it("preserves a newer gap draft when an earlier gap save completes", async () => {
    let resolveFirstSave!: (res: Response) => void;
    const firstSavePromise = new Promise<Response>((resolve) => {
      resolveFirstSave = resolve;
    });

    const gaps: GapSummary[] = [
      {
        question: "do you ship to spain?",
        displayQuestion: "Do you ship to Spain?",
        times: 3,
        lastAsked: 1_700_000_500_000,
        exampleMessageId: "msg_gap_a",
        handled: false,
        documentId: null,
      },
      {
        question: "do you support sso?",
        displayQuestion: "Do you support SSO?",
        times: 2,
        lastAsked: 1_700_000_400_000,
        exampleMessageId: "msg_gap_b",
        handled: false,
        documentId: null,
      },
    ];

    const server = installFakeServer({
      gaps,
      onAnswerPost: async (body) => {
        if (body.fromMessageId === "msg_gap_a") {
          return firstSavePromise;
        }
        return Response.json(
          {
            documentId: "doc_saved_b",
            sourceId: "src_entry_1",
            url: "https://example.com/admin/sources#entry:2",
            counts: { written: 1, unchanged: 0, deleted: 0 },
          },
          { status: 201 },
        );
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Gaps" }));
    expect(await screen.findByText("Do you ship to Spain?")).toBeTruthy();

    const [writeA, writeB] = screen.getAllByRole("button", { name: "Write the right answer" });
    expect(writeA).toBeDefined();
    expect(writeB).toBeDefined();
    if (!writeA || !writeB) return;

    fireEvent.click(writeA);
    fireEvent.change(await screen.findByLabelText("Answer"), {
      target: { value: "Yes, we ship to Spain." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(server.answerPosts).toHaveLength(1));

    // While A's save is still pending, switch to gap B and type a draft.
    fireEvent.click(writeB);
    const questionInput = (await screen.findByLabelText("Question")) as HTMLInputElement;
    expect(questionInput.value).toBe("Do you support SSO?");
    const answerInput = screen.getByLabelText("Answer") as HTMLTextAreaElement;
    fireEvent.change(answerInput, {
      target: { value: "Yes, SAML SSO is on Business plans." },
    });

    // Complete A's save.
    resolveFirstSave(
      Response.json(
        {
          documentId: "doc_saved_a",
          sourceId: "src_entry_1",
          url: "https://example.com/admin/sources#entry:1",
          counts: { written: 1, unchanged: 0, deleted: 0 },
        },
        { status: 201 },
      ),
    );

    // Gap A is marked handled on reload, while B's editor and draft remain intact.
    expect(await screen.findByText("Handled")).toBeTruthy();
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe(
      "Do you support SSO?",
    );
    expect((screen.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(
      "Yes, SAML SSO is on Business plans.",
    );
  });

  it("preserves a newer conversation turn draft when an earlier turn save completes", async () => {
    let resolveFirstSave!: (res: Response) => void;
    const firstSavePromise = new Promise<Response>((resolve) => {
      resolveFirstSave = resolve;
    });

    const server = installFakeServer({
      conversations: [
        {
          id: "cnv_two",
          assistantId: "ast_1",
          visitorId: "vis_1",
          startedAt: 1_700_000_100_000,
          pageUrl: "https://docs.example.com",
          firstQuestion: "Question one?",
          turnCount: 4,
          hasUnanswered: true,
        },
      ],
      conversationDetails: {
        cnv_two: {
          conversation: {
            id: "cnv_two",
            assistantId: "ast_1",
            visitorId: "vis_1",
            startedAt: 1_700_000_100_000,
            pageUrl: "https://docs.example.com",
          },
          turns: [
            {
              id: "msg_q_1",
              role: "user",
              content: "Question one?",
              citations: [],
              answered: true,
              createdAt: 1_700_000_101_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: null,
            },
            {
              id: "msg_a_1",
              role: "assistant",
              content: "I could not find an answer.",
              citations: [],
              answered: false,
              createdAt: 1_700_000_102_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: "msg_q_1",
            },
            {
              id: "msg_q_2",
              role: "user",
              content: "Question two?",
              citations: [],
              answered: true,
              createdAt: 1_700_000_103_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: null,
            },
            {
              id: "msg_a_2",
              role: "assistant",
              content: "I could not find an answer.",
              citations: [],
              answered: false,
              createdAt: 1_700_000_104_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: "msg_q_2",
            },
          ],
        },
      },
      onAnswerPost: async (body) => {
        if (body.fromMessageId === "msg_a_1") {
          return firstSavePromise;
        }
        return Response.json(
          {
            documentId: "doc_saved_2",
            sourceId: "src_entry_1",
            url: "https://example.com/admin/sources#entry:2",
            counts: { written: 1, unchanged: 0, deleted: 0 },
          },
          { status: 201 },
        );
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    const [writeFirst, writeSecond] = await screen.findAllByRole("button", {
      name: "Write the right answer",
    });
    expect(writeFirst).toBeDefined();
    expect(writeSecond).toBeDefined();
    if (!writeFirst || !writeSecond) return;

    fireEvent.click(writeFirst);
    fireEvent.change(await screen.findByLabelText("Answer"), {
      target: { value: "Answer one." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(server.answerPosts).toHaveLength(1));

    // Switch to turn 2 while turn 1's save is in flight and type a draft.
    fireEvent.click(writeSecond);
    const questionInput = (await screen.findByLabelText("Question")) as HTMLInputElement;
    expect(questionInput.value).toBe("Question two?");
    fireEvent.change(screen.getByLabelText("Answer"), {
      target: { value: "Draft answer two." },
    });

    resolveFirstSave(
      Response.json(
        {
          documentId: "doc_saved_1",
          sourceId: "src_entry_1",
          url: "https://example.com/admin/sources#entry:1",
          counts: { written: 1, unchanged: 0, deleted: 0 },
        },
        { status: 201 },
      ),
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(
        "Draft answer two.",
      ),
    );
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Question two?");
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
      "Reports",
      "Conversations",
      "Gaps",
      "Sources",
      "Tools",
      "Behaviour",
      "Widget",
      "Install",
    ]);
    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/admin\//);
    }
  });

  it("paginates Gaps so unresolved questions beyond the first 100 are reachable", async () => {
    const manyGaps: GapSummary[] = Array.from({ length: 101 }, (_, i) => ({
      question: i < 100 ? `handled question ${i + 1}?` : "unresolved 101st question?",
      displayQuestion: i < 100 ? `Handled question ${i + 1}?` : "Unresolved 101st question?",
      times: i < 100 ? 2 : 1,
      lastAsked: 1_700_000_000_000 + i,
      exampleMessageId: `msg_gap_${i + 1}`,
      handled: i < 100,
      documentId: i < 100 ? `doc_${i + 1}` : null,
    }));

    installFakeServer({ gaps: manyGaps });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Gaps" }));
    expect(await screen.findByText("Handled question 1?")).toBeTruthy();
    expect(screen.queryByText("Unresolved 101st question?")).toBeNull();

    // Advance 4 pages (25 per page): offset 0 -> 25 -> 50 -> 75 -> 100.
    for (let page = 0; page < 4; page++) {
      const nextButton = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
      expect(nextButton.disabled).toBe(false);
      fireEvent.click(nextButton);
      await waitFor(() =>
        expect(screen.getByText(`Handled question ${(page + 1) * 25 + 1}?`)).toBeTruthy(),
      ).catch(() => undefined);
    }

    expect(await screen.findByText("Unresolved 101st question?")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("shows the one-time ingest key and assistant ID when creating an assistant", async () => {
    installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "New assistant" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Create assistant" }));

    expect(await screen.findByText(/Copy your ingest key now/)).toBeTruthy();
    expect((screen.getByLabelText("Assistant ID") as HTMLInputElement).value).toBe("ast_created");
    expect((screen.getByLabelText("Ingest key") as HTMLInputElement).value).toBe("ik_created_once");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/Copy your ingest key now/)).toBeNull();
  });

  it("rotates the ingest key on the Install screen and displays it once", async () => {
    installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Install" }));
    expect(((await screen.findByLabelText("Assistant ID")) as HTMLInputElement).value).toBe(
      "ast_1",
    );

    fireEvent.click(screen.getByRole("button", { name: "Rotate ingest key" }));
    expect(await screen.findByText(/previous key stopped working immediately/)).toBeTruthy();
    expect((screen.getByLabelText("New ingest key") as HTMLInputElement).value).toBe(
      "ik_rotated_once",
    );
  });

  it("renders action and tool call rows with names and outcomes on Conversation", async () => {
    installFakeServer({
      conversationDetails: {
        cnv_1: {
          conversation: {
            id: "cnv_1",
            assistantId: "ast_1",
            visitorId: "vis_1",
            startedAt: 1_700_000_100_000,
            pageUrl: "https://docs.example.com/pricing",
          },
          turns: [
            {
              id: "msg_q1",
              role: "user",
              content: "Open my invoice please",
              citations: [],
              answered: true,
              createdAt: 1_700_000_100_000,
              feedback: [],
              answerDocumentId: null,
              replyTo: null,
            },
            {
              id: "msg_a1",
              role: "assistant",
              content: "I tried to open your invoice.",
              citations: [],
              toolCalls: [
                { callId: "c1", name: "lookup_order", kind: "mcp", ok: true },
                { callId: "c2", name: "navigate", kind: "action", ok: false },
              ],
              answered: true,
              createdAt: 1_700_000_100_500,
              feedback: [],
              answerDocumentId: null,
              replyTo: "msg_q1",
            },
          ],
        },
      },
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    const list = await screen.findByRole("list", { name: "What the assistant did" });
    expect(list.textContent).toContain("Tool: lookup_order");
    expect(list.textContent).toContain("On the page: navigate — did not work");
  });
});
