import {
  CHAT_PROTOCOL_VERSION,
  defaultVersionConfig,
  MAX_CHAT_MESSAGE_LENGTH,
  parseChatRequest,
} from "@solvchat/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { Assistant, VersionRow } from "../src/api/types.js";

function makeAssistant(id: string, name: string, allowedOrigins: string[] = []): Assistant {
  return {
    id,
    orgId: "org_00000000000000000000",
    name,
    publicKey: `pk_${id}`,
    allowedOrigins,
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

function makeVersion(
  id: string,
  assistantId: string,
  state: VersionRow["state"],
  overrides?: Partial<VersionRow["config"]["behaviour"]>,
): VersionRow {
  const config = defaultVersionConfig();
  if (overrides) {
    config.behaviour = { ...config.behaviour, ...overrides };
  }
  return {
    id,
    orgId: "org_00000000000000000000",
    assistantId,
    state,
    config,
    createdAt: 1_700_000_000_000,
    publishedAt: state === "draft" ? null : 1_700_000_100_000,
  };
}

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const payload = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function createControlledSseResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
    push(event: string, data: unknown) {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

interface FakeServerOptions {
  signedIn?: boolean;
  assistants?: Assistant[];
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installFakeServer(options: FakeServerOptions = {}) {
  let signedIn = options.signedIn ?? true;
  const assistants: Assistant[] = options.assistants
    ? [...options.assistants]
    : [makeAssistant("ast_1", "Docs Bot", ["https://docs.example.com"])];

  const drafts = new Map<string, VersionRow>();
  const versions = new Map<string, VersionRow[]>();

  for (const a of assistants) {
    const draft = makeVersion(`ver_draft_${a.id}`, a.id, "draft");
    const published = makeVersion(`ver_pub_${a.id}`, a.id, "published");
    const archived = makeVersion(`ver_arch_${a.id}`, a.id, "archived", {
      greeting: "Old archived greeting",
    });
    drafts.set(a.id, draft);
    versions.set(a.id, [draft, published, archived]);
  }

  let forceNext401 = false;
  let nextLogoutFailure: "http" | "network" | null = null;
  let pendingDraftSave: Promise<void> | null = null;
  let pendingDraftGet: Promise<void> | null = null;
  let pendingAssistantGet: Promise<void> | null = null;
  let pendingAssistantPatch: Promise<void> | null = null;
  let pendingPublish: Promise<void> | null = null;
  let nextChatResponder:
    | ((body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>)
    | null = null;
  const chatBodies: Array<Record<string, unknown>> = [];
  const calls: Array<{ method: string; path: string }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path });

    if (path === "/api/admin/login" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { password?: string };
      if (body.password === "correct-password") {
        signedIn = true;
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Sign-in failed." }, { status: 401 });
    }

    if (path === "/api/admin/logout" && method === "POST") {
      if (nextLogoutFailure === "network") {
        nextLogoutFailure = null;
        throw new TypeError("Failed to fetch");
      }
      if (nextLogoutFailure === "http") {
        nextLogoutFailure = null;
        return Response.json({ error: "Could not clear session." }, { status: 500 });
      }
      signedIn = false;
      return Response.json({ ok: true });
    }

    if (path.startsWith("/api/admin/")) {
      if (!signedIn || forceNext401) {
        forceNext401 = false;
        signedIn = false;
        return Response.json({ error: "Sign in first." }, { status: 401 });
      }
    }

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants });
    }

    if (path === "/api/admin/assistants" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        name: string;
        allowedOrigins: string[];
      };
      const created = makeAssistant(`ast_${assistants.length + 1}`, body.name, body.allowedOrigins);
      assistants.push(created);
      const draft = makeVersion(`ver_draft_${created.id}`, created.id, "draft", {
        greeting: `Hi from ${created.name}`,
      });
      drafts.set(created.id, draft);
      versions.set(created.id, [draft]);
      return Response.json({ assistant: created, ingestKey: "ik_shown_once" }, { status: 201 });
    }

    const singleAssistant = /^\/api\/admin\/assistants\/([^/]+)$/.exec(path);
    if (singleAssistant?.[1]) {
      const id = singleAssistant[1];
      const found = assistants.find((a) => a.id === id);
      if (!found) return Response.json({ error: "Not found." }, { status: 404 });

      if (method === "GET") {
        if (pendingAssistantGet) {
          const wait = pendingAssistantGet;
          pendingAssistantGet = null;
          await wait;
        }
        return Response.json({ assistant: found });
      }
      if (method === "PATCH") {
        if (pendingAssistantPatch) {
          const wait = pendingAssistantPatch;
          pendingAssistantPatch = null;
          await wait;
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          name: string;
          allowedOrigins: string[];
        };
        for (let i = 0; i < body.allowedOrigins.length; i++) {
          const origin = body.allowedOrigins[i] ?? "";
          if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
            return Response.json(
              {
                error: "That is not valid.",
                fields: [
                  `allowedOrigins[${i}]: must be an absolute URL such as https://example.com`,
                ],
              },
              { status: 400 },
            );
          }
        }
        found.name = body.name;
        found.allowedOrigins = body.allowedOrigins;
        return Response.json({ assistant: found });
      }
    }

    const draftMatch = /^\/api\/admin\/assistants\/([^/]+)\/draft$/.exec(path);
    if (draftMatch?.[1]) {
      const id = draftMatch[1];
      const draft = drafts.get(id);
      if (!draft) return Response.json({ error: "Not found." }, { status: 404 });

      if (method === "GET") {
        if (pendingDraftGet) {
          const wait = pendingDraftGet;
          pendingDraftGet = null;
          await wait;
        }
        return Response.json({ draft });
      }
      if (method === "PUT") {
        if (pendingDraftSave) {
          const wait = pendingDraftSave;
          pendingDraftSave = null;
          await wait;
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Partial<VersionRow["config"]>;
        if (body.behaviour) {
          draft.config = { ...draft.config, behaviour: body.behaviour };
        }
        if (body.widget) {
          draft.config = { ...draft.config, widget: body.widget };
        }
        return Response.json({ draft });
      }
    }

    const publishMatch = /^\/api\/admin\/assistants\/([^/]+)\/publish$/.exec(path);
    if (publishMatch?.[1] && method === "POST") {
      if (pendingPublish) {
        const wait = pendingPublish;
        pendingPublish = null;
        await wait;
      }
      const id = publishMatch[1];
      const draft = drafts.get(id);
      if (!draft) return Response.json({ error: "Not found." }, { status: 404 });
      const list = versions.get(id) ?? [];
      for (const v of list) {
        if (v.state === "published") v.state = "archived";
      }
      const published: VersionRow = {
        ...draft,
        id: `ver_pub_${Date.now()}`,
        state: "published",
        publishedAt: 1_700_000_200_000,
      };
      list.unshift(published);
      versions.set(id, list);
      // Like the engine: the draft is promoted and a fresh draft with the same
      // config takes its place under a new id.
      drafts.set(id, { ...draft, id: `ver_draft_${id}_${list.length}` });
      return Response.json({ version: published });
    }

    const versionsMatch = /^\/api\/admin\/assistants\/([^/]+)\/versions$/.exec(path);
    if (versionsMatch?.[1] && method === "GET") {
      return Response.json({ versions: versions.get(versionsMatch[1]) ?? [] });
    }

    const overviewMatch = /^\/api\/admin\/assistants\/([^/]+)\/overview$/.exec(path);
    if (overviewMatch?.[1] && method === "GET") {
      return Response.json({
        messages: 0,
        answeredShare: 0,
        topQuestions: [],
        todayCostMicros: 0,
      });
    }

    const rollbackMatch = /^\/api\/admin\/assistants\/([^/]+)\/versions\/([^/]+)\/rollback$/.exec(
      path,
    );
    if (rollbackMatch?.[1] && rollbackMatch[2] && method === "POST") {
      const id = rollbackMatch[1];
      const versionId = rollbackMatch[2];
      const list = versions.get(id) ?? [];
      const target = list.find((v) => v.id === versionId);
      if (!target) return Response.json({ error: "Not found." }, { status: 404 });
      for (const v of list) {
        if (v.state === "published") v.state = "archived";
      }
      const restored: VersionRow = {
        ...target,
        id: `ver_restored_${Date.now()}`,
        state: "published",
        publishedAt: 1_700_000_300_000,
      };
      list.unshift(restored);
      versions.set(id, list);
      return Response.json({ version: restored });
    }

    if (path === "/api/admin/chat" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      chatBodies.push(body);
      if (nextChatResponder) {
        const respond = nextChatResponder;
        nextChatResponder = null;
        return respond(body, init);
      }
      return sseResponse([
        { event: "token", data: { text: `Draft reply to: ${String(body.message)}` } },
        { event: "done", data: { messageId: "msg_1", conversationId: "conv_preview_1" } },
      ]);
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    fetchMock,
    calls,
    chatBodies,
    triggerNext401() {
      forceNext401 = true;
    },
    failNextLogout(kind: "http" | "network") {
      nextLogoutFailure = kind;
    },
    holdNextDraftSave() {
      const d = createDeferred();
      pendingDraftSave = d.promise;
      return d;
    },
    holdNextDraftGet() {
      const d = createDeferred();
      pendingDraftGet = d.promise;
      return d;
    },
    holdNextAssistantGet() {
      const d = createDeferred();
      pendingAssistantGet = d.promise;
      return d;
    },
    holdNextAssistantPatch() {
      const d = createDeferred();
      pendingAssistantPatch = d.promise;
      return d;
    },
    holdNextPublish() {
      const d = createDeferred();
      pendingPublish = d.promise;
      return d;
    },
    setNextChatResponse(
      responder: (
        body: Record<string, unknown>,
        init?: RequestInit,
      ) => Response | Promise<Response>,
    ) {
      nextChatResponder = responder;
    },
  };
}

describe("admin app", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/admin");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders login, shows one plain message on wrong password, and opens the shell on right password", async () => {
    installFakeServer({ signedIn: false });
    render(<App />);

    const passwordInput = await screen.findByLabelText("Password");
    fireEvent.change(passwordInput, { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Sign-in failed.");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("How your assistant is doing.")).toBeTruthy();
  });

  it("returns the owner to login when any API call answers 401", async () => {
    const server = installFakeServer({ signedIn: true });
    render(<App />);

    await screen.findByRole("navigation", { name: "Primary" });
    server.triggerNext401();

    fireEvent.click(screen.getByRole("link", { name: "Behaviour" }));
    expect(await screen.findByLabelText("Password")).toBeTruthy();
  });

  it("switches assistants and creates a new assistant and selects it", async () => {
    const first = makeAssistant("ast_1", "First Bot");
    const second = makeAssistant("ast_2", "Second Bot");
    installFakeServer({ signedIn: true, assistants: [first, second] });

    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const select = (await screen.findByLabelText("Assistant")) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe("ast_1");
    });

    fireEvent.change(select, { target: { value: "ast_2" } });
    expect(select.value).toBe("ast_2");

    fireEvent.click(screen.getByRole("button", { name: "New assistant" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Third Bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Create assistant" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Assistant") as HTMLSelectElement).value).toBe("ast_3");
    });
    // The new assistant's ingest key is shown once, in a read-only field to
    // copy (screens.test.tsx covers dismissing it).
    expect((screen.getByLabelText("Ingest key") as HTMLInputElement).value).toBe("ik_shown_once");
  });

  it("edits Behaviour, marks unsaved, saves, publishes, and restores from History", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "Welcome to our docs!" } });

    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Draft saved.")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/^Published \(/)).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByRole("region", { name: "Version history" })).toBeTruthy();

    const restoreButtons = await screen.findAllByRole("button", { name: "Restore" });
    fireEvent.click(restoreButtons[0] as HTMLElement);

    expect(await screen.findByText("Restored earlier version.")).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/rollback"))).toBe(
      true,
    );
  });

  it("shows the API field error when Widget allowed origins are invalid", async () => {
    installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/widget");
    render(<App />);

    const origins = await screen.findByLabelText("Allowed origins");
    fireEvent.change(origins, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("must be an absolute URL such as https://example.com"),
    ).toBeTruthy();
  });

  it("keeps the Try it transcript across screen navigation and sends target: draft and protocol version", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const input = await screen.findByLabelText("Ask a question");
    fireEvent.change(input, { target: { value: "How do I install?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Draft reply to: How do I install?")).toBeTruthy();

    expect(server.chatBodies[0]).toMatchObject({
      target: "draft",
      protocol: CHAT_PROTOCOL_VERSION,
      assistant: "pk_ast_1",
      message: "How do I install?",
    });

    // Navigate to Widget, then Overview, then back to Behaviour.
    fireEvent.click(screen.getByRole("link", { name: "Widget" }));
    expect(await screen.findByRole("heading", { name: "Widget" })).toBeTruthy();
    expect(screen.getByText("How do I install?")).toBeTruthy();
    expect(screen.getByText("Draft reply to: How do I install?")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("Draft reply to: How do I install?")).toBeTruthy();
  });

  it.each([
    ["a 500", () => Response.json({ error: "Database unavailable." }, { status: 500 })],
    [
      "a network error",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])(
    "S36: offers a retry, not the login screen, when the first request fails with %s",
    async (_name, fail) => {
      installFakeServer({ signedIn: true });
      const server = globalThis.fetch;
      let failNext = true;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (failNext) {
          failNext = false;
          return fail();
        }
        return server(input, init);
      });
      render(<App />);

      expect(await screen.findByText("Could not reach the server.")).toBeTruthy();
      expect(screen.queryByLabelText("Password")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("navigation", { name: "Primary" })).toBeTruthy();
    },
  );

  it("S36: still shows the login screen when the first request gets a 401", async () => {
    installFakeServer({ signedIn: false });
    render(<App />);
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(screen.queryByText("Could not reach the server.")).toBeNull();
  });

  it("S34: links only http(s) citations in Try it", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);
    server.setNextChatResponse(() =>
      sseResponse([
        { event: "token", data: { text: "See the guide." } },
        { event: "citation", data: { url: "javascript:alert(1)", title: "Bad link" } },
        { event: "citation", data: { url: "https://docs.example.com/guide", title: "Guide" } },
        { event: "done", data: { messageId: "msg_1", conversationId: "cnv_1" } },
      ]),
    );

    const input = await screen.findByLabelText("Ask a question");
    fireEvent.change(input, { target: { value: "Where is the guide?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const good = await screen.findByRole("link", { name: "Guide" });
    expect(good.getAttribute("href")).toBe("https://docs.example.com/guide");
    expect(screen.queryByRole("link", { name: "Bad link" })).toBeNull();
    expect(screen.queryByText("Bad link")).toBeNull();
  });

  it("exposes accessible navigation without phase 2 items or model/key settings", async () => {
    installFakeServer({ signedIn: true });
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "Conversations",
      "Gaps",
      "Sources",
      "Tools",
      "Behaviour",
      "Widget",
      "Install",
    ]);

    for (const link of links) {
      expect(link.getAttribute("href")).toMatch(/^\/admin\//);
    }

    expect(screen.queryByText(/model|temperature|chunking/i)).toBeNull();
  });

  it("F1: disables inputs during save and preserves newer edits on Behaviour", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "First edit" } });

    const deferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(greeting.disabled).toBe(true);
    });

    // Simulate a change arriving while the save request is still in flight.
    fireEvent.change(greeting, { target: { value: "Newer edit" } });
    deferred.resolve();

    expect(await screen.findByText("Draft saved.")).toBeTruthy();
    expect(greeting.disabled).toBe(false);
    expect(greeting.value).toBe("Newer edit");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("F1: disables inputs during save and preserves newer edits on Widget origins and settings", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/widget");
    render(<App />);

    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const origins = screen.getByLabelText("Allowed origins") as HTMLTextAreaElement;

    fireEvent.change(origins, { target: { value: "https://first.example.com" } });
    fireEvent.change(title, { target: { value: "First Title" } });

    const patchDeferred = server.holdNextAssistantPatch();
    const putDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(title.disabled).toBe(true);
      expect(origins.disabled).toBe(true);
    });

    fireEvent.change(origins, { target: { value: "https://newer.example.com" } });
    patchDeferred.resolve();

    await waitFor(() => {
      expect(
        server.calls.some(
          (c) => c.method === "PUT" && c.path === "/api/admin/assistants/ast_1/draft",
        ),
      ).toBe(true);
    });

    fireEvent.change(title, { target: { value: "Newer Title" } });
    putDeferred.resolve();

    expect(await screen.findByText("Draft saved.")).toBeTruthy();
    expect(origins.value).toBe("https://newer.example.com");
    expect(title.value).toBe("Newer Title");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("F2: serializes saving and publishing on Behaviour and Widget", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "Updated greeting" } });

    const saveDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const publishBtn = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(publishBtn.disabled).toBe(true);
    });
    fireEvent.click(publishBtn);
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(
      false,
    );

    saveDeferred.resolve();
    expect(await screen.findByText("Draft saved.")).toBeTruthy();

    const publishDeferred = server.holdNextPublish();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    fireEvent.change(greeting, { target: { value: "Another unsaved edit" } });
    const saveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveBtn.disabled).toBe(true);
    });
    publishDeferred.resolve();
    expect(await screen.findByText(/^Published \(/)).toBeTruthy();
    // The edit typed while publishing survives the replacement draft.
    await waitFor(() => {
      expect(greeting.value).toBe("Another unsaved edit");
    });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    // Verify the same serialization on Widget.
    fireEvent.click(screen.getByRole("link", { name: "Widget" }));
    const widgetTitle = (await screen.findByLabelText("Title")) as HTMLInputElement;
    fireEvent.change(widgetTitle, { target: { value: "Updated Widget" } });

    const widgetSaveDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const widgetPublishBtn = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(widgetPublishBtn.disabled).toBe(true);
    });
    widgetSaveDeferred.resolve();
    expect(await screen.findByText("Draft saved.")).toBeTruthy();

    const widgetPublishDeferred = server.holdNextPublish();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    fireEvent.change(widgetTitle, { target: { value: "Unsaved Widget" } });
    const widgetSaveBtn = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(widgetSaveBtn.disabled).toBe(true);
    });
    widgetPublishDeferred.resolve();
    expect(await screen.findByText(/^Published \(/)).toBeTruthy();
    await waitFor(() => {
      expect(widgetTitle.value).toBe("Unsaved Widget");
    });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it.each([
    ["/admin/behaviour", "First thing it says"],
    ["/admin/widget", "Title"],
  ])("disables Publish on %s while there are unsaved changes", async (route, label) => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", route);
    render(<App />);

    const field = (await screen.findByLabelText(label)) as HTMLInputElement;
    const publishBtn = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publishBtn.disabled).toBe(false);

    fireEvent.change(field, { target: { value: "Not saved yet" } });
    expect(publishBtn.disabled).toBe(true);
    expect(screen.getByText("Save your changes before publishing.")).toBeTruthy();
    fireEvent.click(publishBtn);
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(
      false,
    );

    // After saving, Publish sends what was saved and the field keeps it.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Draft saved.")).toBeTruthy();
    expect(publishBtn.disabled).toBe(false);
    fireEvent.click(publishBtn);
    expect(await screen.findByText(/^Published \(/)).toBeTruthy();
    await waitFor(() => {
      expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(
        true,
      );
    });
    expect(field.value).toBe("Not saved yet");
  });

  it("F3: keeps the owner signed in with a retryable error when logout fails, then signs out on retry", async () => {
    const server = installFakeServer({ signedIn: true });
    render(<App />);

    await screen.findByRole("navigation", { name: "Primary" });

    server.failNextLogout("http");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not clear session.");
    expect(screen.queryByLabelText("Password")).toBeNull();

    server.failNextLogout("network");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Could not sign out. Try again.");
    });
    expect(screen.queryByLabelText("Password")).toBeNull();

    // Retry succeeds and returns to the login screen.
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Password")).toBeTruthy();
  });

  it("F4: blocks Publish on Widget while a Behaviour draft save is in flight across navigation", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "In-flight behaviour" } });

    const saveDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Navigate to Widget while Behaviour's save is still outstanding.
    fireEvent.click(screen.getByRole("link", { name: "Widget" }));
    await screen.findByLabelText("Title");

    const widgetPublishBtn = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(widgetPublishBtn.disabled).toBe(true);
    fireEvent.click(widgetPublishBtn);
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(
      false,
    );

    // Also verify History Restore is disabled while save is in flight.
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const restoreButtons = await screen.findAllByRole("button", { name: "Restore" });
    expect((restoreButtons[0] as HTMLButtonElement).disabled).toBe(true);

    // Once the save completes, Publish and Restore become enabled.
    saveDeferred.resolve();
    await waitFor(() => {
      expect(widgetPublishBtn.disabled).toBe(false);
      expect((restoreButtons[0] as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(widgetPublishBtn);
    expect(await screen.findByText(/^Published \(/)).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/publish"))).toBe(true);
  });

  it("F4: coordinates mutations per-assistant without blocking other assistants and refreshes on return", async () => {
    const first = makeAssistant("ast_1", "First Bot");
    const second = makeAssistant("ast_2", "Second Bot");
    const server = installFakeServer({ signedIn: true, assistants: [first, second] });

    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "Ast1 updated" } });

    const saveDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Switch to ast_2: its Publish button should not be blocked by ast_1's save.
    const select = screen.getByLabelText("Assistant") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ast_2" } });
    await waitFor(() => {
      expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).not.toBe(
        "Ast1 updated",
      );
    });
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    // Switch back to ast_1 while save is still in flight: Publish is still disabled.
    fireEvent.change(select, { target: { value: "ast_1" } });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    saveDeferred.resolve();
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect((screen.getByLabelText("First thing it says") as HTMLInputElement).value).toBe(
        "Ast1 updated",
      );
    });
  });

  it("F5: returns the owner to login when Try it receives 401 on an expired session", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const input = await screen.findByLabelText("Ask a question");
    server.triggerNext401();

    fireEvent.change(input, { target: { value: "Test expired session" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path === "/api/admin/chat")).toBe(
      true,
    );
    expect(server.calls.some((c) => c.path === "/v1/chat")).toBe(false);
    expect(server.chatBodies).toHaveLength(0);
  });

  it("F6: preserves unsaved Behaviour edits when restoring a version from History", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    const persona = screen.getByLabelText("How it should sound") as HTMLTextAreaElement;
    fireEvent.change(greeting, { target: { value: "Unsaved greeting" } });
    fireEvent.change(persona, { target: { value: "Unsaved persona" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const restoreButtons = await screen.findAllByRole("button", { name: "Restore" });
    fireEvent.click(restoreButtons[0] as HTMLElement);

    expect(await screen.findByText("Restored earlier version.")).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/rollback"))).toBe(
      true,
    );
    expect(greeting.value).toBe("Unsaved greeting");
    expect(persona.value).toBe("Unsaved persona");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("F6: preserves unsaved Widget settings and allowed origins when restoring a version from History", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/widget");
    render(<App />);

    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const accent = screen.getByLabelText("Accent colour") as HTMLInputElement;
    const origins = screen.getByLabelText("Allowed origins") as HTMLTextAreaElement;

    fireEvent.change(title, { target: { value: "Unsaved Widget Title" } });
    fireEvent.change(accent, { target: { value: "#123456" } });
    fireEvent.change(origins, { target: { value: "https://unsaved.example.com" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const restoreButtons = await screen.findAllByRole("button", { name: "Restore" });
    fireEvent.click(restoreButtons[0] as HTMLElement);

    expect(await screen.findByText("Restored earlier version.")).toBeTruthy();
    expect(server.calls.some((c) => c.method === "POST" && c.path.endsWith("/rollback"))).toBe(
      true,
    );
    expect(title.value).toBe("Unsaved Widget Title");
    expect(accent.value).toBe("#123456");
    expect(origins.value).toBe("https://unsaved.example.com");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("F7: preserves Widget edits made while background reload is in flight after a cross-screen save", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "Updated before nav" } });

    const saveDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Navigate to Widget while Behaviour's save is still pending.
    fireEvent.click(screen.getByRole("link", { name: "Widget" }));
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    const origins = screen.getByLabelText("Allowed origins") as HTMLTextAreaElement;
    expect(title.disabled).toBe(true);
    expect(origins.disabled).toBe(true);

    // Hold the background reload GETs triggered when the Behaviour save finishes.
    const assistantGetDeferred = server.holdNextAssistantGet();
    const draftGetDeferred = server.holdNextDraftGet();
    saveDeferred.resolve();

    await waitFor(() => {
      expect(title.disabled).toBe(false);
      expect(origins.disabled).toBe(false);
    });

    // Edit Widget fields while the reload GETs are still pending.
    fireEvent.change(title, { target: { value: "Edited during reload" } });
    fireEvent.change(origins, { target: { value: "https://edited-during-reload.example.com" } });

    assistantGetDeferred.resolve();
    draftGetDeferred.resolve();

    // Give effects a tick to process the resolved reload responses.
    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
    });
    expect(title.value).toBe("Edited during reload");
    expect(origins.value).toBe("https://edited-during-reload.example.com");
  });

  it("F7: preserves Behaviour edits made while background reload is in flight on return", async () => {
    const first = makeAssistant("ast_1", "First Bot");
    const second = makeAssistant("ast_2", "Second Bot");
    const server = installFakeServer({ signedIn: true, assistants: [first, second] });

    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const greeting = (await screen.findByLabelText("First thing it says")) as HTMLInputElement;
    fireEvent.change(greeting, { target: { value: "Ast1 saved greeting" } });

    const saveDeferred = server.holdNextDraftSave();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Switch away and back while save is still in flight.
    const select = screen.getByLabelText("Assistant") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ast_2" } });
    fireEvent.change(select, { target: { value: "ast_1" } });

    const returnedGreeting = (await screen.findByLabelText(
      "First thing it says",
    )) as HTMLInputElement;
    await waitFor(() => {
      expect(returnedGreeting.disabled).toBe(true);
    });

    const draftGetDeferred = server.holdNextDraftGet();
    saveDeferred.resolve();

    await waitFor(() => {
      expect(returnedGreeting.disabled).toBe(false);
    });

    fireEvent.change(returnedGreeting, { target: { value: "Newer edit during reload" } });
    draftGetDeferred.resolve();

    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeTruthy();
    });
    expect(returnedGreeting.value).toBe("Newer edit during reload");
  });

  it("F8: rejects oversized Try it messages, excludes failed exchanges from history, and caps resent history length", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const input = (await screen.findByLabelText("Ask a question")) as HTMLInputElement;
    const sendBtn = screen.getByRole("button", { name: "Send" });

    // 1. Oversized input is rejected before appending or sending.
    const oversized = "x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1);
    fireEvent.change(input, { target: { value: oversized } });
    fireEvent.click(sendBtn);

    expect(
      await screen.findByText(`Message must be at most ${MAX_CHAT_MESSAGE_LENGTH} characters.`),
    ).toBeTruthy();
    expect(server.chatBodies).toHaveLength(0);
    expect(input.value).toBe(oversized);

    // 2. Failed exchange (SSE error event) is excluded from subsequent history.
    server.setNextChatResponse(() =>
      sseResponse([{ event: "error", data: { message: "Model unavailable" } }]),
    );
    fireEvent.change(input, { target: { value: "First attempt that fails" } });
    fireEvent.click(sendBtn);
    expect(await screen.findByText("Model unavailable")).toBeTruthy();

    // 3. Successful exchange with an oversized assistant reply (> MAX_CHAT_MESSAGE_LENGTH).
    const longReply = "r".repeat(MAX_CHAT_MESSAGE_LENGTH + 500);
    server.setNextChatResponse(() =>
      sseResponse([
        { event: "token", data: { text: longReply } },
        { event: "done", data: { messageId: "msg_long", conversationId: "conv_preview_1" } },
      ]),
    );
    fireEvent.change(input, { target: { value: "Second attempt succeeds" } });
    fireEvent.click(sendBtn);
    expect(await screen.findByText(longReply)).toBeTruthy();

    // Failed exchange was not sent in the second request's history.
    expect(server.chatBodies[1]?.history).toBeUndefined();

    // 4. Follow-up message resends history truncated to MAX_CHAT_MESSAGE_LENGTH and valid under parseChatRequest.
    fireEvent.change(input, { target: { value: "Follow-up question" } });
    fireEvent.click(sendBtn);
    expect(await screen.findByText("Draft reply to: Follow-up question")).toBeTruthy();

    const followUpBody = server.chatBodies[2];
    expect(followUpBody).toBeTruthy();
    const parsed = parseChatRequest(followUpBody);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.history).toEqual([
        { role: "user", content: "Second attempt succeeds" },
        { role: "assistant", content: "r".repeat(MAX_CHAT_MESSAGE_LENGTH) },
      ]);
    }
  });

  it("F9: scopes Try it cancellation to the cleared assistant without interrupting another assistant", async () => {
    const first = makeAssistant("ast_a", "Assistant A");
    const second = makeAssistant("ast_b", "Assistant B");
    const server = installFakeServer({ signedIn: true, assistants: [first, second] });

    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const select = (await screen.findByLabelText("Assistant")) as HTMLSelectElement;

    // 1. Give assistant B an existing transcript.
    fireEvent.change(select, { target: { value: "ast_b" } });
    server.setNextChatResponse(() =>
      sseResponse([
        { event: "token", data: { text: "B existing reply" } },
        { event: "done", data: { messageId: "msg_b1", conversationId: "conv_b1" } },
      ]),
    );
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "Question for B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("B existing reply")).toBeTruthy();

    // 2. Switch to assistant A and send a question that streams partially before waiting.
    fireEvent.change(select, { target: { value: "ast_a" } });
    const streamA = createControlledSseResponse();
    let signalA: AbortSignal | undefined;
    server.setNextChatResponse((_body, init) => {
      signalA = init?.signal ?? undefined;
      return streamA.response;
    });

    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "Question for A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    streamA.push("token", { text: "Partial A" });
    expect(await screen.findByText("Partial A")).toBeTruthy();
    expect(signalA?.aborted).toBe(false);

    // 3. Switch back to B while A is still streaming; B's input should stay enabled and Clear should only clear B.
    fireEvent.change(select, { target: { value: "ast_b" } });
    expect(await screen.findByText("B existing reply")).toBeTruthy();
    expect((screen.getByLabelText("Ask a question") as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("B existing reply")).toBeNull();
    expect(signalA?.aborted).toBe(false);

    // 4. Finish A's stream while B is selected, then switch back to A and verify full exchange and follow-up.
    streamA.push("token", { text: " complete" });
    streamA.push("done", { messageId: "msg_a1", conversationId: "conv_a1" });
    streamA.close();

    fireEvent.change(select, { target: { value: "ast_a" } });
    expect(await screen.findByText("Partial A complete")).toBeTruthy();

    await waitFor(() => {
      expect((screen.getByLabelText("Ask a question") as HTMLInputElement).disabled).toBe(false);
    });

    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "Follow-up for A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Draft reply to: Follow-up for A")).toBeTruthy();

    const followUp = server.chatBodies[2];
    expect(followUp).toMatchObject({
      assistant: "pk_ast_a",
      conversationId: "conv_a1",
      history: [
        { role: "user", content: "Question for A" },
        { role: "assistant", content: "Partial A complete" },
      ],
    });
  });

  it("F9: isolates concurrent assistant requests and prevents stale cleanup after Clear and resend", async () => {
    const first = makeAssistant("ast_a", "Assistant A");
    const second = makeAssistant("ast_b", "Assistant B");
    const server = installFakeServer({ signedIn: true, assistants: [first, second] });

    window.history.replaceState(null, "", "/admin/behaviour");
    render(<App />);

    const select = (await screen.findByLabelText("Assistant")) as HTMLSelectElement;

    // Start streaming on A.
    const streamA = createControlledSseResponse();
    let signalA: AbortSignal | undefined;
    server.setNextChatResponse((_body, init) => {
      signalA = init?.signal ?? undefined;
      return streamA.response;
    });
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "A stream" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    streamA.push("token", { text: "A working" });
    expect(await screen.findByText("A working")).toBeTruthy();

    // Switch to B and start streaming on B concurrently.
    fireEvent.change(select, { target: { value: "ast_b" } });
    const streamB1 = createControlledSseResponse();
    let signalB1: AbortSignal | undefined;
    server.setNextChatResponse((_body, init) => {
      signalB1 = init?.signal ?? undefined;
      return streamB1.response;
    });
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "B first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    streamB1.push("token", { text: "B partial" });
    expect(await screen.findByText("B partial")).toBeTruthy();

    // Clear B: B's first request is aborted, A's is untouched.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(signalB1?.aborted).toBe(true);
    expect(signalA?.aborted).toBe(false);
    expect(screen.queryByText("B partial")).toBeNull();

    // Immediately send a second request on B while B1 may still be unwinding.
    const streamB2 = createControlledSseResponse();
    server.setNextChatResponse(() => streamB2.response);
    fireEvent.change(screen.getByLabelText("Ask a question"), {
      target: { value: "B second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // B2 should still be sending until B2 itself finishes (B1's cleanup must not clear B2).
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Sending…" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    streamB2.push("token", { text: "B2 reply" });
    streamB2.push("done", { messageId: "msg_b2", conversationId: "conv_b2" });
    streamB2.close();
    expect(await screen.findByText("B2 reply")).toBeTruthy();
    expect(server.chatBodies[2]).toMatchObject({
      assistant: "pk_ast_b",
      message: "B second",
    });
    expect(server.chatBodies[2]?.history).toBeUndefined();
    expect(server.chatBodies[2]?.conversationId).toBeUndefined();

    // Complete A's stream and verify A was unaffected.
    streamA.push("done", { messageId: "msg_a", conversationId: "conv_a" });
    streamA.close();
    fireEvent.change(select, { target: { value: "ast_a" } });
    expect(await screen.findByText("A working")).toBeTruthy();
  });

  it("F9: marks retained cancelled exchanges as failed so they cannot enter subsequent history", async () => {
    const server = installFakeServer({ signedIn: true });
    window.history.replaceState(null, "", "/admin/behaviour");

    const RealAbortController = globalThis.AbortController;
    const createdControllers: AbortController[] = [];
    vi.stubGlobal(
      "AbortController",
      class extends RealAbortController {
        constructor() {
          super();
          createdControllers.push(this);
        }
      },
    );

    render(<App />);

    const input = (await screen.findByLabelText("Ask a question")) as HTMLInputElement;
    const stream = createControlledSseResponse();
    let requestSignal: AbortSignal | undefined;
    server.setNextChatResponse((_body, init) => {
      requestSignal = init?.signal ?? undefined;
      return stream.response;
    });

    fireEvent.change(input, { target: { value: "Cancelled question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    stream.push("token", { text: "Partial cancelled reply" });
    expect(await screen.findByText("Partial cancelled reply")).toBeTruthy();

    // Abort the request controller directly without clearing turns, retaining the cancelled exchange.
    const requestController = createdControllers.find((c) => c.signal === requestSignal);
    expect(requestController).toBeTruthy();
    requestController?.abort();

    await waitFor(() => {
      expect(input.disabled).toBe(false);
    });
    expect(screen.getByText("Cancelled question")).toBeTruthy();
    expect(screen.getByText("Partial cancelled reply")).toBeTruthy();

    // Sending a subsequent question must not include the cancelled exchange in history.
    fireEvent.change(input, { target: { value: "Fresh question" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Draft reply to: Fresh question")).toBeTruthy();

    expect(server.chatBodies[1]).toMatchObject({ message: "Fresh question" });
    expect(server.chatBodies[1]?.history).toBeUndefined();
  });
});
