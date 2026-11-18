import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, AssistantReport, ResponseTimePeriod } from "../src/api/types.js";

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

const SEEDED_REPORT: AssistantReport = {
  days: 30,
  from: "2026-10-16",
  to: "2026-11-15",
  questions: 42,
  replies: 40,
  answeredShare: 0.754,
  thumbsDownShare: 0.125,
  costMicros: 5_000,
  topQuestions: [
    { question: '=SUM(A1:A2), "pricing"?\nDetails', count: 8 },
    { question: "How do I reset my password?", count: 5 },
  ],
  topGaps: [{ question: "Do you support SAML?", count: 3 }],
  topSources: [
    { url: "https://docs.example.com/pricing", title: "Pricing", count: 12 },
    { url: "javascript:alert(1)", title: "Unsafe page", count: 2 },
  ],
  uncitedSources: [{ url: "https://docs.example.com/changelog", title: "Changelog" }],
  uncitedTotal: 4,
};

function installFakeServer(options?: {
  report?: AssistantReport | ((days: number) => AssistantReport | Promise<Response>);
}) {
  const assistant = makeAssistant();
  const calls: Array<{ path: string; search: string }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url, "https://example.com");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ path: parsed.pathname, search: parsed.search });

    if (parsed.pathname === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }

    if (parsed.pathname === `/api/admin/assistants/${assistant.id}/overview` && method === "GET") {
      return Response.json({
        topQuestions: [],
        todayCostMicros: 0,
      });
    }

    if (parsed.pathname === `/api/admin/assistants/${assistant.id}/report` && method === "GET") {
      const days = Number(parsed.searchParams.get("days") ?? 30);
      if (typeof options?.report === "function") {
        const result = await options.report(days);
        if (result instanceof Response) return result;
        return Response.json(result);
      }
      return Response.json(options?.report ?? SEEDED_REPORT);
    }

    if (parsed.pathname === "/api/admin/session" && method === "GET") {
      return Response.json({ authenticated: true });
    }

    return new Response("Not found", { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

describe("Reports screen", () => {
  beforeEach(() => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it("renders seeded figures, explanations, tables, and and-N-more", async () => {
    installFakeServer({ report: SEEDED_REPORT });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));

    expect(await screen.findByRole("heading", { name: "Reports" })).toBeTruthy();
    expect(
      screen.getByText("How your assistant did from 16 Oct 2026 to 15 Nov 2026."),
    ).toBeTruthy();

    // Four stat cards with Overview formatting and plain explanations.
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("How many questions visitors asked in this period.")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(
      screen.getByText("Share of answers your assistant could give from your content."),
    ).toBeTruthy();
    expect(screen.getByText("13%")).toBeTruthy();
    expect(screen.getByText("Share of answers a visitor said did not help.")).toBeTruthy();
    expect(screen.getByText("< $0.01")).toBeTruthy();
    expect(screen.getByText("Estimated cost for this period.")).toBeTruthy();

    // Four tables.
    expect(screen.getByText("How do I reset my password?")).toBeTruthy();
    expect(screen.getByText("Do you support SAML?")).toBeTruthy();
    const pricingLink = screen.getByRole("link", { name: "Pricing" });
    expect(pricingLink.getAttribute("href")).toBe("https://docs.example.com/pricing");
    // Unsafe URLs are rendered as text, not links.
    expect(screen.queryByRole("link", { name: "Unsafe page" })).toBeNull();
    expect(screen.getByText("Unsafe page")).toBeTruthy();
    expect(screen.getByText("Changelog")).toBeTruthy();
    expect(screen.getByText("and 3 more")).toBeTruthy();
  });

  it("omits and-N-more when uncitedTotal matches the list length", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        uncitedTotal: 1,
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
    await screen.findByText("Changelog");
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
  });

  it("refetches when the period changes and updates the heading", async () => {
    const server = installFakeServer({
      report: (days) => ({
        ...SEEDED_REPORT,
        days: days as 7 | 30 | 90,
        from: days === 7 ? "2026-11-08" : "2026-08-17",
        to: "2026-11-15",
      }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
    await screen.findByText("How your assistant did from 17 Aug 2026 to 15 Nov 2026.");

    fireEvent.click(await screen.findByRole("radio", { name: "7 days" }));
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.path.endsWith("/report") && call.search.includes("days=7"),
        ),
      ).toBe(true),
    );
    expect(
      await screen.findByText("How your assistant did from 8 Nov 2026 to 15 Nov 2026."),
    ).toBeTruthy();
  });

  it("downloads a CSV holding every figure and row without a second request, then revokes the object URL", async () => {
    const server = installFakeServer({ report: SEEDED_REPORT });
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:report";
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };

    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
      const downloadBtn = await screen.findByRole("button", { name: "Download CSV" });
      const reportCallsBefore = server.calls.filter((c) => c.path.endsWith("/report")).length;

      fireEvent.click(downloadBtn);

      const reportCallsAfter = server.calls.filter((c) => c.path.endsWith("/report")).length;
      expect(reportCallsAfter).toBe(reportCallsBefore);
      expect(blobs).toHaveLength(1);

      const text = await blobs[0]?.text();
      expect(text).toContain("Report 2026-10-16 to 2026-11-15");
      expect(text).toContain(`"Questions asked","42"`);
      expect(text).toContain(`"Answered share","75%"`);
      expect(text).toContain(`"Marked not helpful","13%"`);
      expect(text).toContain(`"Cost","< $0.01"`);
      expect(text).toContain("Most asked questions");
      expect(text).toContain(`"'=SUM(A1:A2), ""pricing""?\nDetails","8"`);
      expect(text).toContain("Most often unanswered");
      expect(text).toContain("Do you support SAML?");
      expect(text).toContain("Pages used most");
      expect(text).toContain("https://docs.example.com/pricing");
      expect(text).toContain("Pages never used");
      expect(text).toContain("Changelog");
      expect(revoked).toEqual(["blob:report"]);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it("shows empty state and no download button when there is no traffic", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        questions: 0,
        replies: 0,
        answeredShare: 0,
        thumbsDownShare: 0,
        costMicros: 0,
        topQuestions: [],
        topGaps: [],
        topSources: [],
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
    expect(
      await screen.findByRole("heading", { name: "Nothing yet for this period" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Once visitors ask questions, their answers show up here."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("preserves cost figure and CSV export when message counts are zero and cost is positive", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        questions: 0,
        replies: 0,
        answeredShare: 0,
        thumbsDownShare: 0,
        costMicros: 250_000,
        topQuestions: [],
        topGaps: [],
        topSources: [],
      },
    });
    const blobs: Blob[] = [];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:report-cost-only";
    };
    URL.revokeObjectURL = () => {};

    try {
      render(<App />);

      fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
      expect(await screen.findByText("$0.25")).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Nothing yet for this period" })).toBeNull();

      const downloadBtn = screen.getByRole("button", { name: "Download CSV" });
      fireEvent.click(downloadBtn);

      expect(blobs).toHaveLength(1);
      const text = await blobs[0]?.text();
      expect(text).toContain(`"Questions asked","0"`);
      expect(text).toContain(`"Cost","$0.25"`);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it("shows loading and error states", async () => {
    let resolveReport!: (res: Response) => void;
    installFakeServer({
      report: () =>
        new Promise<Response>((resolve) => {
          resolveReport = resolve;
        }),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
    expect(await screen.findByText("Loading report…")).toBeTruthy();

    resolveReport(Response.json({ error: "Report failed" }, { status: 500 }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Report failed")).toBeTruthy();
  });

  it("hides stale report and prevents CSV export while a period change is pending", async () => {
    let resolveSevenDay!: (res: Response) => void;
    installFakeServer({
      report: (days) => {
        if (days === 7) {
          return new Promise<Response>((resolve) => {
            resolveSevenDay = resolve;
          });
        }
        return SEEDED_REPORT;
      },
    });
    const blobs: Blob[] = [];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:report-transition";
    };
    URL.revokeObjectURL = () => {};

    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
      expect(
        await screen.findByText("How your assistant did from 16 Oct 2026 to 15 Nov 2026."),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();

      fireEvent.click(screen.getByRole("radio", { name: "7 days" }));

      expect(await screen.findByText("Loading report…")).toBeTruthy();
      expect(screen.getByText("How your assistant did over time.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
      expect(blobs).toHaveLength(0);

      resolveSevenDay(
        Response.json({
          ...SEEDED_REPORT,
          days: 7,
          from: "2026-11-08",
          to: "2026-11-15",
          questions: 11,
        }),
      );

      expect(
        await screen.findByText("How your assistant did from 8 Nov 2026 to 15 Nov 2026."),
      ).toBeTruthy();
      expect(screen.getByText("11")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      expect(blobs).toHaveLength(1);
      const text = await blobs[0]?.text();
      expect(text).toContain("Report 2026-11-08 to 2026-11-15");
      expect(text).toContain(`"Questions asked","11"`);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it("renders count pills as .badge elements inside .row-item rows", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        topQuestions: [
          {
            question:
              "Can you explain in great detail how enterprise billing, invoicing, and annual renewals work?",
            count: 9,
          },
        ],
      },
    });
    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
    const pill = await screen.findByText("9 times");
    expect(pill.classList.contains("badge")).toBe(true);
    expect(pill.closest(".row-item")).toBeTruthy();
    const badges = container.querySelectorAll(".row-item > .badge");
    expect(badges.length).toBeGreaterThanOrEqual(3);
  });
});

const RESPONSE_TIME: ResponseTimePeriod = {
  days: 30,
  from: "2026-10-16",
  to: "2026-11-15",
  status: "measured",
  answers: 40,
  pageActionAnswers: 0,
  timed: 40,
  firstTokenMedianMs: 820,
  firstTokenP90Ms: 2_450,
  totalMedianMs: 6_100,
  previous: {
    from: "2026-09-16",
    to: "2026-10-15",
    status: "measured",
    answers: 30,
    pageActionAnswers: 0,
    timed: 28,
    firstTokenMedianMs: 1_240,
    firstTokenP90Ms: 2_430,
    totalMedianMs: 5_800,
  },
};

describe("Reports response time", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/admin");
  });

  it("shows the three waits in plain words, each against the 30 days before", async () => {
    installFakeServer({ report: { ...SEEDED_REPORT, responseTime: RESPONSE_TIME } });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));

    const section = await screen.findByRole("region", { name: "Response time" });
    expect(section.textContent).toContain("Try it and tests are not counted.");
    expect(section.textContent).not.toMatch(/TTFT|token|percentile/i);

    const starts = screen.getByRole("region", { name: "Answer starts appearing" });
    expect(starts.textContent).toContain("0.8 s");
    expect(starts.textContent).toContain("0.4 s faster than the 30 days before");
    expect(starts.textContent).toContain("Typical time until the answer starts appearing.");
    // 2.45 s and 2.43 s are compared as shown: "2.5 s" against "2.4 s".
    const slowest = screen.getByRole("region", { name: "Slowest 1 in 10 start after" });
    expect(slowest.textContent).toContain("2.5 s");
    expect(slowest.textContent).toContain("0.1 s slower than the 30 days before");
    const full = screen.getByRole("region", { name: "Full answer" });
    expect(full.textContent).toContain("6.1 s");
    expect(full.textContent).toContain("0.3 s slower than the 30 days before");
  });

  it("says why there is no number when most answers have no timing", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        responseTime: {
          ...RESPONSE_TIME,
          status: "mostly_untimed",
          timed: 3,
          firstTokenMedianMs: null,
          firstTokenP90Ms: null,
          totalMedianMs: null,
          previous: { ...RESPONSE_TIME.previous, status: "no_answers", answers: 0, timed: 0 },
        },
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));

    const section = await screen.findByRole("region", { name: "Response time" });
    expect(section.textContent).toContain(
      "Most answers in this period are from before answer times were recorded, so a number would mislead.",
    );
    const starts = screen.getByRole("region", { name: "Answer starts appearing" });
    expect(starts.textContent).toContain("Not measured");
    expect(starts.textContent).not.toMatch(/\d+(\.\d)? s/);
    expect(starts.textContent).not.toContain("than the 30 days before");
  });

  it("says answers that used a page action are left out, and why", async () => {
    installFakeServer({
      report: { ...SEEDED_REPORT, responseTime: { ...RESPONSE_TIME, pageActionAnswers: 5 } },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));

    const section = await screen.findByRole("region", { name: "Response time" });
    expect(section.textContent).toContain(
      "5 answers that used a page action are not counted, because their time stops at the page action.",
    );
    const full = screen.getByRole("region", { name: "Full answer" });
    expect(full.textContent).toContain("6.1 s");
  });

  it("says every answer used a page action instead of calling them old", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        responseTime: {
          ...RESPONSE_TIME,
          status: "page_actions_only",
          answers: 0,
          pageActionAnswers: 4,
          timed: 0,
          firstTokenMedianMs: null,
          firstTokenP90Ms: null,
          totalMedianMs: null,
        },
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));

    const section = await screen.findByRole("region", { name: "Response time" });
    expect(section.textContent).toContain(
      "Every answer in this period used a page action. Those are not counted, because their time stops at the page action.",
    );
    expect(section.textContent).not.toContain("before answer times were recorded");
    expect(section.textContent).not.toContain("4 answers that used a page action");
    const full = screen.getByRole("region", { name: "Full answer" });
    expect(full.textContent).toContain("Not measured");
    expect(full.textContent).not.toMatch(/\d+(\.\d)? s/);
  });

  it("notes a previous period with no figure instead of comparing with it", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        responseTime: {
          ...RESPONSE_TIME,
          previous: {
            ...RESPONSE_TIME.previous,
            status: "mostly_untimed",
            firstTokenMedianMs: null,
            firstTokenP90Ms: null,
            totalMedianMs: null,
          },
        },
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
    const starts = await screen.findByRole("region", { name: "Answer starts appearing" });
    expect(starts.textContent).toContain("0.8 s");
    expect(starts.textContent).toContain("No figure for the 30 days before");
  });

  it("puts the three waits and the period before in the CSV", async () => {
    installFakeServer({
      report: {
        ...SEEDED_REPORT,
        responseTime: {
          ...RESPONSE_TIME,
          previous: {
            ...RESPONSE_TIME.previous,
            status: "mostly_untimed",
            firstTokenMedianMs: null,
            firstTokenP90Ms: null,
            totalMedianMs: null,
          },
        },
      },
    });
    const blobs: Blob[] = [];
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:report";
    };
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("link", { name: "Reports" }));
      fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }));
      const text = (await blobs[0]?.text()) ?? "";
      const lines = text.split("\r\n");
      const start = lines.indexOf(`"Response time"`);
      expect(start).toBeGreaterThan(-1);
      expect(lines.slice(start + 1, start + 5)).toEqual([
        `"Figure","This period","The 30 days before"`,
        `"Answer starts appearing","0.8 s","Not measured"`,
        `"Slowest 1 in 10 start after","2.5 s","Not measured"`,
        `"Full answer","6.1 s","Not measured"`,
      ]);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});
