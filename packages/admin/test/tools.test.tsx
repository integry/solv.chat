import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, McpServerSummary, McpToolView } from "../src/api/types.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

function makeAssistant(): Assistant {
  return {
    id: "ast_1",
    orgId: "org_00000000000000000000",
    name: "Docs Bot",
    publicKey: "pk_ast_1",
    allowedOrigins: ["https://docs.example.com"],
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

function makeServer(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: "mcp_1",
    assistantId: "ast_1",
    label: "Order lookup",
    url: "https://tools.example.com/mcp",
    authKind: "none",
    headerName: null,
    hasSecret: false,
    enabled: true,
    sendConversationContext: false,
    createdAt: 1_700_000_000_000,
    toolCount: 1,
    allowedCount: 0,
    ...overrides,
  };
}

function makeTool(overrides: Partial<McpToolView> = {}): McpToolView {
  return {
    id: "tool_1",
    serverId: "mcp_1",
    name: "lookup_order",
    description: "Look up an order by number",
    inputSchema: { type: "object" },
    allowed: false,
    ...overrides,
  };
}

interface FakeServerOptions {
  servers?: McpServerSummary[];
  toolsByServer?: Record<string, McpToolView[]>;
  nextPostError?: { status: number; body: unknown };
  nextRefreshError?: { status: number; body: unknown };
  refreshedTools?: McpToolView[];
  /** The add succeeds but listing the new server's tools failed with this message. */
  nextAddRefreshError?: string;
  /** How many server-list GETs fail before one succeeds. */
  failServersLoad?: number;
  /** The next server PATCH fails with this status and body. */
  nextServerPatchError?: { status: number; body: unknown };
  onRequest?: (method: string, path: string) => Promise<void> | void;
}

function installFakeServer(options: FakeServerOptions = {}) {
  const assistant = makeAssistant();
  let servers: McpServerSummary[] = options.servers ? options.servers.map((s) => ({ ...s })) : [];
  let nextPostError = options.nextPostError;
  let nextRefreshError = options.nextRefreshError;
  let nextAddRefreshError = options.nextAddRefreshError;
  let serverLoadFailures = options.failServersLoad ?? 0;
  let nextServerPatchError = options.nextServerPatchError;
  const toolsByServer: Record<string, McpToolView[]> = {};
  if (options.toolsByServer) {
    for (const [id, list] of Object.entries(options.toolsByServer)) {
      toolsByServer[id] = list.map((t) => ({ ...t }));
    }
  }

  const posts: Array<Record<string, unknown>> = [];
  const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
  const deletes: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(rawUrl, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    await options.onRequest?.(method, path);

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants: [assistant] });
    }
    if (path === `/api/admin/assistants/${assistant.id}/overview` && method === "GET") {
      return Response.json({
        topQuestions: [],
        todayCostMicros: 0,
      });
    }

    if (path === `/api/admin/assistants/${assistant.id}/mcp-servers` && method === "GET") {
      if (serverLoadFailures > 0) {
        serverLoadFailures--;
        return Response.json({ error: "The database is busy." }, { status: 503 });
      }
      return Response.json({ servers });
    }

    if (path === `/api/admin/assistants/${assistant.id}/mcp-servers` && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push(body);
      if (nextPostError) {
        const err = nextPostError;
        nextPostError = undefined;
        return Response.json(err.body, { status: err.status });
      }
      const id = `mcp_${servers.length + 1}`;
      const refreshError = nextAddRefreshError;
      nextAddRefreshError = undefined;
      const newTools: McpToolView[] = refreshError
        ? []
        : [makeTool({ id: `tool_${id}_1`, serverId: id, name: "get_status", allowed: false })];
      toolsByServer[id] = newTools;
      const created = makeServer({
        id,
        label: String(body.label ?? ""),
        url: String(body.url ?? ""),
        authKind: body.authKind === "static_header" ? "static_header" : "none",
        headerName: typeof body.headerName === "string" ? body.headerName : null,
        hasSecret: typeof body.headerValue === "string" && body.headerValue.length > 0,
        toolCount: newTools.length,
        allowedCount: 0,
      });
      servers = [...servers, created];
      return Response.json(
        { server: created, tools: newTools, ...(refreshError ? { refreshError } : {}) },
        { status: 201 },
      );
    }

    const serverPatchMatch = /^\/api\/admin\/mcp-servers\/([^/]+)$/.exec(path);
    if (serverPatchMatch?.[1] && method === "PATCH") {
      const serverId = serverPatchMatch[1];
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      patches.push({ path, body });
      if (nextServerPatchError) {
        const err = nextServerPatchError;
        nextServerPatchError = undefined;
        return Response.json(err.body, { status: err.status });
      }
      servers = servers.map((s) => {
        if (s.id !== serverId) return s;
        const hasSecret =
          body.headerValue === "" || body.headerValue === null
            ? false
            : typeof body.headerValue === "string"
              ? true
              : s.hasSecret;
        return {
          ...s,
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.url === "string" ? { url: body.url } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.sendConversationContext === "boolean"
            ? { sendConversationContext: body.sendConversationContext }
            : {}),
          ...(body.authKind === "none" || body.authKind === "static_header"
            ? { authKind: body.authKind }
            : {}),
          ...(typeof body.headerName === "string" ? { headerName: body.headerName } : {}),
          hasSecret,
        };
      });
      const updated = servers.find((s) => s.id === serverId);
      return Response.json({ server: updated });
    }

    if (serverPatchMatch?.[1] && method === "DELETE") {
      const serverId = serverPatchMatch[1];
      deletes.push(serverId);
      servers = servers.filter((s) => s.id !== serverId);
      return Response.json({ deleted: true });
    }

    const refreshMatch = /^\/api\/admin\/mcp-servers\/([^/]+)\/refresh$/.exec(path);
    if (refreshMatch?.[1] && method === "POST") {
      const serverId = refreshMatch[1];
      if (nextRefreshError) {
        const err = nextRefreshError;
        nextRefreshError = undefined;
        return Response.json(err.body, { status: err.status });
      }
      const nextTools = options.refreshedTools ?? toolsByServer[serverId] ?? [];
      toolsByServer[serverId] = nextTools.map((t) => ({ ...t }));
      servers = servers.map((s) =>
        s.id === serverId
          ? {
              ...s,
              toolCount: nextTools.length,
              allowedCount: nextTools.filter((t) => t.allowed).length,
            }
          : s,
      );
      return Response.json({ tools: nextTools });
    }

    const toolsMatch = /^\/api\/admin\/mcp-servers\/([^/]+)\/tools$/.exec(path);
    if (toolsMatch?.[1] && method === "GET") {
      return Response.json({ tools: toolsByServer[toolsMatch[1]] ?? [] });
    }

    const toolPatchMatch = /^\/api\/admin\/mcp-servers\/([^/]+)\/tools\/([^/]+)$/.exec(path);
    if (toolPatchMatch?.[1] && toolPatchMatch?.[2] && method === "PATCH") {
      const serverId = toolPatchMatch[1];
      const toolId = toolPatchMatch[2];
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      patches.push({ path, body });
      const list = toolsByServer[serverId] ?? [];
      let updatedTool: McpToolView | undefined;
      toolsByServer[serverId] = list.map((t) => {
        if (t.id !== toolId) return t;
        updatedTool = { ...t, allowed: Boolean(body.allowed) };
        return updatedTool;
      });
      servers = servers.map((s) =>
        s.id === serverId
          ? {
              ...s,
              allowedCount: (toolsByServer[serverId] ?? []).filter((t) => t.allowed).length,
            }
          : s,
      );
      return Response.json({ tool: updatedTool });
    }

    return Response.json({ error: `Unhandled ${method} ${path}` }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { posts, patches, deletes };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/admin");
});

describe("Tools screen", () => {
  it("renders navigation with Tools in the Build group and no model/temperature/chunking settings", async () => {
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

    fireEvent.click(screen.getByRole("link", { name: "Tools" }));
    await screen.findByRole("heading", { name: "Tools" });
    expect(screen.queryByText(/model|temperature|chunking/i)).toBeNull();
  });

  it("shows empty state, adds a server, and lists its tools off by default", async () => {
    const server = installFakeServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));

    expect(await screen.findByText(/No tool servers yet/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("What this is"), {
      target: { value: "Order lookup" },
    });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://tools.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toEqual({
      label: "Order lookup",
      url: "https://tools.example.com/mcp",
      authKind: "none",
    });

    expect(await screen.findByText("Order lookup")).toBeTruthy();
    expect(screen.getByText("Credential: not set")).toBeTruthy();
    expect(screen.getByText("0 of 1 tools on")).toBeTruthy();

    // The new server's tools open straight away, so the owner can switch them on.
    expect(await screen.findByText("get_status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide tools" })).toBeTruthy();
    const toggle = screen.getByRole("checkbox", { name: /Off/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("shows the standing warning whenever a server is listed and names a read-only token", async () => {
    installFakeServer({ servers: [makeServer()] });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));

    const warning = await screen.findByRole("note");
    expect(warning.textContent).toMatch(/every tool runs with the credential/i);
    expect(warning.textContent).toMatch(/only read/i);
  });

  it("sends the key once, uses a password input, never populates it on edit, and leaves it out of the DOM", async () => {
    const server = installFakeServer();
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));

    fireEvent.change(await screen.findByLabelText("What this is"), {
      target: { value: "Order lookup" },
    });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://tools.example.com/mcp" },
    });
    fireEvent.click(screen.getByLabelText("This server needs a key"));

    const keyInput = screen.getByLabelText("Key") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.change(keyInput, { target: { value: "ro_token_123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(server.posts[0]).toMatchObject({
      authKind: "static_header",
      headerName: "Authorization",
      headerValue: "ro_token_123",
    });

    await waitFor(() => expect(screen.getByText("Credential: set")).toBeTruthy());
    expect(document.body.innerHTML).not.toContain("ro_token_123");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editKeyInput = (await screen.findByLabelText("New key")) as HTMLInputElement;
    expect(editKeyInput.type).toBe("password");
    expect(editKeyInput.value).toBe("");
    expect(document.body.innerHTML).not.toContain("ro_token_123");
  });

  it("switches a tool on and off with one PATCH each and shows the Publish hint", async () => {
    const server = installFakeServer({
      servers: [makeServer()],
      toolsByServer: { mcp_1: [makeTool()] },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));

    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
    const toggle = (await screen.findByRole("checkbox", { name: /Off/i })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]).toEqual({
      path: "/api/admin/mcp-servers/mcp_1/tools/tool_1",
      body: { allowed: true },
    });

    const publishHint = await screen.findByRole("status");
    expect(publishHint.textContent).toMatch(/takes effect on Publish/i);

    const onToggle = (await screen.findByRole("checkbox", {
      name: /Visitors can use this/i,
    })) as HTMLInputElement;
    expect(onToggle.checked).toBe(true);

    fireEvent.click(onToggle);
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]).toEqual({
      path: "/api/admin/mcp-servers/mcp_1/tools/tool_1",
      body: { allowed: false },
    });
  });

  it("refreshes tools and deletes a server after confirmation", async () => {
    const server = installFakeServer({
      servers: [makeServer({ toolCount: 1 })],
      toolsByServer: { mcp_1: [makeTool()] },
      refreshedTools: [
        makeTool(),
        makeTool({ id: "tool_2", name: "list_items", description: "List items" }),
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));

    expect(await screen.findByText("0 of 1 tools on")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("0 of 2 tools on")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(server.deletes).toHaveLength(0);
    const dialog = await screen.findByRole("dialog", { name: "Delete Order lookup?" });
    expect(within(dialog).getByText(/stops using its tools straight away/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete server" }));
    await waitFor(() => expect(server.deletes).toEqual(["mcp_1"]));
    expect(await screen.findByText("Tool server removed.")).toBeTruthy();
    expect(await screen.findByText(/No tool servers yet/i)).toBeTruthy();
  });

  it("shows a field error against url and shows a 502 error while keeping the server listed", async () => {
    installFakeServer({
      servers: [makeServer()],
      nextPostError: {
        status: 400,
        body: {
          error: "That is not valid.",
          fields: ["url: must be an https URL that is not a private or loopback address"],
        },
      },
      nextRefreshError: {
        status: 502,
        body: {
          error: "That tool server could not be reached.",
        },
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));

    fireEvent.change(await screen.findByLabelText("What this is"), {
      target: { value: "Bad server" },
    });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://localhost/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    expect(
      await screen.findByText("must be an https URL that is not a private or loopback address"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("That tool server could not be reached.")).toBeTruthy();
    expect(screen.getByText("Order lookup")).toBeTruthy();
  });

  it("applies the updated tool before reload completes so a quick second toggle reverses it", async () => {
    let toolsGetCount = 0;
    let releaseSecondGet!: () => void;
    const secondGetPending = new Promise<void>((resolve) => {
      releaseSecondGet = resolve;
    });

    const server = installFakeServer({
      servers: [makeServer()],
      toolsByServer: { mcp_1: [makeTool({ allowed: false })] },
      onRequest: async (method, path) => {
        if (method === "GET" && path === "/api/admin/mcp-servers/mcp_1/tools") {
          toolsGetCount += 1;
          if (toolsGetCount === 2) {
            await secondGetPending;
          }
        }
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));

    const toggle = (await screen.findByRole("checkbox", { name: /Off/i })) as HTMLInputElement;
    fireEvent.click(toggle);

    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]?.body).toEqual({ allowed: true });

    // Even while the reload GET is still pending, the checkbox reflects the
    // authoritative PATCH response and is enabled for the next toggle.
    const updatedToggle = (await screen.findByRole("checkbox", {
      name: /Visitors can use this/i,
    })) as HTMLInputElement;
    await waitFor(() => expect(updatedToggle.disabled).toBe(false));
    expect(updatedToggle.checked).toBe(true);

    fireEvent.click(updatedToggle);
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]?.body).toEqual({ allowed: false });

    releaseSecondGet();
    await waitFor(() =>
      expect((screen.getByRole("checkbox", { name: /Off/i }) as HTMLInputElement).checked).toBe(
        false,
      ),
    );
  });

  it("preserves a newer server editor when an earlier save or credential removal completes", async () => {
    let releasePatch!: () => void;
    let patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    let holdNextPatch = true;

    const server = installFakeServer({
      servers: [
        makeServer({ id: "mcp_1", label: "Server A", hasSecret: true, authKind: "static_header" }),
        makeServer({ id: "mcp_2", label: "Server B" }),
      ],
      onRequest: async (method, path) => {
        if (method === "PATCH" && path === "/api/admin/mcp-servers/mcp_1" && holdNextPatch) {
          await patchPending;
        }
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    await screen.findByText("Server A");

    const [editServerA] = screen.getAllByRole("button", { name: "Edit" });
    if (!editServerA) throw new Error("Expected Edit button for Server A");
    fireEvent.click(editServerA);
    fireEvent.change(screen.getByLabelText("What this is", { selector: "#edit-mcp_1-label" }), {
      target: { value: "Server A saved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Switch to Server B's editor while Server A's PATCH is still pending.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const bLabelInput = screen.getByLabelText("What this is", {
      selector: "#edit-mcp_2-label",
    }) as HTMLInputElement;
    fireEvent.change(bLabelInput, { target: { value: "Server B unsaved" } });

    releasePatch();
    await waitFor(() => expect(server.patches).toHaveLength(1));
    await screen.findByText("Server A saved");

    // Server B's editor and unsaved input must still be intact.
    expect(
      (
        screen.getByLabelText("What this is", {
          selector: "#edit-mcp_2-label",
        }) as HTMLInputElement
      ).value,
    ).toBe("Server B unsaved");

    // Now test the Remove credential completion path in the same way.
    patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    holdNextPatch = true;

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove credential" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("What this is", { selector: "#edit-mcp_2-label" }), {
      target: { value: "Server B still unsaved" },
    });

    releasePatch();
    await waitFor(() => expect(server.patches).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getAllByText("Credential: not set").length).toBeGreaterThanOrEqual(2),
    );
    expect(
      (
        screen.getByLabelText("What this is", {
          selector: "#edit-mcp_2-label",
        }) as HTMLInputElement
      ).value,
    ).toBe("Server B still unsaved");
  });

  it("preserves a reopened editor for the same server when an earlier save or credential removal completes", async () => {
    let releasePatch!: () => void;
    let patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    let holdNextPatch = true;

    const server = installFakeServer({
      servers: [
        makeServer({ id: "mcp_1", label: "Server A", hasSecret: true, authKind: "static_header" }),
      ],
      onRequest: async (method, path) => {
        if (method === "PATCH" && path === "/api/admin/mcp-servers/mcp_1" && holdNextPatch) {
          await patchPending;
        }
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    await screen.findByText("Server A");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("What this is", { selector: "#edit-mcp_1-label" }), {
      target: { value: "Server A first save" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Close and reopen the same server's editor while the first PATCH is pending.
    fireEvent.click(screen.getByRole("button", { name: "Close edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("What this is", { selector: "#edit-mcp_1-label" }), {
      target: { value: "Server A reopened unsaved" },
    });

    releasePatch();
    await waitFor(() => expect(server.patches).toHaveLength(1));
    await screen.findByText("Server A first save");

    expect(
      (
        screen.getByLabelText("What this is", {
          selector: "#edit-mcp_1-label",
        }) as HTMLInputElement
      ).value,
    ).toBe("Server A reopened unsaved");

    // Now test the Remove credential completion path for the same server.
    patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    holdNextPatch = true;

    fireEvent.click(screen.getByRole("button", { name: "Remove credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Close edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("What this is", { selector: "#edit-mcp_1-label" }), {
      target: { value: "Server A reopened after remove" },
    });

    releasePatch();
    await waitFor(() => expect(server.patches).toHaveLength(2));
    await screen.findByText("Credential: not set");

    expect(
      (
        screen.getByLabelText("What this is", {
          selector: "#edit-mcp_1-label",
        }) as HTMLInputElement
      ).value,
    ).toBe("Server A reopened after remove");
  });

  it("does not overwrite completed disable or credential changes when submitting a reopened editor", async () => {
    let releasePatch!: () => void;
    let patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    let holdNextPatch = true;

    const server = installFakeServer({
      servers: [
        makeServer({
          id: "mcp_1",
          label: "Server A",
          enabled: true,
          hasSecret: true,
          authKind: "static_header",
          headerName: "X-Api-Key",
        }),
      ],
      onRequest: async (method, path) => {
        if (method === "PATCH" && path === "/api/admin/mcp-servers/mcp_1" && holdNextPatch) {
          await patchPending;
        }
      },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    await screen.findByText("Server A");

    // 1. Start a disabling save and hold it pending.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // 2. Close and reopen the same server's editor while the disabling PATCH is pending.
    fireEvent.click(screen.getByRole("button", { name: "Close edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("What this is", { selector: "#edit-mcp_1-label" }), {
      target: { value: "Server A renamed" },
    });

    // 3. Complete the disabling save before submitting the rename.
    holdNextPatch = false;
    releasePatch();
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect(server.patches[0]?.body).toEqual({ enabled: false });
    await screen.findByText("Disabled");

    // 4. Submit the rename; it must only send the edited label and keep the server disabled.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patches).toHaveLength(2));
    expect(server.patches[1]?.body).toEqual({ label: "Server A renamed" });
    await screen.findByText("Server A renamed");
    expect(screen.getByText("Disabled")).toBeTruthy();

    // 5. Repeat with Remove credential pending while a reopened editor only changes the URL.
    patchPending = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    holdNextPatch = true;

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Close edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Address", { selector: "#edit-mcp_1-url" }), {
      target: { value: "https://tools.example.com/v2" },
    });

    holdNextPatch = false;
    releasePatch();
    await waitFor(() => expect(server.patches).toHaveLength(3));
    expect(server.patches[2]?.body).toEqual({ headerValue: "" });
    await screen.findByText("Credential: not set");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.patches).toHaveLength(4));
    expect(server.patches[3]?.body).toEqual({ url: "https://tools.example.com/v2" });
    await screen.findByText("https://tools.example.com/v2");
    expect(screen.getByText("Credential: not set")).toBeTruthy();
  });

  it("uses identical card header and actions markup regardless of enabled or credential state", async () => {
    installFakeServer({
      servers: [
        makeServer({
          id: "mcp_1",
          label: "Server Enabled",
          url: "https://a.example.com/mcp",
          enabled: true,
          hasSecret: true,
          authKind: "static_header",
          headerName: "Authorization",
        }),
        makeServer({
          id: "mcp_2",
          label: "Server Disabled",
          url: "https://very-long-server-hostname.example.com/some/path/mcp",
          enabled: false,
          hasSecret: false,
          authKind: "none",
        }),
      ],
    });

    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    await screen.findByText("Server Enabled");
    await screen.findByText("Server Disabled");

    const cards = Array.from(container.querySelectorAll("ul.source-list > li.source-card"));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const header = card.querySelector(".source-row-header");
      expect(header).toBeTruthy();
      expect(header?.children).toHaveLength(2);
      const actions = header?.querySelector(".actions");
      expect(actions).toBeTruthy();
      expect(actions?.querySelectorAll("button")).toHaveLength(4);
    }
  });

  it("shows Send conversation context on each server, off by default, and saves it at once", async () => {
    const fake = installFakeServer({
      servers: [
        makeServer({ id: "mcp_1", label: "Order lookup" }),
        makeServer({ id: "mcp_2", label: "Stock", url: "https://stock.example.com/mcp" }),
      ],
    });
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    await screen.findByText("Stock");

    const cards = Array.from(container.querySelectorAll("ul.source-list > li.source-card"));
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const toggle = within(card as HTMLElement).getByRole("switch", {
        name: "Send conversation context",
      });
      expect((toggle as HTMLInputElement).checked).toBe(false);
      // One sentence: what is sent and why an owner would turn it on.
      expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
      const hint = container.querySelector(`#${toggle.getAttribute("aria-describedby")}`);
      expect(hint?.textContent).toMatch(/conversation, visitor and assistant ids/);
      expect(hint?.textContent).toMatch(/never messages/);
      expect(hint?.textContent).toMatch(/tell visitors apart/);
    }

    const first = cards[0] as HTMLElement;
    fireEvent.click(within(first).getByRole("switch", { name: "Send conversation context" }));
    await waitFor(() =>
      expect(
        (
          within(first).getByRole("switch", {
            name: "Send conversation context",
          }) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
    expect(fake.patches).toEqual([
      { path: "/api/admin/mcp-servers/mcp_1", body: { sendConversationContext: true } },
    ]);
    // The other server is untouched.
    expect(
      (
        within(cards[1] as HTMLElement).getByRole("switch", {
          name: "Send conversation context",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("shows the engine's message when Send conversation context cannot be saved", async () => {
    installFakeServer({
      servers: [makeServer({ authKind: "static_header", headerName: "Solv-Visitor-Id" })],
      nextServerPatchError: {
        status: 400,
        body: {
          error:
            "headerName: Solv-Conversation-Id, Solv-Visitor-Id, Solv-Assistant-Id are sent by solv.chat itself",
          errors: [
            "headerName: Solv-Conversation-Id, Solv-Visitor-Id, Solv-Assistant-Id are sent by solv.chat itself",
          ],
        },
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Tools" }));
    fireEvent.click(await screen.findByRole("switch", { name: "Send conversation context" }));
    expect(await screen.findByText(/are sent by solv\.chat itself/)).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: "Send conversation context" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("explains what a tool server is when there are none, with an example", async () => {
    installFakeServer();
    window.history.replaceState(null, "", "/admin/tools");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No tool servers yet" })).toBeTruthy();
    expect(screen.getByText(/A tool server is a small web service/)).toBeTruthy();
    expect(screen.getByText(/Where is order 1042\?/)).toBeTruthy();
    // The credential warning stays even with nothing added.
    expect(screen.getByRole("note").textContent).toMatch(/only read/i);

    fireEvent.click(screen.getByRole("button", { name: "Add a tool server" }));
    expect(document.activeElement).toBe(screen.getByLabelText("What this is"));
  });

  it("says it connected after adding, and the tools found can be switched on there", async () => {
    const server = installFakeServer();
    window.history.replaceState(null, "", "/admin/tools");
    render(<App />);

    fireEvent.change(await screen.findByLabelText("What this is"), {
      target: { value: "Status page" },
    });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://status.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(await screen.findByText(/Connected to Status page\./)).toBeTruthy();
    const toggle = (await screen.findByRole("checkbox", { name: /Off/i })) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(server.patches).toEqual([
        { path: "/api/admin/mcp-servers/mcp_1/tools/tool_mcp_1_1", body: { allowed: true } },
      ]),
    );
    expect(
      (
        (await screen.findByRole("checkbox", {
          name: /Visitors can use this/i,
        })) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("says it could not connect when the server was added but its tools could not be listed", async () => {
    installFakeServer({ nextAddRefreshError: "That tool server could not be reached." });
    window.history.replaceState(null, "", "/admin/tools");
    render(<App />);

    fireEvent.change(await screen.findByLabelText("What this is"), {
      target: { value: "Flaky" },
    });
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://flaky.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));

    expect(await screen.findByText("Could not connect")).toBeTruthy();
    expect(
      await screen.findByText(/That tool server could not be reached\. Check the address and key/),
    ).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(await screen.findByText(/This server offered no tools/)).toBeTruthy();
  });

  it("sends no DELETE when the owner cancels deleting a server", async () => {
    const server = installFakeServer({ servers: [makeServer()] });
    window.history.replaceState(null, "", "/admin/tools");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Order lookup?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.deletes).toEqual([]);
    expect(screen.getByText("Order lookup")).toBeTruthy();
  });

  it("shows an error with Try again when the servers cannot load, and recovers", async () => {
    installFakeServer({ servers: [makeServer()], failServersLoad: 1 });
    window.history.replaceState(null, "", "/admin/tools");
    render(<App />);

    expect(await screen.findByText("Could not load your tool servers.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Order lookup")).toBeTruthy();
  });

  it("has no serious accessibility problems, empty or with a server and the delete dialog", async () => {
    installFakeServer();
    window.history.replaceState(null, "", "/admin/tools");
    const first = render(<App />);
    await screen.findByRole("heading", { name: "No tool servers yet" });
    await expectNoSeriousA11yViolations(document.body);
    first.unmount();
    vi.unstubAllGlobals();

    installFakeServer({ servers: [makeServer()], toolsByServer: { mcp_1: [makeTool()] } });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "View tools" }));
    await screen.findByText("lookup_order");
    await expectNoSeriousA11yViolations(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Delete Order lookup?" });
    await expectNoSeriousA11yViolations(document.body);
  });
});
