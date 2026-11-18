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
import { findAssistantButton, openNewAssistantForm } from "./support/switcher.js";

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

/** The first row in the Conversations list (each row is one link). */
async function findConversationRow(): Promise<HTMLElement> {
  await screen.findByText(/Showing 1/);
  const row = document.querySelector<HTMLElement>(".conv-row");
  if (!row) throw new Error("No conversation row");
  return row;
}

function makeOverview(overrides: Partial<AssistantOverview> = {}): AssistantOverview {
  return {
    topQuestions: [{ question: "pricing?", count: 5 }],
    todayCostMicros: 15_000,
    dailyCostCapMicros: 2_000_000,
    configError: null,
    period: {
      days: 7,
      from: "2026-11-10",
      to: "2026-11-16",
      questions: 12,
      replies: 12,
      answeredShare: 0.75,
      thumbsDownShare: 0.25,
      costMicros: 20_000,
      previous: {
        from: "2026-11-03",
        to: "2026-11-09",
        questions: 9,
        replies: 9,
        answeredShare: 0.8,
        thumbsDownShare: 0.25,
        costMicros: 10_000,
      },
    },
    daily: [
      { day: "2026-11-10", questions: 1 },
      { day: "2026-11-11", questions: 0 },
      { day: "2026-11-12", questions: 3 },
      { day: "2026-11-13", questions: 2 },
      { day: "2026-11-14", questions: 0 },
      { day: "2026-11-15", questions: 4 },
      { day: "2026-11-16", questions: 2 },
    ],
    setup: {
      hasContent: true,
      tried: true,
      published: true,
      installed: true,
      visitorQuestion: true,
    },
    attention: { openGaps: 0, failingTests: 0, notIndexed: [] },
    ...overrides,
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
  onTestPost?: () => Promise<void>;
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
  const testPosts: Array<{ question: string; expectation: unknown }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/overview` && method === "GET") {
      return Response.json(options?.overview ?? makeOverview());
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
      const listed =
        parsed.searchParams.get("status") === "open" ? gaps.filter((g) => !g.handled) : gaps;
      return Response.json({
        gaps: listed.slice(offset, offset + limit),
        total: listed.length,
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

    if (path === `/api/admin/assistants/${assistant.id}/tests` && method === "POST") {
      if (options?.onTestPost) await options.onTestPost();
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        question: string;
        expectation: unknown;
      };
      testPosts.push(body);
      return Response.json(
        {
          test: {
            id: `tst_${testPosts.length}`,
            orgId: assistant.orgId,
            assistantId: assistant.id,
            question: body.question,
            expectation: body.expectation,
            createdAt: 1_700_000_000_000,
          },
        },
        { status: 201 },
      );
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { answerPosts, testPosts };
}

describe("admin phase 1 screens", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it("renders Overview's four period figures, with the change against the previous 7 days", async () => {
    installFakeServer({
      overview: makeOverview({
        topQuestions: [{ question: "how much does it cost?", count: 7 }],
        todayCostMicros: 20_000,
      }),
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(
      await screen.findByText(
        "Last 7 days, 10 Nov 2026 to 16 Nov 2026, compared with the 7 days before.",
      ),
    ).toBeTruthy();
    // The same four figures, with the same names, as Reports.
    const asked = screen.getByRole("region", { name: "Questions asked" });
    expect(asked.textContent).toContain("12");
    expect(asked.textContent).toContain("3 more than the 7 days before");
    const answered = screen.getByRole("region", { name: "Answered share" });
    expect(answered.textContent).toContain("75%");
    expect(answered.textContent).toContain("5 points lower than the 7 days before");
    const notHelpful = screen.getByRole("region", { name: "Marked not helpful" });
    expect(notHelpful.textContent).toContain("25%");
    expect(notHelpful.textContent).toContain("Same as the 7 days before");
    const cost = screen.getByRole("region", { name: "Cost" });
    expect(cost.textContent).toContain("$0.02");
    expect(cost.textContent).toContain("$0.01 in the 7 days before");
    expect(screen.getByText("Today so far: $0.02. Daily spend cap: $2.00.")).toBeTruthy();
    expect(screen.queryByText("Messages")).toBeNull();

    const topLink = screen.getByRole("link", { name: "how much does it cost?" });
    expect(topLink.getAttribute("href")).toBe(
      "/admin/conversations?question=how+much+does+it+cost%3F&assistant=ast_1",
    );
    expect(screen.getByText("7 times")).toBeTruthy();
  });

  it("renders Overview's response time: the typical wait against the 7 days before", async () => {
    const week = {
      from: "2026-11-10",
      to: "2026-11-16",
      status: "measured" as const,
      answers: 12,
      timed: 12,
      firstTokenMedianMs: 1_900,
      firstTokenP90Ms: 4_000,
      totalMedianMs: 7_000,
    };
    installFakeServer({
      overview: makeOverview({
        responseTime: {
          ...week,
          days: 7,
          previous: { ...week, from: "2026-11-03", to: "2026-11-09", firstTokenMedianMs: 1_400 },
        },
      }),
    });
    render(<App />);

    const figure = await screen.findByRole("region", {
      name: "Time until the answer starts appearing",
    });
    expect(figure.textContent).toContain("1.9 s");
    expect(figure.textContent).toContain("0.5 s slower than the 7 days before");
    expect(figure.textContent).toContain("Try it and tests are not counted.");
  });

  it("says Overview's response time is not measured when most answers have no timing", async () => {
    const week = {
      from: "2026-11-10",
      to: "2026-11-16",
      status: "mostly_untimed" as const,
      answers: 12,
      timed: 2,
      firstTokenMedianMs: null,
      firstTokenP90Ms: null,
      totalMedianMs: null,
    };
    installFakeServer({
      overview: makeOverview({ responseTime: { ...week, days: 7, previous: week } }),
    });
    render(<App />);

    const figure = await screen.findByRole("region", {
      name: "Time until the answer starts appearing",
    });
    expect(figure.textContent).toContain("Not measured");
    expect(figure.textContent).toContain(
      "Most answers in this period are from before answer times",
    );
    expect(figure.querySelector(".stat-change")).toBeNull();
  });

  it("renders configuration error and unknown-cost spend cap warning on Overview", async () => {
    installFakeServer({
      overview: makeOverview({
        todayCostMicros: 0,
        todayCostUnknown: true,
        dailyCostCapMicros: 2_000_000,
        configError: "OpenRouter is selected, but SOLV_LLM_MODEL is not set.",
      }),
    });
    render(<App />);

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    expect(attention.textContent).toContain(
      "OpenRouter is selected, but SOLV_LLM_MODEL is not set.",
    );
    expect(screen.getByText("Today so far: $0.00. Daily spend cap: $2.00.")).toBeTruthy();
    expect(
      screen.getByText(
        "Cost is not being reported for this model, so the daily spend cap cannot protect this instance.",
      ),
    ).toBeTruthy();
  });

  it("formats cost and daily spend cap in credits when costUnit is credits", async () => {
    installFakeServer({
      overview: makeOverview({
        todayCostMicros: 20_000,
        dailyCostCapMicros: 2_000_000,
        costUnit: "credits",
      }),
    });
    render(<App />);

    expect(await screen.findByText("0.02 credits")).toBeTruthy();
    expect(
      screen.getByText("Today so far: 0.02 credits. Daily spend cap: 2.00 credits."),
    ).toBeTruthy();
  });

  it("opens Gaps, writes an answer inline, saves, and removes the gap", async () => {
    const server = installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Gaps" }));
    expect(await screen.findByText("Do you ship to Spain?")).toBeTruthy();
    expect(screen.getByText("Asked 3 times")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Write an answer" }));

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

    expect(
      await screen.findByText(
        "Answer saved to your sources. The assistant can use it once indexed.",
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No unanswered questions" })).toBeTruthy();
    expect(screen.queryByText("Do you ship to Spain?")).toBeNull();
  });

  it("renders Conversations, opens a conversation, and renders citations as links", async () => {
    installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    expect(await screen.findByText("How do I start?")).toBeTruthy();

    // The whole row is the link; there is no separate "Open" button.
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /How do I start\?/ }));
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
    fireEvent.click(await findConversationRow());
    fireEvent.click(await screen.findByRole("button", { name: "Write an answer for this" }));
    expect(await screen.findByRole("heading", { name: "Gaps" })).toBeTruthy();

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
    fireEvent.click(await findConversationRow());
    fireEvent.click(await screen.findByRole("button", { name: "Write an answer for this" }));
    expect(await screen.findByRole("heading", { name: "Gaps" })).toBeTruthy();

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

    const [writeA, writeB] = screen.getAllByRole("button", { name: "Write an answer" });
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

    // Gap A leaves the list on reload, while B's editor and draft remain intact.
    await waitFor(() => expect(screen.queryByText("Do you ship to Spain?")).toBeNull());
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe(
      "Do you support SSO?",
    );
    expect((screen.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(
      "Yes, SAML SSO is on Business plans.",
    );
  });

  it("keeps a newer turn's in-place answer draft when an earlier turn's save completes", async () => {
    let resolveFirstSave!: (res: Response) => void;
    const firstSave = new Promise<Response>((resolve) => {
      resolveFirstSave = resolve;
    });
    const saved = (n: number) =>
      Response.json(
        {
          documentId: `doc_saved_${n}`,
          sourceId: "src_entry_1",
          url: `https://example.com/admin/sources#entry:${n}`,
          counts: { written: 1, unchanged: 0, deleted: 0 },
        },
        { status: 201 },
      );
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
      onAnswerPost: (body) => (body.fromMessageId === "msg_a_1" ? firstSave : saved(2)),
    });
    // With Gaps hidden, the answer is written in place under its turn.
    render(<App options={{ hideScreens: ["gaps"] }} />);
    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    fireEvent.click(await findConversationRow());

    const [writeFirst, writeSecond] = await screen.findAllByRole("button", {
      name: "Write an answer for this",
    });
    if (!writeFirst || !writeSecond) throw new Error("Expected two unanswered turns");

    fireEvent.click(writeFirst);
    expect(((await screen.findByLabelText("Question")) as HTMLInputElement).value).toBe(
      "Question one?",
    );
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Answer one." } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(server.answerPosts).toHaveLength(1));

    // Turn 2's editor opens while turn 1's save is still running.
    fireEvent.click(writeSecond);
    await waitFor(() =>
      expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Question two?"),
    );
    fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Draft answer two." } });

    resolveFirstSave(saved(1));
    expect(await screen.findByText(/Answer saved to your sources/)).toBeTruthy();
    // Turn 1's save leaves turn 2's editor open, with its draft.
    expect(screen.getAllByLabelText("Answer")).toHaveLength(1);
    expect((screen.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(
      "Draft answer two.",
    );
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Question two?");

    // And it saves on its own turn.
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(server.answerPosts).toHaveLength(2));
    expect(server.answerPosts[1]).toEqual({
      question: "Question two?",
      answer: "Draft answer two.",
      fromMessageId: "msg_a_2",
    });
    await waitFor(() => expect(screen.queryByLabelText("Answer")).toBeNull());
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

    const snippetBox = screen.getByLabelText(
      "Paste this into your site, once per page that should show the chat.",
    ) as HTMLTextAreaElement;
    expect(snippetBox.value).toContain("pk_ast_1");
    expect(snippetBox.value).toContain("https://example.com/widget.js");

    fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(snippetBox.value));
    expect(await screen.findByText("Copied.")).toBeTruthy();
  });

  it("exposes all nine navigation items in order and keyboard-reachable links", async () => {
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
      "Behaviour",
      "Tools",
      "Widget",
      "Tests",
      "Install",
      "Providers",
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
      handled: false,
      documentId: null,
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

    await findAssistantButton();
    openNewAssistantForm();
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
    const developers = (await screen.findByText("For developers")).closest("details");
    if (!developers) throw new Error("no For developers section");
    expect(developers.open).toBe(false);
    developers.open = true;
    expect(((await screen.findByLabelText("Assistant ID")) as HTMLInputElement).value).toBe(
      "ast_1",
    );

    // Rotating breaks the old key, so it asks first.
    fireEvent.click(screen.getByRole("button", { name: "Rotate ingest key" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
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
    fireEvent.click(await findConversationRow());

    const list = await screen.findByRole("list", { name: "What the assistant did" });
    expect(list.textContent).toContain("Tool: lookup_order");
    expect(list.textContent).toContain("On the page: navigate — did not work");
  });

  it("adds a test from a conversation turn pre-filled with the visitor's question", async () => {
    const server = installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    fireEvent.click(await findConversationRow());
    fireEvent.click(await screen.findByRole("button", { name: "Add to tests" }));

    const questionInput = screen.getByLabelText("Question") as HTMLInputElement;
    expect(questionInput.value).toBe("How do I start?");

    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "Sign up" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    expect(await screen.findByText("Added to tests.")).toBeTruthy();
    expect(server.testPosts).toEqual([
      { question: "How do I start?", expectation: { kind: "contains", phrase: "Sign up" } },
    ]);
  });

  it("adds a test from a gap pre-filled with the gap's question", async () => {
    const server = installFakeServer();
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Gaps" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to tests" }));

    const questionInput = screen.getByLabelText("Question") as HTMLInputElement;
    expect(questionInput.value).toBe("Do you ship to Spain?");

    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "Spain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    expect(await screen.findByText("Added to tests.")).toBeTruthy();
    expect(server.testPosts).toEqual([
      { question: "Do you ship to Spain?", expectation: { kind: "contains", phrase: "Spain" } },
    ]);
  });

  it("does not close a newer gap test editor when an earlier gap test save finishes", async () => {
    let resolveFirst!: () => void;
    const firstPost = new Promise<void>((res) => {
      resolveFirst = res;
    });
    let postCount = 0;
    installFakeServer({
      gaps: [
        {
          question: "gap a?",
          displayQuestion: "Gap A?",
          times: 2,
          lastAsked: 1_700_000_500_000,
          exampleMessageId: "msg_gap_a",
          handled: false,
          documentId: null,
        },
        {
          question: "gap b?",
          displayQuestion: "Gap B?",
          times: 1,
          lastAsked: 1_700_000_400_000,
          exampleMessageId: "msg_gap_b",
          handled: false,
          documentId: null,
        },
      ],
      onTestPost: async () => {
        postCount++;
        if (postCount === 1) await firstPost;
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Gaps" }));
    const [addA, addB] = await screen.findAllByRole("button", { name: "Add to tests" });
    if (!addA || !addB) throw new Error("Expected Add to tests buttons for both gaps");
    fireEvent.click(addA);
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    // While Gap A's save is in flight, switch to Gap B and type an expectation.
    fireEvent.click(addB);
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Gap B?");
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "Beta draft" } });

    resolveFirst();
    expect(await screen.findByText("Added to tests.")).toBeTruthy();
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Gap B?");
    expect((screen.getByLabelText("Words") as HTMLInputElement).value).toBe("Beta draft");
  });

  it("does not close a newer conversation test editor when an earlier save finishes", async () => {
    let resolveFirst!: () => void;
    const firstPost = new Promise<void>((res) => {
      resolveFirst = res;
    });
    let postCount = 0;
    installFakeServer({
      conversationDetails: {
        cnv_1: {
          conversation: {
            id: "cnv_1",
            assistantId: "ast_1",
            visitorId: "vis_1",
            startedAt: 1_700_000_100_000,
            pageUrl: "https://example.com/pricing",
          },
          turns: [
            {
              id: "msg_u1",
              role: "user",
              content: "First question?",
              citations: [],
              answered: true,
              replyTo: null,
              answerDocumentId: null,
              createdAt: 1_700_000_100_000,
              feedback: [],
            },
            {
              id: "msg_a1",
              role: "assistant",
              content: "First reply.",
              citations: [],
              answered: true,
              replyTo: "msg_u1",
              answerDocumentId: null,
              createdAt: 1_700_000_101_000,
              feedback: [],
            },
            {
              id: "msg_u2",
              role: "user",
              content: "Second question?",
              citations: [],
              answered: true,
              replyTo: null,
              answerDocumentId: null,
              createdAt: 1_700_000_102_000,
              feedback: [],
            },
            {
              id: "msg_a2",
              role: "assistant",
              content: "Second reply.",
              citations: [],
              answered: true,
              replyTo: "msg_u2",
              answerDocumentId: null,
              createdAt: 1_700_000_103_000,
              feedback: [],
            },
          ],
        },
      },
      onTestPost: async () => {
        postCount++;
        if (postCount === 1) await firstPost;
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Conversations" }));
    fireEvent.click(await findConversationRow());
    const [addFirst, addSecond] = await screen.findAllByRole("button", { name: "Add to tests" });
    if (!addFirst || !addSecond) throw new Error("Expected Add to tests buttons for both turns");
    fireEvent.click(addFirst);
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    // While first turn's save is in flight, switch to second turn and type an expectation.
    fireEvent.click(addSecond);
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Second question?");
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "Second draft" } });

    resolveFirst();
    expect(await screen.findByText("Added to tests.")).toBeTruthy();
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Second question?");
    expect((screen.getByLabelText("Words") as HTMLInputElement).value).toBe("Second draft");
  });
});
