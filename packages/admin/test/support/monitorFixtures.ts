import type {
  AssistantOverview,
  ConversationDetail,
  ConversationSummary,
  GapSummary,
} from "../../src/api/types.js";

/**
 * Realistic Monitor-screen data for the browser layout test: long questions,
 * every badge and every Overview block, so wrapping and contrast are checked
 * on the busiest version of each screen.
 */

const HOUR = 3_600_000;

export function monitorOverview(now: number): AssistantOverview {
  const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
  return {
    messages: 120,
    answeredShare: 0.82,
    todayCostMicros: 41_000,
    dailyCostCapMicros: 2_000_000,
    configError: null,
    topQuestions: [
      {
        question: "how do i install the widget on a single-page app with client-side routing?",
        count: 14,
      },
      { question: "do you ship to spain?", count: 9 },
      { question: "what is the refund policy?", count: 6 },
    ],
    period: {
      days: 7,
      from: day(6),
      to: day(0),
      questions: 48,
      replies: 48,
      answeredShare: 0.79,
      thumbsDownShare: 0.06,
      costMicros: 182_000,
      previous: {
        from: day(13),
        to: day(7),
        questions: 37,
        replies: 37,
        answeredShare: 0.84,
        thumbsDownShare: 0.08,
        costMicros: 141_000,
      },
    },
    daily: [3, 9, 6, 11, 4, 8, 7].map((questions, i) => ({ day: day(6 - i), questions })),
    setup: {
      hasContent: true,
      tried: true,
      published: true,
      installed: false,
      visitorQuestion: false,
    },
    attention: {
      openGaps: 5,
      failingTests: 1,
      notIndexed: [{ sourceId: "src_1", label: "Help centre", documents: 3 }],
    },
  };
}

export function monitorConversations(now: number): ConversationSummary[] {
  const base = {
    assistantId: "ast_1",
    visitorId: "vis_1",
    pageUrl: "https://docs.example.com/pricing",
    hasUnanswered: false,
    hasNotHelpful: false,
    usedTool: false,
  };
  return [
    {
      ...base,
      id: "cnv_1",
      startedAt: now - 2 * HOUR,
      lastMessageAt: now - 2 * HOUR,
      firstQuestion: "Do you ship to Spain, and how long does delivery to the Canary Islands take?",
      turnCount: 4,
      hasUnanswered: true,
      hasNotHelpful: true,
    },
    {
      ...base,
      id: "cnv_2",
      startedAt: now - 5 * HOUR,
      lastMessageAt: now - 5 * HOUR,
      firstQuestion: "Where is my order #4821?",
      turnCount: 2,
      usedTool: true,
    },
    {
      ...base,
      id: "cnv_3",
      startedAt: now - 26 * HOUR,
      lastMessageAt: now - 26 * HOUR,
      firstQuestion: "How do I reset my password?",
      turnCount: 2,
    },
  ];
}

export function monitorConversationDetail(now: number): ConversationDetail {
  const start = now - 2 * HOUR;
  return {
    conversation: {
      id: "cnv_1",
      assistantId: "ast_1",
      visitorId: "vis_1",
      startedAt: start,
      pageUrl: "https://docs.example.com/shipping",
    },
    turns: [
      {
        id: "msg_q1",
        role: "user",
        content: "Do you ship to Spain, and how long does delivery to the Canary Islands take?",
        citations: [],
        answered: true,
        createdAt: start,
        feedback: [],
        answerDocumentId: null,
        replyTo: null,
      },
      {
        id: "msg_a1",
        role: "assistant",
        content:
          "I could not find that in the help centre. You can ask our team at support@example.com.",
        citations: [],
        answered: false,
        createdAt: start + 4_000,
        feedback: [{ id: "fbk_1", value: "down", note: "", createdAt: start + 9_000 }],
        answerDocumentId: null,
        replyTo: "msg_q1",
      },
      {
        id: "msg_q2",
        role: "user",
        content: "What about returns?",
        citations: [],
        answered: true,
        createdAt: start + 60_000,
        feedback: [],
        answerDocumentId: null,
        replyTo: null,
      },
      {
        id: "msg_a2",
        role: "assistant",
        content: "Returns are free within 30 days. Start one from your order page.",
        citations: [
          { url: "https://docs.example.com/returns", title: "Returns and refunds" },
          { url: "https://docs.example.com/orders", title: "Managing your orders" },
        ],
        answered: true,
        createdAt: start + 63_000,
        feedback: [],
        answerDocumentId: null,
        replyTo: "msg_q2",
      },
    ],
  };
}

export function monitorGaps(now: number): GapSummary[] {
  return [
    {
      question: "do you ship to spain?",
      displayQuestion: "Do you ship to Spain?",
      times: 9,
      lastAsked: now - 2 * HOUR,
      exampleMessageId: "msg_q1",
      handled: false,
      documentId: null,
    },
    {
      question: "can i pay with an invoice instead of a credit card for the annual business plan?",
      displayQuestion:
        "Can I pay with an invoice instead of a credit card for the annual Business plan?",
      times: 4,
      lastAsked: now - 30 * HOUR,
      exampleMessageId: "msg_q5",
      handled: false,
      documentId: null,
    },
    {
      question: "is there a dark mode?",
      displayQuestion: "Is there a dark mode?",
      times: 1,
      lastAsked: now - 72 * HOUR,
      exampleMessageId: "msg_q9",
      handled: false,
      documentId: null,
    },
  ];
}
