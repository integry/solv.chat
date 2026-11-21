import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { AnswerTest, Assistant, TestRunResponse, TestRunRow } from "../src/api/types.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

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

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function installFakeServer(options?: {
  tests?: AnswerTest[];
  runResponse?: TestRunResponse | (() => Promise<TestRunResponse>);
  onPostTest?: () => Promise<void>;
  onPatchTest?: () => Promise<void>;
  onDeleteTest?: () => Promise<void>;
  runs?: TestRunRow[];
  failTestsLoad?: number;
}) {
  const assistant = makeAssistant();
  const tests: AnswerTest[] = options?.tests ? [...options.tests] : [];
  let nextId = 1;
  let testsLoadFailures = options?.failTestsLoad ?? 0;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/tests` && method === "GET") {
      if (testsLoadFailures > 0) {
        testsLoadFailures--;
        return Response.json({ error: "The database is busy." }, { status: 503 });
      }
      return Response.json({ tests: [...tests] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/test-runs` && method === "GET") {
      return Response.json({ runs: options?.runs ?? [] });
    }

    if (path === `/api/admin/assistants/${assistant.id}/tests` && method === "POST") {
      if (options?.onPostTest) await options.onPostTest();
      if (tests.length >= 25) {
        return Response.json(
          {
            error: "That is not valid.",
            fields: ["tests: an assistant can have at most 25 tests"],
          },
          { status: 400 },
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        question: string;
        expectation: AnswerTest["expectation"];
      };
      const created: AnswerTest = {
        id: `tst_${nextId++}`,
        orgId: assistant.orgId,
        assistantId: assistant.id,
        question: body.question,
        expectation: body.expectation,
        createdAt: 1_700_000_000_000 + nextId,
        latestResult: null,
      };
      tests.push(created);
      return Response.json({ test: created }, { status: 201 });
    }

    const testMatch = /^\/api\/admin\/tests\/([^/]+)$/.exec(path);
    if (testMatch?.[1]) {
      const testId = testMatch[1];
      const idx = tests.findIndex((t) => t.id === testId);
      if (idx === -1) return Response.json({ error: "Not found." }, { status: 404 });

      if (method === "PATCH") {
        if (options?.onPatchTest) await options.onPatchTest();
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          question?: string;
          expectation?: AnswerTest["expectation"];
        };
        const current = tests[idx];
        if (!current) return Response.json({ error: "Not found." }, { status: 404 });
        const updated: AnswerTest = {
          ...current,
          question: body.question ?? current.question,
          expectation: body.expectation ?? current.expectation,
        };
        tests[idx] = updated;
        return Response.json({ test: updated });
      }

      if (method === "DELETE") {
        if (options?.onDeleteTest) await options.onDeleteTest();
        const currentIdx = tests.findIndex((t) => t.id === testId);
        if (currentIdx === -1) return Response.json({ error: "Not found." }, { status: 404 });
        tests.splice(currentIdx, 1);
        return Response.json({ deleted: true });
      }
    }

    if (path === `/api/admin/assistants/${assistant.id}/test-runs` && method === "POST") {
      const res =
        typeof options?.runResponse === "function"
          ? await options.runResponse()
          : (options?.runResponse ?? {
              runId: "run_1",
              passed: true,
              results: [],
            });
      for (const result of res.results) {
        const target = tests.find((t) => t.id === result.testId);
        if (target) target.latestResult = result;
      }
      return Response.json(res, { status: 201 });
    }

    if (path === "/api/admin/overview" || path.endsWith("/overview")) {
      return Response.json({
        topQuestions: [],
        todayCostMicros: 0,
      });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { tests, fetchMock };
}

describe("Tests screen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows empty state when there are no tests", async () => {
    installFakeServer({ tests: [] });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Tests" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No tests yet" })).toBeTruthy();
    expect(screen.getByText(/Tests guard publishing\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add your first test" })).toBeTruthy();
    const runBtn = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
  });

  it("lists existing tests with their expectations and latest results", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "What does Pro cost?",
          expectation: { kind: "contains", phrase: "$29" },
          createdAt: 1_700_000_000_000,
          latestResult: {
            testId: "tst_1",
            question: "What does Pro cost?",
            expectation: { kind: "contains", phrase: "$29" },
            outcome: "passed",
            reason: 'Said "$29".',
            excerpt: "Pro costs $29 per month.",
          },
        },
        {
          id: "tst_2",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Can I get a refund?",
          expectation: { kind: "cites", url: "https://example.com/refunds" },
          createdAt: 1_700_000_000_100,
          latestResult: {
            testId: "tst_2",
            question: "Can I get a refund?",
            expectation: { kind: "cites", url: "https://example.com/refunds" },
            outcome: "failed",
            reason: "Did not cite https://example.com/refunds. Cited: nothing.",
            excerpt: "Refunds are handled case by case.",
            traceId: "msg_trace_2",
          },
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    expect(await screen.findByText("What does Pro cost?")).toBeTruthy();
    expect(screen.getByText('It must mention "$29"')).toBeTruthy();
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.getByText('Said "$29".')).toBeTruthy();

    expect(screen.getByText("Can I get a refund?")).toBeTruthy();
    expect(screen.getByText("It must link to https://example.com/refunds")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(
      screen.getByText("Did not cite https://example.com/refunds. Cited: nothing."),
    ).toBeTruthy();
    // The answer that failed is quoted next to the reason.
    expect(screen.getByText("Refunds are handled case by case.")).toBeTruthy();
    // How it was made opens from the result that kept a trace, and only there.
    const disclosures = screen.getAllByText("How this answer was made");
    expect(disclosures).toHaveLength(1);
    const row = disclosures[0]?.closest("tr") as HTMLElement;
    expect(within(row).getByText("Can I get a refund?")).toBeTruthy();
  });

  it("adds each of the four expectations and shows the extra field only when needed", async () => {
    const server = installFakeServer({ tests: [] });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByRole("heading", { name: "Tests" });

    // 1. contains ("It must mention")
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    expect(screen.getByText("The answer has to include these words.")).toBeTruthy();
    expect(screen.getByLabelText("Words")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Q1?" },
    });
    fireEvent.change(screen.getByLabelText("Words"), {
      target: { value: "hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));
    expect(await screen.findByText("Q1?")).toBeTruthy();

    // 2. notContains ("It must not mention")
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.change(screen.getByLabelText("What the answer must do"), {
      target: { value: "notContains" },
    });
    expect(screen.getByText("The answer must never include these words.")).toBeTruthy();
    expect(screen.getByLabelText("Words")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Q2?" } });
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));
    expect(await screen.findByText("Q2?")).toBeTruthy();

    // 3. cites ("It must link to")
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.change(screen.getByLabelText("What the answer must do"), {
      target: { value: "cites" },
    });
    expect(screen.getByText("The answer has to link to this page or use it.")).toBeTruthy();
    expect(screen.getByLabelText("Page address")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Q3?" } });
    fireEvent.change(screen.getByLabelText("Page address"), {
      target: { value: "https://example.com/docs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));
    expect(await screen.findByText("Q3?")).toBeTruthy();

    // 4. declines ("It must say it does not know") -> no extra field
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.change(screen.getByLabelText("What the answer must do"), {
      target: { value: "declines" },
    });
    expect(screen.getByText("For questions your site should not answer.")).toBeTruthy();
    expect(screen.queryByLabelText("Words")).toBeNull();
    expect(screen.queryByLabelText("Page address")).toBeNull();
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Q4?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));
    expect(await screen.findByText("Q4?")).toBeTruthy();

    expect(server.tests.map((t) => t.expectation)).toEqual([
      { kind: "contains", phrase: "hello" },
      { kind: "notContains", phrase: "secret" },
      { kind: "cites", url: "https://example.com/docs" },
      { kind: "declines" },
    ]);
  });

  it("edits and deletes a test", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Old question?",
          expectation: { kind: "contains", phrase: "old" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    expect(await screen.findByText("Old question?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Old question?" }));

    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Updated question?" },
    });
    fireEvent.change(screen.getByLabelText("Words"), {
      target: { value: "updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    expect(await screen.findByText("Updated question?")).toBeTruthy();
    expect(screen.getByText('It must mention "updated"')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete test: Updated question?" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this test?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete test" }));
    await waitFor(() => {
      expect(screen.queryByText("Updated question?")).toBeNull();
    });
    expect(await screen.findByText("Test deleted.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No tests yet" })).toBeTruthy();
  });

  it("runs all tests with progress state, mixed outcomes, and stopped-early notice", async () => {
    const deferred = createDeferred<TestRunResponse>();
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Pass question?",
          expectation: { kind: "contains", phrase: "yes" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
        {
          id: "tst_2",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Fail question?",
          expectation: { kind: "contains", phrase: "never" },
          createdAt: 1_700_000_000_100,
          latestResult: null,
        },
        {
          id: "tst_3",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Skipped question?",
          expectation: { kind: "declines" },
          createdAt: 1_700_000_000_200,
          latestResult: null,
        },
      ],
      runResponse: () => deferred.promise,
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Pass question?");
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(screen.getByText("Running tests against your draft…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Running…" })).toBeTruthy();

    deferred.resolve({
      runId: "run_1",
      passed: false,
      stopped: "The run took too long and stopped early.",
      results: [
        {
          testId: "tst_1",
          question: "Pass question?",
          expectation: { kind: "contains", phrase: "yes" },
          outcome: "passed",
          reason: 'Said "yes".',
          excerpt: "Yes, we support that.",
        },
        {
          testId: "tst_2",
          question: "Fail question?",
          expectation: { kind: "contains", phrase: "never" },
          outcome: "failed",
          reason: 'Did not say "never".',
          excerpt: "Here is the answer.",
        },
        {
          testId: "tst_3",
          question: "Skipped question?",
          expectation: { kind: "declines" },
          outcome: "not_run",
          reason: "The run took too long and stopped early.",
          excerpt: "",
        },
      ],
    });

    expect(await screen.findByText("Passed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Not run")).toBeTruthy();
    expect(screen.getByText('Said "yes".')).toBeTruthy();
    expect(screen.getByText('Did not say "never".')).toBeTruthy();
    expect(screen.getByText("Here is the answer.")).toBeTruthy();
    expect(
      screen.getAllByText("The run took too long and stopped early.").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("displays the test-limit validation error when creating a 26th test", async () => {
    const existing: AnswerTest[] = Array.from({ length: 25 }, (_, i) => ({
      id: `tst_${i + 1}`,
      orgId: "org_00000000000000000000",
      assistantId: "ast_1",
      question: `Existing question ${i + 1}?`,
      expectation: { kind: "declines" as const },
      createdAt: 1_700_000_000_000 + i,
      latestResult: null,
    }));
    installFakeServer({ tests: existing });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Existing question 1?");
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "One too many?" },
    });
    fireEvent.change(screen.getByLabelText("Words"), {
      target: { value: "limit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("an assistant can have at most 25 tests");
    expect(screen.queryByText("One too many?")).toBeNull();
  });

  it("clears stale run and server results when a test is edited", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "What does Pro cost?",
          expectation: { kind: "contains", phrase: "$29" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
      runResponse: {
        runId: "run_1",
        passed: true,
        results: [
          {
            testId: "tst_1",
            question: "What does Pro cost?",
            expectation: { kind: "contains", phrase: "$29" },
            outcome: "passed",
            reason: 'Said "$29".',
            excerpt: "Pro costs $29 per month.",
          },
        ],
      },
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("What does Pro cost?");
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("Passed")).toBeTruthy();
    expect(screen.getByText('Said "$29".')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit test: What does Pro cost?" }));
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "$99" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    expect(await screen.findByText('It must mention "$99"')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Passed")).toBeNull();
    });
    expect(screen.queryByText('Said "$29".')).toBeNull();
    expect(screen.getByText("Not run yet")).toBeTruthy();
  });

  it("ignores a server latestResult whose question or expectation no longer matches", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "What does Pro cost?",
          expectation: { kind: "contains", phrase: "$99" },
          createdAt: 1_700_000_000_000,
          latestResult: {
            testId: "tst_1",
            question: "What does Pro cost?",
            expectation: { kind: "contains", phrase: "$29" },
            outcome: "passed",
            reason: 'Said "$29".',
            excerpt: "Pro costs $29 per month.",
          },
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    expect(await screen.findByText('It must mention "$99"')).toBeTruthy();
    expect(screen.getByText("Not run yet")).toBeTruthy();
    expect(screen.queryByText("Passed")).toBeNull();
    expect(screen.queryByText('Said "$29".')).toBeNull();
  });

  it("does not close a newer edit session when an earlier edit save finishes", async () => {
    const firstPatch = createDeferred<void>();
    let patchCount = 0;
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question A?",
          expectation: { kind: "contains", phrase: "alpha" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
        {
          id: "tst_2",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question B?",
          expectation: { kind: "contains", phrase: "beta" },
          createdAt: 1_700_000_000_100,
          latestResult: null,
        },
      ],
      onPatchTest: async () => {
        patchCount++;
        if (patchCount === 1) await firstPatch.promise;
      },
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Question A?");
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Question A?" }));
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "alpha-updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    // While A's save is in flight, switch to editing B and enter changes.
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Question B?" }));
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Question B?");
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "beta-draft" } });

    firstPatch.resolve();
    expect(await screen.findByText('It must mention "alpha-updated"')).toBeTruthy();

    // B's editor must still be open with its unsaved changes.
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Question B?");
    expect((screen.getByLabelText("Words") as HTMLInputElement).value).toBe("beta-draft");
  });

  it("does not close a newer add session when an earlier add save finishes", async () => {
    const firstPost = createDeferred<void>();
    let postCount = 0;
    installFakeServer({
      tests: [
        {
          id: "tst_0",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Existing?",
          expectation: { kind: "declines" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
      onPostTest: async () => {
        postCount++;
        if (postCount === 1) await firstPost.promise;
      },
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Existing?");
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "First question?" } });
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    // Leave the add form (Cancel is disabled mid-save, so via Edit) and open a new one
    // while the first save is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Existing?" }));
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.change(screen.getByLabelText("Question"), { target: { value: "Second draft?" } });

    firstPost.resolve();
    expect(await screen.findByText("First question?")).toBeTruthy();
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe("Second draft?");
  });

  it("preserves edits completed on another test while a delete is in flight", async () => {
    const deleteDeferred = createDeferred<void>();
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question A?",
          expectation: { kind: "contains", phrase: "alpha" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
        {
          id: "tst_2",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question B?",
          expectation: { kind: "contains", phrase: "beta" },
          createdAt: 1_700_000_000_100,
          latestResult: null,
        },
      ],
      onDeleteTest: async () => {
        await deleteDeferred.promise;
      },
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Question A?");
    fireEvent.click(screen.getByRole("button", { name: "Delete test: Question A?" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this test?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete test" }));

    // While A's delete is pending, edit and save B.
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Question B?" }));
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Question B updated?" },
    });
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "beta-updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    expect(await screen.findByText("Question B updated?")).toBeTruthy();
    expect(screen.getByText('It must mention "beta-updated"')).toBeTruthy();

    // Now let A's delete complete; B's saved changes must remain intact.
    deleteDeferred.resolve();
    await waitFor(() => {
      expect(screen.queryByText("Question A?")).toBeNull();
    });
    expect(screen.getByText("Question B updated?")).toBeTruthy();
    expect(screen.getByText('It must mention "beta-updated"')).toBeTruthy();
  });

  it("preserves unsaved input when reopening the same test while an earlier save finishes", async () => {
    const firstPatch = createDeferred<void>();
    let patchCount = 0;
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question A?",
          expectation: { kind: "contains", phrase: "alpha" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
      onPatchTest: async () => {
        patchCount++;
        if (patchCount === 1) await firstPatch.promise;
      },
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Question A?");
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Question A?" }));
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "alpha-updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save test" }));

    // Leave the editor via Add test, then reopen the same test and enter new unsaved input.
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit test: Question A?" }));
    fireEvent.change(screen.getByLabelText("Question"), {
      target: { value: "Question A newer draft?" },
    });
    fireEvent.change(screen.getByLabelText("What the answer must do"), {
      target: { value: "notContains" },
    });
    fireEvent.change(screen.getByLabelText("Words"), { target: { value: "alpha-newer-draft" } });

    firstPatch.resolve();
    expect(await screen.findByText("Test saved.")).toBeTruthy();

    // The newer session for the same test must still be open with its unsaved input.
    expect((screen.getByLabelText("Question") as HTMLInputElement).value).toBe(
      "Question A newer draft?",
    );
    expect((screen.getByLabelText("What the answer must do") as HTMLSelectElement).value).toBe(
      "notContains",
    );
    expect((screen.getByLabelText("Words") as HTMLInputElement).value).toBe("alpha-newer-draft");
  });

  it("shows each test as a table row with the result badge in its own Result cell", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question A?",
          expectation: { kind: "contains", phrase: "alpha" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    const table = await screen.findByRole("table", { name: "Tests" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual(["Question", "Result", "What it answered", "Actions"]);
    const badge = within(table).getByText("Not run yet");
    expect(badge.closest("td")?.getAttribute("data-label")).toBe("Result");
    const row = badge.closest("tr") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Edit test: Question A?" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Delete test: Question A?" })).toBeTruthy();
  });

  it("shows when the tests last ran, from stored runs and after Run now", async () => {
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question A?",
          expectation: { kind: "contains", phrase: "alpha" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
      runs: [
        {
          id: "run_old",
          versionId: "ver_1",
          startedAt: twoHoursAgo - 3600 * 1000,
          results: [],
          passed: true,
        },
        { id: "run_new", versionId: "ver_1", startedAt: twoHoursAgo, results: [], passed: false },
      ],
      runResponse: {
        runId: "run_2",
        passed: true,
        results: [
          {
            testId: "tst_1",
            question: "Question A?",
            expectation: { kind: "contains", phrase: "alpha" },
            outcome: "passed",
            reason: 'Said "alpha".',
            excerpt: "alpha",
          },
        ],
      },
    });
    window.history.replaceState(null, "", "/admin/tests");
    const { container } = render(<App />);

    expect(await screen.findByText("2 hours ago")).toBeTruthy();
    expect(container.querySelector(".test-summary")?.textContent).toContain("Last run");

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("All tests passed.")).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector(".test-summary")?.textContent).toMatch(
        /Last run (now|\d+ seconds? ago).*1 passed/,
      );
    });
  });

  it("says the tests have not run when there are no stored runs", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Question A?",
          expectation: { kind: "declines" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);
    expect(await screen.findByText(/Not run yet\. Press Run now/)).toBeTruthy();
  });

  it("sends no DELETE when the owner cancels the confirmation", async () => {
    const server = installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Keep me?",
          expectation: { kind: "declines" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete test: Keep me?" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this test?" });
    expect(within(dialog).getByText(/"Keep me\?" will no longer be checked/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(server.fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(screen.getByText("Keep me?")).toBeTruthy();
  });

  it("opens the add form from the empty state", async () => {
    installFakeServer({ tests: [] });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add your first test" }));
    expect(screen.getByLabelText("Question")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No tests yet" })).toBeNull();
  });

  it("shows an error with Try again when the tests cannot load, and recovers", async () => {
    installFakeServer({
      failTestsLoad: 1,
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Back again?",
          expectation: { kind: "declines" },
          createdAt: 1_700_000_000_000,
          latestResult: null,
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    expect(await screen.findByText("Could not load your tests.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Back again?")).toBeTruthy();
  });

  it("has no serious accessibility problems with results and the delete dialog open", async () => {
    installFakeServer({
      tests: [
        {
          id: "tst_1",
          orgId: "org_00000000000000000000",
          assistantId: "ast_1",
          question: "Can I get a refund?",
          expectation: { kind: "contains", phrase: "30 days" },
          createdAt: 1_700_000_000_000,
          latestResult: {
            testId: "tst_1",
            question: "Can I get a refund?",
            expectation: { kind: "contains", phrase: "30 days" },
            outcome: "failed",
            reason: 'Did not say "30 days".',
            excerpt: "Ask support.",
          },
        },
      ],
    });
    window.history.replaceState(null, "", "/admin/tests");
    render(<App />);

    await screen.findByText("Ask support.");
    await expectNoSeriousA11yViolations(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Delete test: Can I get a refund?" }));
    await screen.findByRole("dialog", { name: "Delete this test?" });
    await expectNoSeriousA11yViolations(document.body);
  });
});
