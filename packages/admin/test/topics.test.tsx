import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, AssistantReport, TopicItem } from "../src/api/types.js";

const HOURS = "top_hours000000000000000";
const REFUNDS = "top_refunds0000000000000";
const UNSAFE = "top_unsafe00000000000000";

function makeAssistant(): Assistant {
  return {
    id: "ast_1",
    orgId: "org_00000000000000000000",
    name: "Docs Bot",
    publicKey: "pk_ast_1",
    allowedOrigins: [],
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

function makeReport(overrides: Partial<AssistantReport> = {}): AssistantReport {
  return {
    days: 30,
    from: "2026-10-16",
    to: "2026-11-15",
    questions: 12,
    replies: 12,
    answeredShare: 0.75,
    thumbsDownShare: 0,
    costMicros: 5_000,
    topQuestions: [{ question: "when are you open?", count: 4 }],
    topGaps: [
      { question: "open on sunday?", count: 2, topic: { id: HOURS, name: "Opening hours" } },
      { question: "do you ship?", count: 1, topic: null },
    ],
    topics: {
      reviewAnswers: true,
      rows: [
        { id: HOURS, name: "Opening hours", questions: 8, unanswered: 2, unansweredShare: 0.25 },
        { id: REFUNDS, name: "Refunds", questions: 3, unanswered: 0, unansweredShare: 0 },
        {
          id: UNSAFE,
          name: '=cmd <img src=x onerror="alert(1)">',
          questions: 1,
          unanswered: 1,
          unansweredShare: 1,
        },
      ],
    },
    topSources: [],
    uncitedSources: [],
    uncitedTotal: 0,
    ...overrides,
  };
}

function installFakeServer(options: { report?: AssistantReport; topics?: TopicItem[] } = {}) {
  const assistant = makeAssistant();
  let topics: TopicItem[] = options.topics ?? [
    { id: HOURS, name: "Opening hours", createdAt: 1 },
    { id: REFUNDS, name: "Refunds", createdAt: 2 },
  ];
  const calls: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const base = `/api/admin/assistants/${assistant.id}`;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url, "https://example.com");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: parsed.pathname, search: parsed.search, body });

    if (parsed.pathname === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }
    if (parsed.pathname === "/api/admin/session") return Response.json({ authenticated: true });
    if (parsed.pathname === `${base}/report`) return Response.json(options.report ?? makeReport());
    if (parsed.pathname === `${base}/topics` && method === "GET") {
      return Response.json({ topics, reviewAnswers: true });
    }
    if (parsed.pathname === `${base}/conversations`) {
      return Response.json({
        conversations: [],
        total: 0,
        limit: 25,
        offset: 0,
        searchPending: false,
      });
    }
    const topicMatch = /\/topics\/([^/]+)(\/merge)?$/.exec(parsed.pathname);
    if (topicMatch) {
      const id = topicMatch[1];
      if (method === "PATCH") {
        const name = (body as { name: string }).name;
        if (name.includes("@")) {
          return Response.json(
            {
              error: "That is not valid.",
              fields: ["name: must not contain an address, an email or a long number"],
            },
            { status: 400 },
          );
        }
        topics = topics.map((t) => (t.id === id ? { ...t, name } : t));
        return Response.json({ topic: topics.find((t) => t.id === id) });
      }
      if (method === "POST" && topicMatch[2]) {
        topics = topics.filter((t) => t.id !== id);
        return Response.json({ topic: topics[0] });
      }
      if (method === "DELETE") {
        topics = topics.filter((t) => t.id !== id);
        return Response.json({ deleted: true });
      }
    }
    return new Response("Not found", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

async function openReports() {
  render(<App />);
  fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
  return screen.findByRole("region", { name: "Topics" });
}

describe("Topics", () => {
  beforeEach(() => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it("lists the period's topics, each opening Conversations filtered to it for the period", async () => {
    installFakeServer();
    const section = await openReports();
    const links = within(section).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Opening hours",
      "Refunds",
      '=cmd <img src=x onerror="alert(1)">',
    ]);
    // A name is text, never markup.
    expect(section.querySelector("img")).toBeNull();
    const href = new URL(links[0]?.getAttribute("href") ?? "", "https://example.com");
    expect(href.pathname).toBe("/admin/conversations");
    expect(Object.fromEntries(href.searchParams)).toEqual({
      topic: HOURS,
      askedFrom: "2026-10-16",
      askedTo: "2026-11-15",
      assistant: "ast_1",
    });
    expect(within(section).getByText("8 questions")).toBeTruthy();
    expect(within(section).getByText("25% not answered")).toBeTruthy();

    // "Most often unanswered" names each question's topic.
    const gaps = screen.getByRole("region", { name: "Most often unanswered" });
    expect(within(gaps).getByText("Opening hours")).toBeTruthy();
    expect(within(gaps).getAllByText("Topic:")).toHaveLength(1);
  });

  it("explains an empty list when Review answers is off", async () => {
    installFakeServer({ report: makeReport({ topics: { reviewAnswers: false, rows: [] } }) });
    const section = await openReports();
    expect(
      within(section).getByText(
        "Review answers is off in Settings, so new questions get no topic. Turn it on to see topics here.",
      ),
    ).toBeTruthy();
    expect(within(section).queryAllByRole("link")).toEqual([]);
  });

  it("puts the topics and each unanswered question's topic in the CSV, guarded like the rest", async () => {
    installFakeServer();
    const blobs: Blob[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:report";
    };
    URL.revokeObjectURL = () => {};
    try {
      await openReports();
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      const lines = ((await blobs[0]?.text()) ?? "").split("\r\n");
      const start = lines.indexOf(`"Topics"`);
      expect(lines.slice(start + 1, start + 5)).toEqual([
        `"Topic","Questions","Could not answer"`,
        `"Opening hours","8","25%"`,
        `"Refunds","3","0%"`,
        `"'=cmd <img src=x onerror=""alert(1)"">","1","100%"`,
      ]);
      const gaps = lines.indexOf(`"Most often unanswered"`);
      expect(lines.slice(gaps + 1, gaps + 4)).toEqual([
        `"Question","Topic","Times"`,
        `"open on sunday?","Opening hours","2"`,
        `"do you ship?","","1"`,
      ]);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("renames, merges and deletes topics from Manage topics, reading the report again", async () => {
    const server = installFakeServer();
    const section = await openReports();
    fireEvent.click(within(section).getByRole("button", { name: "Manage topics" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage topics" });
    await within(dialog).findByText("Opening hours");
    const reportReads = () => server.calls.filter((c) => c.path.endsWith("/report")).length;
    const before = reportReads();

    // Rename, with the engine's refusal shown beside the field.
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Opening hours" }));
    const input = within(dialog).getByLabelText("New name for Opening hours");
    fireEvent.change(input, { target: { value: "jane@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText("must not contain an address, an email or a long number"),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "Hours" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText("Hours");
    expect(server.calls.find((c) => c.method === "PATCH" && c.body)?.path).toBe(
      `/api/admin/assistants/ast_1/topics/${HOURS}`,
    );

    // Merge Refunds into Hours.
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge Refunds" }));
    fireEvent.change(within(dialog).getByLabelText("Merge “Refunds” into"), {
      target: { value: HOURS },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(within(dialog).queryByText("Refunds")).toBeNull());
    expect(server.calls.find((c) => c.path.endsWith("/merge"))).toMatchObject({
      method: "POST",
      path: `/api/admin/assistants/ast_1/topics/${REFUNDS}/merge`,
      body: { into: HOURS },
    });

    // Delete, after saying what happens to its questions.
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Hours" }));
    expect(
      within(dialog).getByText("Delete “Hours”? Its questions will have no topic."),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText("No topics yet.")).toBeTruthy();
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(true);
    await waitFor(() => expect(reportReads()).toBeGreaterThanOrEqual(before + 3));
  });

  it("filters Conversations by topic and keeps the choice in the address", async () => {
    const server = installFakeServer();
    window.history.pushState(null, "", "/admin/conversations?assistant=ast_1");
    render(<App />);
    const select = (await screen.findByLabelText("Topic")) as HTMLSelectElement;
    await within(select).findByRole("option", { name: "Refunds" });
    fireEvent.change(select, { target: { value: REFUNDS } });
    await waitFor(() =>
      expect(
        server.calls.some(
          (c) => c.path.endsWith("/conversations") && c.search.includes(`topic=${REFUNDS}`),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(window.location.search).toContain(`topic=${REFUNDS}`));
  });

  it("opens a topic link from Reports with its period, and removes it in one click", async () => {
    const server = installFakeServer();
    window.history.pushState(
      null,
      "",
      `/admin/conversations?topic=${HOURS}&askedFrom=2026-10-16&askedTo=2026-11-15&assistant=ast_1`,
    );
    render(<App />);
    expect(
      await screen.findByText("Topic: “Opening hours” from 16 Oct 2026 to 15 Nov 2026"),
    ).toBeTruthy();
    const listCall = server.calls.find((c) => c.path.endsWith("/conversations"));
    const sent = new URLSearchParams(listCall?.search);
    expect([sent.get("topic"), sent.get("askedFrom"), sent.get("askedTo")]).toEqual([
      HOURS,
      "2026-10-16",
      "2026-11-15",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove “Topic: Opening hours”" }));
    await waitFor(() => expect(window.location.search).not.toContain("topic="));
  });
});
