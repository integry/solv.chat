import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, SourceSummary } from "../src/api/types.js";
import { RECENT_CHANGES_TEXT } from "../src/screens/RecentChangesNotice.js";
import { TryItPane } from "../src/shell/TryItPane.js";

/**
 * Issue #131: while an assistant's content changes may not show in answers
 * yet, Sources and Try it say so, and stop once they do.
 */

const assistant: Assistant = {
  id: "ast_1",
  orgId: "org_00000000000000000000",
  name: "Docs Bot",
  publicKey: "pk_ast_1",
  allowedOrigins: [],
  hasIngestKey: true,
  createdAt: 1_700_000_000_000,
};

interface Status {
  settling: boolean;
  indexing: number;
  settlesAt: number | null;
}

function installServer(initial: Status) {
  let status = initial;
  const statusGets: number[] = [];
  const sources: SourceSummary[] = [
    {
      id: "src_entry_1",
      orgId: assistant.orgId,
      assistantId: assistant.id,
      kind: "entry",
      label: "Answers you wrote",
      settings: {},
      createdAt: 1_700_000_000_000,
      documentCount: 1,
      lastUpdatedAt: 1_700_000_100_000,
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw, "https://example.com").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/admin/assistants" && method === "GET") {
        return Response.json({ assistants: [assistant] });
      }
      if (path === "/api/admin/assistants/ast_1/content-status") {
        statusGets.push(Date.now());
        return Response.json(status);
      }
      if (path === "/api/admin/assistants/ast_1/sources" && method === "GET") {
        return Response.json({ sources: sources.map((s) => ({ ...s })) });
      }
      if (path === "/api/admin/sources/src_entry_1" && method === "DELETE") {
        sources.splice(0);
        // The engine records the deletion: answers may still show it a while.
        status = { settling: true, indexing: 0, settlesAt: Date.now() + 60_000 };
        return Response.json({ deleted: true });
      }
      if (path === "/api/admin/chat") {
        const sse = [
          `event: token\ndata: ${JSON.stringify({ text: "Invoices go out monthly." })}\n\n`,
          `event: done\ndata: ${JSON.stringify({ messageId: "msg_try", conversationId: "cnv_try" })}\n\n`,
        ].join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    }),
  );
  return {
    statusGets,
    set(next: Status) {
      status = next;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("recent changes notice", () => {
  it("shows on Sources after a source is deleted", async () => {
    installServer({ settling: false, indexing: 0, settlesAt: null });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);
    expect(await screen.findByText("Answers you wrote")).toBeTruthy();
    expect(screen.queryByText(RECENT_CHANGES_TEXT)).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Actions for Answers you wrote" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Answers you wrote?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete source" }));

    const notice = await screen.findByText(RECENT_CHANGES_TEXT);
    expect(notice.getAttribute("role")).toBe("status");
  });

  it("clears on Sources once the window is over", async () => {
    const server = installServer({
      settling: true,
      indexing: 0,
      // Checked again a second after it is due to end.
      settlesAt: Date.now(),
    });
    window.history.replaceState(null, "", "/admin/sources");
    render(<App />);
    expect(await screen.findByText(RECENT_CHANGES_TEXT)).toBeTruthy();
    server.set({ settling: false, indexing: 0, settlesAt: null });
    await waitFor(() => expect(screen.queryByText(RECENT_CHANGES_TEXT)).toBeNull(), {
      timeout: 4_000,
    });
  });

  it("shows in Try it while content is waiting, checks again after an answer, and clears", async () => {
    const server = installServer({ settling: true, indexing: 2, settlesAt: null });
    render(<TryItPane assistant={assistant} />);
    expect(await screen.findByText(RECENT_CHANGES_TEXT)).toBeTruthy();
    const before = server.statusGets.length;

    server.set({ settling: false, indexing: 0, settlesAt: null });
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "How does billing work?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Invoices go out monthly.");
    await waitFor(() => expect(screen.queryByText(RECENT_CHANGES_TEXT)).toBeNull());
    expect(server.statusGets.length).toBeGreaterThan(before);
  });

  it("checks nothing while Try it is hidden", async () => {
    const server = installServer({ settling: true, indexing: 1, settlesAt: null });
    render(<TryItPane assistant={assistant} hidden />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.statusGets).toEqual([]);
    expect(screen.queryByText(RECENT_CHANGES_TEXT)).toBeNull();
  });
});
