import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdminMount,
  App,
  type Assistant,
  type ExtraScreenProps,
  type HeaderSlotProps,
  type MountAdminOptions,
  mountAdmin,
} from "../src/index.js";
import { NAV_ITEMS } from "../src/routing.js";
import {
  assistantButton,
  findAssistantButton,
  listedAssistantNames,
  openNewAssistantForm,
  selectedAssistantId,
} from "./support/switcher.js";

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

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface ServerOptions {
  /** Holds each create request until `releaseCreate()` is called. */
  holdCreates?: boolean;
  /** Answers `POST /api/admin/chat`; the default is a one-token reply. */
  chat?: (body: { message: string }) => Response;
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

function installServer(initial: Assistant[] = [], options: ServerOptions = {}) {
  const assistants = [...initial];
  const calls: Call[] = [];
  const heldCreates: Array<() => void> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants });
    }
    if (path === "/api/admin/assistants" && method === "POST") {
      if (options.holdCreates) {
        await new Promise<void>((resolve) => heldCreates.push(resolve));
      }
      const input = body as { name: string; allowedOrigins: string[] };
      for (let i = 0; i < input.allowedOrigins.length; i++) {
        const origin = input.allowedOrigins[i] ?? "";
        if (!origin.startsWith("https://") && !origin.startsWith("http://")) {
          return Response.json(
            {
              error: "That is not valid.",
              fields: [`allowedOrigins[${i}]: must be an absolute URL such as https://example.com`],
            },
            { status: 400 },
          );
        }
      }
      const created = makeAssistant(
        `ast_${assistants.length + 1}`,
        input.name,
        input.allowedOrigins,
      );
      assistants.push(created);
      // Distinct per creation so tests can tell which key the notice shows.
      const ingestKey =
        assistants.length === 1 ? "ik_test_once" : `ik_test_once_${assistants.length}`;
      return Response.json({ assistant: created, ingestKey }, { status: 201 });
    }
    if (path === "/api/admin/chat" && method === "POST") {
      const chatBody = body as { message: string };
      if (options.chat) return options.chat(chatBody);
      return sseResponse([
        { event: "token", data: { text: `Reply to: ${chatBody.message}` } },
        { event: "done", data: { messageId: "msg_1", conversationId: "conv_1" } },
      ]);
    }
    if (path === "/api/admin/account") {
      return Response.json({ org: "Acme" });
    }
    if (path.endsWith("/overview")) {
      return Response.json({ messages: 0, answeredShare: 1, todayCostMicros: 0, topQuestions: [] });
    }
    if (path.endsWith("/sources")) {
      return Response.json({ sources: [] });
    }
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    assistants,
    calls,
    heldCreateCount: () => heldCreates.length,
    releaseCreate: () => {
      const release = heldCreates.shift();
      if (!release) throw new Error("no create request is held");
      release();
    },
  };
}

let activeMount: AdminMount | null = null;
let container: HTMLDivElement | null = null;

function mountIntoDom(options?: MountAdminOptions): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    activeMount = mountAdmin(container as HTMLElement, options);
  });
}

let headerProps: HeaderSlotProps[] = [];

function OrgName({ api }: HeaderSlotProps) {
  headerProps.push({ api });
  const res = api.useResource<{ org: string }>("/api/admin/account");
  return <span data-testid="org-name">{res.value?.org ?? "…"}</span>;
}

function OrgSwitcher({ api }: HeaderSlotProps) {
  headerProps.push({ api });
  return (
    <button type="button" data-testid="org-switcher">
      Switch organisation
    </button>
  );
}

function AccountScreen({ assistantId }: ExtraScreenProps) {
  return (
    <div className="screen">
      <h1>Account</h1>
      <p data-testid="account-assistant">{assistantId ?? "none"}</p>
    </div>
  );
}

const accountOptions: MountAdminOptions = {
  extraNavItems: [
    {
      id: "account",
      label: "Account",
      path: "/admin/account",
      section: "Account",
      assistantScoped: false,
    },
    { id: "usage", label: "Usage", path: "/admin/usage", section: "Account" },
  ],
  extraScreens: { account: AccountScreen, usage: AccountScreen },
};

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/overview");
  headerProps = [];
});

afterEach(() => {
  if (activeMount) {
    const mount = activeMount;
    act(() => mount.unmount());
    activeMount = null;
  }
  container?.remove();
  container = null;
  cleanup();
  vi.unstubAllGlobals();
});

function header(): HTMLElement {
  const el = document.querySelector("header.shell-header");
  if (!(el instanceof HTMLElement)) throw new Error("no header");
  return el;
}

describe("header slots", () => {
  it("renders no slot wrappers when no slots are given", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    mountIntoDom();
    await screen.findByRole("heading", { name: "Overview", level: 1 });
    await waitFor(() => {
      expect(selectedAssistantId()).toBe("ast_1");
    });
    expect(header().querySelector(".shell-header-slot")).toBeNull();
    const children = Array.from(header().children);
    expect(children[0]?.classList.contains("shell-brand")).toBe(true);
    expect(children[1]?.classList.contains("switcher")).toBe(true);
    expect(children[children.length - 1]?.textContent).toBe("Sign out");
  });

  it("renders headerStart after the product name and headerEnd before Sign out, with api", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    mountIntoDom({ headerStart: OrgName, headerEnd: OrgSwitcher });

    await waitFor(() => {
      expect(screen.getByTestId("org-name").textContent).toBe("Acme");
    });
    const children = Array.from(header().children);
    const brandIndex = children.findIndex((el) => el.classList.contains("shell-brand"));
    const startIndex = children.findIndex((el) => el.contains(screen.getByTestId("org-name")));
    const switcherIndex = children.findIndex((el) => el.classList.contains("switcher"));
    const endIndex = children.findIndex((el) => el.contains(screen.getByTestId("org-switcher")));
    const signOutIndex = children.findIndex((el) => el.textContent === "Sign out");
    expect(startIndex).toBe(brandIndex + 1);
    expect(switcherIndex).toBe(startIndex + 1);
    // Publish status and the Try it toggle sit between the switcher and headerEnd.
    expect(endIndex).toBeGreaterThan(switcherIndex);
    expect(signOutIndex).toBeGreaterThan(endIndex);
    expect(children.slice(endIndex + 1, signOutIndex).every((el) => el.tagName === "BUTTON")).toBe(
      true,
    );

    expect(headerProps.length).toBeGreaterThan(0);
    for (const props of headerProps) {
      expect(props.api.getJson).toBeTypeOf("function");
      expect(props.api.postJson).toBeTypeOf("function");
      expect(props.api.useResource).toBeTypeOf("function");
      expect(props.api.apiFetch).toBeTypeOf("function");
    }
  });
});

describe("assistantScoped", () => {
  it("hides the assistant switcher, New assistant and Try it on an unscoped screen", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    window.history.replaceState(null, "", "/admin/account");
    mountIntoDom(accountOptions);

    await screen.findByRole("heading", { name: "Account", level: 1 });
    await waitFor(() => {
      expect(screen.getByTestId("account-assistant").textContent).toBe("ast_1");
    });
    expect(screen.queryByRole("button", { name: /^Assistant / })).toBeNull();
    expect(screen.queryByRole("option", { name: "New assistant" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try it" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();
    expect((document.querySelector(".switcher") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".try-it") as HTMLElement).hidden).toBe(true);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();

    // Back on a built-in screen the chrome returns.
    fireEvent.click(screen.getByRole("link", { name: "Sources" }));
    await screen.findByRole("heading", { name: "Sources", level: 1 });
    expect(assistantButton()).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Try it" })).toBeTruthy();
  });

  it("keeps the Try it conversation and unsent question across an unscoped screen", async () => {
    let closeStream: (() => void) | null = null;
    const server = installServer([makeAssistant("ast_1", "Docs Bot")], {
      chat: (body) => {
        if (body.message === "First question") {
          return sseResponse([
            { event: "token", data: { text: "First answer" } },
            { event: "done", data: { messageId: "msg_1", conversationId: "conv_1" } },
          ]);
        }
        if (body.message !== "Second question") {
          return sseResponse([
            { event: "token", data: { text: `Reply to: ${body.message}` } },
            { event: "done", data: { messageId: "msg_3", conversationId: "conv_1" } },
          ]);
        }
        // The second answer streams until the test closes it.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`event: token\ndata: ${JSON.stringify({ text: "Second " })}\n\n`),
            );
            closeStream = () => {
              controller.enqueue(
                encoder.encode(
                  `event: token\ndata: ${JSON.stringify({ text: "answer" })}\n\n` +
                    `event: done\ndata: ${JSON.stringify({ messageId: "msg_2", conversationId: "conv_1" })}\n\n`,
                ),
              );
              controller.close();
            };
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      },
    });
    mountIntoDom(accountOptions);

    fireEvent.click(await screen.findByRole("button", { name: "Try it" }));
    const pane = await screen.findByRole("complementary", { name: "Try it" });
    const input = within(pane).getByLabelText("Ask a question") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "First question" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await within(pane).findByText("First answer");

    // An answer is still streaming when the owner leaves.
    fireEvent.change(input, { target: { value: "Second question" } });
    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await within(pane).findByText("Second");
    expect(input.disabled).toBe(true);

    fireEvent.click(screen.getByRole("link", { name: "Account" }));
    await screen.findByRole("heading", { name: "Account", level: 1 });
    // Hidden: out of layout, the tab order and the accessibility tree, but still mounted.
    expect(screen.queryByRole("complementary", { name: "Try it" })).toBeNull();
    expect(pane.isConnected).toBe(true);
    expect(pane.hidden).toBe(true);

    act(() => closeStream?.());
    await waitFor(() => {
      expect(pane.textContent).toContain("Second answer");
    });

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.getByRole("complementary", { name: "Try it" })).toBe(pane);
    expect(pane.hidden).toBe(false);
    expect(within(pane).getByText("First question")).toBeTruthy();
    expect(within(pane).getByText("First answer")).toBeTruthy();
    expect(within(pane).getByText("Second question")).toBeTruthy();
    expect(pane.textContent).toContain("Second answer");

    // An unsent question survives a round trip too.
    fireEvent.change(input, { target: { value: "Third question" } });
    fireEvent.click(screen.getByRole("link", { name: "Account" }));
    await screen.findByRole("heading", { name: "Account", level: 1 });
    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("Third question");

    fireEvent.click(within(pane).getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(pane.textContent).toContain("Reply to: Third question");
    });
    const chats = server.calls.filter((c) => c.method === "POST" && c.path === "/api/admin/chat");
    expect(chats).toHaveLength(3);
    expect(chats[2]?.body).toMatchObject({ conversationId: "conv_1" });
  });

  it("keeps a half-filled New assistant form across an unscoped screen", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    mountIntoDom(accountOptions);

    await findAssistantButton();
    openNewAssistantForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Half typed" } });

    fireEvent.click(screen.getByRole("link", { name: "Account" }));
    await screen.findByRole("heading", { name: "Account", level: 1 });
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Overview" }));
    await screen.findByRole("heading", { name: "Overview" });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Half typed");
  });

  it("keeps the assistant chrome on extra screens by default", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    window.history.replaceState(null, "", "/admin/usage");
    mountIntoDom(accountOptions);

    await screen.findByRole("heading", { name: "Account", level: 1 });
    expect(assistantButton()).toBeTruthy();
    openNewAssistantForm();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
    await screen.findByRole("complementary", { name: "Try it" });
  });

  it("renders the unscoped screen with zero assistants and no first-run state", async () => {
    installServer([]);
    window.history.replaceState(null, "", "/admin/account");
    mountIntoDom(accountOptions);

    await screen.findByRole("heading", { name: "Account", level: 1 });
    expect(screen.getByTestId("account-assistant").textContent).toBe("none");
    expect(screen.queryByRole("button", { name: /^Assistant / })).toBeNull();
    expect((document.querySelector(".switcher") as HTMLElement).hidden).toBe(true);
    expect(screen.queryByRole("option", { name: "New assistant" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Create your first assistant" })).toBeNull();
  });
});

describe("defaultScreen", () => {
  it("lands /admin/ on the host's screen", async () => {
    installServer([]);
    window.history.replaceState(null, "", "/admin/");
    mountIntoDom({ ...accountOptions, defaultScreen: "account" });

    await screen.findByRole("heading", { name: "Account", level: 1 });
    expect(screen.getByRole("link", { name: "Account" }).getAttribute("aria-current")).toBe("page");
  });

  it("lands /admin/ on a built-in screen", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    window.history.replaceState(null, "", "/admin");
    mountIntoDom({ defaultScreen: "sources" });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Sources" }).getAttribute("aria-current")).toBe(
        "page",
      );
    });
  });

  it("still lands on Overview without defaultScreen", async () => {
    installServer([makeAssistant("ast_1", "Docs Bot")]);
    window.history.replaceState(null, "", "/admin/");
    mountIntoDom(accountOptions);
    await screen.findByRole("heading", { name: "Overview" });
  });

  it("throws at mount time for an unknown or hidden defaultScreen", () => {
    const el = document.createElement("div");
    expect(() => mountAdmin(el, { defaultScreen: "billing" })).toThrow(/defaultScreen "billing"/);
    expect(() =>
      mountAdmin(el, { hideScreens: ["providers"], defaultScreen: "providers" }),
    ).toThrow(/defaultScreen "providers"/);
  });
});

const FIRST_RUN_SCREENS = NAV_ITEMS.filter((item) => item.id !== "providers");

describe("first-run state", () => {
  it.each(FIRST_RUN_SCREENS.map((item) => [item.id, item.path]))(
    "shows the first-run state on %s with no assistant",
    async (_id, path) => {
      installServer([]);
      window.history.replaceState(null, "", path);
      render(<App />);

      const form = await screen.findByRole("form", { name: "Create your first assistant" });
      expect(screen.queryByText("Create an assistant to begin.")).toBeNull();
      expect(within(form).getByLabelText("Name")).toBeTruthy();
      expect(within(form).getByLabelText("Allowed origins (optional, one per line)")).toBeTruthy();
      const steps = within(screen.getByRole("region", { name: "Next steps" })).getByRole("list");
      expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
      expect(steps.textContent).toMatch(/Add sources/);
      expect(steps.textContent).toMatch(/Try it/);
      expect(steps.textContent).toMatch(/snippet/);
      expect(document.activeElement).toBe(within(form).getByLabelText("Name"));
    },
  );

  it("creates the assistant and lands on Sources for it", async () => {
    const server = installServer([]);
    window.history.replaceState(null, "", "/admin/overview");
    render(<App />);

    const form = await screen.findByRole("form", { name: "Create your first assistant" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Help Desk" } });
    fireEvent.change(within(form).getByLabelText("Allowed origins (optional, one per line)"), {
      target: { value: "https://example.com\n" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create assistant" }));

    await screen.findByRole("heading", { name: "Sources" });
    expect(window.location.pathname).toBe("/admin/sources");
    expect(selectedAssistantId()).toBe("ast_1");
    expect(screen.getByRole("link", { name: "Sources" }).getAttribute("aria-current")).toBe("page");
    expect((screen.getByLabelText("Ingest key") as HTMLInputElement).value).toBe("ik_test_once");
    expect(server.calls).toContainEqual({
      method: "POST",
      path: "/api/admin/assistants",
      body: { name: "Help Desk", allowedOrigins: ["https://example.com"] },
    });
    await waitFor(() => {
      expect(
        server.calls.some(
          (c) => c.method === "GET" && c.path === "/api/admin/assistants/ast_1/sources",
        ),
      ).toBe(true);
    });
  });

  it("announces the same origin validation error as the dialog and stays put", async () => {
    installServer([]);
    window.history.replaceState(null, "", "/admin/widget");
    render(<App />);

    const form = await screen.findByRole("form", { name: "Create your first assistant" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Help Desk" } });
    fireEvent.change(within(form).getByLabelText("Allowed origins (optional, one per line)"), {
      target: { value: "example.com" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create assistant" }));

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe("must be an absolute URL such as https://example.com");
    expect(window.location.pathname).toBe("/admin/widget");
    expect(screen.getByRole("heading", { name: "Create your first assistant" })).toBeTruthy();
  });

  it("stays on the current screen after creation when Sources is hidden", async () => {
    installServer([]);
    window.history.replaceState(null, "", "/admin/overview");
    render(<App options={{ hideScreens: ["sources"] }} />);

    const form = await screen.findByRole("form", { name: "Create your first assistant" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Help Desk" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create assistant" }));

    await screen.findByRole("heading", { name: "Overview" });
    expect(window.location.pathname).toBe("/admin/overview");
  });

  it("keeps both assistants when the first-run and header forms create at once", async () => {
    const server = installServer([], { holdCreates: true });
    window.history.replaceState(null, "", "/admin/overview");
    render(<App />);

    const firstRun = await screen.findByRole("form", { name: "Create your first assistant" });
    fireEvent.change(within(firstRun).getByLabelText("Name"), { target: { value: "First" } });
    openNewAssistantForm();
    const headerForm = document.querySelector("header form");
    if (!(headerForm instanceof HTMLElement)) throw new Error("no header form");
    fireEvent.change(within(headerForm).getByLabelText("Name"), { target: { value: "Second" } });

    fireEvent.click(within(firstRun).getByRole("button", { name: "Create assistant" }));
    fireEvent.click(within(headerForm).getByRole("button", { name: "Create assistant" }));
    await waitFor(() => expect(server.heldCreateCount()).toBe(2));

    await act(async () => server.releaseCreate());
    await screen.findByRole("heading", { name: "Sources" });
    await act(async () => server.releaseCreate());

    await waitFor(() => {
      expect(listedAssistantNames()).toEqual(["First", "Second"]);
    });
    expect(selectedAssistantId()).toBe("ast_2");
    expect(server.assistants.map((a) => a.name)).toEqual(["First", "Second"]);
  });

  it("keeps each one-time key until dismissed when two creations finish close together", async () => {
    const server = installServer([], { holdCreates: true });
    window.history.replaceState(null, "", "/admin/overview");
    render(<App />);

    const firstRun = await screen.findByRole("form", { name: "Create your first assistant" });
    fireEvent.change(within(firstRun).getByLabelText("Name"), { target: { value: "First" } });
    openNewAssistantForm();
    const headerForm = document.querySelector("header form");
    if (!(headerForm instanceof HTMLElement)) throw new Error("no header form");
    fireEvent.change(within(headerForm).getByLabelText("Name"), { target: { value: "Second" } });

    fireEvent.click(within(firstRun).getByRole("button", { name: "Create assistant" }));
    fireEvent.click(within(headerForm).getByRole("button", { name: "Create assistant" }));
    await waitFor(() => expect(server.heldCreateCount()).toBe(2));

    await act(async () => server.releaseCreate());
    await screen.findByRole("heading", { name: "Sources" });
    await act(async () => server.releaseCreate());
    await waitFor(() => expect(server.assistants).toHaveLength(2));

    // The second key must not replace the first one before the user has copied it.
    const notice = await screen.findByRole("status", { name: "New ingest key" });
    await waitFor(() => expect(notice.textContent).toMatch(/1 more new key is next/));
    expect((within(notice).getByLabelText("Assistant ID") as HTMLInputElement).value).toBe("ast_1");
    expect((within(notice).getByLabelText("Ingest key") as HTMLInputElement).value).toBe(
      "ik_test_once",
    );

    fireEvent.click(within(notice).getByRole("button", { name: "Done" }));
    const next = screen.getByRole("status", { name: "New ingest key" });
    expect((within(next).getByLabelText("Assistant ID") as HTMLInputElement).value).toBe("ast_2");
    expect((within(next).getByLabelText("Ingest key") as HTMLInputElement).value).toBe(
      "ik_test_once_2",
    );
    expect(next.textContent).not.toMatch(/more new key/);

    fireEvent.click(within(next).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("status", { name: "New ingest key" })).toBeNull();
  });
});
