import type { AnswerOutcome } from "@solvchat/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type {
  ConversationDetail,
  ConversationTurn,
  GapSummary,
  ProviderSettingsView,
} from "../src/api/types.js";
import { Conversation } from "../src/screens/Conversation.js";
import { Gaps } from "../src/screens/Gaps.js";
import { Providers } from "../src/screens/Providers.js";
import { ToastProvider } from "../src/ui/Toast.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

function turn(overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: "msg",
    role: "assistant",
    content: "",
    citations: [],
    toolCalls: null,
    answered: true,
    createdAt: 1_763_300_000_000,
    feedback: [],
    answerDocumentId: null,
    replyTo: null,
    ...overrides,
  };
}

function detailWith(replies: Array<Partial<ConversationTurn>>): ConversationDetail {
  const turns: ConversationTurn[] = [];
  replies.forEach((reply, i) => {
    turns.push(turn({ id: `q${i}`, role: "user", content: `Question ${i}?` }));
    turns.push(turn({ id: `a${i}`, content: `Reply ${i}.`, replyTo: `q${i}`, ...reply }));
  });
  return {
    conversation: {
      id: "cnv_1",
      assistantId: "ast_1",
      visitorId: "vis_1",
      startedAt: 1_763_300_000_000,
      pageUrl: "https://site.example/",
    },
    turns,
  };
}

function serve(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: Array<{ path: string; search: URLSearchParams; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "https://example.com");
      calls.push({ path: url.pathname, search: url.searchParams, ...(init ? { init } : {}) });
      const route = routes[url.pathname];
      if (!route) return Response.json({ error: "Not found." }, { status: 404 });
      return Response.json(route(init));
    }),
  );
  return calls;
}

/** The turn element of an assistant reply, by its text. */
async function replyItem(text: string): Promise<HTMLElement> {
  const body = await screen.findByText(text);
  const item = body.closest("li");
  if (!item) throw new Error(`no turn for ${text}`);
  return item;
}

describe("answer review in the admin", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  describe("Conversation", () => {
    it("shows one outcome badge per reviewed reply, in plain words", async () => {
      const outcomes: AnswerOutcome[] = [
        "answered",
        "partial",
        "declined",
        "off_topic",
        "wants_human",
      ];
      serve({
        "/api/admin/conversations/cnv_1": () =>
          detailWith([...outcomes.map((outcome) => ({ outcome })), { outcome: null }]),
      });
      render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);

      const labels = [
        "Answered",
        "Partly answered",
        "Could not answer",
        "Off topic",
        "Asked for a person",
      ];
      for (const [i, label] of labels.entries()) {
        const item = await replyItem(`Reply ${i}.`);
        expect(within(item).getByText(label).closest(".status-badge")).toBeTruthy();
        expect(within(item).getAllByText(/./, { selector: ".status-badge" })).toHaveLength(1);
      }
      // An unreviewed reply has no outcome badge.
      const unreviewed = await replyItem("Reply 5.");
      expect(unreviewed.querySelector(".status-badge")).toBeNull();
    });

    it("offers 'Write an answer for this' on a reply that had content and still could not answer", async () => {
      serve({
        "/api/admin/conversations/cnv_1": () =>
          detailWith([{ outcome: "declined" }, { outcome: "answered" }]),
      });
      render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
      const declined = await replyItem("Reply 0.");
      expect(declined.className).toContain("turn-gap");
      expect(
        within(declined).getByRole("button", { name: "Write an answer for this" }),
      ).toBeTruthy();
      const answered = await replyItem("Reply 1.");
      expect(
        within(answered).queryByRole("button", { name: "Write an answer for this" }),
      ).toBeNull();
    });

    it("keeps 'Unanswered' for a retrieval miss, without a second badge, and 'Answer written' once fixed", async () => {
      serve({
        "/api/admin/conversations/cnv_1": () =>
          detailWith([
            { answered: false, outcome: "declined" },
            { outcome: "declined", answerDocumentId: "doc_1" },
          ]),
      });
      render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
      const miss = await replyItem("Reply 0.");
      expect(within(miss).getByText("Unanswered")).toBeTruthy();
      expect(within(miss).queryByText("Could not answer")).toBeNull();
      const fixed = await replyItem("Reply 1.");
      expect(within(fixed).getByText("Answer written")).toBeTruthy();
      expect(within(fixed).queryByText("Could not answer")).toBeNull();
      await expectNoSeriousA11yViolations(document.body);
    });

    it("shows the outcome of a retrieval miss reviewed as a person or off topic, and offers no answer to write", async () => {
      serve({
        "/api/admin/conversations/cnv_1": () =>
          detailWith([
            { answered: false, outcome: "wants_human" },
            { answered: false, outcome: "off_topic" },
            { answered: false, outcome: null },
          ]),
      });
      render(<Conversation assistantId="ast_1" conversationId="cnv_1" onBack={() => {}} />);
      for (const [text, label] of [
        ["Reply 0.", "Asked for a person"],
        ["Reply 1.", "Off topic"],
      ] as const) {
        const item = await replyItem(text);
        expect(within(item).getByText(label).closest(".status-badge")).toBeTruthy();
        expect(within(item).queryByText("Unanswered")).toBeNull();
        expect(item.className).not.toContain("turn-gap");
        expect(within(item).queryByRole("button", { name: "Write an answer for this" })).toBeNull();
      }
      // A miss not reviewed yet reads as before.
      const pending = await replyItem("Reply 2.");
      expect(within(pending).getByText("Unanswered")).toBeTruthy();
      expect(
        within(pending).getByRole("button", { name: "Write an answer for this" }),
      ).toBeTruthy();
    });
  });

  describe("Conversations", () => {
    it("filters by 'Could not answer', 'Asked for a person' and 'Off topic'", async () => {
      const calls = serve({
        "/api/admin/assistants": () => ({
          assistants: [
            {
              id: "ast_1",
              orgId: "org_1",
              name: "Docs Bot",
              publicKey: "pk_1",
              allowedOrigins: [],
              hasIngestKey: false,
              createdAt: 1,
            },
          ],
        }),
        "/api/admin/assistants/ast_1/conversations": () => ({
          conversations: [],
          total: 0,
          limit: 25,
          offset: 0,
        }),
        "/api/admin/assistants/ast_1/versions": () => ({ versions: [] }),
      });
      window.history.pushState(null, "", "/admin/conversations");
      render(<App />);
      await screen.findByRole("heading", { name: "Conversations", level: 1 });
      const lastFilter = () =>
        calls
          .filter((c) => c.path.endsWith("/conversations"))
          .at(-1)
          ?.search.get("filter");

      fireEvent.click(await screen.findByRole("button", { name: "Could not answer" }));
      await waitFor(() => expect(lastFilter()).toBe("could_not_answer"));
      fireEvent.click(screen.getByRole("button", { name: "Asked for a person" }));
      await waitFor(() => expect(lastFilter()).toBe("could_not_answer,asked_for_person"));
      expect(new URLSearchParams(window.location.search).get("filter")).toBe(
        "could_not_answer,asked_for_person",
      );
      fireEvent.click(screen.getByRole("button", { name: "Off topic" }));
      await waitFor(() => expect(lastFilter()).toBe("could_not_answer,asked_for_person,off_topic"));
    });
  });

  describe("Gaps", () => {
    function gap(overrides: Partial<GapSummary>): GapSummary {
      return {
        question: "q",
        displayQuestion: "Q?",
        times: 1,
        lastAsked: Date.now() - 60_000,
        exampleMessageId: "msg_q",
        handled: false,
        documentId: null,
        ...overrides,
      };
    }

    it("tells 'no content found' from 'had content, could not answer'", async () => {
      serve({
        "/api/admin/assistants/ast_1/gaps": () => ({
          gaps: [
            gap({
              question: "a",
              displayQuestion: "Only missing?",
              times: 2,
              noContentTimes: 2,
              declinedTimes: 0,
              exampleMessageId: "m1",
            }),
            gap({
              question: "b",
              displayQuestion: "Only unclear?",
              times: 1,
              noContentTimes: 0,
              declinedTimes: 1,
              exampleMessageId: "m2",
            }),
            gap({
              question: "c",
              displayQuestion: "Both?",
              times: 3,
              noContentTimes: 1,
              declinedTimes: 2,
              exampleMessageId: "m3",
            }),
            gap({ question: "d", displayQuestion: "Older engine?", exampleMessageId: "m4" }),
          ],
          total: 4,
          limit: 25,
          offset: 0,
        }),
      });
      render(
        <ToastProvider>
          <main>
            <Gaps assistantId="ast_1" />
          </main>
        </ToastProvider>,
      );
      const item = async (title: string) => {
        const el = (await screen.findByText(title)).closest("li");
        if (!el) throw new Error(title);
        return within(el);
      };
      const missing = await item("Only missing?");
      expect(missing.getByText("No content found")).toBeTruthy();
      expect(missing.queryByText(/Had content/)).toBeNull();
      const unclear = await item("Only unclear?");
      expect(unclear.getByText("Had content, could not answer").getAttribute("title")).toMatch(
        /unclear/,
      );
      expect(unclear.queryByText(/No content found/)).toBeNull();
      const both = await item("Both?");
      expect(both.getByText("No content found (1)")).toBeTruthy();
      expect(both.getByText("Had content, could not answer (2)")).toBeTruthy();
      const older = await item("Older engine?");
      expect(older.queryByText(/No content found|Had content/)).toBeNull();
    });
  });

  describe("Settings → Providers", () => {
    function view(reviewAnswers?: boolean): ProviderSettingsView {
      return {
        settings: {
          llmProvider: { value: "anthropic", source: "none" },
          llmTier: { value: "fast", source: "none" },
          llmModel: { value: null, source: "none" },
          embeddingsProvider: { value: "openai", source: "none" },
          ...(reviewAnswers === undefined
            ? {}
            : { reviewAnswers: { value: reviewAnswers, source: "none" as const } }),
        },
        keysManaged: false,
        keys: {
          anthropic: { source: "environment", updatedAt: null, unreadable: false },
          openai: { source: "environment", updatedAt: null, unreadable: false },
          openrouter: { source: "none", updatedAt: null, unreadable: false },
        },
        configError: null,
      };
    }

    function renderProviders() {
      render(
        <ToastProvider>
          <main>
            <Providers />
          </main>
        </ToastProvider>,
      );
    }

    it("has one 'Review answers' switch, on by default, that saves only itself", async () => {
      let state = view(true);
      const puts: unknown[] = [];
      serve({
        "/api/admin/assistants": () => ({ assistants: [] }),
        "/api/admin/providers": (init) => {
          if (init?.method === "PUT") {
            const body = JSON.parse(String(init.body)) as { reviewAnswers: boolean };
            puts.push(body);
            state = view(body.reviewAnswers);
            state.settings.reviewAnswers = { value: body.reviewAnswers, source: "stored" };
          }
          return state;
        },
      });
      // Through the shell, which the axe check needs (as in providers.test.tsx).
      window.history.pushState(null, "", "/admin/providers");
      render(<App />);
      const section = await screen.findByRole("region", { name: "Answer review" });
      const box = within(section).getByRole("checkbox", { name: "Review answers" });
      expect((box as HTMLInputElement).checked).toBe(true);
      expect(section.textContent).toMatch(/small amount of your model budget per answer/);
      await expectNoSeriousA11yViolations(document.body);

      fireEvent.click(box);
      await waitFor(() => expect(puts).toEqual([{ reviewAnswers: false }]));
      await waitFor(() => expect((box as HTMLInputElement).checked).toBe(false));
    });

    it("shows no switch for an engine that sends none", async () => {
      serve({ "/api/admin/providers": () => view() });
      renderProviders();
      await screen.findByRole("heading", { name: "Models" });
      expect(screen.queryByRole("checkbox", { name: "Review answers" })).toBeNull();
    });
  });
});
