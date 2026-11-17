import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type {
  Assistant,
  AssistantOverview,
  AssistantReport,
  ConversationDetail,
  ConversationSummary,
  GapSummary,
} from "../src/api/types.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";
import { findAssistantButton, pickAssistant, selectedAssistantId } from "./support/switcher.js";

const ASSISTANT: Assistant = {
  id: "ast_1",
  orgId: "org_00000000000000000000",
  name: "Docs Bot",
  publicKey: "pk_ast_1",
  allowedOrigins: ["https://docs.example.com"],
  hasIngestKey: true,
  createdAt: 1_700_000_000_000,
};

const OTHER_ASSISTANT: Assistant = {
  ...ASSISTANT,
  id: "ast_2",
  name: "Sales Bot",
  publicKey: "pk_ast_2",
};

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function overview(overrides: Partial<AssistantOverview> = {}): AssistantOverview {
  return {
    messages: 30,
    answeredShare: 0.8,
    topQuestions: [{ question: "do you ship to spain?", count: 4 }],
    todayCostMicros: 1_000,
    dailyCostCapMicros: 2_000_000,
    configError: null,
    period: {
      days: 7,
      from: "2026-11-10",
      to: "2026-11-16",
      questions: 6,
      replies: 6,
      answeredShare: 0.5,
      thumbsDownShare: 0,
      costMicros: 4_000,
      previous: {
        from: "2026-11-03",
        to: "2026-11-09",
        questions: 8,
        replies: 8,
        answeredShare: 0.5,
        thumbsDownShare: 0,
        costMicros: 4_000,
      },
    },
    daily: [
      { day: "2026-11-10", questions: 0 },
      { day: "2026-11-11", questions: 1 },
      { day: "2026-11-12", questions: 0 },
      { day: "2026-11-13", questions: 2 },
      { day: "2026-11-14", questions: 0 },
      { day: "2026-11-15", questions: 3 },
      { day: "2026-11-16", questions: 0 },
    ],
    setup: {
      hasContent: true,
      tried: true,
      published: false,
      installed: false,
      visitorQuestion: false,
    },
    attention: { openGaps: 0, failingTests: 0, notIndexed: [] },
    ...overrides,
  };
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
  topQuestions: [{ question: "how do i reset my password?", count: 3 }],
  topGaps: [],
  topSources: [],
  uncitedSources: [{ url: "https://docs.example.com/old", title: "Old page" }],
  uncitedTotal: 1,
};

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "cnv_1",
    assistantId: ASSISTANT.id,
    visitorId: "vis_1",
    startedAt: NOW - 3 * 3_600_000,
    pageUrl: "https://docs.example.com/shipping",
    firstQuestion: "Do you ship to Spain?",
    turnCount: 2,
    hasUnanswered: true,
    hasNotHelpful: true,
    usedTool: false,
    lastMessageAt: NOW - 3 * 3_600_000,
    ...overrides,
  };
}

const DETAIL: ConversationDetail = {
  conversation: {
    id: "cnv_1",
    assistantId: ASSISTANT.id,
    visitorId: "vis_1",
    startedAt: Date.UTC(2026, 10, 16, 9, 0, 0),
    pageUrl: "https://docs.example.com/shipping",
  },
  turns: [
    {
      id: "msg_q1",
      role: "user",
      content: "Do you ship to Spain?",
      citations: [],
      answered: true,
      createdAt: Date.UTC(2026, 10, 16, 9, 0, 0),
      feedback: [],
      answerDocumentId: null,
      replyTo: null,
    },
    {
      id: "msg_a1",
      role: "assistant",
      content: "I could not find that.",
      citations: [],
      answered: false,
      createdAt: Date.UTC(2026, 10, 16, 9, 0, 5),
      feedback: [{ id: "fbk_1", value: "down", note: "", createdAt: 1 }],
      answerDocumentId: null,
      replyTo: "msg_q1",
    },
    {
      id: "msg_q2",
      role: "user",
      content: "What about returns?",
      citations: [],
      answered: true,
      createdAt: Date.UTC(2026, 10, 16, 9, 1, 0),
      feedback: [],
      answerDocumentId: null,
      replyTo: null,
    },
    {
      id: "msg_a2",
      role: "assistant",
      content: "Returns are free for 30 days.",
      citations: [{ url: "https://docs.example.com/returns", title: "Returns policy" }],
      answered: true,
      createdAt: Date.UTC(2026, 10, 16, 9, 1, 4),
      feedback: [],
      answerDocumentId: null,
      replyTo: "msg_q2",
    },
  ],
};

function gap(overrides: Partial<GapSummary> = {}): GapSummary {
  return {
    question: "do you ship to spain?",
    displayQuestion: "Do you ship to Spain?",
    times: 4,
    lastAsked: NOW - 3_600_000,
    exampleMessageId: "msg_q1",
    handled: false,
    documentId: null,
    ...overrides,
  };
}

interface ServerOptions {
  overview?: AssistantOverview | (() => Response);
  report?: AssistantReport | (() => Response);
  conversations?: (search: URLSearchParams) => ConversationSummary[] | Response;
  gaps?: GapSummary[];
  /** Also list the second assistant (it has no conversations of its own). */
  twoAssistants?: boolean;
  /** Holds each dismiss request until the test resolves it. */
  holdDismiss?: (release: () => void) => void;
  /** Holds each restore request until the test resolves it. */
  holdRestore?: (release: () => void) => void;
}

function installServer(options: ServerOptions = {}) {
  const calls: Array<{ method: string; path: string; search: URLSearchParams; body: unknown }> = [];
  const gaps = (options.gaps ?? [gap()]).map((g) => ({ ...g }));
  const dismissed = new Set<string>();

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://example.com");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path: url.pathname, search: url.searchParams, body });
    const base = `/api/admin/assistants/${ASSISTANT.id}`;

    if (url.pathname === "/api/admin/assistants") {
      return Response.json({
        assistants: options.twoAssistants ? [ASSISTANT, OTHER_ASSISTANT] : [ASSISTANT],
      });
    }
    if (url.pathname === `/api/admin/assistants/${OTHER_ASSISTANT.id}/conversations`) {
      return Response.json({ conversations: [], total: 0, limit: 25, offset: 0 });
    }
    if (url.pathname === `${base}/overview`) {
      if (typeof options.overview === "function") return options.overview();
      return Response.json(options.overview ?? overview());
    }
    if (url.pathname === `${base}/report`) {
      if (typeof options.report === "function") return options.report();
      return Response.json(options.report ?? REPORT);
    }
    if (url.pathname === `${base}/conversations`) {
      const result = options.conversations
        ? options.conversations(url.searchParams)
        : [conversation()];
      if (result instanceof Response) return result;
      return Response.json({ conversations: result, total: result.length, limit: 25, offset: 0 });
    }
    if (url.pathname === "/api/admin/conversations/cnv_1") {
      return Response.json(DETAIL);
    }
    if (url.pathname === "/api/admin/conversations/cnv_2") {
      return Response.json({
        ...DETAIL,
        conversation: { ...DETAIL.conversation, id: "cnv_2", assistantId: OTHER_ASSISTANT.id },
      });
    }
    if (url.pathname === `${base}/gaps` && method === "GET") {
      const listed = gaps.filter((g) => !dismissed.has(g.question) && !g.handled);
      return Response.json({ gaps: listed, total: listed.length, limit: 25, offset: 0 });
    }
    if (url.pathname === `${base}/gaps/dismiss` && method === "POST") {
      const question = (body as { question: string }).question;
      const hold = options.holdDismiss;
      if (hold) await new Promise<void>((release) => hold(release));
      dismissed.add(question);
      return Response.json({ question, dismissed: true });
    }
    if (url.pathname === `${base}/gaps/restore` && method === "POST") {
      const question = (body as { question: string }).question;
      const hold = options.holdRestore;
      if (hold) await new Promise<void>((release) => hold(release));
      dismissed.delete(question);
      return Response.json({ question, dismissed: false });
    }
    if (url.pathname === `${base}/answers` && method === "POST") {
      const from = (body as { fromMessageId: string }).fromMessageId;
      for (const g of gaps) if (g.exampleMessageId === from) g.handled = true;
      return Response.json(
        {
          documentId: "doc_1",
          sourceId: "src_1",
          url: "https://example.com/e",
          counts: { written: 1, unchanged: 0, deleted: 0 },
        },
        { status: 201 },
      );
    }
    if (url.pathname === `${base}/versions`) {
      return Response.json({ versions: [] });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

async function open(path: string) {
  window.history.pushState(null, "", path);
  render(<App />);
  await screen.findByRole("heading", { level: 1 });
}

describe("Monitor screens", () => {
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

  describe("Overview", () => {
    it("ticks the getting-started steps from stored state and links each to its screen", async () => {
      installServer();
      await open("/admin/overview");

      const checklist = await screen.findByRole("region", { name: "Getting started" });
      expect(within(checklist).getByText("2 of 5 done")).toBeTruthy();
      const steps = within(checklist).getAllByRole("listitem");
      expect(steps.map((li) => li.textContent?.includes("(done)"))).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(
        within(checklist).getByRole("link", { name: "Add content" }).getAttribute("href"),
      ).toBe("/admin/sources");
      expect(
        within(checklist).getByRole("link", { name: "Install on your site" }).getAttribute("href"),
      ).toBe("/admin/install");

      fireEvent.click(within(checklist).getByRole("link", { name: "First visitor question" }));
      expect(await screen.findByRole("heading", { name: "Conversations", level: 1 })).toBeTruthy();
      expect(window.location.pathname).toBe("/admin/conversations");
    });

    it("hides the checklist when dismissed, and for good on this assistant", async () => {
      installServer();
      await open("/admin/overview");

      fireEvent.click(await screen.findByRole("button", { name: "Hide checklist" }));
      expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();

      cleanup();
      await open("/admin/overview");
      await screen.findByRole("region", { name: "Questions asked" });
      expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    });

    it("does not render the checklist once every step is done", async () => {
      installServer({
        overview: overview({
          setup: {
            hasContent: true,
            tried: true,
            published: true,
            installed: true,
            visitorQuestion: true,
          },
        }),
      });
      await open("/admin/overview");
      await screen.findByRole("region", { name: "Questions asked" });
      expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    });

    it("opens the Try it pane from the checklist", async () => {
      installServer({
        overview: overview({
          setup: {
            hasContent: true,
            tried: false,
            published: false,
            installed: false,
            visitorQuestion: false,
          },
        }),
      });
      await open("/admin/overview");
      const toggle = await screen.findByRole("button", { name: "Try it" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(screen.getByRole("button", { name: "Open Try it" }));
      await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    });

    it("lists what needs attention, each linking to the screen that fixes it", async () => {
      installServer({
        overview: overview({
          configError: "The OpenAI key must be entered again.",
          attention: {
            openGaps: 3,
            failingTests: 1,
            notIndexed: [{ sourceId: "src_1", label: "Docs", documents: 2 }],
          },
        }),
      });
      await open("/admin/overview");

      const block = await screen.findByRole("region", { name: "Needs attention" });
      const links = within(block)
        .getAllByRole("link")
        .map((a) => [a.textContent, a.getAttribute("href")]);
      expect(links).toEqual([
        ["Check providers", "/admin/providers"],
        ["3 unanswered questions are waiting for an answer", "/admin/gaps"],
        ["1 test failed in the last run", "/admin/tests"],
        ["Docs: 2 pages were not indexed", "/admin/sources"],
      ]);
      expect(block.textContent).toContain("The OpenAI key must be entered again.");
    });

    it("does not render Needs attention when there is nothing to show", async () => {
      installServer();
      await open("/admin/overview");
      await screen.findByRole("region", { name: "Questions asked" });
      expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
    });

    it("draws questions per day with a table of the same numbers", async () => {
      installServer();
      await open("/admin/overview");

      const chart = await screen.findByRole("region", { name: "Questions per day" });
      expect(chart.querySelectorAll("svg rect.chart-bar")).toHaveLength(7);
      const table = within(chart).getByRole("table", { name: "Questions per day" });
      const rows = within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => Array.from(row.querySelectorAll("td")).map((td) => td.textContent));
      expect(rows[0]).toEqual(["10 Nov 2026", "0"]);
      expect(rows[5]).toEqual(["15 Nov 2026", "3"]);
      // The bars are decoration; the table carries the numbers for screen readers.
      expect(chart.querySelector(".chart")?.getAttribute("aria-hidden")).toBe("true");
    });

    it("shows a skeleton while loading, then an error with a retry that works", async () => {
      let attempts = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      installServer({
        overview: () => {
          attempts++;
          return attempts === 1
            ? Response.json({ error: "Overview is down." }, { status: 500 })
            : Response.json(overview());
        },
      });
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).endsWith("/overview") && attempts === 0) await gate;
          return realFetch(input, init);
        }),
      );
      await open("/admin/overview");

      expect(await screen.findByText("Loading overview…")).toBeTruthy();
      await act(async () => release());
      expect(await screen.findByText("Could not load the overview.")).toBeTruthy();
      expect(screen.getByText("Overview is down.")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("region", { name: "Questions asked" })).toBeTruthy();
      expect(attempts).toBe(2);
    });

    it("has no serious accessibility violations", async () => {
      installServer({
        overview: overview({
          attention: { openGaps: 2, failingTests: 0, notIndexed: [] },
        }),
      });
      await open("/admin/overview");
      await screen.findByRole("region", { name: "Getting started" });
      await expectNoSeriousA11yViolations(document.body);
    });
  });

  describe("Reports", () => {
    it("links questions to their conversations and says what the CSV holds", async () => {
      installServer();
      await open("/admin/reports");

      const asked = await screen.findByRole("link", { name: "how do i reset my password?" });
      expect(asked.getAttribute("href")).toBe(
        "/admin/conversations?q=how%20do%20i%20reset%20my%20password%3F",
      );
      const csv = screen.getByRole("button", { name: "Download CSV" });
      const hint = document.getElementById(csv.getAttribute("aria-describedby") ?? "");
      expect(hint?.textContent).toBe(
        "The CSV holds the four figures and the four lists below, for 18 Oct 2026 to 16 Nov 2026.",
      );
      expect(screen.getByRole("link", { name: "Old page" }).getAttribute("href")).toBe(
        "https://docs.example.com/old",
      );

      fireEvent.click(asked);
      expect(await screen.findByRole("heading", { name: "Conversations", level: 1 })).toBeTruthy();
      expect((screen.getByLabelText("Search conversations") as HTMLInputElement).value).toBe(
        "how do i reset my password?",
      );
    });

    it("shows a compact empty state for each list with nothing in the period", async () => {
      installServer();
      await open("/admin/reports");
      await screen.findByRole("radio", { name: "30 days" });
      const unanswered = await screen.findByRole("region", { name: "Most often unanswered" });
      expect(within(unanswered).getByRole("heading", { name: "None in this period" })).toBeTruthy();
      expect(unanswered.querySelector(".empty-state-compact")).toBeTruthy();
    });

    it("offers the periods as presets that a keyboard can move between", async () => {
      const { calls } = installServer();
      await open("/admin/reports");
      const group = await screen.findByRole("group", { name: "Period" });
      const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
      expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
        "7 days",
        "30 days",
        "90 days",
      ]);
      // Native radios sharing a name: arrow keys move between them.
      expect(new Set(radios.map((r) => r.name)).size).toBe(1);
      expect(radios[1]?.checked).toBe(true);

      fireEvent.click(within(group).getByRole("radio", { name: "90 days" }));
      await waitFor(() =>
        expect(calls.some((c) => c.path.endsWith("/report") && c.search.get("days") === "90")).toBe(
          true,
        ),
      );
    });

    it("retries after an error", async () => {
      let attempts = 0;
      installServer({
        report: () => {
          attempts++;
          return attempts === 1
            ? Response.json({ error: "Report failed" }, { status: 500 })
            : Response.json(REPORT);
        },
      });
      await open("/admin/reports");
      expect(await screen.findByText("Could not load the report.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("region", { name: "Questions asked" })).toBeTruthy();
    });

    it("has no serious accessibility violations", async () => {
      installServer();
      await open("/admin/reports");
      await screen.findByRole("region", { name: "Questions asked" });
      await expectNoSeriousA11yViolations(document.body);
    });
  });

  describe("Conversations", () => {
    it("shows each row with its first question, time, count and badges; the row opens it", async () => {
      installServer({
        conversations: () => [
          conversation(),
          conversation({
            id: "cnv_2",
            firstQuestion: "Open my invoice",
            hasUnanswered: false,
            hasNotHelpful: false,
            usedTool: true,
            turnCount: 4,
          }),
        ],
      });
      await open("/admin/conversations");

      const row = await screen.findByRole("link", { name: /Do you ship to Spain\?/ });
      expect(row.textContent).toContain("3 hours ago");
      expect(row.textContent).toContain("2 messages");
      expect(row.textContent).toContain("Unanswered");
      expect(row.textContent).toContain("Marked not helpful");
      const second = screen.getByRole("link", { name: /Open my invoice/ });
      expect(second.textContent).toContain("Used a tool");
      expect(second.textContent).not.toContain("Unanswered");
      expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

      fireEvent.click(row);
      expect(await screen.findByText("I could not find that.")).toBeTruthy();
      expect(window.location.search).toBe("?id=cnv_1&assistant=ast_1");

      fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
      expect(await screen.findByRole("link", { name: /Do you ship to Spain\?/ })).toBeTruthy();
      expect(window.location.search).toBe("");
    });

    it("goes back to the list when Conversations is picked in the sidebar", async () => {
      installServer();
      await open("/admin/conversations");
      fireEvent.click(await screen.findByRole("link", { name: /Do you ship to Spain\?/ }));
      expect(await screen.findByText("I could not find that.")).toBeTruthy();

      const nav = screen.getByRole("navigation", { name: "Primary" });
      fireEvent.click(within(nav).getByRole("link", { name: "Conversations" }));
      expect(await screen.findByRole("link", { name: /Do you ship to Spain\?/ })).toBeTruthy();
      expect(screen.queryByText("I could not find that.")).toBeNull();
      expect(window.location.pathname).toBe("/admin/conversations");
      expect(window.location.search).toBe("");
    });

    it("filters by flag and date and searches by text", async () => {
      const { calls } = installServer();
      await open("/admin/conversations");
      await screen.findByRole("link", { name: /Do you ship to Spain\?/ });

      const lastList = () => calls.filter((c) => c.path.endsWith("/conversations")).at(-1);

      fireEvent.click(screen.getByRole("button", { name: "Unanswered" }));
      fireEvent.click(screen.getByRole("button", { name: "Used a tool" }));
      expect(screen.getByRole("button", { name: "Unanswered" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      await waitFor(() => expect(lastList()?.search.get("filter")).toBe("unanswered,used_tool"));

      fireEvent.change(screen.getByLabelText("Started"), { target: { value: "7" } });
      await waitFor(() => expect(lastList()?.search.get("days")).toBe("7"));

      fireEvent.change(screen.getByLabelText("Search conversations"), {
        target: { value: "spain" },
      });
      await waitFor(() => expect(lastList()?.search.get("q")).toBe("spain"), { timeout: 2000 });
      expect(lastList()?.search.get("offset")).toBe("0");
    });

    it("offers Clear filters when nothing matches", async () => {
      installServer({
        conversations: (search) => (search.get("filter") ? [] : [conversation()]),
      });
      await open("/admin/conversations");
      await screen.findByRole("link", { name: /Do you ship to Spain\?/ });

      fireEvent.click(screen.getByRole("button", { name: "Marked not helpful" }));
      expect(await screen.findByRole("heading", { name: "No conversations match" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(await screen.findByRole("link", { name: /Do you ship to Spain\?/ })).toBeTruthy();
    });

    it("retries after an error", async () => {
      let attempts = 0;
      installServer({
        conversations: () => {
          attempts++;
          return attempts === 1
            ? Response.json({ error: "List failed." }, { status: 500 })
            : [conversation()];
        },
      });
      await open("/admin/conversations");
      expect(await screen.findByText("Could not load conversations.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: /Do you ship to Spain\?/ })).toBeTruthy();
    });

    it("shows turns with times and sources, and sends an unanswered turn to Gaps prefilled", async () => {
      const { calls } = installServer({ gaps: [] });
      await open("/admin/conversations?id=cnv_1");

      const transcript = await screen.findByRole("list", { name: "Messages" });
      const turns = within(transcript).getAllByRole("listitem", { hidden: false });
      const top = turns.filter((li) => li.parentElement === transcript);
      expect(top.map((li) => li.querySelector(".turn-role")?.textContent)).toEqual([
        "Visitor",
        "Assistant",
        "Visitor",
        "Assistant",
      ]);
      expect(top[0]?.querySelector("time")?.getAttribute("dateTime")).toBe(
        "2026-11-16T09:00:00.000Z",
      );
      const sources = within(top[3] as HTMLElement).getByRole("list", { name: "Sources" });
      expect(
        within(sources).getByRole("link", { name: "Returns policy" }).getAttribute("href"),
      ).toBe("https://docs.example.com/returns");
      expect(within(top[1] as HTMLElement).getByText("Unanswered")).toBeTruthy();
      // Only the unanswered reply offers it.
      expect(screen.getAllByRole("button", { name: "Write an answer for this" })).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Write an answer for this" }));
      expect(await screen.findByRole("heading", { name: "Gaps", level: 1 })).toBeTruthy();
      expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe(
        "Do you ship to Spain?",
      );
      // The handed-over question leaves the address, so a reload does not reopen it.
      expect(window.location.search).toBe("");

      fireEvent.change(screen.getByLabelText("Answer"), { target: { value: "Yes, in 3 days." } });
      fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
      await waitFor(() =>
        expect(calls.find((c) => c.path.endsWith("/answers"))?.body).toEqual({
          question: "Do you ship to Spain?",
          answer: "Yes, in 3 days.",
          fromMessageId: "msg_a1",
        }),
      );
    });

    it("drops an open conversation when another assistant is picked", async () => {
      installServer({ twoAssistants: true });
      await open("/admin/conversations");
      fireEvent.click(await screen.findByRole("link", { name: /Do you ship to Spain\?/ }));
      expect(await screen.findByText("I could not find that.")).toBeTruthy();

      pickAssistant(OTHER_ASSISTANT.id);
      expect(await screen.findByRole("heading", { name: "No conversations yet" })).toBeTruthy();
      expect(screen.queryByText("I could not find that.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Add to tests" })).toBeNull();
      expect(window.location.search).toBe("");
    });

    it("opens a shared link under the assistant it names", async () => {
      installServer({ twoAssistants: true });
      // Not the first assistant, which the shell would pick on its own.
      await open(`/admin/conversations?id=cnv_2&assistant=${OTHER_ASSISTANT.id}`);
      expect(await screen.findByText("I could not find that.")).toBeTruthy();
      await findAssistantButton();
      expect(selectedAssistantId()).toBe(OTHER_ASSISTANT.id);
      expect(screen.getAllByRole("button", { name: "Add to tests" }).length).toBeGreaterThan(0);
    });

    it("does not show or act on a conversation that belongs to another assistant", async () => {
      installServer({ twoAssistants: true });
      // A link without its assistant, opened while the other assistant is selected.
      await open(`/admin/conversations?assistant=${OTHER_ASSISTANT.id}`);
      await screen.findByRole("heading", { name: "No conversations yet" });
      act(() => {
        window.history.pushState(null, "", "/admin/conversations?id=cnv_1");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      expect(
        await screen.findByText(/This conversation belongs to another assistant/),
      ).toBeTruthy();
      expect(screen.queryByText("I could not find that.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Add to tests" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Write an answer for this" })).toBeNull();
    });

    it("has no serious accessibility violations on the list and the conversation", async () => {
      installServer();
      await open("/admin/conversations");
      await screen.findByRole("link", { name: /Do you ship to Spain\?/ });
      await expectNoSeriousA11yViolations(document.body);

      fireEvent.click(screen.getByRole("link", { name: /Do you ship to Spain\?/ }));
      await screen.findByText("I could not find that.");
      await expectNoSeriousA11yViolations(document.body);
    });
  });

  describe("Gaps", () => {
    it("explains what will appear when there are no gaps", async () => {
      installServer({ gaps: [] });
      await open("/admin/gaps");
      expect(await screen.findByRole("heading", { name: "No unanswered questions" })).toBeTruthy();
      expect(
        screen.getByText(/Writing an answer adds it to your sources, so the next visitor/),
      ).toBeTruthy();
    });

    it("asks only for open gaps, most asked first as the engine sends them", async () => {
      const { calls } = installServer({
        gaps: [gap(), gap({ question: "sso?", displayQuestion: "SSO?", times: 1 })],
      });
      await open("/admin/gaps");
      await screen.findByText("Do you ship to Spain?");
      expect(calls.find((c) => c.path.endsWith("/gaps"))?.search.get("status")).toBe("open");
      const titles = Array.from(document.querySelectorAll(".gap-item .source-title")).map(
        (el) => el.textContent,
      );
      expect(titles).toEqual(["Do you ship to Spain?", "SSO?"]);
      expect(screen.getByText("Asked 4 times")).toBeTruthy();
    });

    it("dismisses a gap and brings it back with Undo", async () => {
      const { calls } = installServer();
      await open("/admin/gaps");
      await screen.findByText("Do you ship to Spain?");

      fireEvent.click(screen.getByRole("button", { name: "Dismiss “Do you ship to Spain?”" }));
      expect(await screen.findByText(/Dismissed “Do you ship to Spain\?”/)).toBeTruthy();
      await waitFor(() => expect(document.querySelector(".gap-item")).toBeNull());
      expect(calls.find((c) => c.path.endsWith("/gaps/dismiss"))?.body).toEqual({
        question: "do you ship to spain?",
      });

      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(document.querySelector(".gap-item")).toBeTruthy());
      expect(calls.find((c) => c.path.endsWith("/gaps/restore"))?.body).toEqual({
        question: "do you ship to spain?",
      });
      expect(screen.queryByText(/Dismissed “/)).toBeNull();
    });

    it("keeps a newer dismissal's Undo when an earlier Undo finishes", async () => {
      let releaseRestore: (() => void) | undefined;
      const { calls } = installServer({
        gaps: [gap(), gap({ question: "sso?", displayQuestion: "SSO?", exampleMessageId: "m2" })],
        holdRestore: (r) => {
          releaseRestore = r;
        },
      });
      await open("/admin/gaps");
      await screen.findByText("SSO?");

      fireEvent.click(screen.getByRole("button", { name: "Dismiss “Do you ship to Spain?”" }));
      expect(await screen.findByText(/Dismissed “Do you ship to Spain\?”/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(releaseRestore).toBeDefined());

      // While the first Undo waits, the second gap is dismissed and finishes first.
      fireEvent.click(screen.getByRole("button", { name: "Dismiss “SSO?”" }));
      expect(await screen.findByText(/Dismissed “SSO\?”/)).toBeTruthy();

      await act(async () => {
        releaseRestore?.();
      });
      // The restored gap is listed again, so the first Undo has fully finished.
      await screen.findByText("Do you ship to Spain?");
      expect(calls.filter((c) => c.path.endsWith("/gaps/restore"))).toHaveLength(1);
      expect(screen.getByText(/Dismissed “SSO\?”/)).toBeTruthy();
      const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
      expect(undo.disabled).toBe(false);
    });

    it("keeps another gap's editor open when an earlier dismissal finishes", async () => {
      let release: (() => void) | undefined;
      installServer({
        gaps: [gap(), gap({ question: "sso?", displayQuestion: "SSO?", exampleMessageId: "m2" })],
        holdDismiss: (r) => {
          release = r;
        },
      });
      await open("/admin/gaps");
      await screen.findByText("SSO?");
      const items = () => Array.from(document.querySelectorAll(".gap-item"));
      const [first, second] = items() as HTMLElement[];
      if (!first || !second) throw new Error("Expected two gaps");

      // The first gap's editor is open when its Dismiss is pressed.
      fireEvent.click(within(first).getByRole("button", { name: "Write an answer" }));
      fireEvent.click(
        within(first).getByRole("button", { name: "Dismiss “Do you ship to Spain?”" }),
      );
      await waitFor(() => expect(release).toBeDefined());

      // While it waits, the owner starts an answer for the second gap.
      fireEvent.click(within(second).getByRole("button", { name: "Write an answer" }));
      fireEvent.change(within(second).getByLabelText("Answer"), {
        target: { value: "Yes, with SAML." },
      });

      await act(async () => release?.());
      expect(await screen.findByText(/Dismissed “Do you ship to Spain\?”/)).toBeTruthy();
      await waitFor(() => expect(items()).toHaveLength(1));
      const remaining = items()[0] as HTMLElement;
      expect((within(remaining).getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(
        "Yes, with SAML.",
      );
    });

    it("keeps another gap's test editor open when an earlier dismissal finishes", async () => {
      let release: (() => void) | undefined;
      installServer({
        gaps: [gap(), gap({ question: "sso?", displayQuestion: "SSO?", exampleMessageId: "m2" })],
        holdDismiss: (r) => {
          release = r;
        },
      });
      await open("/admin/gaps");
      await screen.findByText("SSO?");
      const items = () => Array.from(document.querySelectorAll(".gap-item"));
      const [first, second] = items() as HTMLElement[];
      if (!first || !second) throw new Error("Expected two gaps");

      fireEvent.click(within(first).getByRole("button", { name: "Add to tests" }));
      fireEvent.click(
        within(first).getByRole("button", { name: "Dismiss “Do you ship to Spain?”" }),
      );
      await waitFor(() => expect(release).toBeDefined());
      fireEvent.click(within(second).getByRole("button", { name: "Add to tests" }));
      expect(second.querySelector("form")).toBeTruthy();

      await act(async () => release?.());
      expect(await screen.findByText(/Dismissed “Do you ship to Spain\?”/)).toBeTruthy();
      await waitFor(() => expect(items()).toHaveLength(1));
      expect((items()[0] as HTMLElement).querySelector("form")).toBeTruthy();
    });

    it("opens the answer editor inline under its gap", async () => {
      installServer({
        gaps: [gap(), gap({ question: "sso?", displayQuestion: "SSO?", exampleMessageId: "m2" })],
      });
      await open("/admin/gaps");
      await screen.findByText("SSO?");
      const [, second] = screen.getAllByRole("button", { name: "Write an answer" });
      if (!second) throw new Error("Expected two gaps");
      fireEvent.click(second);
      const items = document.querySelectorAll(".gap-item");
      expect(items[1]?.querySelector("form")).toBeTruthy();
      expect(items[0]?.querySelector("form")).toBeNull();
      expect(second.getAttribute("aria-expanded")).toBe("true");
    });

    it("has no serious accessibility violations", async () => {
      installServer();
      await open("/admin/gaps");
      await screen.findByText("Do you ship to Spain?");
      fireEvent.click(screen.getByRole("button", { name: "Write an answer" }));
      await expectNoSeriousA11yViolations(document.body);
    });
  });
});
