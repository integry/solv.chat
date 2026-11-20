import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnswerTrace,
  AnswerTracePart,
  Assistant,
  ConversationDetail,
} from "../src/api/types.js";
import { AnswerTrace as AnswerTraceView, formatMs } from "../src/screens/AnswerTrace.js";
import { Conversation } from "../src/screens/Conversation.js";
import { TryItPane } from "../src/shell/TryItPane.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

const DETAIL: ConversationDetail = {
  conversation: {
    id: "cnv_1",
    assistantId: "ast_1",
    visitorId: "vis_1",
    startedAt: 1_763_300_000_000,
    pageUrl: "https://site.example/docs",
  },
  turns: [
    {
      id: "msg_q",
      role: "user",
      content: "How does billing work?",
      citations: [],
      toolCalls: null,
      answered: true,
      createdAt: 1_763_300_000_000,
      feedback: [],
      answerDocumentId: null,
      replyTo: null,
    },
    {
      id: "msg_a",
      role: "assistant",
      content: "Invoices go out monthly.",
      citations: [],
      toolCalls: null,
      answered: true,
      createdAt: 1_763_300_001_000,
      feedback: [],
      answerDocumentId: null,
      replyTo: "msg_q",
    },
  ],
};

function part(overrides: Partial<AnswerTracePart> = {}): AnswerTracePart {
  return {
    kind: "answer",
    stop: "complete",
    version: {
      id: "ver_1",
      state: "published",
      current: { state: "published", createdAt: 1_763_200_000_000, publishedAt: 1_763_200_000_000 },
    },
    model: { provider: "anthropic", id: "model-fast", keySource: "environment" },
    retrieval: {
      floor: 0.3,
      ms: 120,
      candidates: [
        {
          chunkId: "chk_1",
          score: 0.82,
          used: true,
          content: {
            documentId: "doc_1",
            title: "Billing",
            url: "https://site.example/billing",
            sourceKind: "push",
            headingPath: "Invoices",
            excerpt: "Invoices are sent monthly.",
          },
        },
        {
          chunkId: "chk_2",
          score: 0.12,
          used: false,
          dropped: "below_floor",
          content: {
            documentId: "doc_2",
            title: "Shipping",
            url: "https://site.example/shipping",
            sourceKind: "push",
            headingPath: "",
            excerpt: "Orders ship within a week.",
          },
        },
        { chunkId: "chk_3", score: 0.71, used: true, content: null },
      ],
    },
    timing: { firstTokenMs: 840, totalMs: 2400 },
    tools: { rounds: 1, ms: 450 },
    ...overrides,
  };
}

function trace(overrides: Partial<AnswerTrace> = {}): AnswerTrace {
  return {
    messageId: "msg_a",
    source: "visitor",
    tokensIn: 1200,
    tokensOut: 300,
    costMicros: 20_000,
    firstTokenMs: 840,
    totalMs: 2400,
    trace: { parts: [part()], truncated: false },
    ...overrides,
  };
}

function installServer(traceBody: () => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(raw, "https://example.com");
      calls.push(url.pathname);
      if (url.pathname === "/api/admin/conversations/cnv_1") return Response.json(DETAIL);
      if (url.pathname === "/api/admin/conversations/cnv_1/messages/msg_a/trace") {
        return traceBody();
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    }),
  );
  return calls;
}

async function openTrace(): Promise<HTMLDetailsElement> {
  const summary = await screen.findByText("How this answer was made");
  const details = summary.closest("details");
  if (!details) throw new Error("no disclosure");
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  return details;
}

describe("How this answer was made", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const DRAFT_PART = part({
    version: {
      id: "ver_draft",
      state: "draft",
      current: { state: "draft", createdAt: 1_763_200_000_000, publishedAt: null },
    },
  });

  it("offers how a Try it answer was made, read by its id from the assistant's preview traces", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(raw, "https://example.com");
        calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
        if (url.pathname === "/api/admin/chat") {
          const sse = [
            `event: token\ndata: ${JSON.stringify({ text: "Invoices go out monthly." })}\n\n`,
            `event: done\ndata: ${JSON.stringify({ messageId: "msg_try", conversationId: "cnv_try" })}\n\n`,
          ].join("");
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        }
        if (url.pathname === "/api/admin/assistants/ast_1/preview-traces/msg_try") {
          return Response.json(
            trace({
              messageId: "msg_try",
              source: "try_it",
              trace: { parts: [DRAFT_PART], truncated: false },
            }),
          );
        }
        return Response.json({ error: "Not found." }, { status: 404 });
      }),
    );
    const assistant: Assistant = {
      id: "ast_1",
      orgId: "org_00000000000000000000",
      name: "Docs Bot",
      publicKey: "pk_ast_1",
      allowedOrigins: [],
      hasIngestKey: false,
      createdAt: 1_700_000_000_000,
    };
    render(<TryItPane assistant={assistant} />);
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "How does billing work?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Invoices go out monthly.");
    const details = await openTrace();
    await waitFor(() => expect(details.textContent).toContain("SettingsThe draft (Try it)"));
    expect(calls).toContain("GET /api/admin/assistants/ast_1/preview-traces/msg_try");
    expect(calls.some((c) => c.includes("/conversations/"))).toBe(false);
  });

  it("labels a test run's answer as the draft in a test run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          trace({
            messageId: "msg_test",
            source: "test_run",
            trace: { parts: [DRAFT_PART], truncated: false },
          }),
        ),
      ),
    );
    render(<AnswerTraceView assistantId="ast_1" messageId="msg_test" />);
    const details = await openTrace();
    await waitFor(() => expect(details.textContent).toContain("SettingsThe draft (test run)"));
  });

  it("is closed by default, on assistant replies only, and loads nothing until opened", async () => {
    const calls = installServer(() => Response.json(trace()));
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const summaries = await screen.findAllByText("How this answer was made");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.closest("details")?.open).toBe(false);
    expect(calls.some((path) => path.endsWith("/trace"))).toBe(false);
  });

  it("shows the content it was given, ranked, with scores and plain labels, and the facts", async () => {
    const calls = installServer(() => Response.json(trace()));
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    const view = within(details);

    const table = await view.findByRole("table", { name: /Content found for this question/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]?.textContent)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "Billing" })).toBeTruthy();
    expect(rows[0]?.textContent).toContain("0.82");
    expect(rows[0]?.textContent).toContain("Used");
    expect(rows[1]?.textContent).toContain("Not used: weak match");
    expect(rows[2]?.textContent).toContain("This content has since changed or been removed.");

    expect(view.getByText(/Published version from/)).toBeTruthy();
    const history = view.getByRole("link", { name: "See History" });
    expect(history.getAttribute("href")).toBe("/admin/behaviour?assistant=ast_1&history=open");
    expect(view.getByText("Anthropic model-fast (key set on the server)")).toBeTruthy();
    expect(view.getByText("120 ms")).toBeTruthy();
    expect(view.getByText("840 ms")).toBeTruthy();
    expect(view.getByText("2.4 s")).toBeTruthy();
    expect(view.getByText(/1 round/)).toBeTruthy();
    expect(view.getByText("1,200 in · 300 out")).toBeTruthy();
    expect(view.getByText("$0.02")).toBeTruthy();
    expect(view.getByText("Finished")).toBeTruthy();

    // Loaded once: closing and opening again reads nothing new.
    const before = calls.filter((p) => p.endsWith("/trace")).length;
    await act(async () => {
      details.open = false;
      details.dispatchEvent(new Event("toggle"));
    });
    await openTrace();
    expect(calls.filter((p) => p.endsWith("/trace")).length).toBe(before);

    await expectNoSeriousA11yViolations(details);
  });

  it.each([
    ["review_timeout", "It failed after a retry: the last try took too long."],
    [
      "review_provider_error",
      "It failed after a retry: the AI provider could not do the last try.",
    ],
    ["review_empty", "It failed after a retry: the last try came back empty."],
    ["review_unparseable", "It failed after a retry: the last try gave a reply we could not read."],
    ["review_skipped_spend_cap", "Skipped: the daily spend limit was reached."],
    ["review_error", "Something went wrong on our side while checking."],
  ] as const)("says in plain words why the answer was not checked (%s)", async (code, words) => {
    installServer(() => Response.json(trace({ reviewFailure: code })));
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    expect(await within(details).findByText(`Not checked. ${words}`)).toBeTruthy();
    expect(within(details).queryByText(code)).toBeNull();
  });

  it("says why an answer with no details was not checked", async () => {
    installServer(() => Response.json(trace({ trace: null, reviewFailure: "review_timeout" })));
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    expect(
      await within(details).findByText("No details were recorded for this answer."),
    ).toBeTruthy();
    expect(
      within(details).getByText(
        "Not checked. It failed after a retry: the last try took too long.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about the check when it gave a result", async () => {
    installServer(() => Response.json(trace({ reviewFailure: null })));
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    await within(details).findByText("Whole answer");
    expect(within(details).queryByText("Answer check")).toBeNull();
  });

  it("says no details were recorded for an answer from before traces", async () => {
    installServer(() => Response.json(trace({ trace: null, firstTokenMs: null, totalMs: null })));
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    expect(
      await within(details).findByText("No details were recorded for this answer."),
    ).toBeTruthy();
    expect(within(details).queryByRole("table")).toBeNull();
  });

  it("explains an answer made with nothing relevant found", async () => {
    installServer(() =>
      Response.json(
        trace({
          trace: {
            parts: [
              part({
                model: null,
                tools: { rounds: 0, ms: 0 },
                retrieval: {
                  floor: 0.3,
                  ms: 90,
                  candidates: [
                    {
                      chunkId: "chk_2",
                      score: 0.1,
                      used: false,
                      dropped: "below_floor",
                      content: null,
                    },
                  ],
                },
              }),
            ],
            truncated: false,
          },
        }),
      ),
    );
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    const view = within(details);
    expect(await view.findByText("No model was asked: nothing relevant was found.")).toBeTruthy();
    expect(view.getByText("Not used: weak match")).toBeTruthy();
    expect(view.getByText("This content has since changed or been removed.")).toBeTruthy();
    expect(view.queryByText(/round/)).toBeNull();
  });

  it("labels each request of a paused answer and an OpenRouter cost in credits", async () => {
    installServer(() =>
      Response.json(
        trace({
          trace: {
            parts: [
              part({
                stop: "paused",
                model: { provider: "openrouter", id: "vendor/model", keySource: "stored" },
              }),
              part({ kind: "resume", stop: "length" }),
            ],
            truncated: true,
          },
        }),
      ),
    );
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    const view = within(details);
    expect(await view.findByText("First reply")).toBeTruthy();
    expect(view.getByText("After page action 1")).toBeTruthy();
    expect(view.getByText("Waited for the visitor's page")).toBeTruthy();
    expect(view.getByText("Cut short at the length limit")).toBeTruthy();
    expect(view.getByText("0.02 credits")).toBeTruthy();
    expect(view.getByText(/key set in Settings/)).toBeTruthy();
    expect(view.getByText("Some details were left out to keep this record small.")).toBeTruthy();
  });

  it("offers a retry when the details cannot be loaded", async () => {
    let fail = true;
    installServer(() =>
      fail ? Response.json({ error: "Server error." }, { status: 500 }) : Response.json(trace()),
    );
    render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
    const details = await openTrace();
    const retry = await within(details).findByRole("button", { name: /Try again/ });
    fail = false;
    await act(async () => retry.click());
    await waitFor(() => expect(within(details).getByRole("table")).toBeTruthy());
  });

  it("writes durations one way", () => {
    expect(formatMs(0)).toBe("0 ms");
    expect(formatMs(999)).toBe("999 ms");
    expect(formatMs(1000)).toBe("1.0 s");
    expect(formatMs(12_345)).toBe("12.3 s");
  });
});
